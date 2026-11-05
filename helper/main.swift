// can-helper — Can's own desktop engine (macOS), milestone 1.
//
// Speaks the same stdio JSON-RPC dialect the Can agent already uses with
// its internal desktop driver: newline-delimited JSON-RPC 2.0, an
// `initialize` handshake, then `tools/call` requests whose results are
// MCP-style CallToolResult objects ({content, structuredContent, isError}).
// The agent spawns it as `<helper> mcp`; only its configured driver path
// changes, nothing else.
//
// Milestone 1 scope: initialize, start_session (no-op), list_windows,
// launch_app. Everything else answers with an honest isError until its
// milestone lands (see docs/SELFBUILT-HELPER.md).
//
// Build:  ./build.sh        (swiftc, Xcode Command Line Tools)
// Run:    ./can-helper mcp  (the agent passes the "mcp" argument)

import Foundation
import CoreGraphics
import AppKit

let HELPER_VERSION = "0.1.0"

// ---------- tiny JSON helpers ----------

func jsonString(_ obj: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let s = String(data: data, encoding: .utf8) else { return "{}" }
    return s
}

func send(_ obj: [String: Any]) {
    FileHandle.standardOutput.write(Data((jsonString(obj) + "\n").utf8))
}

func toolResult(id: Any, structured: Any?, text: String, isError: Bool = false) {
    var result: [String: Any] = [
        "content": [["type": "text", "text": text]],
        "isError": isError,
    ]
    if let structured = structured { result["structuredContent"] = structured }
    send(["jsonrpc": "2.0", "id": id, "result": result])
}

func toolError(id: Any, _ message: String) {
    toolResult(id: id, structured: nil, text: message, isError: true)
}

// ---------- verbs ----------

func listWindows() -> [[String: Any]] {
    let opts: CGWindowListOption = [.optionAll]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var out: [[String: Any]] = []
    for w in raw {
        let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        if layer != 0 { continue } // normal application windows only
        let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
        let wid = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
        if pid == 0 || wid == 0 { continue }
        var entry: [String: Any] = [
            "pid": pid,
            "window_id": wid,
            "app_name": (w[kCGWindowOwnerName as String] as? String) ?? "",
            // Empty without the Screen Recording permission; the agent
            // treats titles as best-effort and matches mainly on app/pid.
            "title": (w[kCGWindowName as String] as? String) ?? "",
            "is_on_screen": (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
        ]
        if let b = w[kCGWindowBounds as String] as? [String: Any] {
            entry["bounds"] = [
                "x": (b["X"] as? NSNumber)?.doubleValue ?? 0,
                "y": (b["Y"] as? NSNumber)?.doubleValue ?? 0,
                "width": (b["Width"] as? NSNumber)?.doubleValue ?? 0,
                "height": (b["Height"] as? NSNumber)?.doubleValue ?? 0,
            ]
        }
        out.append(entry)
    }
    return out
}

func launchApp(args: [String: Any]) -> (ok: Bool, message: String) {
    let name = (args["app_name"] as? String) ?? (args["app"] as? String)
        ?? (args["name"] as? String) ?? ""
    let bundleId = (args["bundle_id"] as? String) ?? ""
    if name.isEmpty && bundleId.isEmpty {
        return (false, "launch_app needs app_name or bundle_id")
    }
    // Delegate resolution to LaunchServices through open(1): it handles
    // localized names, bundle ids and already-running apps uniformly.
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    proc.arguments = bundleId.isEmpty ? ["-a", name] : ["-b", bundleId]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    do { try proc.run() } catch {
        return (false, "launch_app failed to start open(1): \(error.localizedDescription)")
    }
    proc.waitUntilExit()
    if proc.terminationStatus != 0 {
        return (false, "launch_app could not open \(bundleId.isEmpty ? name : bundleId)")
    }
    // Give the app a moment to create its window, then report what we see.
    Thread.sleep(forTimeInterval: 0.6)
    let wins = listWindows().filter {
        let appName = ($0["app_name"] as? String ?? "")
        return name.isEmpty || appName.localizedCaseInsensitiveContains(name)
            || name.localizedCaseInsensitiveContains(appName)
    }
    return (true, jsonString(["launched": true, "app": name, "windows": wins]))
}

// ---------- dispatch ----------

func handleToolsCall(id: Any, params: [String: Any]) {
    let name = (params["name"] as? String) ?? ""
    let args = (params["arguments"] as? [String: Any]) ?? [:]
    switch name {
    case "start_session":
        toolResult(id: id, structured: [String: Any](), text: "{}")
    case "list_windows":
        let wins = listWindows()
        toolResult(id: id, structured: ["windows": wins], text: jsonString(["windows": wins]))
    case "launch_app":
        let r = launchApp(args: args)
        if r.ok { toolResult(id: id, structured: nil, text: r.message) }
        else { toolError(id: id, r.message) }
    default:
        toolError(id: id, "can-helper milestone 1: tool '\(name)' is not implemented yet")
    }
}

func handle(line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let method = obj["method"] as? String else { return }
    let id = obj["id"] ?? NSNull()
    switch method {
    case "initialize":
        send(["jsonrpc": "2.0", "id": id, "result": [
            "protocolVersion": "2024-11-05",
            "capabilities": ["tools": [String: Any]()],
            "serverInfo": ["name": "can-helper", "version": HELPER_VERSION],
        ]])
    case "tools/call":
        handleToolsCall(id: id, params: (obj["params"] as? [String: Any]) ?? [:])
    case "ping":
        send(["jsonrpc": "2.0", "id": id, "result": [String: Any]()])
    default:
        if !(id is NSNull) {
            send(["jsonrpc": "2.0", "id": id,
                  "error": ["code": -32601, "message": "method not found: \(method)"]])
        }
    }
}

// ---------- main ----------

// NSWorkspace / CGWindowList calls want a run-loop-friendly process; a
// plain stdin line loop is enough for the request/response pattern here.
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    handle(line: line)
}

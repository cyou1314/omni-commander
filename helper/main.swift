// can-helper — Can's own desktop engine (macOS), milestone 2.
//
// Speaks the same stdio JSON-RPC dialect the Can agent already uses with
// its internal desktop driver: newline-delimited JSON-RPC 2.0, an
// `initialize` handshake, then `tools/call` requests whose results are
// MCP-style CallToolResult objects ({content, structuredContent, isError}).
// The agent spawns it as `<helper> mcp`; only its configured driver path
// changes, nothing else.
//
// Milestone 1: initialize, start_session (no-op), list_windows, launch_app.
// Milestone 2: get_window_state (AX tree walk -> elements + tokens +
// markdown tree text, optional window screenshot) and click by
// element_token (AX press). Remaining verbs answer with an honest
// isError until their milestone lands (see docs/SELFBUILT-HELPER.md).
//
// Build:  ./build.sh        (swiftc, Xcode Command Line Tools)
// Run:    ./can-helper mcp  (the agent passes the "mcp" argument)

import Foundation
import CoreGraphics
import ApplicationServices
import ImageIO
import ScreenCaptureKit

let HELPER_VERSION = "0.2.0"

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

func intArg(_ args: [String: Any], _ key: String) -> Int {
    if let n = args[key] as? NSNumber { return n.intValue }
    if let s = args[key] as? String, let v = Int(s) { return v }
    return 0
}

// ---------- list_windows / launch_app (milestone 1) ----------

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

func windowBounds(windowId: Int) -> CGRect? {
    for w in listWindows() where (w["window_id"] as? Int) == windowId {
        if let b = w["bounds"] as? [String: Any] {
            return CGRect(x: (b["x"] as? Double) ?? 0, y: (b["y"] as? Double) ?? 0,
                          width: (b["width"] as? Double) ?? 0, height: (b["height"] as? Double) ?? 0)
        }
    }
    return nil
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

// ---------- accessibility helpers (milestone 2) ----------

func axAttr(_ el: AXUIElement, _ attr: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String {
    (axAttr(el, attr) as? String) ?? ""
}

func axValueString(_ el: AXUIElement) -> String {
    guard let v = axAttr(el, kAXValueAttribute as String) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    if let b = v as? Bool { return b ? "true" : "false" }
    return ""
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    guard let v = axAttr(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
    guard let v = axAttr(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

// Find the AX window element for (pid, cgWindowId) by matching the AX
// window's frame against the CG window's bounds; fall back to the app's
// only / main window when the match is ambiguous.
func findAXWindow(pid: Int, windowId: Int) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid_t(pid))
    let wins = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    if wins.isEmpty { return nil }
    if let target = windowBounds(windowId: windowId) {
        for w in wins {
            guard let pos = axPoint(w, kAXPositionAttribute as String),
                  let size = axSize(w, kAXSizeAttribute as String) else { continue }
            if abs(pos.x - target.origin.x) <= 2 && abs(pos.y - target.origin.y) <= 2
                && abs(size.width - target.size.width) <= 2 && abs(size.height - target.size.height) <= 2 {
                return w
            }
        }
    }
    if wins.count == 1 { return wins[0] }
    for w in wins {
        if let main = axAttr(w, kAXMainAttribute as String) as? Bool, main { return w }
    }
    return wins[0]
}

// ---------- snapshots & tokens ----------

var snapshotSeq = 0
var tokenRegistry: [String: AXUIElement] = [:]
var windowTokens: [String: [String]] = [:] // "pid:wid" -> tokens of the latest snapshot

let interactiveRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXLink",
    "AXSlider", "AXIncrementor", "AXStepper", "AXTab", "AXTabButton",
    "AXDisclosureTriangle", "AXColorWell", "AXSegmentedControl",
]

struct Walked {
    let el: AXUIElement
    let depth: Int
    let role: String
    let label: String
    let value: String
}

func walkTree(root: AXUIElement, maxNodes: Int, maxDepth: Int) -> (nodes: [Walked], truncated: Bool) {
    var out: [Walked] = []
    var truncated = false
    func label(of el: AXUIElement) -> String {
        let t = axString(el, kAXTitleAttribute as String)
        if !t.isEmpty { return t }
        let d = axString(el, kAXDescriptionAttribute as String)
        if !d.isEmpty { return d }
        return axString(el, kAXHelpAttribute as String)
    }
    func visit(_ el: AXUIElement, _ depth: Int) {
        if out.count >= maxNodes { truncated = true; return }
        let role = axString(el, kAXRoleAttribute as String)
        out.append(Walked(el: el, depth: depth, role: role,
                          label: label(of: el), value: axValueString(el)))
        if depth >= maxDepth { return }
        for child in axChildren(el) { visit(child, depth + 1) }
    }
    visit(root, 0)
    return (out, truncated)
}

func getWindowState(id: Any, args: [String: Any]) {
    let pid = intArg(args, "pid")
    let wid = intArg(args, "window_id")
    if pid == 0 || wid == 0 {
        toolError(id: id, "get_window_state needs pid and window_id"); return
    }
    if !AXIsProcessTrusted() {
        toolError(id: id, "can-helper: accessibility permission is not granted for this process "
            + "(AXIsProcessTrusted=false); grant the helper in System Settings > "
            + "Privacy & Security > Accessibility, then retry"); return
    }
    guard let win = findAXWindow(pid: pid, windowId: wid) else {
        toolError(id: id, "can-helper: no accessibility window found for pid \(pid), window_id \(wid)"); return
    }

    let (nodes, walkTruncated) = walkTree(root: win, maxNodes: 3000, maxDepth: 60)

    // Element list: interactive roles, or anything carrying a label/value
    // the model might reference. Tokens point back into the registry.
    snapshotSeq += 1
    let snapId = "s\(snapshotSeq)"
    let key = "\(pid):\(wid)"
    if let old = windowTokens[key] { for t in old { tokenRegistry.removeValue(forKey: t) } }
    var tokens: [String] = []
    var elements: [[String: Any]] = []
    var elTruncated = false
    for n in nodes {
        let interesting = interactiveRoles.contains(n.role) || !n.label.isEmpty || !n.value.isEmpty
        if !interesting { continue }
        if elements.count >= 500 { elTruncated = true; break }
        let idx = elements.count
        let token = "\(snapId):\(idx)"
        tokenRegistry[token] = n.el
        tokens.append(token)
        elements.append([
            "element_index": idx,
            "element_token": token,
            "role": n.role,
            "label": n.label,
            "value": n.value,
        ])
    }
    windowTokens[key] = tokens

    // Markdown-ish tree text: every walked node, one line each. The agent
    // passes this through to the model verbatim (trimmed), and some apps
    // expose readouts only here (e.g. the Calculator display value).
    var treeLines: [String] = []
    for n in nodes.prefix(800) {
        var line = String(repeating: "  ", count: min(n.depth, 12)) + (n.role.isEmpty ? "AXElement" : n.role)
        if !n.label.isEmpty { line += " \"\(n.label)\"" }
        if !n.value.isEmpty { line += " = \(n.value)" }
        treeLines.append(line)
    }
    let treeText = treeLines.joined(separator: "\n")

    var sc: [String: Any] = [
        "elements": elements,
        "truncated": walkTruncated || elTruncated,
        "ax_trusted": true,
    ]

    var content: [[String: Any]] = [["type": "text", "text": treeText]]

    if let wantShot = args["include_screenshot"] as? Bool, wantShot {
        if let img = captureWindowPNG(windowId: wid) {
            sc["screenshot_width"] = img.width
            sc["screenshot_height"] = img.height
            sc["screenshot_mime_type"] = "image/png"
            content.append(["type": "image", "data": img.b64, "mimeType": "image/png"])
        } else {
            sc["screenshot_error"] = "window capture failed (screen recording permission for this process?)"
        }
    }

    send(["jsonrpc": "2.0", "id": id, "result": [
        "content": content,
        "structuredContent": sc,
        "isError": false,
    ]])
}

// Window capture goes through ScreenCaptureKit: the legacy
// CGWindowListCreateImage API is unavailable in current SDKs. SCK is
// async, so bridge it with a semaphore. Any failure (above all: the
// Screen Recording permission not being granted to this process) comes
// back as nil and the caller reports screenshot_error instead.
func captureWindowPNG(windowId: Int) -> (b64: String, width: Int, height: Int)? {
    var result: (b64: String, width: Int, height: Int)? = nil
    let sem = DispatchSemaphore(value: 0)
    Task {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let win = content.windows.first(where: { $0.windowID == CGWindowID(windowId) })
            else { return }
            let filter = SCContentFilter(desktopIndependentWindow: win)
            let cfg = SCStreamConfiguration()
            cfg.width = max(Int(win.frame.width), 1)
            cfg.height = max(Int(win.frame.height), 1)
            cfg.showsCursor = false
            cfg.captureResolution = .best
            let cg = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: cfg)
            let data = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(
                data, "public.png" as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(dest, cg, nil)
            if CGImageDestinationFinalize(dest) {
                result = (data.base64EncodedString(), cg.width, cg.height)
            }
        } catch {
            result = nil
        }
    }
    sem.wait()
    return result
}

func clickElement(id: Any, args: [String: Any]) {
    guard let token = args["element_token"] as? String, !token.isEmpty else {
        toolError(id: id, "can-helper milestone 2: click needs an element_token "
            + "(pixel coordinate clicks land in milestone 4)"); return
    }
    guard let el = tokenRegistry[token] else {
        toolError(id: id, "can-helper: unknown or stale element_token '\(token)'; take a fresh snapshot"); return
    }
    let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success {
        toolError(id: id, "can-helper: AX press failed for token '\(token)' (AXError \(err.rawValue))"); return
    }
    toolResult(id: id, structured: [String: Any](), text: "{}")
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
    case "get_window_state":
        getWindowState(id: id, args: args)
    case "click":
        clickElement(id: id, args: args)
    default:
        toolError(id: id, "can-helper milestone 2: tool '\(name)' is not implemented yet")
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

// The plain stdin line loop is enough for the agent's request/response
// pattern; AX calls are synchronous and same-process.
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    handle(line: line)
}

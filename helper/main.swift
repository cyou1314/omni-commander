// can-helper — Can's own desktop engine (macOS), milestone 4.
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
// element_token (AX press).
// Milestone 3: type_text (focus + unicode key events posted to the pid),
// set_value (direct AX value write), press_key (named keys and modifier
// combos posted to the pid), get_desktop_state (full-screen capture via
// ScreenCaptureKit, optional downscale).
// Milestone 4: pixel clicks and drags (window / desktop / from_zoom
// coordinate spaces, CGEvent mouse posts) and zoom (window-region crop
// that arms the from_zoom context). Elements also carry a window-
// relative `frame`, like the old driver's, so callers can aim pixel
// clicks. Remaining verbs answer with an honest isError until their
// milestone lands (see docs/SELFBUILT-HELPER.md).
//
// Build:  ./build.sh        (swiftc, Xcode Command Line Tools)
// Run:    ./can-helper mcp  (the agent passes the "mcp" argument)

import Foundation
import CoreGraphics
import ApplicationServices
import ImageIO
import ScreenCaptureKit

let HELPER_VERSION = "0.4.0"

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
    let frame: CGRect?
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    var posRef: AnyObject?
    var sizeRef: AnyObject?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let pv = posRef, let sv = sizeRef,
          CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID()
    else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(unsafeBitCast(pv, to: AXValue.self), .cgPoint, &p)
    AXValueGetValue(unsafeBitCast(sv, to: AXValue.self), .cgSize, &s)
    return CGRect(origin: p, size: s)
}

func cgWindowFrame(windowId: Int) -> CGRect? {
    let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId))
        as? [[String: Any]] ?? []
    guard let info = list.first,
          let bounds = info[kCGWindowBounds as String] as? [String: Any],
          let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double,
          let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double
    else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
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
                          label: label(of: el), value: axValueString(el),
                          frame: axFrame(el)))
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
    // A fresh snapshot replaces any zoom context (same rule as the old
    // driver: zoom -> snapshot -> from_zoom click is an error).
    zoomCtx = nil
    let winFrame = cgWindowFrame(windowId: wid)

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
        var element: [String: Any] = [
            "element_index": idx,
            "element_token": token,
            "role": n.role,
            "label": n.label,
            "value": n.value,
        ]
        if let f = n.frame, let wf = winFrame {
            element["frame"] = [
                "x": Int(f.origin.x - wf.origin.x),
                "y": Int(f.origin.y - wf.origin.y),
                "width": Int(f.width),
                "height": Int(f.height),
            ]
        }
        elements.append(element)
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
func captureWindowCGImage(windowId: Int) -> CGImage? {
    var result: CGImage? = nil
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
            result = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: cfg)
        } catch {
            result = nil
        }
    }
    sem.wait()
    return result
}

func captureWindowPNG(windowId: Int) -> (b64: String, width: Int, height: Int)? {
    guard let cg = captureWindowCGImage(windowId: windowId),
          let data = pngData(of: cg) else { return nil }
    return (data.base64EncodedString(), cg.width, cg.height)
}

func clickElement(id: Any, args: [String: Any]) {
    if let token = args["element_token"] as? String, !token.isEmpty {
        guard let el = tokenRegistry[token] else {
            toolError(id: id, "can-helper: unknown or stale element_token '\(token)'; take a fresh snapshot"); return
        }
        let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
        if err != .success {
            toolError(id: id, "can-helper: AX press failed for token '\(token)' (AXError \(err.rawValue))"); return
        }
        toolResult(id: id, structured: [String: Any](), text: "{}")
        return
    }
    // No token: pixel click (milestone 4).
    guard let pt = pixelPoint(args: args, xKey: "x", yKey: "y") else {
        toolError(id: id, pixelError ?? "can-helper: click needs an element_token or x/y"); return
    }
    mouseClick(pid: pt.pid, point: pt.point)
    toolResult(id: id, structured: [String: Any](), text: "{}")
}

// ---------- pixel space: click / drag / zoom (milestone 4) ----------
//
// The agent scales model coordinates into THIS helper's reported
// capture space before calling, and our captures are point-sized
// (1 image px = 1 screen point), so:
//   window space  -> screen = window origin + (x, y)
//   desktop space -> screen = (x, y)
//   from_zoom     -> the stored zoom rect maps crop px back to window
//                    points, then as window space.

struct ZoomCtx {
    let pid: Int
    let wid: Int
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let imgW: Int
    let imgH: Int
}

var zoomCtx: ZoomCtx? = nil
var lastDesktopCaptureId: String? = nil
var pixelError: String? = nil

func doubleArg(_ args: [String: Any], _ key: String) -> Double {
    if let n = args[key] as? NSNumber { return n.doubleValue }
    if let d = args[key] as? Double { return d }
    if let i = args[key] as? Int { return Double(i) }
    return 0
}

// Resolve a click/drag endpoint to a screen point + target pid
// (pid 0 = post to the HID tap, used for desktop space).
func pixelPoint(args: [String: Any], xKey: String, yKey: String) -> (pid: Int, point: CGPoint)? {
    pixelError = nil
    let x = doubleArg(args, xKey)
    let y = doubleArg(args, yKey)
    if (args["from_zoom"] as? Bool) == true {
        guard let z = zoomCtx else {
            pixelError = "can-helper: zoom context missing or replaced by a newer snapshot; call zoom again"
            return nil
        }
        let pid = intArg(args, "pid")
        let wid = intArg(args, "window_id")
        if (pid != 0 && pid != z.pid) || (wid != 0 && wid != z.wid) {
            pixelError = "can-helper: from_zoom target does not match the zoomed window"
            return nil
        }
        guard let frame = cgWindowFrame(windowId: z.wid) else {
            pixelError = "can-helper: zoomed window is gone"
            return nil
        }
        let wx = z.x1 + x * (z.x2 - z.x1) / Double(max(z.imgW, 1))
        let wy = z.y1 + y * (z.y2 - z.y1) / Double(max(z.imgH, 1))
        return (z.pid, CGPoint(x: frame.origin.x + wx, y: frame.origin.y + wy))
    }
    if (args["scope"] as? String) == "desktop" {
        if let cid = args["capture_id"] as? String, cid != lastDesktopCaptureId {
            pixelError = "can-helper: stale capture_id '\(cid)'; take a fresh desktop state"
            return nil
        }
        return (0, CGPoint(x: x, y: y))
    }
    let pid = intArg(args, "pid")
    let wid = intArg(args, "window_id")
    if wid == 0 {
        pixelError = "can-helper: pixel click needs pid and window_id (or scope=desktop)"
        return nil
    }
    guard let frame = cgWindowFrame(windowId: wid) else {
        pixelError = "can-helper: window \(wid) not found"
        return nil
    }
    return (pid, CGPoint(x: frame.origin.x + x, y: frame.origin.y + y))
}

func postMouse(pid: Int, point: CGPoint, type: CGEventType) {
    guard let ev = CGEvent(mouseEventSource: nil, mouseType: type,
                           mouseCursorPosition: point, mouseButton: .left) else { return }
    if pid > 0 {
        ev.postToPid(pid_t(pid))
    } else {
        ev.post(tap: .cghidEventTap)
    }
}

func mouseClick(pid: Int, point: CGPoint) {
    postMouse(pid: pid, point: point, type: .leftMouseDown)
    Thread.sleep(forTimeInterval: 0.03)
    postMouse(pid: pid, point: point, type: .leftMouseUp)
}

func dragTool(id: Any, args: [String: Any]) {
    guard let from = pixelPoint(args: args, xKey: "from_x", yKey: "from_y") else {
        toolError(id: id, pixelError ?? "can-helper: drag needs from_x/from_y/to_x/to_y"); return
    }
    guard let to = pixelPoint(args: args, xKey: "to_x", yKey: "to_y") else {
        toolError(id: id, pixelError ?? "can-helper: drag needs from_x/from_y/to_x/to_y"); return
    }
    let pid = from.pid != 0 ? from.pid : to.pid
    let duration = max(doubleArg(args, "duration_ms"), 50) / 1000.0
    let steps = 12
    postMouse(pid: pid, point: from.point, type: .leftMouseDown)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: from.point.x + (to.point.x - from.point.x) * t,
                        y: from.point.y + (to.point.y - from.point.y) * t)
        postMouse(pid: pid, point: p, type: .leftMouseDragged)
        Thread.sleep(forTimeInterval: duration / Double(steps))
    }
    postMouse(pid: pid, point: to.point, type: .leftMouseUp)
    toolResult(id: id, structured: [String: Any](), text: "{}")
}

func zoomTool(id: Any, args: [String: Any]) {
    let pid = intArg(args, "pid")
    let wid = intArg(args, "window_id")
    if wid == 0 { toolError(id: id, "can-helper: zoom needs pid and window_id"); return }
    let x1 = doubleArg(args, "x1"), y1 = doubleArg(args, "y1")
    let x2 = doubleArg(args, "x2"), y2 = doubleArg(args, "y2")
    if x2 <= x1 || y2 <= y1 {
        toolError(id: id, "can-helper: zoom needs a non-empty rect (x1<x2, y1<y2)"); return
    }
    guard let frame = cgWindowFrame(windowId: wid) else {
        toolError(id: id, "can-helper: window \(wid) not found"); return
    }
    guard let cg = captureWindowCGImage(windowId: wid) else {
        toolError(id: id, "can-helper: zoom capture failed (screen recording permission for this process?)"); return
    }
    // Capture px per window point (normally 1:1; stay exact regardless).
    let sx = Double(cg.width) / max(frame.width, 1)
    let sy = Double(cg.height) / max(frame.height, 1)
    let rect = CGRect(x: x1 * sx, y: y1 * sy,
                      width: (x2 - x1) * sx, height: (y2 - y1) * sy)
        .intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    if rect.isNull || rect.width < 2 || rect.height < 2 {
        toolError(id: id, "can-helper: zoom rect is outside the window"); return
    }
    guard let crop = cg.cropping(to: rect) else {
        toolError(id: id, "can-helper: zoom crop failed"); return
    }
    let out = scaled(crop, maxDim: 500)
    guard let data = pngData(of: out) else {
        toolError(id: id, "can-helper: zoom encode failed"); return
    }
    zoomCtx = ZoomCtx(pid: pid, wid: wid, x1: x1, y1: y1, x2: x2, y2: y2,
                      imgW: out.width, imgH: out.height)
    let sc: [String: Any] = [
        "screenshot_width": out.width,
        "screenshot_height": out.height,
        "screenshot_mime_type": "image/png",
    ]
    send(["jsonrpc": "2.0", "id": id, "result": [
        "content": [["type": "image", "data": data.base64EncodedString(), "mimeType": "image/png"]],
        "structuredContent": sc,
        "isError": false,
    ]])
}

// ---------- typing & keys (milestone 3) ----------

func tokenElement(_ args: [String: Any]) -> AXUIElement? {
    guard let token = args["element_token"] as? String else { return nil }
    return tokenRegistry[token]
}

func focusElement(_ el: AXUIElement) -> Bool {
    // Make the element's window the app's main/focused window first —
    // after programmatic value writes some apps drop first-responder,
    // and key events posted to the pid then land nowhere. Then focus
    // the element itself.
    var winRef: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &winRef) == .success,
       let anyWin = winRef,
       CFGetTypeID(anyWin) == AXUIElementGetTypeID() {
        let win = unsafeBitCast(anyWin, to: AXUIElement.self)
        AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(win, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    return AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
}

func postKeyEvent(pid: Int, keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else { return }
    ev.flags = flags
    ev.postToPid(pid_t(pid))
}

func postUnicodeChar(pid: Int, ch: Character) {
    let units = Array(String(ch).utf16)
    for down in [true, false] {
        guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
        units.withUnsafeBufferPointer { buf in
            ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buf.baseAddress)
        }
        ev.postToPid(pid_t(pid))
    }
}

// type_text: focus the element, then deliver the text as unicode key
// events to the app (real keystrokes, so fields that react per-keystroke
// behave). If the element cannot take keyboard focus we error out and
// the agent falls back to set_value, exactly as it does with the old
// driver.
func typeText(id: Any, args: [String: Any]) {
    let pid = intArg(args, "pid")
    let text = (args["text"] as? String) ?? ""
    guard let el = tokenElement(args) else {
        toolError(id: id, "can-helper: type_text needs a valid element_token from the latest snapshot"); return
    }
    if !focusElement(el) {
        // Some fields report focus failure yet still receive keys when
        // their window is key; only hard-fail for clearly non-textual
        // elements.
        let role = axString(el, kAXRoleAttribute as String)
        if !["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) {
            toolError(id: id, "can-helper: element (role \(role)) cannot take keyboard focus"); return
        }
    }
    // Let the window actually become key before posting: events posted
    // to the pid are routed to the app's key window at delivery time,
    // and a just-raised window may not be key yet (text then lands in
    // another window of the same app or nowhere).
    Thread.sleep(forTimeInterval: 0.2)
    for ch in text { postUnicodeChar(pid: pid, ch: ch) }
    Thread.sleep(forTimeInterval: 0.05)
    toolResult(id: id, structured: [String: Any](), text: "{}")
}

func setValue(id: Any, args: [String: Any]) {
    let value = (args["value"] as? String) ?? ""
    guard let el = tokenElement(args) else {
        toolError(id: id, "can-helper: set_value needs a valid element_token from the latest snapshot"); return
    }
    var settable = DarwinBoolean(false)
    AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
    if !settable.boolValue {
        toolError(id: id, "can-helper: element's value is not settable"); return
    }
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
    if err != .success {
        toolError(id: id, "can-helper: set_value failed (AXError \(err.rawValue))"); return
    }
    toolResult(id: id, structured: [String: Any](), text: "{}")
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
    "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
    "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39,
    "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "command": 55, "cmd": 55, "shift": 56,
    "capslock": 57, "option": 58, "alt": 58, "control": 59, "ctrl": 59,
    "rightshift": 60, "rightoption": 61, "rightcontrol": 62, "fn": 63,
    "f17": 64, "f18": 79, "f19": 80, "f20": 90, "f5": 96, "f6": 97,
    "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103, "f13": 105,
    "f16": 106, "f10": 109, "f12": 111, "f15": 113, "home": 115,
    "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119, "f2": 120,
    "pagedown": 121, "f1": 122, "left": 123, "right": 124, "down": 125,
    "up": 126,
]

// press_key: one named key, optionally with "+"-joined modifiers
// ("cmd+a"). With an element_token, the element is focused first.
func pressKey(id: Any, args: [String: Any]) {
    let pid = intArg(args, "pid")
    let raw = ((args["key"] as? String) ?? "").lowercased()
    if raw.isEmpty { toolError(id: id, "can-helper: press_key needs a key"); return }
    if let el = tokenElement(args) { _ = focusElement(el); Thread.sleep(forTimeInterval: 0.08) }
    let parts = raw.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let keyName = parts.last, let code = keyCodes[keyName] else {
        toolError(id: id, "can-helper: unknown key '\(raw)'"); return
    }
    // A bare printable character goes out as a unicode event: a raw
    // keycode event posted to another pid can be dropped when the
    // target's first responder was reset by a programmatic value
    // write, while the unicode path lands like typed text.
    if parts.count == 1 && keyName.count == 1 {
        postUnicodeChar(pid: pid, ch: keyName.first!)
        toolResult(id: id, structured: [String: Any](), text: "{}")
        return
    }
    var flags: CGEventFlags = []
    for mod in parts.dropLast() {
        switch mod {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: toolError(id: id, "can-helper: unknown modifier '\(mod)'"); return
        }
    }
    postKeyEvent(pid: pid, keyCode: code, down: true, flags: flags)
    Thread.sleep(forTimeInterval: 0.02)
    postKeyEvent(pid: pid, keyCode: code, down: false, flags: flags)
    toolResult(id: id, structured: [String: Any](), text: "{}")
}

// ---------- desktop state (milestone 3) ----------

var captureSeq = 0

func pngData(of cg: CGImage) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(dest, cg, nil)
    return CGImageDestinationFinalize(dest) ? (data as Data) : nil
}

func scaled(_ cg: CGImage, maxDim: Int) -> CGImage {
    let longSide = max(cg.width, cg.height)
    if maxDim <= 0 || longSide <= maxDim { return cg }
    let ratio = Double(maxDim) / Double(longSide)
    let w = max(Int(Double(cg.width) * ratio), 1)
    let h = max(Int(Double(cg.height) * ratio), 1)
    guard let ctx = CGContext(data: nil, width: w, height: h,
                              bitsPerComponent: cg.bitsPerComponent,
                              bytesPerRow: 0, space: cg.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: cg.bitmapInfo.rawValue) else { return cg }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? cg
}

// Full-screen capture of the main display via ScreenCaptureKit.
func captureDesktop(maxDim: Int) -> (b64: String, width: Int, height: Int)? {
    var result: (b64: String, width: Int, height: Int)? = nil
    let sem = DispatchSemaphore(value: 0)
    Task {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { return }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.width = max(Int(display.width), 1)
            cfg.height = max(Int(display.height), 1)
            cfg.showsCursor = false
            cfg.captureResolution = .best
            let cg = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: cfg)
            let img = scaled(cg, maxDim: maxDim)
            if let data = pngData(of: img) {
                result = (data.base64EncodedString(), img.width, img.height)
            }
        } catch {
            result = nil
        }
    }
    sem.wait()
    return result
}

func getDesktopState(id: Any, args: [String: Any]) {
    let maxDim = intArg(args, "max_image_dimension")
    guard let shot = captureDesktop(maxDim: maxDim) else {
        toolError(id: id, "can-helper: desktop capture failed (screen recording permission for this process?)"); return
    }
    captureSeq += 1
    lastDesktopCaptureId = "cap-\(captureSeq)"
    // True display size from the display mode (the image itself may have
    // been downscaled to max_image_dimension).
    var screenW = shot.width, screenH = shot.height
    if let mode = CGDisplayCopyDisplayMode(CGMainDisplayID()) {
        screenW = mode.pixelWidth
        screenH = mode.pixelHeight
    }
    let sc: [String: Any] = [
        "screenshot_width": shot.width,
        "screenshot_height": shot.height,
        "screen_width": screenW,
        "screen_height": screenH,
        "screenshot_mime_type": "image/png",
        "capture_id": lastDesktopCaptureId ?? "cap-\(captureSeq)",
    ]
    send(["jsonrpc": "2.0", "id": id, "result": [
        "content": [["type": "image", "data": shot.b64, "mimeType": "image/png"]],
        "structuredContent": sc,
        "isError": false,
    ]])
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
    case "type_text":
        typeText(id: id, args: args)
    case "set_value":
        setValue(id: id, args: args)
    case "press_key":
        pressKey(id: id, args: args)
    case "get_desktop_state":
        getDesktopState(id: id, args: args)
    case "drag":
        dragTool(id: id, args: args)
    case "zoom":
        zoomTool(id: id, args: args)
    default:
        toolError(id: id, "can-helper milestone 4: tool '\(name)' is not implemented yet")
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

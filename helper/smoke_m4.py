#!/usr/bin/env python3
"""Milestone-4 smoke driver for can-helper.

Replays, against Calculator, the same pixel loop the old driver once
passed — but aiming from the AX element `frame`s the helper now
reports (deterministic, no vision needed):

  initialize -> launch Calculator -> snapshot (frames + readout)
  -> window pixel click on AC -> readout 0
  -> window pixel click on "7" -> readout 7
  -> zoom the 7/8 row -> from_zoom click on "8" -> readout 78
     (NO snapshot between zoom and the from_zoom click — a snapshot
     replaces the zoom context by design)
  -> desktop pixel click on "9" (capture_id bound) -> readout 789
  -> desktop drag of the title bar (+70,+50) -> window moved
  -> drag it back -> window home again

Usage: python3 smoke_m4.py [path-to-can-helper]
"""

import json
import subprocess
import sys
import time

HELPER = sys.argv[1] if len(sys.argv) > 1 else "./can-helper"

proc = subprocess.Popen([HELPER, "mcp"], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, text=True)
_seq = 0
failures = []


def call(method, params=None, is_notification=False):
    global _seq
    msg = {"jsonrpc": "2.0", "method": method}
    if not is_notification:
        _seq += 1
        msg["id"] = _seq
    msg["params"] = params or {}
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    if is_notification:
        return None
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("helper closed stdout unexpectedly")
    return json.loads(line)


def tool(name, args):
    result = (call("tools/call", {"name": name, "arguments": args}).get("result") or {})
    if result.get("isError"):
        text = ""
        for part in result.get("content") or []:
            if part.get("type") == "text":
                text = part.get("text", "")
                break
        raise RuntimeError(f"tool {name} returned error: {text[:400]}")
    return result


def sc_of(result):
    return result.get("structuredContent") or {}


def check(label, ok, detail=""):
    print(f"[{'ok' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def calc_window():
    wins = sc_of(tool("list_windows", {})).get("windows") or []
    calc = [w for w in wins if "Calculator" in str(w.get("app_name", ""))
            or "计算器" in str(w.get("app_name", ""))]
    calc.sort(key=lambda w: 0 if w.get("is_on_screen") else 1)
    return calc[0] if calc else None


def snapshot(pid, wid):
    r = tool("get_window_state", {"pid": pid, "window_id": wid,
                                  "tree_format": "both", "include_screenshot": True})
    elements = sc_of(r).get("elements") or []
    tree = ""
    for part in r.get("content") or []:
        if part.get("type") == "text":
            tree = part.get("text", "")
            break
    readout = None
    for line in tree.splitlines():
        if "编辑字段" in line and "=" in line:
            readout = line.rsplit("=", 1)[1].strip()
    return elements, readout, sc_of(r)


def by_label(elements, *labels):
    for lab in labels:
        for e in elements:
            if e.get("label") == lab:
                return e
    return None


def center(frame):
    return (frame["x"] + frame["width"] / 2, frame["y"] + frame["height"] / 2)


try:
    resp = call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "smoke-m4", "version": "0"}})
    info = (resp.get("result") or {}).get("serverInfo") or {}
    check("initialize", info.get("name") == "can-helper", json.dumps(info))
    call("notifications/initialized", is_notification=True)
    tool("start_session", {"session": "smoke"})

    tool("launch_app", {"bundle_id": "com.apple.Calculator"})
    time.sleep(0.6)
    win = calc_window()
    check("calculator window", win is not None)
    if win is None:
        raise SystemExit(1)
    pid, wid = win["pid"], win["window_id"]
    bounds = win.get("bounds") or {}
    print(f"    calculator: pid={pid} window_id={wid} bounds={bounds}")

    elements, readout, sc = snapshot(pid, wid)
    print(f"    shot {sc.get('screenshot_width')}x{sc.get('screenshot_height')}, "
          f"readout before: {readout!r}")
    ac = by_label(elements, "全部清除", "清除", "AC")
    b7 = by_label(elements, "7")
    b8 = by_label(elements, "8")
    b9 = by_label(elements, "9")
    check("frames present", all(e is not None and e.get("frame") for e in (ac, b7, b8, b9)),
          "AC/7/8/9 buttons with frames")
    if not all((ac, b7, b8, b9)):
        raise SystemExit(1)

    # Window-space pixel clicks: AC, then 7.
    cx, cy = center(ac["frame"])
    tool("click", {"pid": pid, "window_id": wid, "x": cx, "y": cy})
    _, readout, _ = snapshot(pid, wid)
    check("pixel AC", readout in ("0", "0."), f"readout={readout!r}")

    cx, cy = center(b7["frame"])
    tool("click", {"pid": pid, "window_id": wid, "x": cx, "y": cy})
    _, readout, _ = snapshot(pid, wid)
    check("pixel click 7", readout == "7", f"readout={readout!r}")

    # Zoom the row holding 7 and 8, then click 8 in crop coordinates.
    f7, f8 = b7["frame"], b8["frame"]
    x1 = min(f7["x"], f8["x"]) - 6
    y1 = f7["y"] - 6
    x2 = max(f7["x"] + f7["width"], f8["x"] + f8["width"]) + 6
    y2 = f7["y"] + f7["height"] + 6
    zr = tool("zoom", {"pid": pid, "window_id": wid,
                       "x1": x1, "y1": y1, "x2": x2, "y2": y2})
    zsc = sc_of(zr)
    cw, ch = zsc.get("screenshot_width") or 0, zsc.get("screenshot_height") or 0
    check("zoom image", cw > 0 and ch > 0 and cw <= 500, f"crop {cw}x{ch}")
    c8x, c8y = center(f8)
    zx = (c8x - x1) * cw / (x2 - x1)
    zy = (c8y - y1) * ch / (y2 - y1)
    tool("click", {"pid": pid, "window_id": wid, "x": zx, "y": zy, "from_zoom": True})
    _, readout, _ = snapshot(pid, wid)
    check("from_zoom click 8", readout == "78", f"readout={readout!r}")

    # Desktop-space pixel click on 9, bound to a fresh capture.
    dr = tool("get_desktop_state", {})
    dsc = sc_of(dr)
    cap_id = dsc.get("capture_id")
    sx = bounds["x"] + center(b9["frame"])[0]
    sy = bounds["y"] + center(b9["frame"])[1]
    tool("click", {"scope": "desktop", "x": sx, "y": sy, "capture_id": cap_id})
    _, readout, _ = snapshot(pid, wid)
    check("desktop click 9", readout == "789", f"readout={readout!r}")

    # Desktop drag: move the window by its title bar, then back.
    tx = bounds["x"] + bounds["width"] / 2
    ty = bounds["y"] + 11
    tool("drag", {"scope": "desktop", "from_x": tx, "from_y": ty,
                  "to_x": tx + 70, "to_y": ty + 50, "duration_ms": 700})
    time.sleep(0.4)
    moved = calc_window()
    mb = (moved or {}).get("bounds") or {}
    dx = mb.get("x", 0) - bounds["x"]
    dy = mb.get("y", 0) - bounds["y"]
    check("drag moved window", abs(dx - 70) <= 10 and abs(dy - 50) <= 10,
          f"delta=({dx:.0f},{dy:.0f})")
    tool("drag", {"scope": "desktop", "from_x": tx + 70, "from_y": ty + 50,
                  "to_x": tx, "to_y": ty, "duration_ms": 700})
    time.sleep(0.4)
    home = calc_window()
    hb = (home or {}).get("bounds") or {}
    check("drag back home", abs(hb.get("x", 0) - bounds["x"]) <= 10
          and abs(hb.get("y", 0) - bounds["y"]) <= 10,
          f"home=({hb.get('x')},{hb.get('y')}) vs ({bounds['x']},{bounds['y']})")
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print("VERDICT: " + ("PASS" if not failures else f"FAIL ({', '.join(failures)})"))
sys.exit(0 if not failures else 1)

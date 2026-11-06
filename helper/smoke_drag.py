#!/usr/bin/env python3
"""Drag probe for can-helper: which windows/points actually drag?

Tries, in order:
  A. Calculator title, center (x + w/2, y + 11)   [the smoke_m4 point]
  B. Calculator title, right of the traffic lights (x + 110, y + 11)
  C. Calculator left edge strip (x + 4, y + 200)
  D. TextEdit document window title, center

Each: record bounds -> desktop drag (+60,+40) -> record bounds ->
drag back if it moved. Prints deltas; no verdict, just the table.

Usage: python3 smoke_drag.py [path-to-can-helper]
"""

import json
import subprocess
import sys
import time

HELPER = sys.argv[1] if len(sys.argv) > 1 else "./can-helper"

proc = subprocess.Popen([HELPER, "mcp"], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, text=True)
_seq = 0


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
    return json.loads(proc.stdout.readline())


def tool(name, args):
    result = (call("tools/call", {"name": name, "arguments": args}).get("result") or {})
    if result.get("isError"):
        text = ""
        for part in result.get("content") or []:
            if part.get("type") == "text":
                text = part.get("text", "")
                break
        raise RuntimeError(f"tool {name} returned error: {text[:300]}")
    return result


def sc_of(result):
    return result.get("structuredContent") or {}


def find_window(*names):
    wins = sc_of(tool("list_windows", {})).get("windows") or []
    hits = [w for w in wins if any(n in str(w.get("app_name", "")) for n in names)]
    hits.sort(key=lambda w: 0 if w.get("is_on_screen") else 1)
    return hits[0] if hits else None


def drag_test(label, win, gx, gy):
    before = win.get("bounds") or {}
    tool("drag", {"scope": "desktop", "from_x": gx, "from_y": gy,
                  "to_x": gx + 60, "to_y": gy + 40, "duration_ms": 800})
    time.sleep(0.5)
    after_w = find_window(win.get("app_name", ""))
    after = (after_w or {}).get("bounds") or {}
    dx = after.get("x", 0) - before.get("x", 0)
    dy = after.get("y", 0) - before.get("y", 0)
    print(f"{label}: grab=({gx:.0f},{gy:.0f}) delta=({dx:.0f},{dy:.0f})")
    if abs(dx) > 3 or abs(dy) > 3:
        tool("drag", {"scope": "desktop", "from_x": gx + 60, "from_y": gy + 40,
                      "to_x": gx, "to_y": gy, "duration_ms": 800})
        time.sleep(0.5)
    return dx, dy


try:
    call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                        "clientInfo": {"name": "smoke-drag", "version": "0"}})
    call("notifications/initialized", is_notification=True)
    tool("start_session", {"session": "smoke"})
    tool("launch_app", {"bundle_id": "com.apple.Calculator"})
    time.sleep(0.6)

    calc = find_window("Calculator", "计算器")
    if calc:
        b = calc["bounds"]
        drag_test("A calc title center", calc, b["x"] + b["width"] / 2, b["y"] + 11)
        calc = find_window("Calculator", "计算器")
        b = calc["bounds"]
        drag_test("B calc title +110", calc, b["x"] + 110, b["y"] + 11)
        calc = find_window("Calculator", "计算器")
        b = calc["bounds"]
        drag_test("C calc left edge", calc, b["x"] + 4, b["y"] + 200)
    else:
        print("no Calculator window")

    tool("launch_app", {"bundle_id": "com.apple.TextEdit"})
    time.sleep(0.8)
    edit = find_window("TextEdit", "文本编辑")
    if edit:
        b = edit["bounds"]
        drag_test("D textedit title center", edit, b["x"] + b["width"] / 2, b["y"] + 12)
    else:
        print("no TextEdit window")
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

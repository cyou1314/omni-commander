#!/usr/bin/env python3
"""Milestone-3 smoke driver for can-helper.

Story, against TextEdit:
  initialize -> start_session -> launch_app (bundle id, dodges the
  localized name) -> list_windows -> get_window_state
  -> type_text into the text area -> state (text must be there)
  -> set_value a different text -> state (value must have changed)
  -> set_value "" -> press_key "x" with the element token -> state
     (value must be "x": proves focus + key delivery)
  -> get_desktop_state with max_image_dimension=1600 (image block,
     dims within the cap, capture_id and screen size reported)

Usage: python3 smoke_m3.py [path-to-can-helper]
"""

import json
import subprocess
import sys

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


def text_area_state(pid, wid):
    r = tool("get_window_state", {"pid": pid, "window_id": wid,
                                  "tree_format": "both", "include_screenshot": False})
    elements = sc_of(r).get("elements") or []
    area = next((e for e in elements if e.get("role") == "AXTextArea"), None)
    return area, elements


try:
    resp = call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "smoke-m3", "version": "0"}})
    info = (resp.get("result") or {}).get("serverInfo") or {}
    check("initialize", info.get("name") == "can-helper", json.dumps(info))
    call("notifications/initialized", is_notification=True)
    tool("start_session", {"session": "smoke"})

    tool("launch_app", {"bundle_id": "com.apple.TextEdit"})
    check("launch_app TextEdit", True)

    wins = sc_of(tool("list_windows", {})).get("windows") or []
    edit = [w for w in wins if "TextEdit" in str(w.get("app_name", ""))
            or "文本编辑" in str(w.get("app_name", ""))]
    check("list_windows finds TextEdit", len(edit) > 0, f"{len(wins)} windows total")
    if not edit:
        raise SystemExit(1)
    win = next((w for w in edit if w.get("is_on_screen")), edit[0])
    pid, wid = win["pid"], win["window_id"]
    print(f"    textedit window: pid={pid} window_id={wid} app={win.get('app_name')}")

    area, elements = text_area_state(pid, wid)
    check("text area found", area is not None, f"{len(elements)} elements")
    if area is None:
        raise SystemExit(1)

    tool("type_text", {"pid": pid, "window_id": wid,
                       "element_token": area["element_token"], "text": "can m3 type"})
    area2, _ = text_area_state(pid, wid)
    val2 = (area2 or {}).get("value", "")
    check("type_text landed", "can m3 type" in val2, f"value={val2[:60]!r}")

    tool("set_value", {"pid": pid, "window_id": wid,
                       "element_token": area2["element_token"], "value": "can m3 set"})
    area3, _ = text_area_state(pid, wid)
    val3 = (area3 or {}).get("value", "")
    check("set_value landed", val3 == "can m3 set", f"value={val3[:60]!r}")

    tool("set_value", {"pid": pid, "window_id": wid,
                       "element_token": area3["element_token"], "value": ""})
    area4, _ = text_area_state(pid, wid)
    tool("press_key", {"pid": pid, "window_id": wid,
                       "element_token": area4["element_token"], "key": "x"})
    area5, _ = text_area_state(pid, wid)
    val5 = (area5 or {}).get("value", "")
    check("press_key landed", val5 == "x", f"value={val5[:60]!r}")

    r = tool("get_desktop_state", {"max_image_dimension": 1600})
    sc = sc_of(r)
    has_image = any(p.get("type") == "image" for p in (r.get("content") or []))
    check("desktop image", has_image,
          f"{sc.get('screenshot_width')}x{sc.get('screenshot_height')} "
          f"screen={sc.get('screen_width')}x{sc.get('screen_height')} "
          f"capture_id={sc.get('capture_id')}")
    long_side = max(sc.get("screenshot_width") or 0, sc.get("screenshot_height") or 0)
    check("desktop downscale respected", 0 < long_side <= 1600, f"long side {long_side}")
    check("capture_id present", bool(sc.get("capture_id")))
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print("VERDICT: " + ("PASS" if not failures else f"FAIL ({', '.join(failures)})"))
sys.exit(0 if not failures else 1)

#!/usr/bin/env python3
"""Milestone-3 smoke driver for can-helper.

Story, against TextEdit:
  initialize -> start_session -> launch_app (bundle id, dodges the
  localized name) -> find a document window (if TextEdit shows its
  start picker, click its New Document button first)
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


def snapshot(pid, wid):
    r = tool("get_window_state", {"pid": pid, "window_id": wid,
                                  "tree_format": "both", "include_screenshot": False})
    return sc_of(r).get("elements") or []


def textedit_windows():
    wins = sc_of(tool("list_windows", {})).get("windows") or []
    edit = [w for w in wins if "TextEdit" in str(w.get("app_name", ""))
            or "文本编辑" in str(w.get("app_name", ""))]
    edit.sort(key=lambda w: 0 if w.get("is_on_screen") else 1)
    return edit, len(wins)


def find_text_area():
    """Return (pid, wid, area_element) for a TextEdit document window,
    clicking the start picker's New Document button if needed."""
    for attempt in range(3):
        edit, total = textedit_windows()
        if attempt == 0:
            print(f"    {total} windows total, {len(edit)} TextEdit")
        for w in edit:
            elements = snapshot(w["pid"], w["window_id"])
            area = next((e for e in elements if e.get("role") == "AXTextArea"), None)
            if area is not None:
                return w["pid"], w["window_id"], area, elements
            if attempt == 0 and w is edit[0]:
                roles = sorted({e.get("role", "?") for e in elements})
                print(f"    window {w['window_id']} roles: {roles}")
            new_btn = next((e for e in elements
                            if e.get("role") == "AXButton"
                            and ("新建" in str(e.get("label", ""))
                                 or "New" in str(e.get("label", "")))), None)
            if new_btn is not None:
                print(f"    clicking new-document button {new_btn.get('label')!r}")
                tool("click", {"pid": w["pid"], "window_id": w["window_id"],
                               "element_token": new_btn["element_token"],
                               "action": "press"})
                time.sleep(1.2)
                break  # re-list windows and retry
    return None, None, None, []


try:
    resp = call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "smoke-m3", "version": "0"}})
    info = (resp.get("result") or {}).get("serverInfo") or {}
    check("initialize", info.get("name") == "can-helper", json.dumps(info))
    call("notifications/initialized", is_notification=True)
    tool("start_session", {"session": "smoke"})

    tool("launch_app", {"bundle_id": "com.apple.TextEdit"})
    check("launch_app TextEdit", True)
    time.sleep(0.8)

    pid, wid, area, elements = find_text_area()
    check("text area found", area is not None,
          f"{len(elements)} elements in last snapshot")
    if area is None:
        raise SystemExit(1)
    print(f"    textedit window: pid={pid} window_id={wid}")

    # Normalize first: the found document may be a leftover from an
    # earlier run with content in it.
    tool("set_value", {"pid": pid, "window_id": wid,
                       "element_token": area["element_token"], "value": ""})
    area = next((e for e in snapshot(pid, wid) if e.get("role") == "AXTextArea"), area)

    tool("type_text", {"pid": pid, "window_id": wid,
                       "element_token": area["element_token"], "text": "can m3 type"})
    area2 = next((e for e in snapshot(pid, wid) if e.get("role") == "AXTextArea"), None)
    val2 = (area2 or {}).get("value", "")
    if "can m3 type" not in val2:
        time.sleep(0.8)  # key delivery can lag; re-read once before failing
        area2 = next((e for e in snapshot(pid, wid) if e.get("role") == "AXTextArea"), None)
        val2 = (area2 or {}).get("value", "")
    check("type_text landed", "can m3 type" in val2, f"value={val2[:60]!r}")

    tool("set_value", {"pid": pid, "window_id": wid,
                       "element_token": area2["element_token"], "value": "can m3 set"})
    area3 = next((e for e in snapshot(pid, wid) if e.get("role") == "AXTextArea"), None)
    val3 = (area3 or {}).get("value", "")
    check("set_value landed", val3 == "can m3 set", f"value={val3[:60]!r}")

    tool("set_value", {"pid": pid, "window_id": wid,
                       "element_token": area3["element_token"], "value": ""})
    area4 = next((e for e in snapshot(pid, wid) if e.get("role") == "AXTextArea"), None)
    tool("press_key", {"pid": pid, "window_id": wid,
                       "element_token": area4["element_token"], "key": "x"})
    area5 = next((e for e in snapshot(pid, wid) if e.get("role") == "AXTextArea"), None)
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

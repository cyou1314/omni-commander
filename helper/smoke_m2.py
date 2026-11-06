#!/usr/bin/env python3
"""Milestone-2 smoke driver for can-helper.

Speaks the agent's JSON-RPC dialect to the helper over stdio and walks the
whole M2 story against the Calculator:
  initialize -> start_session -> launch_app -> list_windows
  -> get_window_state -> click the "7" button by token
  -> get_window_state again (readout must show 7)
  -> get_window_state with screenshot (report whether an image came back)

Usage: python3 smoke_m2.py [path-to-can-helper]
Prints a transcript and a final VERDICT line. Exit 0 iff all checks pass
(screenshot capture is reported but not required: it needs the Screen
Recording permission, which is granted separately).
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
    resp = call("tools/call", {"name": name, "arguments": args})
    result = resp.get("result") or {}
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


def text_of(result):
    for part in result.get("content") or []:
        if part.get("type") == "text":
            return part.get("text", "")
    return ""


def check(label, ok, detail=""):
    print(f"[{'ok' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


try:
    resp = call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "smoke-m2", "version": "0"}})
    info = (resp.get("result") or {}).get("serverInfo") or {}
    check("initialize", info.get("name") == "can-helper", json.dumps(info))
    call("notifications/initialized", is_notification=True)

    tool("start_session", {"session": "smoke"})
    check("start_session", True)

    r = tool("launch_app", {"app_name": "Calculator"})
    launched = {}
    try:
        launched = json.loads(text_of(r))
    except Exception:
        pass
    check("launch_app Calculator", bool(launched.get("launched")),
          f"windows reported: {len(launched.get('windows') or [])}")

    r = tool("list_windows", {})
    wins = sc_of(r).get("windows") or []
    calc = [w for w in wins if "计算器" in str(w.get("app_name", ""))
            or "Calculator" in str(w.get("app_name", ""))]
    check("list_windows finds Calculator", len(calc) > 0, f"{len(wins)} windows total")
    if not calc:
        raise SystemExit(1)
    win = next((w for w in calc if w.get("is_on_screen")), calc[0])
    pid, wid = win["pid"], win["window_id"]
    print(f"    calculator window: pid={pid} window_id={wid} app={win.get('app_name')}")

    r = tool("get_window_state", {"pid": pid, "window_id": wid,
                                  "tree_format": "both", "include_screenshot": False})
    sc = sc_of(r)
    elements = sc.get("elements") or []
    check("get_window_state elements", len(elements) >= 20,
          f"{len(elements)} elements, truncated={sc.get('truncated')}")
    tree = text_of(r)
    statics = [ln.strip() for ln in tree.splitlines() if "AXStaticText" in ln]
    print(f"    tree lines: {len(tree.splitlines())}, AXStaticText lines: {len(statics)}")
    for ln in statics[:4]:
        print(f"    tree: {ln[:120]}")

    seven = next((e for e in elements if e.get("label") == "7"), None)
    check('button "7" present', seven is not None,
          f"token={seven.get('element_token') if seven else '-'}")
    if seven:
        tool("click", {"pid": pid, "window_id": wid,
                       "element_token": seven["element_token"], "action": "press"})
        check("click by token", True)
        r2 = tool("get_window_state", {"pid": pid, "window_id": wid,
                                       "tree_format": "both", "include_screenshot": False})
        tree2 = text_of(r2)
        statics2 = [ln.strip() for ln in tree2.splitlines() if "AXStaticText" in ln]
        for ln in statics2[:4]:
            print(f"    tree after click: {ln[:120]}")
        readout7 = any(("= 7" in ln) or ('"7"' in ln) for ln in statics2)
        check("readout shows 7 after click", readout7)

    r3 = tool("get_window_state", {"pid": pid, "window_id": wid,
                                   "tree_format": "markdown", "include_screenshot": True})
    sc3 = sc_of(r3)
    has_image = any(p.get("type") == "image" for p in (r3.get("content") or []))
    print(f"    screenshot: image_block={has_image} "
          f"w={sc3.get('screenshot_width')} h={sc3.get('screenshot_height')} "
          f"error={sc3.get('screenshot_error', '-')}")
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print("VERDICT: " + ("PASS" if not failures else f"FAIL ({', '.join(failures)})"))
sys.exit(0 if not failures else 1)

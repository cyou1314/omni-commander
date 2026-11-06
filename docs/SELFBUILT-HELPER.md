# Self-built desktop helper (replacing Cua Driver)

> **Current state:** all five milestones below are done, and the closing
> section — "Integration: Can.app bundle identity + helper 0.5.1" — describes
> how the system runs today (it supersedes the TCC notes in milestone 5:
> grants now belong to the Can.app bundle, not to `node`). Cua Driver was
> uninstalled from the owner's Mac on 2026-11-06; there is no Cua fallback
> anymore. Read the milestones as the build log, the last section as fact.

Goal: replace the internal Cua Driver engine with our own helper binary, so
the desktop layer is Can's own code end to end. The agent keeps spawning it
exactly the same way (`<helper> mcp`, stdio JSON-RPC); only `cuaPath`
changes. Product surface stays 100% Can.

## The contract is only 11 verbs

Measured from `agent/agent.js` — this is everything the agent ever calls:

| Verb | Used for | macOS implementation |
| --- | --- | --- |
| `start_session` | handshake / liveness | no-op returning `{}` (helper is the agent's child process, same lifetime; no daemon session registry) |
| `list_windows` | window discovery | `CGWindowListCopyWindowInfo` |
| `launch_app` | open / resolve an app | `NSWorkspace` |
| `get_window_state` | structural snapshot: elements + tokens, markdown tree text, window screenshot + capture dims | AX tree walk (`AXUIElement`), screenshot via ScreenCaptureKit |
| `click` | by `element_token` (AX press), or pixel x/y (window / desktop scope), or `from_zoom` | `AXUIElementPerformAction(kAXPressAction)` / `CGEvent` posted to the pid |
| `type_text` | text into an element | AX value set, else `CGEvent` keyboard posts to the pid |
| `set_value` | direct value write (fallback) | `AXUIElementSetAttributeValue(kAXValueAttribute)` |
| `press_key` | key strokes | `CGEvent` posted to the pid |
| `get_desktop_state` | full-screen screenshot + dims + `capture_id` | ScreenCaptureKit / `CGDisplayCreateImage` |
| `zoom` | crop of a window region (≤500px wide) for precise pixel work | crop of the window capture (ImageIO) |
| `drag` | press-drag-release in screenshot pixels | `CGEvent` mouse-dragged sequence to the pid |

Semantics the agent relies on (must be preserved):

- Snapshot tokens are `<snapshot_id>:<index>`; a newer snapshot of the same
  window supersedes older tokens (stale token → explicit error).
- The markdown tree text carries values some apps expose nowhere else
  (e.g. the Calculator readout as an `AXStaticText` value).
- Pixel coordinates are in the corresponding capture's pixel space
  (window shot for window scope, desktop shot for desktop scope); a click
  may carry the `capture_id` of the shot it was read from.
- After `zoom`, `from_zoom` clicks translate crop pixels back to window
  space; any newer snapshot replaces the zoom context.
- Errors must be honest: no window, stale token, missing permission →
  a clear error, never a silent no-op.

## Implementation notes

- Language: Swift, single binary, no runtime dependencies
  (ApplicationServices, CoreGraphics, ScreenCaptureKit, ImageIO).
  Built on the owner's Mac with the Xcode Command Line Tools.
- Permissions: the helper needs its own Accessibility + Screen Recording
  grants (TCC is per-binary). Rebuilds can invalidate the grant (ad-hoc
  signature / cdhash changes) — sign with a stable self-signed identity
  if re-granting becomes a nuisance.
- The agent's session-recovery logic (unique session label, re-start on
  "session has ended") stays harmless: the helper accepts the `session`
  argument and ignores it.

## Milestones

1. ✅ Skeleton: stdio JSON-RPC, `initialize`, `start_session`, `list_windows`,
   `launch_app`. (Verified on the owner's Mac 2026-11-06: swiftc 6.4,
   handshake + 30 windows returned.)
2. ✅ `get_window_state` (elements + tokens + tree text + screenshot) and
   token `click`. (Verified on the owner's Mac 2026-11-06 with
   `helper/smoke_m2.py`: Calculator snapshot returned 29 elements and the
   readout in the tree text; clicking the "7" button by token changed the
   readout to 7; the ScreenCaptureKit window shot came back inline.
   Note: screenshots use ScreenCaptureKit — `CGWindowListCreateImage`
   is unavailable in current SDKs.)
3. ✅ `type_text` / `set_value` / `press_key`, `get_desktop_state`.
   (Verified on the owner's Mac 2026-11-06, helper 0.3.1, `smoke_m3.py`:
   typed text, direct value write and a bare-character key all landed in
   TextEdit; full-screen capture returned 1512×982 pt with the true
   3024×1964 screen size and a capture_id. Two focus lessons baked in:
   focus the element's window (main+focused) before posting keys, and
   give the window a beat to become key — events posted to a pid are
   routed to whichever window is key at delivery time.)
4. ✅ Pixel `click` / `drag` / `zoom` (+ `from_zoom`).
   (Verified on the owner's Mac 2026-11-06, helper 0.4.1, `smoke_m4.py`:
   the full pixel loop — AC → 7 → zoom → from_zoom 8 → 78 → desktop 9
   → 789 — plus a title-bar drag forth and back. Two delivery lessons
   baked in: mouse events must go to the HID tap (pid-posted mouse is
   ignored by many apps; keyboard is the opposite), and the macOS 27
   Calculator window exposes no drag region, so the drag check uses a
   standard title bar — the mechanism is the same.)
5. ✅ Swap-in acceptance: point the agent's `cuaPath` at the helper and run
   the full battery — calculator structural (42 / 60), batch, pixel
   (7 → zoom → 8 = 78), Notes read — with Cua still installed as the
   fallback (swap back by config only).
   (Verified on the owner's Mac 2026-11-06, helper 0.4.3 deployed as
   `/Users/cyou/can-agent/Can`: open_app by English and Chinese names,
   snapshot with readout, batch 6×7=42 re-read from a fresh snapshot,
   full-screen ScreenCaptureKit shot, window shot 230×408 → pixel click
   7 → zoom crop → from_zoom click 8 → readout 78, Notes listing read
   back (8 notes). One TCC lesson, learned the hard way: under the
   launchd agent the helper's *effective* TCC identity is its
   responsible process — the agent's `node` runtime — so the
   Accessibility and Screen Recording grants must be ON for `node` in
   System Settings; an entry for the helper binary itself (added via
   the file picker as "Can") does not take effect for the agent chain.
   Grants only bind after the agent restarts. The helper asks politely
   itself since 0.4.3 (`AXIsProcessTrustedWithOptions` prompt +
   `CGRequestScreenCaptureAccess`, plus a `Can authorize` CLI mode),
   which is what registered `node` in both lists. The product-grade
   fix — bundle agent + helper into Can.app so the responsible process
   *is* "Can" — is a later step; today's wiring depends on the `node`
   toggles staying on.)

Windows parity is a separate later step (UIA); the macOS helper ships
first because that is the machine Can runs on today.

## Integration: Can.app bundle identity + helper 0.5.1 (2026-11-06)

launchd no longer starts node directly. `com.can.agent` runs the
supervisor inside `~/Applications/Can.app` (`app/supervisor.swift`: it
spawns node on agent.js, restarts it after crashes, forwards SIGTERM);
the supervisor is the process at the root of the agent chain, so TCC
attributes the whole chain to the bundle `com.can.agent`. The bundle
holds only the supervisor, the icon and Info.plist — its content is
frozen, so its ad-hoc CDHash (`32c636d70955f2972c6c4ead87d040384fa04903`)
never changes when agent.js or the helper binary are updated, and the
grants survive updates. agent.js and the helper binary stay in
`~/can-agent` (the agent's state lives next to them; the signed bundle
is not writable state storage). node remains an external runtime.

Grants (both obtained 2026-11-06, verified by a full battery through
the live agent: snapshot, window + fullscreen captures, ref clicks,
batch 7×6=42, ego batch):

- Accessibility: the helper's own prompt registered "Can" (bundle) in
  the list; the owner flipped it on.
- Screen Recording: `CGRequestScreenCaptureAccess` did NOT register a
  list entry under the bundle identity in practice (AX registration
  worked, screen did not). The entry was added with the Settings
  picker's "+" button pointing at Can.app itself; picker-added screen
  entries start enabled. Helper 0.5.1 still calls
  `ensureScreenAccess()` before captures (preflight + prompt once per
  process) so the request is always made; on this OS the picker add is
  the reliable path.
- Cleanup: the stale Accessibility entry for the bare helper FILE was
  removed from the list (the two "Can" rows are distinguishable by
  icon: generic EXEC icon = file entry, Can icon = bundle). node keeps
  its own entries (shared with other tools). Pre-switch bundle backups
  were moved to the Trash.

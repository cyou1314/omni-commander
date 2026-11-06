# can-helper

Can's own desktop engine for macOS — the self-built replacement for the
internal Cua Driver. Design and milestones: `docs/SELFBUILT-HELPER.md`.

The Can agent spawns it exactly like the current driver:

```
<path-to-can-helper> mcp
```

and speaks newline-delimited JSON-RPC (`initialize`, then `tools/call`).
To try it, point `cuaPath` in the agent's `config.json` at the built
binary and restart the agent. Point it back to swap back — the old driver
stays installed as the fallback until the swap-in acceptance passes.

## Build (on the Mac)

```sh
./build.sh   # swiftc -O main.swift -o can-helper
```

Requires the Xcode Command Line Tools (`xcode-select --install`).

## Permissions

The helper needs its own grants in System Settings → Privacy & Security:

- **Accessibility** — reading the AX tree and pressing elements (milestone 2+)
- **Screen Recording** — window titles and screenshots

Rebuilds can drop the grant (the binary's code identity changes); if a
freshly built helper suddenly sees no titles, re-toggle its entry there.

## Status

Milestone 1 (verified on the owner's Mac, 2026-11-06): `initialize`,
`start_session`, `list_windows`, `launch_app`.
Milestone 2: `get_window_state` (elements + tokens + tree text + optional
window screenshot) and `click` by element token.
Later verbs answer with an explicit "not implemented yet" error.

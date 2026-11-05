# Can on Windows

The Can agent is a single cross-platform `agent/agent.js` (Node, built-ins
only). The same file runs on macOS and Windows; the OS-specific pieces are
branched internally:

| Piece | macOS | Windows |
| --- | --- | --- |
| Shell for `can_run_command` | zsh | cmd.exe (+ its own blocked-pattern list) |
| Screenshot PNG→JPEG | `sips` | PowerShell + System.Drawing |
| Owner-confirmation dialog | AppleScript dialog | PowerShell WinForms dialog (same fail-closed timeout) |
| Keep-alive | launchd `com.can.agent` | Scheduled Task "Can Agent" (logon trigger, restart on failure) |
| Desktop engine | Cua Driver (`cua-driver mcp`) | Cua Driver (`cua-driver mcp`, UIA) |
| Daily browser (ego) | ego lite via ego-browser CLI | **not available yet** (ego for Windows is beta) — the tools report this honestly |
| Sandbox browser | Google Chrome via CDP | Google Chrome via CDP (standard install paths) |

## Install

Prerequisites: Node.js LTS, Cua Driver for Windows (on PATH, or set
`cuaPath` in the config to its full path).

```powershell
# from the folder containing agent.js
powershell -ExecutionPolicy Bypass -File install-windows.ps1
```

The installer copies the agent to `%USERPROFILE%\can-agent`, creates the
work folder `%USERPROFILE%\can-work`, asks for the agent key once, writes
`config.json` (see `config.example.windows.json`), and registers the
scheduled task. Check `%USERPROFILE%\can-agent\status.json` for
`"state": "connected"`.

## Boundaries

- **One agent at a time.** The gateway relays jobs to a single connected
  agent; running the Mac and Windows agents simultaneously is not routed
  per machine yet. Stop one before starting the other.
- The fence defaults in the example config mirror the owner's current
  Mac setup (all confirmations off; the catastrophic-pattern hard blocks
  and the full audit log are always on). Set the `fence` switches to
  `true` to require an on-screen confirmation for sensitive tools.
- File tools stay confined to the work folder, exactly as on macOS.

> **注（2026-11-06）**：本文写于 agent 刚站起来的 Step 2 阶段，下面的安装一节
> 是最初的简版装法（launchd 直接拉 Node）。现行装法让 launchd 拉起 **Can.app
> 里的守护进程**（`app/supervisor.swift`），再由守护进程拉起 Node——这样 macOS
> 的两项隐私权限都记在「Can」名下。**安装与权限步骤以
> [../docs/TUTORIAL.md](../docs/TUTORIAL.md) 第 2 步为准**；工具早已不止文中
> 两个（现有 33 个，见教程附录 A）。

# Can agent (Mac)

The local half of Can (omni-commander V2, Step 2): a zero-dependency
Node script that lives on the owner's Mac, dials **out** to the Can
gateway (no inbound ports), and executes the tool jobs the gateway
relays from ChatGPT web.

- Heartbeat every 20s; long-poll `/agent/poll` (25s) with the shared
  agent key (`X-Agent-Key`); results posted to `/agent/result`.
- Step-2 tools only: `can_status` (this computer's name, macOS
  version, agent uptime) and `can_write_note` (appends a line to
  `write-log.txt` beside the agent). Real capabilities arrive in
  Step 3, one layer at a time, behind the agent's own guardrails.
- Local state beside the script: `agent.log`, `status.json`
  (connection state), `write-log.txt`.

## Install (macOS)

```sh
mkdir -p ~/can-agent
cp agent.js com.can.agent.plist ~/can-agent/
cp config.example.json ~/can-agent/config.json   # fill in gateway + key
chmod 600 ~/can-agent/config.json
cp com.can.agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.can.agent.plist
```

The plist runs `/Users/cyou/node/bin/node` — adjust the node path and
`WorkingDirectory` to your machine. `KeepAlive` + `RunAtLoad` keep the
agent resident across crashes and reboots.

## Can.app shell

`~/Applications/Can.app` carries the product name and icon: its
`Contents/MacOS/Can` launcher starts the agent only if it is not
already running and stamps `app-opened.txt`. The icon (`Can.icns`) is
built from the gateway's `/icon.png` with `sips` + `iconutil`.

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

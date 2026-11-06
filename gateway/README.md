> **注（2026-11-06）**：本文写于网关刚起步的 Step 1 阶段，当时只有
> `can_status` / `can_write_note` 两个工具。现行网关是同一份 `gateway.py`，
> 已长到 33 个工具；部署与使用以 [../docs/TUTORIAL.md](../docs/TUTORIAL.md) 为准。
> 下面关于 `.env` 变量、端点与运行时文件的说明仍然准确。

# Can gateway

The cloud half of Can (omni-commander V2): a remote MCP server with
OAuth 2.1 that ChatGPT web connects to as a custom connector. It
authenticates the owner and relays tool calls to the local agent on
the owner's computer (Step 2): the agent dials out to
`/agent/heartbeat` and long-polls `/agent/poll` with a shared agent
key, executes jobs locally, and posts results to `/agent/result`.
Tools: `can_status` (read) and `can_write_note` (write), both executed
by the agent on the computer. If the agent has not checked in within
`CAN_AGENT_TTL` seconds (default 45), tools answer `agent_offline`
truthfully — the gateway never fakes a local execution.

## Run

```sh
python3 -m venv .venv && ./.venv/bin/pip install "mcp<2"
# .env (chmod 600) must define:
#   CAN_PUBLIC_URL          public https base URL, no trailing slash
#   CAN_OWNER_CODE          code the owner types on the consent page
#   CAN_STATIC_CLIENT_ID    optional pre-registered client id
#   CAN_STATIC_CLIENT_SECRET  optional, for connectors without DCR
#   CAN_AGENT_KEY           shared key the local agent presents
#   CAN_AGENT_TTL           agent liveness window, seconds (default 45)
#   CAN_PORT                listen port (default 8792)
systemd: can-gateway.service (EnvironmentFile=.env)
```

Endpoints: `/` branded landing page, `/can/consent` branded consent
page, `/authorize` `/token` `/register` `/revoke` OAuth 2.1 (dynamic
client registration supported, PKCE S256, refresh-token rotation,
`offline_access` advertised), `/mcp` Streamable HTTP, bearer required.

## Files at runtime (never commit)

- `.env` — secrets. `state.json` — registered clients and live tokens
  (mode 0600). `traffic.log`, `tool-calls.log`, `write-log.txt` —
  acceptance ground truth.
- `assets/icon.png`, `assets/icon-256.png` — the product icon.

## Security notes

- Single user: the owner. The consent page is gated by the owner code;
  wrong code is rejected before any authorization code is issued.
- Tool calls without a valid bearer token get 401.
- Step 1 tools are harmless by design. Real computer capabilities move
  in only behind the local agent's own allowlist/hand-off enforcement
  (Steps 3–4); the gateway never stores computer data.

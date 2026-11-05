# Can gateway

The cloud half of Can (omni-commander V2): a remote MCP server with
OAuth 2.1 that ChatGPT web connects to as a custom connector. It
authenticates the owner and (from Step 2 on) relays tool calls to the
local agent on the owner's computer. Step 1 executes two starter tools
on the gateway host itself: `can_status` (read) and `can_write_note`
(write).

## Run

```sh
python3 -m venv .venv && ./.venv/bin/pip install "mcp<2"
# .env (chmod 600) must define:
#   CAN_PUBLIC_URL          public https base URL, no trailing slash
#   CAN_OWNER_CODE          code the owner types on the consent page
#   CAN_STATIC_CLIENT_ID    optional pre-registered client id
#   CAN_STATIC_CLIENT_SECRET  optional, for connectors without DCR
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

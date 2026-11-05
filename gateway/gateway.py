#!/usr/bin/env python3
"""Can gateway — omni-commander V2, Step 1 (formal).

A single-file remote MCP server with OAuth 2.1, product name "Can":
  - branded landing page at / and a branded consent page at /can/consent
  - OAuth: DCR (/oauth/register), authorize -> consent page (owner code),
    token (auth code + PKCE, refresh rotation), revoke
  - MCP endpoint at /mcp (Streamable HTTP), bearer-token protected
  - Step-1 tools only, executed here on the gateway host:
      can_status     (read)  - report gateway online
      can_write_note (write) - append a line to write-log.txt
  - every JSON-RPC request is logged to traffic.log; tool calls to
    tool-calls.log (ground truth for acceptance tests)

Config comes from the environment (see .env):
  CAN_PUBLIC_URL  public https base URL, no trailing slash
  CAN_OWNER_CODE  code the owner types on the consent page
  CAN_STATIC_CLIENT_ID / CAN_STATIC_CLIENT_SECRET
                  optional pre-registered client for connectors that
                  do not use dynamic registration
  CAN_PORT        listen port (default 8792)

State (registered clients, codes, tokens) persists to state.json so a
gateway restart does not force re-registration. Single user: the owner.
"""
import json
import os
import secrets
import time
from pathlib import Path

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.settings import (
    AuthSettings,
    ClientRegistrationOptions,
    RevocationOptions,
)
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, RedirectResponse

BASE = Path(__file__).resolve().parent
STATE_FILE = BASE / "state.json"
TRAFFIC_LOG = BASE / "traffic.log"
TOOL_LOG = BASE / "tool-calls.log"
WRITE_LOG = BASE / "write-log.txt"
ICON = BASE / "assets" / "icon.png"
ICON_256 = BASE / "assets" / "icon-256.png"

PUBLIC_URL = os.environ["CAN_PUBLIC_URL"].rstrip("/")
OWNER_CODE = os.environ["CAN_OWNER_CODE"]
PORT = int(os.environ.get("CAN_PORT", "8792"))
SCOPES = ["can:tools", "offline_access"]
ACCESS_TTL = 8 * 3600
REFRESH_TTL = 30 * 24 * 3600


def log_line(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


class Store:
    """JSON-file persistence for clients, codes, and tokens."""

    def __init__(self):
        self.data = {"clients": {}, "codes": {}, "access": {}, "refresh": {}, "pending": {}}
        if STATE_FILE.exists():
            try:
                self.data.update(json.loads(STATE_FILE.read_text(encoding="utf-8")))
            except Exception:
                pass

    def save(self):
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data), encoding="utf-8")
        tmp.replace(STATE_FILE)
        STATE_FILE.chmod(0o600)


store = Store()


class CanProvider(OAuthAuthorizationServerProvider):
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = store.data["clients"].get(client_id)
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        store.data["clients"][str(client_info.client_id)] = client_info.model_dump(mode="json")
        store.save()

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        key = secrets.token_urlsafe(24)
        store.data["pending"][key] = {
            "client_id": str(client.client_id),
            "client_name": client.client_name or "ChatGPT",
            "params": params.model_dump(mode="json"),
            "expires_at": time.time() + 600,
        }
        store.save()
        return f"{PUBLIC_URL}/can/consent?k={key}"

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        raw = store.data["codes"].get(authorization_code)
        return AuthorizationCode.model_validate(raw) if raw else None

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        store.data["codes"].pop(authorization_code.code, None)
        return self._issue(client, authorization_code.scopes, authorization_code.resource,
                           subject=authorization_code.subject)

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        raw = store.data["refresh"].get(refresh_token)
        return RefreshToken.model_validate(raw) if raw else None

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        store.data["refresh"].pop(refresh_token.token, None)
        return self._issue(client, scopes or refresh_token.scopes, refresh_token.resource,
                           subject=refresh_token.subject)

    async def load_access_token(self, token: str) -> AccessToken | None:
        raw = store.data["access"].get(token)
        if not raw:
            return None
        tok = AccessToken.model_validate(raw)
        if tok.expires_at and tok.expires_at < int(time.time()):
            store.data["access"].pop(token, None)
            store.save()
            return None
        return tok

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        store.data["access"].pop(token.token, None)
        store.data["refresh"].pop(token.token, None)
        store.save()

    def _issue(self, client, scopes, resource, subject=None) -> OAuthToken:
        access = secrets.token_urlsafe(48)
        refresh = secrets.token_urlsafe(48)
        now = int(time.time())
        store.data["access"][access] = AccessToken(
            token=access, client_id=str(client.client_id), scopes=scopes,
            expires_at=now + ACCESS_TTL, resource=resource, subject=subject,
        ).model_dump(mode="json")
        store.data["refresh"][refresh] = RefreshToken(
            token=refresh, client_id=str(client.client_id), scopes=scopes,
            expires_at=now + REFRESH_TTL, resource=resource, subject=subject,
        ).model_dump(mode="json")
        store.save()
        return OAuthToken(
            access_token=access, token_type="Bearer", expires_in=ACCESS_TTL,
            scope=" ".join(scopes), refresh_token=refresh,
        )


# Optional pre-registered static client (for connectors without DCR).
_static_id = os.environ.get("CAN_STATIC_CLIENT_ID")
_static_secret = os.environ.get("CAN_STATIC_CLIENT_SECRET")
if _static_id and _static_id not in store.data["clients"]:
    store.data["clients"][_static_id] = OAuthClientInformationFull(
        client_id=_static_id,
        client_secret=_static_secret,
        client_name="Can (static client)",
        redirect_uris=[AnyHttpUrl("https://chatgpt.com/connector_platform_oauth_redirect"),
                       AnyHttpUrl("https://chatgpt.com/aip/plugin-oauth-callback")],
        token_endpoint_auth_method="client_secret_post",
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        scope=" ".join(SCOPES),
    ).model_dump(mode="json")
    store.save()

provider = CanProvider()

mcp = FastMCP(
    "Can",
    host="127.0.0.1",
    port=PORT,
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    auth_server_provider=provider,
    auth=AuthSettings(
        issuer_url=AnyHttpUrl(PUBLIC_URL),
        resource_server_url=AnyHttpUrl(PUBLIC_URL + "/mcp"),
        required_scopes=["can:tools"],
        validate_token_resource=False,
        client_registration_options=ClientRegistrationOptions(
            enabled=True, valid_scopes=SCOPES, default_scopes=["can:tools"]
        ),
        revocation_options=RevocationOptions(enabled=True),
    ),
)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
def can_status() -> str:
    """Report whether the owner's Can gateway is online. Read-only."""
    log_line(TOOL_LOG, f"{time.strftime('%H:%M:%S')} CALL can_status")
    return json.dumps({
        "product": "Can", "status": "online", "nonce": "CAN-STATUS-1105",
        "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
def can_write_note(text: str) -> str:
    """Append a short note to the Can gateway write-log. This is a WRITE action."""
    log_line(TOOL_LOG, f"{time.strftime('%H:%M:%S')} CALL can_write_note text={text!r}")
    log_line(WRITE_LOG, f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}")
    return json.dumps({"written": True, "echo": text, "nonce": "CAN-WRITE-1105"})


PAGE_CSS = """
body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#eef0f4;
color:#1c2330;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:20px;box-shadow:0 12px 40px rgba(30,40,70,.12);
padding:36px 40px;max-width:380px;text-align:center}
.card img{width:96px;height:96px;border-radius:22px}
h1{font-size:26px;margin:14px 0 6px}p{color:#5a6478;font-size:14px;line-height:1.6}
input{font-size:16px;padding:10px 12px;border:1px solid #ccd2dd;border-radius:10px;width:80%;text-align:center}
button{margin-top:16px;background:#1c2330;color:#fff;border:0;border-radius:10px;
font-size:16px;padding:11px 34px;cursor:pointer}
.err{color:#c0392b}
"""


@mcp.custom_route("/", methods=["GET"])
async def landing(request: Request):
    return HTMLResponse(f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Can</title><link rel="icon" href="/icon-256.png"><style>{PAGE_CSS}</style></head>
<body><div class="card"><img src="/icon-256.png" alt="Can">
<h1>Can</h1><p>网关运行中。<br>在 ChatGPT 里添加 Can 连接器，即可从网页对话控制这台电脑。</p>
</div></body></html>""")


@mcp.custom_route("/icon.png", methods=["GET"])
async def icon_full(request: Request):
    return FileResponse(ICON, media_type="image/png")


@mcp.custom_route("/icon-256.png", methods=["GET"])
async def icon_small(request: Request):
    return FileResponse(ICON_256, media_type="image/png")


def consent_page(client_name: str, key: str, error: str = "") -> HTMLResponse:
    err = f'<p class="err">{error}</p>' if error else ""
    return HTMLResponse(f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Can — 授权</title><link rel="icon" href="/icon-256.png"><style>{PAGE_CSS}</style></head>
<body><div class="card"><img src="/icon-256.png" alt="Can">
<h1>Can</h1>
<p><b>{client_name}</b> 正在请求连接你的 Can 网关。<br>只有机主本人可以授权：请输入机主码。</p>
{err}
<form method="post" action="/can/consent">
<input type="hidden" name="k" value="{key}">
<input type="password" name="code" autocomplete="off" placeholder="机主码">
<br><button type="submit">授权连接</button>
</form></div></body></html>""")


@mcp.custom_route("/can/consent", methods=["GET"])
async def consent_get(request: Request):
    key = request.query_params.get("k", "")
    pending = store.data["pending"].get(key)
    if not pending or pending["expires_at"] < time.time():
        return HTMLResponse("<h1>Can</h1><p>授权请求已过期，请回 ChatGPT 重新连接。</p>", status_code=400)
    return consent_page(pending["client_name"], key)


@mcp.custom_route("/can/consent", methods=["POST"])
async def consent_post(request: Request):
    form = await request.form()
    key = str(form.get("k", ""))
    code = str(form.get("code", ""))
    pending = store.data["pending"].get(key)
    if not pending or pending["expires_at"] < time.time():
        return HTMLResponse("<h1>Can</h1><p>授权请求已过期，请回 ChatGPT 重新连接。</p>", status_code=400)
    if not secrets.compare_digest(code, OWNER_CODE):
        log_line(TRAFFIC_LOG, f"{time.strftime('%H:%M:%S')} CONSENT DENIED (bad owner code)")
        return consent_page(pending["client_name"], key, error="机主码不正确，授权已拒绝。")
    params = AuthorizationParams.model_validate(pending["params"])
    auth_code = secrets.token_urlsafe(48)
    store.data["codes"][auth_code] = AuthorizationCode(
        code=auth_code,
        scopes=params.scopes or ["can:tools"],
        expires_at=time.time() + 600,
        client_id=pending["client_id"],
        code_challenge=params.code_challenge,
        redirect_uri=params.redirect_uri,
        redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
        resource=params.resource,
        subject="owner",
    ).model_dump(mode="json")
    store.data["pending"].pop(key, None)
    store.save()
    log_line(TRAFFIC_LOG, f"{time.strftime('%H:%M:%S')} CONSENT GRANTED client={pending['client_id']}")
    return RedirectResponse(
        construct_redirect_uri(str(params.redirect_uri), code=auth_code, state=params.state),
        status_code=302,
    )


class LoggingASGI:
    """Pass-through ASGI wrapper logging JSON-RPC methods + auth events."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        body = b""
        more = True
        while more:
            msg = await receive()
            if msg["type"] == "http.request":
                body += msg.get("body", b"")
                more = msg.get("more_body", False)
            elif msg["type"] == "http.disconnect":
                more = False
        path = scope.get("path", "")
        if path.startswith("/mcp"):
            try:
                payload = json.loads(body.decode("utf-8")) if body else {}
                tool = (payload.get("params") or {}).get("name", "")
                log_line(TRAFFIC_LOG, f"{time.strftime('%H:%M:%S')} {scope.get('method')} {path} "
                                      f"rpc={payload.get('method', '?')} tool={tool}")
            except Exception:
                log_line(TRAFFIC_LOG, f"{time.strftime('%H:%M:%S')} {scope.get('method')} {path} (unparsed)")
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


if __name__ == "__main__":
    import uvicorn

    log_line(TRAFFIC_LOG, f"{time.strftime('%H:%M:%S')} Can gateway starting on 127.0.0.1:{PORT} issuer={PUBLIC_URL}")
    uvicorn.run(LoggingASGI(mcp.streamable_http_app()), host="127.0.0.1", port=PORT, log_level="warning")

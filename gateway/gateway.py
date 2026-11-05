#!/usr/bin/env python3
"""Can gateway — omni-commander V2, Steps 1-2 (v1.1 relay).

A single-file remote MCP server with OAuth 2.1, product name "Can":
  - branded landing page at / and a branded consent page at /can/consent
  - OAuth: DCR (/oauth/register), authorize -> consent page (owner code),
    token (auth code + PKCE, refresh rotation), revoke
  - MCP endpoint at /mcp (Streamable HTTP), bearer-token protected
  - tools are RELAYED to the owner's local agent (Step 2): the agent
    dials out to /agent/heartbeat + /agent/poll (long-poll) with a shared
    agent key, executes jobs on the owner's computer, and posts results
    to /agent/result. If no agent has heartbeated within CAN_AGENT_TTL
    seconds, tools answer agent_offline truthfully — never fake a local
    execution on the gateway host.
      can_status     (read)  - the agent reports the computer's state
      can_write_note (write) - the agent appends a line on the computer
      can_list_files / can_read_file (read), can_write_file (write,
      create-only) and can_run_command (exec) - Step 3: the file and
      terminal layer, confined by the agent to its work folder
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
import asyncio
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
from mcp.types import ImageContent, TextContent, ToolAnnotations
from pydantic import AnyHttpUrl
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse

BASE = Path(__file__).resolve().parent
STATE_FILE = BASE / "state.json"
TRAFFIC_LOG = BASE / "traffic.log"
TOOL_LOG = BASE / "tool-calls.log"
WRITE_LOG = BASE / "write-log.txt"
ICON = BASE / "assets" / "icon.png"
ICON_256 = BASE / "assets" / "icon-256.png"

PUBLIC_URL = os.environ["CAN_PUBLIC_URL"].rstrip("/")
OWNER_CODE = os.environ["CAN_OWNER_CODE"]
AGENT_KEY = os.environ.get("CAN_AGENT_KEY", "")
AGENT_TTL = int(os.environ.get("CAN_AGENT_TTL", "45"))
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


# ---------------------------------------------------------------- agent relay
# The local agent dials out; jobs wait in memory for it to claim them.

jobs: dict[str, dict] = {}


def agent_info() -> dict:
    return store.data.get("agent") or {}


def agent_online() -> bool:
    return bool(agent_info()) and (time.time() - agent_info().get("last_seen", 0) <= AGENT_TTL)


async def relay(tool: str, arguments: dict, timeout: float = 30.0) -> str | None:
    """Queue a job for the local agent and wait for its result string."""
    job_id = secrets.token_urlsafe(12)
    fut = asyncio.get_running_loop().create_future()
    jobs[job_id] = {"tool": tool, "arguments": arguments, "future": fut, "claimed": False}
    log_line(TOOL_LOG, f"{time.strftime('%H:%M:%S')} RELAY {tool} job={job_id} args={arguments!r}")
    try:
        result = await asyncio.wait_for(fut, timeout)
        log_line(TOOL_LOG, f"{time.strftime('%H:%M:%S')} RESULT {tool} job={job_id} ok")
        return result
    except asyncio.TimeoutError:
        log_line(TOOL_LOG, f"{time.strftime('%H:%M:%S')} TIMEOUT {tool} job={job_id}")
        return None
    finally:
        jobs.pop(job_id, None)


def _agent_key_ok(request: Request) -> bool:
    return bool(AGENT_KEY) and secrets.compare_digest(request.headers.get("x-agent-key", ""), AGENT_KEY)


@mcp.custom_route("/agent/heartbeat", methods=["POST"])
async def agent_heartbeat(request: Request):
    if not _agent_key_ok(request):
        return JSONResponse({"error": "bad agent key"}, status_code=403)
    try:
        info = await request.json()
    except Exception:
        info = {}
    info = {k: info.get(k) for k in ("agent_id", "name", "hostname", "os", "version")}
    store.data["agent"] = {**info, "last_seen": time.time()}
    store.save()
    return JSONResponse({"ok": True})


@mcp.custom_route("/agent/poll", methods=["GET"])
async def agent_poll(request: Request):
    if not _agent_key_ok(request):
        return JSONResponse({"error": "bad agent key"}, status_code=403)
    wait = min(float(request.query_params.get("wait", "25")), 30.0)
    deadline = time.time() + wait
    while True:
        for job_id, job in jobs.items():
            if not job["claimed"]:
                job["claimed"] = True
                return JSONResponse({"job_id": job_id, "tool": job["tool"], "arguments": job["arguments"]})
        if time.time() >= deadline:
            return JSONResponse({}, status_code=204)
        await asyncio.sleep(0.4)


@mcp.custom_route("/agent/result", methods=["POST"])
async def agent_result(request: Request):
    if not _agent_key_ok(request):
        return JSONResponse({"error": "bad agent key"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    job = jobs.get(str(body.get("job_id", "")))
    if job and not job["future"].done():
        if body.get("ok"):
            job["future"].set_result(str(body.get("result", "")))
        else:
            job["future"].set_result(json.dumps({"error": "agent_error", "detail": str(body.get("result", ""))}))
    return JSONResponse({"ok": True})


async def relay_tool(name: str, arguments: dict, timeout: float = 30.0) -> str:
    """Shared tool body: offline pre-check, relay to the agent, timeout."""
    log_line(TOOL_LOG, f"{time.strftime('%H:%M:%S')} CALL {name} args={arguments!r}")
    if not agent_online():
        return json.dumps({
            "error": "agent_offline",
            "detail": "The Can agent on the owner's computer has not checked in recently; nothing was executed.",
            "tool": name,
        })
    result = await relay(name, arguments, timeout)
    if result is None:
        return json.dumps({"error": "agent_timeout", "tool": name})
    return result


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_status() -> str:
    """Report whether the owner's computer is online, via the Can agent on that computer. Read-only."""
    return await relay_tool("can_status", {})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_write_note(text: str) -> str:
    """Append a short note to the Can write-log on the owner's computer, via the Can agent. This is a WRITE action."""
    return await relay_tool("can_write_note", {"text": text})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_list_files(path: str = ".") -> str:
    """List files and folders inside the Can work folder on the owner's computer. The path is relative to the work folder ("." is the work folder itself). Read-only."""
    return await relay_tool("can_list_files", {"path": path})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_read_file(path: str) -> str:
    """Read a text file inside the Can work folder on the owner's computer. The path is relative to the work folder. Read-only."""
    return await relay_tool("can_read_file", {"path": path})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_write_file(path: str, content: str) -> str:
    """Create a NEW text file inside the Can work folder on the owner's computer. The path is relative to the work folder. Refuses to overwrite an existing file. This is a WRITE action."""
    return await relay_tool("can_write_file", {"path": path, "content": content})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_run_command(command: str) -> str:
    """Run a shell command on the owner's computer, inside the Can work folder, and return its exit code and output. This EXECUTES on the computer. Fence: the owner must approve it in a dialog ON the computer itself; if he denies it or does not answer, the result is an owner_denied error and nothing runs."""
    return await relay_tool("can_run_command", {"command": command}, timeout=115)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_desktop_windows(app: str = "") -> str:
    """List open windows on the owner's computer (optionally filtered by app name): pid, window_id, app, title, on-screen flag. This is the desktop / UI-automation layer: it works on ANY app's window from the outside — including browsers like Chrome or Edge — without any plugin. Read-only."""
    return await relay_tool("can_desktop_windows", {"app": app})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_desktop_open_app(name: str) -> str:
    """Open (launch in the background, without stealing focus) or surface an app on the owner's computer by name, e.g. "Calculator", "Google Chrome", "Notes". Returns its pid and windows; remember the window for snapshot/click/type."""
    return await relay_tool("can_desktop_open_app", {"name": name}, timeout=60)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=False))
async def can_desktop_snapshot(app: str = "", pid: int = 0, window_id: int = 0) -> str:
    """Snapshot a window's interface as a list of elements with refs (d1, d2, ...): role, label, value. Identify the window by pid+window_id (from can_desktop_windows / can_desktop_open_app), or by app name, or leave all empty for the last window Can looked at. Take a FRESH snapshot before clicking or typing: refs die when a new snapshot is taken. Read-only. Works on any app, including a browser window — this is how Can operates browsers other than ego."""
    return await relay_tool("can_desktop_snapshot", {"app": app, "pid": pid, "window_id": window_id}, timeout=60)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_desktop_click(ref: str, pid: int = 0, window_id: int = 0) -> str:
    """Click an element (ref from can_desktop_snapshot, e.g. "d3") in a window on the owner's computer. Works in the background without stealing focus. Fence: the owner must approve it in a dialog ON the computer itself; denied or unanswered returns an owner_denied error and nothing is clicked."""
    return await relay_tool("can_desktop_click", {"ref": ref, "pid": pid, "window_id": window_id}, timeout=115)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_desktop_type(ref: str, text: str, pid: int = 0, window_id: int = 0) -> str:
    """Type text into an element (ref from can_desktop_snapshot) in a window on the owner's computer. Fence: the owner must approve it in a dialog ON the computer itself; denied or unanswered returns an owner_denied error and nothing is typed."""
    return await relay_tool("can_desktop_type", {"ref": ref, "text": text, "pid": pid, "window_id": window_id}, timeout=115)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_desktop_key(key: str, ref: str = "", pid: int = 0, window_id: int = 0) -> str:
    """Press one key (return, tab, escape, space, delete, up/down/left/right, f1-f12, a letter or digit) in a window on the owner's computer, optionally targeting an element ref from can_desktop_snapshot. Fence: the owner must approve it in a dialog ON the computer itself; denied or unanswered returns an owner_denied error and no key is pressed."""
    return await relay_tool("can_desktop_key", {"key": key, "ref": ref, "pid": pid, "window_id": window_id}, timeout=115)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_desktop_screenshot(max_dim: int = 1600) -> list:
    """Take a REAL screenshot of the owner's computer screen (the whole display) and return it as an image visible in this conversation. Use it whenever the user asks to SEE the screen, or when a structural snapshot is not enough to know what is on it. max_dim caps the image's long edge in pixels (default 1600). Read-only: nothing on the computer is touched."""
    raw = await relay_tool("can_desktop_screenshot", {"max_dim": max_dim}, timeout=60)
    try:
        data = json.loads(raw)
    except Exception:
        return [TextContent(type="text", text=raw)]
    b64 = data.get("screenshot_png_b64") if isinstance(data, dict) else None
    if not b64:
        return [TextContent(type="text", text=raw)]
    summary = (
        f"Screenshot of the owner's computer screen "
        f"({data.get('screenshot_width')}x{data.get('screenshot_height')} image, "
        f"display {data.get('screen_width')}x{data.get('screen_height')})."
    )
    return [
        TextContent(type="text", text=summary),
        ImageContent(type="image", data=b64, mimeType=data.get("mime") or "image/png"),
    ]


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_audit_log(lines: int = 20) -> str:
    """Read the Can agent's local audit log on the owner's computer: every tool call and fence decision (executed / blocked / confirmed / denied), newest last. Read-only."""
    return await relay_tool("can_audit_log", {"lines": lines})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_browser_open(url: str) -> str:
    """Open a web page in Can's own browser on the owner's computer (a dedicated browser profile, not the owner's daily browser) and return the page title and URL."""
    return await relay_tool("can_browser_open", {"url": url})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_browser_snapshot() -> str:
    """Take a snapshot of the current page in Can's browser: URL, title, page text, and the interactive elements with refs (e1, e2, ...) to use with can_browser_click and can_browser_type. Read-only."""
    return await relay_tool("can_browser_snapshot", {})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_browser_click(ref: str) -> str:
    """Click the element with the given ref (from can_browser_snapshot) in Can's browser. This ACTS on the page."""
    return await relay_tool("can_browser_click", {"ref": ref})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_browser_type(ref: str, text: str, submit: bool = False) -> str:
    """Type text into the element with the given ref (from can_browser_snapshot) in Can's browser. Set submit=true to submit the form afterwards. This ACTS on the page."""
    return await relay_tool("can_browser_type", {"ref": ref, "text": text, "submit": submit})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_browser_close() -> str:
    """Close Can's browser on the owner's computer."""
    return await relay_tool("can_browser_close", {})


# ---------------------------------------------------------------- ego tools
# The owner's DAILY browser (ego lite) with his logins. Two spaces:
# "can" = Can's own task space inside that browser; "user" = the owner's
# own space (pages he has open), which must be claimed first with
# can_ego_claim (the owner asked for this capability explicitly).
EGO_TIMEOUT = 115


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_ego_spaces() -> str:
    """List the task spaces in the owner's daily browser (ego lite): id, name and ownership (agent or user). Read-only."""
    return await relay_tool("can_ego_spaces", {}, timeout=EGO_TIMEOUT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_ego_claim(space_id: int) -> str:
    """Claim one of the owner's own browser spaces (from can_ego_spaces) so Can can operate the pages he has open there. Use only when the owner asks to work in his own space."""
    return await relay_tool("can_ego_claim", {"space_id": space_id}, timeout=EGO_TIMEOUT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_ego_open(url: str) -> str:
    """Open a web page in Can's own task space inside the owner's daily browser (ego lite, with the owner's logins). Returns the page title and URL."""
    return await relay_tool("can_ego_open", {"url": url}, timeout=EGO_TIMEOUT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
async def can_ego_snapshot(space: str = "can") -> str:
    """Take a semantic snapshot of the current page in the owner's daily browser: space="can" for Can's task space, space="user" for the owner's own claimed space. Elements carry refs like @21 for can_ego_click / can_ego_type. Read-only."""
    return await relay_tool("can_ego_snapshot", {"space": space}, timeout=EGO_TIMEOUT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_ego_click(space: str, target: str) -> str:
    """Click an element in the owner's daily browser: space is "can" or "user"; target is a snapshot ref (e.g. "@21") or a selector like text=..., loc=role:button[name='...']. This ACTS in the owner's logged-in browser. Fence: the owner must approve it in a dialog ON the computer itself; denied or unanswered returns an owner_denied error and nothing is clicked."""
    return await relay_tool("can_ego_click", {"space": space, "target": target}, timeout=EGO_TIMEOUT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
async def can_ego_type(space: str, target: str, text: str) -> str:
    """Fill a field in the owner's daily browser: space is "can" or "user"; target is a snapshot ref (e.g. "@21") or a selector. This ACTS in the owner's logged-in browser. Fence: the owner must approve it in a dialog ON the computer itself; denied or unanswered returns an owner_denied error and nothing is typed."""
    return await relay_tool("can_ego_type", {"space": space, "target": target, "text": text}, timeout=EGO_TIMEOUT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
async def can_ego_finish() -> str:
    """Close Can's own task space in the owner's daily browser (keeps nothing). The owner's own space is never closed by this."""
    return await relay_tool("can_ego_finish", {}, timeout=EGO_TIMEOUT)


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
    info = agent_info()
    if agent_online():
        agent_line = f"电脑 agent 在线：{info.get('name') or info.get('hostname') or ''}"
    else:
        agent_line = "电脑 agent 离线"
    return HTMLResponse(f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Can</title><link rel="icon" href="/icon-256.png"><style>{PAGE_CSS}</style></head>
<body><div class="card"><img src="/icon-256.png" alt="Can">
<h1>Can</h1><p>网关运行中。<br>在 ChatGPT 里添加 Can 连接器，即可从网页对话控制这台电脑。</p>
<p>{agent_line}</p>
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

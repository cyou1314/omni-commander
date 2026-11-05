# omni-commander

**One tool stack for your computer. Any AI brain can drive it.**

omni-commander is not another agent and not another model. It is a curated,
model-agnostic stack of existing MCP servers and skills that lets an AI
assistant actually *do things* on your own machine:

- read, write and search **files**
- run **terminal** commands and processes
- drive your **real, logged-in browser** (not a disposable empty one)
- operate **desktop apps** in the background, without stealing your mouse

The brain is interchangeable. Claude, GPT, Gemini, DeepSeek — any client that
speaks [MCP](https://modelcontextprotocol.io) can use the exact same stack.
You assemble the hands once; you swap brains whenever you like.

## Why structured-first?

Most "computer use" demos fail the same way: the model stares at screenshots
and guesses pixel coordinates. omni-commander routes every task down the most
deterministic path that can do the job:

| Priority | Layer | Tool | Why |
|----------|-------|------|-----|
| 1 | APIs / files / terminal | Desktop Commander MCP | Direct calls. Deterministic, no screen involved |
| 2 | Browser, structured | ego (logged-in) · Playwright MCP (clean) | Accessibility / semantic tree, elements clicked by ref, not by coordinates |
| 3 | Desktop apps, structured | Cua Driver MCP | Reads native apps' accessibility tree, works in the background, does not take over cursor or focus |
| 4 | Pixel computer use (fallback only) | Your client's built-in computer use | Screenshots + coordinates. Most flexible, least reliable — last resort, short steps, verify every step |

Plus three rules baked into the router (`rules/ROUTER.md`):

- **Verify every step.** After each action, re-read state before acting again. Never blind-chain clicks.
- **Solidify what works.** A flow that succeeded once becomes a script in `workflows/`; next time the script runs, not the model's improvisation.
- **Hand off the dangerous stuff.** CAPTCHAs, 2FA, payments, deletions and publishing stop and wait for the human.

## Components (V1)

| Component | Role | License / source |
|-----------|------|------------------|
| [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | Files, terminal, processes | MIT, open source |
| [ego (lite)](https://lite.ego.app) + ego-browser skill | Logged-in browser, isolated Spaces | Browser binary closed source, free; skill open |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) (Microsoft) | Clean browser automation | Apache-2.0 |
| [Cua Driver](https://github.com/trycua/cua) | Background desktop app control | MIT, early preview |
| `rules/`, `workflows/`, `config/` in this repo | The router, guardrails and setup — the part we actually write | MIT (this repo) |

Optional, add only when needed: Chrome DevTools MCP (browser debugging /
network / performance inspection).

## Quick start

V1 is local-only, single user, macOS first. Follow the step-by-step guide —
one step at a time, each with its own acceptance check:

➡️ **[docs/SETUP.md](docs/SETUP.md)**

Short version: Node ≥ 22.12 → copy `config/mcp-servers.example.json` into your
MCP client → install components one by one → run the acceptance task for each
layer → finish with one cross-layer task.

## What V1 is not

- Not a remote service. No accounts, no cloud relay (that is a possible V2: a
  tunnel + one token, nothing more).
- Not a sandbox. These tools run with your user account's real permissions.
  The guardrails in `rules/ROUTER.md` are guardrails, not a security boundary.
  Read them before you run anything.

## Status

V1 under construction, step by step. See [docs/SETUP.md](docs/SETUP.md) for the
current step checklist.

## License

MIT — see [LICENSE](LICENSE). Third-party components keep their own licenses.

# SETUP — step by step, one acceptance check per step

Rules of the road:

- Do not skip ahead. A step is done only when its acceptance check passes.
- One primary tool per layer. Overlapping primaries are how brains pick the wrong tool and things fall over.
- **Cross-platform by design:** the steps are identical on Windows, macOS and Linux. Where a command or path differs, all three variants are given. Placeholders like `/Users/you/...` / `C:\Users\you\...` must be replaced with your real paths.

## Step 0 — Node version

```bash
node --version   # must be >= 22.12
```

Desktop Commander requires Node 22.12+; that version also covers every other
component here (Playwright MCP needs 18+, Chrome DevTools MCP needs 20.19+).
If your Node is older or lives in a custom folder, note its absolute path —
Step 1 needs it.

**Accept:** version printed is ≥ 22.12.

## Step 1 — Pick ONE brain client, mount Desktop Commander

Pick one MCP client as the V1 entry point (Claude Code, Codex, Cursor…).
Others can be added later by copying the same config — the tools are installed
once, the brains are interchangeable.

Copy the config file for your OS — `config/mcp-servers.windows.json`,
`config/mcp-servers.macos.json` or `config/mcp-servers.linux.json` — adjust
the paths, and put it in your client's MCP config.

> **Pitfall, all OSes (learned the hard way):** MCP clients spawn servers
> with a stripped environment. If `npx` is not on that PATH, the server
> silently fails to start and *no tools appear, with no error*.
> - macOS / Linux: use the **absolute path** to `npx` and pass `env.PATH`
>   explicitly, as the config files do.
> - Windows: `npx` is a `.cmd` shim that many clients cannot spawn directly —
>   the Windows config runs it through `cmd /c`, which is the standard fix.

Restart the client.

> **Recommended: fixed install instead of npx-on-demand (verified on the
> first test machine, macOS + Codex, 2026-11-05).** The `npx -y …@latest`
> form downloads the package the first time the server starts; on the test
> machine that download stalled indefinitely (the npx cache held only a
> lock file) and the tools never appeared. What passed instead:
>
> ```bash
> mkdir -p ~/commander-tools/desktop-commander && cd ~/commander-tools/desktop-commander
> npm init -y && npm install @wonderwhy-er/desktop-commander@latest
> ```
>
> then register the server as `command = <abs path to node>`,
> `args = ["<abs path>/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"]`.
> No per-start download, and the version is pinned by the lock file.
> Two traps seen on the test machine: (1) `npm`'s own scripts resolve
> `node` through `env`, so when the brain's terminal lacks Node on PATH the
> install dies with `env: node: No such file or directory` — prefix the
> command with `PATH=<node bin dir>:$PATH`; (2) the install pulls in
> Puppeteer's browser download (~180 MB), so first install takes minutes,
> not seconds — judge it by the lock file appearing, not by silence.

**Accept:** in a fresh session, ask the brain to (1) create a file in your
allowlisted folder, write one line, read it back; (2) run a harmless terminal
command such as `ls`. Both must succeed. Then set Desktop Commander's
`allowedDirectories` to that folder only (its `set_config_value` tool), and
prove the fence: reading a file *outside* the allowlist must be refused
(on the test machine: `Path not allowed`).

## Step 2 — ego, the logged-in browser (install once, verify here)

Install [ego (lite)](https://lite.ego.app), migrate your Chrome state when it
offers, and make sure the `ego-browser` skill is visible to your brain client
(ego installs it for common clients on first run; activate with `/ego-browser`).

Platform reality for this layer: ego is full-featured on **macOS**, in
**beta on Windows**, and **not yet available on Linux**. On Linux (or if the
Windows beta misbehaves), fill the same role with the fallback: Chrome
DevTools MCP attached to your daily Chrome, or
[agent-browser](https://github.com/vercel-labs/agent-browser) driving your
real profile. The acceptance check below is written against the *role*, so
it applies to whichever driver you use.

Division of labour, write it down for your brain: **needs your login → ego;
does not need login / must be reproducible → Playwright (Step 3).**

> **Verified on the first test machine (macOS + Codex, 2026-11-05):**
> whether a task Space carries your logins depends on **which profile it is
> created under**, not on whether the ego window happens to be open. Create
> task Spaces under the profile you actually browse with (the one holding
> your daily Spaces); a Space created under a default or other profile
> opens sites logged out. On the test machine the brain could use the
> `ego-browser` skill straight from `~/.agents/skills`, no copying needed.

**Accept:** the brain opens an isolated workspace in your logged-in browser
(an ego Space, or the fallback driver's equivalent session), loads a site you
are logged into, takes a semantic snapshot, finds a named button and clicks
it — without touching the tabs you are personally using.

## Step 3 — Playwright MCP, the clean browser

Already in the example config from Step 1 (`@playwright/mcp`). Restart the
client if you added it later.

**Accept:** in a fresh (logged-out) browser, the brain opens a public page,
fills a form, submits it, and reads the result back from a new snapshot.
Actions must target snapshot refs, not coordinates.

> **Verified on the first test machine (macOS + Codex, 2026-11-05):**
> unlike Desktop Commander in Step 1, the `npx -y @playwright/mcp@latest`
> form worked here — the `browser_*` tools appeared in a fresh session and
> the browser launched with no separate install step. Acceptance run:
> opened `https://the-internet.herokuapp.com/login` (a public demo site),
> filled Username / Password through snapshot refs, clicked Login, and
> read `You logged into a secure area!` back from the post-submit snapshot
> at `/secure`; the browser was closed afterwards. Config backup before
> the change: `config.toml.bak-omni-step3`. If the npx first-start
> download ever stalls on another machine, fall back to the Step 1
> fixed-install pattern instead of retrying npx.

## Step 4 — Cua Driver, the desktop layer

Install (macOS / Linux):

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

Install (Windows, PowerShell):

```powershell
irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex
```

Then, every OS:

```bash
cua-driver permissions grant   # macOS: grant Accessibility + Screen Recording to CuaDriver.app itself, not to your terminal; other OSes: follow its prompts
cua-driver mcp-config          # prints the exact MCP registration for your machine — use it, don't hand-copy paths
```

Add what `mcp-config` prints to your client config and restart. Platform
status: Windows and macOS are the stable builds; the Linux build is a
pre-release that needs an X11 / XWayland desktop with AT-SPI 2 — on Linux,
prove this layer last and expect rough edges.

> Cua Driver is an early preview. Prove it on harmless apps (Calculator,
> Notes) before pointing it at anything that matters.

**Accept (the official quickstart task):** the brain computes 6 × 7 in
Calculator **in the background** while you keep using the machine in the
foreground — your cursor and focus are never taken.

## Step 5 — Router rules and the hand-off list

Copy `rules/ROUTER.md` into wherever your brain client reads standing
instructions (project instructions / global rules). Fill in:

- your allowlisted folders
- your hand-off list (default: CAPTCHA, 2FA, payment, deletion, publishing)

**Accept:** give the brain a task that would need a hand-off action mid-way.
It must stop at that action and ask you, not improvise around it.

## Step 6 — One cross-layer task

Example: download a file from a logged-in site with **your logged-in browser
driver** → rename and inspect it locally with **Desktop Commander** → open a
local app with **Cua Driver** and enter the result. Every layer participates,
every step is verified.

**Accept:** end state matches what you asked for, and the task log shows which
layer did what.

## Step 7 — Solidify it into a script

Save the Step 6 flow into `workflows/` (ego batch JS and/or shell), following
`workflows/README.md`. Run it again — this time as a script, not as the brain
improvising.

**Accept:** same result, faster, and nothing was left to guesswork.

V1 is done. Remote access, a second brain client, and Chrome DevTools MCP are
V2 topics — do not bolt them on early.

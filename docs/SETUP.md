# SETUP — step by step, one acceptance check per step

Rules of the road:

- Do not skip ahead. A step is done only when its acceptance check passes.
- One primary tool per layer. Overlapping primaries are how brains pick the wrong tool and things fall over.
- Commands below are macOS-first (the first machine this was built on). Paths with `/Users/you/...` are placeholders — replace with your real paths.

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

Copy `config/mcp-servers.example.json`, adjust the paths, and put it in your
client's MCP config.

> **macOS pitfall (learned the hard way):** MCP clients spawn servers with a
> stripped environment. If `npx` is not on that PATH, the server silently
> fails to start and *no tools appear, with no error*. Always use the
> **absolute path** to `npx` and pass `env.PATH` explicitly, as the example
> config does.

Restart the client.

**Accept:** in a fresh session, ask the brain to (1) create a file in your
allowlisted folder, write one line, read it back; (2) run a harmless terminal
command such as `ls`. Both must succeed. Then set Desktop Commander's
`allowedDirectories` to that folder only (its `set_config_value` tool).

## Step 2 — ego, the logged-in browser (install once, verify here)

Install [ego (lite)](https://lite.ego.app), migrate your Chrome state when it
offers, and make sure the `ego-browser` skill is visible to your brain client
(ego installs it for common clients on first run; activate with `/ego-browser`).

Division of labour, write it down for your brain: **needs your login → ego;
does not need login / must be reproducible → Playwright (Step 3).**

**Accept:** the brain opens a Space in ego, loads a site you are logged into,
takes a semantic snapshot, finds a named button and clicks it — without
touching the tabs you are personally using.

## Step 3 — Playwright MCP, the clean browser

Already in the example config from Step 1 (`@playwright/mcp`). Restart the
client if you added it later.

**Accept:** in a fresh (logged-out) browser, the brain opens a public page,
fills a form, submits it, and reads the result back from a new snapshot.
Actions must target snapshot refs, not coordinates.

## Step 4 — Cua Driver, the desktop layer

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver permissions grant   # grant Accessibility + Screen Recording to CuaDriver.app itself, not to your terminal
cua-driver mcp-config          # prints the exact MCP registration for your machine — use it, don't hand-copy paths
```

Add what `mcp-config` prints to your client config and restart.

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

Example: download a file from a logged-in site with **ego** → rename and
inspect it locally with **Desktop Commander** → open a local app with
**Cua Driver** and enter the result. Every layer participates, every step is
verified.

**Accept:** end state matches what you asked for, and the task log shows which
layer did what.

## Step 7 — Solidify it into a script

Save the Step 6 flow into `workflows/` (ego batch JS and/or shell), following
`workflows/README.md`. Run it again — this time as a script, not as the brain
improvising.

**Accept:** same result, faster, and nothing was left to guesswork.

V1 is done. Remote access, a second brain client, and Chrome DevTools MCP are
V2 topics — do not bolt them on early.

# Can — omni-commander V2 web edition plan

Decided 2026-11-05. V1 (see `docs/SETUP.md`) proved the layers on one machine
with a local brain. V2 turns that into the owner's own product, in the shape
of the reference he pointed at on day one: **chat with ChatGPT in a browser,
see and control your own computer.**

## Product identity

- The product is the owner's own: **his name, his icon** on every surface a
  user can see — gateway pages, the local agent app, the connector entry in
  ChatGPT. Product name: **Can** (chosen by the owner 2026-11-05; the
  repository keeps the `omni-commander` name for now).
- Third-party components may run *inside*, never as the product's face.

## Shape — three parts

1. **Web brain.** ChatGPT in the browser. Nothing to build; the gateway is
   registered there as a custom MCP connector.
2. **Gateway (his).** A small cloud service under his name/icon: OAuth login,
   one HTTPS MCP endpoint, and a relay to the local agent. It authenticates
   and forwards — it does not store computer data.
3. **Local agent (his).** A resident app on the owner's computer, his name
   and icon. It dials *out* to the gateway (no inbound ports on the
   computer), receives tool calls, executes them locally, and reports back.

## Safety model (the part that must not regress)

- The allowlist and the hand-off list are enforced **by the local agent, on
  the computer** — never merely promised by the web brain. A confused or
  manipulated chat cannot talk the agent past them.
- Remote-originated calls are stricter than local ones: the agent knows
  which side a call came from and applies the stricter rule set.
- Single user: the owner. No multi-user, no billing, no public sign-up.

## Steps (one at a time, each verified before the next)

- **Step 0 — Name and icon.** Done 2026-11-05: product name **Can**;
  icon supplied by the owner (glossy white rounded-triangle play mark,
  `assets/can-icon.png`). Every later surface uses them.
- **Step 1 — Web chain proof (the critical one).** Minimal gateway: branded
  login page + MCP endpoint + relay, registered as a custom connector in
  ChatGPT web, exposing exactly one harmless tool (report whether the
  computer is online). *Accept:* in a ChatGPT web conversation, the tool
  answers from the real computer.
- **Step 2 — The agent stands up.** Resident app on the Mac with the
  product's name and icon: connects out to the gateway, shows connection
  state, survives restart. Shell first, polish later.
- **Step 3 — Layers move in, one by one.** Files/terminal first, then the
  two browser layers, then desktop. The V1 stack becomes the agent's
  internals: Desktop Commander and Playwright run headless inside; ego
  stays the owner's own browser; **Cua Driver runs as an internal engine
  behind the agent** (owner's decision, 2026-11-05) — invisible in daily
  use, still named in the OS permission list until Step 6.
- **Step 4 — Local guardrails.** The agent enforces the allowlist and
  hand-off list itself, with the stricter remote rule set, and keeps a
  local log of every executed call.
- **Step 5 — Full acceptance.** From a ChatGPT web conversation, run
  workflow 01 (`workflows/01-x-profile-to-notes.md`) by name through the
  whole chain; then repeat the command from a *different device's* browser
  (e.g. phone) and watch the Mac execute it.
- **Step 6 and beyond (not V2's first release).** Replace the internal Cua
  engine with a home-grown native accessibility helper, so even the OS
  permission list carries only the product's own name. Windows agent after
  that.

## What carries over from V1

The four layers and their verified behaviour, the router rules, the
hand-off list, and workflow 01 as the standing acceptance test. V1's local
Codex setup keeps working throughout — V2 adds the web product beside it,
it does not tear V1 down.

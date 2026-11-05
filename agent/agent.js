#!/usr/bin/env node
"use strict";
/* Can agent — omni-commander V2, Steps 2-3.
 * Runs on the owner's Mac. Dials OUT to the Can gateway (no inbound
 * ports): heartbeat every 20s, long-polls for tool jobs, executes them
 * locally, posts results back. Node built-ins only.
 * Tools:
 *   can_status      -> this computer's identity + liveness
 *   can_write_note  -> append a line to write-log.txt in this folder
 *   can_list_files  -> list a folder inside the work folder (Step 3)
 *   can_read_file   -> read a text file inside the work folder
 *   can_write_file  -> create a NEW file inside the work folder
 *                      (refuses to overwrite)
 *   can_run_command -> run a shell command with cwd = work folder
 *   can_browser_*   -> drive Google Chrome via CDP with a dedicated
 *                      Can profile (NOT the owner's daily browser):
 *                      open / snapshot (refs) / click / type / close
 *   can_ego_*       -> drive the owner's DAILY browser (ego lite, with
 *                      the owner's logins) through the ego-browser CLI:
 *                      spaces / claim / open / snapshot / click / type /
 *                      finish. "can" space = Can's own task space in the
 *                      daily browser; "user" space = the owner's own
 *                      space (the pages he has open), claimed on his
 *                      explicit request.
 *   can_desktop_*   -> UI-automation layer over ANY app window, via
 *                      the Cua Driver running as a private internal
 *                      engine (spawned as `cua-driver mcp`, stdio):
 *                      windows / open_app / snapshot (refs d1...) /
 *                      click / type / key. Also the way Can operates
 *                      browsers other than ego (snapshot the browser
 *                      window, click its elements; no plugin).
 * File tools are confined to the work folder (config.workRoot):
 * absolute paths, ".." escapes and symlink escapes are refused.
 * can_run_command has a 30s timeout, capped output, and a blocklist
 * of catastrophic patterns. Step 4 fence (below, before dispatch):
 * sensitive tools need the owner's click on a native Mac dialog,
 * and every call is written to audit.log.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, exec, execFile, spawn } = require("child_process");
const net = require("net");

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const GATEWAY = String(cfg.gateway || "").replace(/\/+$/, "");
const KEY = cfg.agentKey || "";
const NAME = cfg.name || "Can agent (Mac)";
const ROOT = cfg.workRoot || "/Users/cyou/commander-work";
const REAL_ROOT = fs.existsSync(ROOT) ? fs.realpathSync(ROOT) : ROOT;
const STARTED = Date.now();
const LOG = path.join(DIR, "agent.log");
const STATUS = path.join(DIR, "status.json");
const WRITELOG = path.join(DIR, "write-log.txt");
const AGENT_VERSION = "0.9.1";

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch (e) {}
  process.stdout.write(line);
}

function computerName() {
  try { return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim(); }
  catch (e) { return os.hostname(); }
}
function macosVersion() {
  try { return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(); }
  catch (e) { return os.release(); }
}
const COMPUTER = computerName();
const MACOS = macosVersion();

function writeStatus(state, extra) {
  const s = Object.assign({
    product: "Can", state, pid: process.pid,
    computer: COMPUTER, macos: MACOS,
    started_at: new Date(STARTED).toISOString(),
    updated_at: new Date().toISOString(),
  }, extra || {});
  try { fs.writeFileSync(STATUS, JSON.stringify(s, null, 2)); } catch (e) {}
}

async function api(method, p, body, timeoutMs) {
  const resp = await fetch(GATEWAY + p, {
    method,
    headers: { "X-Agent-Key": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 30000),
  });
  return resp;
}

async function heartbeat() {
  const resp = await api("POST", "/agent/heartbeat", {
    agent_id: "mac-1", name: NAME, hostname: os.hostname(),
    os: `macOS ${MACOS}`, version: AGENT_VERSION,
  }, 10000);
  if (!resp.ok) throw new Error("heartbeat HTTP " + resp.status);
  writeStatus("connected", { last_heartbeat: new Date().toISOString() });
}

/* ---------------------------------------------------------- file layer */
function resolveInRoot(rel) {
  if (typeof rel !== "string" || rel === "") rel = ".";
  if (path.isAbsolute(rel)) throw new Error("absolute paths are not allowed; use a path relative to the work folder");
  const candidate = path.resolve(ROOT, rel);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) {
    throw new Error("path escapes the work folder");
  }
  let probe = candidate;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  if (real !== REAL_ROOT && !real.startsWith(REAL_ROOT + path.sep)) {
    throw new Error("path escapes the work folder (symlink)");
  }
  return candidate;
}

function toolListFiles(args) {
  const rel = (args && args.path) || ".";
  const target = resolveInRoot(rel);
  const st = fs.statSync(target);
  if (!st.isDirectory()) throw new Error("not a folder: " + rel);
  const names = fs.readdirSync(target).sort();
  const entries = names.slice(0, 200).map((name) => {
    const s = fs.statSync(path.join(target, name));
    return { name, type: s.isDirectory() ? "dir" : "file", size: s.isFile() ? s.size : undefined };
  });
  return JSON.stringify({ path: rel, entries, truncated: names.length > 200 });
}

function toolReadFile(args) {
  const rel = (args && args.path) || "";
  const target = resolveInRoot(rel);
  const st = fs.statSync(target);
  if (!st.isFile()) throw new Error("not a file: " + rel);
  if (st.size > 262144) throw new Error("file too large to read (limit 256KB)");
  const buf = fs.readFileSync(target);
  if (buf.subarray(0, 4096).includes(0)) throw new Error("file looks binary; not returned");
  const text = buf.toString("utf8");
  const cap = 32000;
  return JSON.stringify({
    path: rel, size: st.size,
    content: text.slice(0, cap), truncated: text.length > cap,
  });
}

function toolWriteFile(args) {
  const rel = (args && args.path) || "";
  const content = String((args && args.content) ?? "");
  const target = resolveInRoot(rel);
  if (fs.existsSync(target)) {
    throw new Error("file already exists; refusing to overwrite: " + rel);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realParent = fs.realpathSync(path.dirname(target));
  if (realParent !== REAL_ROOT && !realParent.startsWith(REAL_ROOT + path.sep)) {
    throw new Error("path escapes the work folder (symlink)");
  }
  fs.writeFileSync(target, content, "utf8");
  return JSON.stringify({ written: true, path: rel, bytes: Buffer.byteLength(content, "utf8") });
}

/* ------------------------------------------------------- terminal layer */
const BLOCKED = [
  /(^|[;&|]\s*)sudo\b/,
  /rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/,
  /rm\s+(-[a-zA-Z]+\s+)+(\/|~|\$HOME)/,
  /\bmkfs\b|\bdd\s+[^|]*\bif=/,
  /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|disk|rdisk)/,
  />\s*\/(etc|System|usr|bin|sbin|Library)\//,
  /launchctl\s+(bootout|unload)\b/,
  /\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
  /\bosascript\b/,
  /\bdiskutil\s+(erase|zero|secureErase|reformat)\b/,
  /\bkillall\b|\bpkill\b/,
  /\bdefaults\s+delete\b|\bnvram\b|\bcsrutil\b|\bspctl\b/,
  /\bchown\s+-R\b[^|;&]*\s\//,
  /\bchmod\s+-R\b[^|;&]*\s\//,
];

function blockedByPattern(command) {
  for (const re of BLOCKED) {
    if (re.test(command)) return true;
  }
  return false;
}

function toolRunCommand(args) {
  const command = String((args && args.command) || "");
  if (!command.trim()) throw new Error("empty command");
  if (blockedByPattern(command)) {
    return Promise.resolve(JSON.stringify({
      error: "blocked_pattern",
      detail: "This command matches a blocked catastrophic pattern and was not run.",
      command,
    }));
  }
  return new Promise((resolve) => {
    exec(command, {
      cwd: ROOT, shell: "/bin/zsh", timeout: 30000, maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, {
        PATH: "/Users/cyou/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      }),
    }, (err, stdout, stderr) => {
      const out = String(stdout || ""), errOut = String(stderr || "");
      resolve(JSON.stringify({
        command, work_folder: ROOT,
        exit_code: err ? (typeof err.code === "number" ? err.code : null) : 0,
        timed_out: Boolean(err && err.killed && err.signal === "SIGTERM"),
        stdout: out.slice(0, 8000), stderr: errOut.slice(0, 2000),
        truncated: out.length > 8000 || errOut.length > 2000,
      }));
    });
  });
}

/* -------------------------------------------------------- browser layer */
/* Drives the installed Google Chrome over CDP (DevTools protocol) with
 * a dedicated Can profile (~/can-agent/browser-profile) — NOT the
 * owner's daily browser and NOT any logged-in profile. Zero-dep:
 * Node's built-in WebSocket speaks to Chrome's debugging socket. */
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BROWSER_PROFILE = path.join(DIR, "browser-profile");
let browser = null; // { proc, ws, sessionId, seq, pending: Map }

function cdpSend(b, method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++b.seq;
    b.pending.set(id, { resolve, reject });
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    b.ws.send(JSON.stringify(msg));
  });
}

async function ensureBrowser() {
  if (browser && browser.ws && browser.ws.readyState === 1) return browser;
  if (!fs.existsSync(CHROME_BIN)) throw new Error("Google Chrome is not installed");
  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  const proc = spawn(CHROME_BIN, [
    "--remote-debugging-port=0",
    "--user-data-dir=" + BROWSER_PROFILE,
    "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome DevTools did not start in 20s")), 20000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", () => { clearTimeout(timer); reject(new Error("Chrome exited early")); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const b = { proc, ws, sessionId: null, seq: 0, pending: new Map() };
  browser = b;
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && b.pending.has(msg.id)) {
      const p = b.pending.get(msg.id);
      b.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result || {});
    }
  });
  ws.addEventListener("close", () => { if (browser === b) browser = null; });
  proc.on("exit", () => { if (browser === b) browser = null; });
  const { targetId } = await cdpSend(b, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdpSend(b, "Target.attachToTarget", { targetId, flatten: true });
  b.sessionId = sessionId;
  await cdpSend(b, "Page.enable", {}, sessionId);
  await cdpSend(b, "Runtime.enable", {}, sessionId);
  return b;
}

async function evalJs(expression) {
  const b = await ensureBrowser();
  const r = await cdpSend(b, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }, b.sessionId);
  if (r.exceptionDetails) {
    const t = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "page JS error";
    throw new Error(String(t).slice(0, 300));
  }
  return r.result ? r.result.value : undefined;
}

async function waitReady(maxMs) {
  const deadline = Date.now() + (maxMs || 9000);
  while (Date.now() < deadline) {
    const state = await evalJs("document.readyState").catch(() => "complete");
    if (state === "complete" || state === "interactive") return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function toolBrowserOpen(args) {
  const url = String((args && args.url) || "");
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  const b = await ensureBrowser();
  await cdpSend(b, "Page.navigate", { url }, b.sessionId);
  await waitReady(9000);
  const info = await evalJs("({url: location.href, title: document.title})");
  return JSON.stringify({ opened: true, url: info.url, title: info.title });
}

const SNAPSHOT_JS = `(() => {
  document.querySelectorAll("[data-can-ref]").forEach((el) => el.removeAttribute("data-can-ref"));
  const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [onclick]';
  const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
    const r = el.getClientRects();
    const s = getComputedStyle(el);
    return r.length > 0 && s.visibility !== "hidden" && s.display !== "none";
  });
  const lines = [];
  els.slice(0, 120).forEach((el, i) => {
    const ref = "e" + (i + 1);
    el.setAttribute("data-can-ref", ref);
    const tag = el.tagName.toLowerCase();
    let kind = tag;
    if (tag === "input") kind = "input[type=" + (el.getAttribute("type") || "text") + "]";
    const label = (el.getAttribute("aria-label") || "").trim()
      || (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : "")
      || (el.getAttribute("placeholder") || "").trim()
      || (el.getAttribute("name") || "").trim()
      || (el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 60);
    const val = tag === "input" || tag === "textarea" || tag === "select" ? (el.value || "") : "";
    lines.push(ref + " " + kind + (label ? " \\"" + label + "\\"" : "") + (val ? " value=\\"" + val + "\\"" : ""));
  });
  return { url: location.href, title: document.title, elements: lines,
           text: (document.body ? document.body.innerText : "").slice(0, 1500),
           element_count: els.length, truncated: els.length > 120 };
})()`;

async function toolBrowserSnapshot() {
  await ensureBrowser();
  const snap = await evalJs(SNAPSHOT_JS);
  return JSON.stringify(snap);
}

async function toolBrowserClick(args) {
  const ref = String((args && args.ref) || "");
  if (!/^e\d+$/.test(ref)) throw new Error("ref must look like e3 (from can_browser_snapshot)");
  const out = await evalJs(`(() => {
    const el = document.querySelector('[data-can-ref="${ref}"]');
    if (!el) return { clicked: false, error: "ref not found; take a fresh snapshot" };
    el.scrollIntoView({ block: "center" });
    el.click();
    return { clicked: true, tag: el.tagName.toLowerCase(),
             text: (el.innerText || el.value || "").trim().slice(0, 80) };
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  await waitReady(6000).catch(() => {});
  const info = await evalJs("({url: location.href, title: document.title})").catch(() => ({}));
  return JSON.stringify(Object.assign({}, out, info));
}

async function toolBrowserType(args) {
  const ref = String((args && args.ref) || "");
  const text = String((args && args.text) ?? "");
  const submit = Boolean(args && args.submit);
  if (!/^e\d+$/.test(ref)) throw new Error("ref must look like e3 (from can_browser_snapshot)");
  const out = await evalJs(`(() => {
    const el = document.querySelector('[data-can-ref="${ref}"]');
    if (!el) return { typed: false, error: "ref not found; take a fresh snapshot" };
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    let submitted = false;
    if (${submit ? "true" : "false"}) {
      if (el.form) { el.form.requestSubmit(); submitted = true; }
      else {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        submitted = true;
      }
    }
    return { typed: true, submitted, value_length: el.value.length };
  })()`);
  if (submit) {
    await new Promise((r) => setTimeout(r, 900));
    await waitReady(6000).catch(() => {});
  }
  const info = await evalJs("({url: location.href, title: document.title})").catch(() => ({}));
  return JSON.stringify(Object.assign({}, out, info));
}

async function toolBrowserClose() {
  if (!browser) return JSON.stringify({ closed: true, was_running: false });
  const b = browser;
  browser = null;
  await Promise.race([
    cdpSend(b, "Browser.close", {}).catch(() => {}),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  try { b.ws.close(); } catch (e) {}
  try { b.proc.kill(); } catch (e) {}
  return JSON.stringify({ closed: true, was_running: true });
}

process.on("exit", () => { if (browser) { try { browser.proc.kill(); } catch (e) {} } });

/* ------------------------------------------------------------ ego layer */
/* The owner's daily browser is ego lite. Its automation surface is the
 * `ego-browser nodejs` runtime: each call runs a fresh Node script with
 * ego globals (taskSpace, claimTaskSpace, listTaskSpaces, Page API).
 * Scripts print one "CAN_RESULT {json}" line for the agent to parse. */
const EGO_BIN = "/Users/cyou/.local/bin/ego-browser";
const EGO_STATE = path.join(DIR, "ego-state.json");
const EGO_CAN_SPACE = "Can";

function egoState() {
  try { return JSON.parse(fs.readFileSync(EGO_STATE, "utf8")); }
  catch (e) { return {}; }
}
function saveEgoState(patch) {
  const s = Object.assign(egoState(), patch);
  fs.writeFileSync(EGO_STATE, JSON.stringify(s, null, 2) + "\n");
  return s;
}

function runEgo(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(EGO_BIN, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      reject(new Error("ego script timed out"));
    }, timeoutMs || 100000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // ego may route console output to either stream; find the marker
      // anywhere in the combined output and parse to end of that line.
      const combined = out + "\n" + err;
      const idx = combined.indexOf("CAN_RESULT ");
      if (idx >= 0) {
        const rest = combined.slice(idx + "CAN_RESULT ".length);
        const line = rest.split("\n")[0];
        try { resolve(JSON.parse(line)); return; }
        catch (e) { /* fall through to error */ }
      }
      reject(new Error("ego failed (exit " + code + "): " + (err || out).slice(-600)));
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

const EGO_USER_PAGE_FN = `
async function userPageOf(task) {
  let page = task.userPage();
  try { await page.url(); return page; } catch (e) {}
  const tabs = await task.tabs();
  const t = tabs.find((x) => x.active) || tabs[0];
  if (t && !t.label) page = await task.adopt(t.page);
  else if (t && t.label) page = task.page(t.label);
  return page;
}
`;

function egoTaskSnippet(space) {
  if (space === "user") {
    const id = egoState().userSpaceId;
    if (!id) throw new Error("no user space claimed yet; call can_ego_claim first");
    return `let task; try { task = await taskSpace(${Number(id)}); } catch (e) { task = await claimTaskSpace(${Number(id)}); }\n`;
  }
  return `const task = await taskSpace(${JSON.stringify(EGO_CAN_SPACE)});\n`;
}

function egoPageSnippet(space) {
  if (space === "user") return EGO_USER_PAGE_FN + "const page = await userPageOf(task);\n";
  return 'const page = task.page("p1");\n';
}

async function toolEgoSpaces() {
  const r = await runEgo(
    'const spaces = await listTaskSpaces();\n' +
    'console.log("CAN_RESULT " + JSON.stringify(spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership }))));\n');
  return JSON.stringify({ spaces: r });
}

async function toolEgoClaim(args) {
  const id = Number(args && args.space_id);
  if (!Number.isFinite(id) || id < 0) throw new Error("space_id must be a number from can_ego_spaces");
  const script =
    `const task = await claimTaskSpace(${id});\n` +
    "let url = null, title = null;\n" +
    "try { const p = task.userPage(); url = await p.url(); title = await p.title(); } catch (e) {}\n" +
    'console.log("CAN_RESULT " + JSON.stringify({ claimed: true, spaceId: task.spaceId, name: task.name, user_page: { url, title } }));\n';
  const r = await runEgo(script);
  saveEgoState({ userSpaceId: id });
  return JSON.stringify(r);
}

async function toolEgoOpen(args) {
  const url = String((args && args.url) || "");
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  const script =
    egoTaskSnippet("can") +
    egoPageSnippet("can") +
    `await page.goto(${JSON.stringify(url)});\n` +
    'console.log("CAN_RESULT " + JSON.stringify({ spaceId: task.spaceId, url: await page.url(), title: await page.title() }));\n';
  const r = await runEgo(script);
  return JSON.stringify(r);
}

async function toolEgoSnapshot(args) {
  const space = args && args.space === "user" ? "user" : "can";
  const script =
    egoTaskSnippet(space) +
    egoPageSnippet(space) +
    "const snap = await page.snapshot();\n" +
    'console.log("CAN_RESULT " + JSON.stringify({ spaceId: task.spaceId, url: await page.url(), snapshot: snap }));\n';
  const r = await runEgo(script);
  const SNAP_CAP = 12000;
  if (typeof r.snapshot === "string" && r.snapshot.length > SNAP_CAP) {
    r.snapshot = r.snapshot.slice(0, SNAP_CAP);
    r.truncated = true;
  }
  return JSON.stringify(r);
}

async function toolEgoClick(args) {
  const space = args && args.space === "user" ? "user" : "can";
  const target = String((args && args.target) || "");
  if (!target) throw new Error("target is required (a snapshot ref like @21 or a selector)");
  const script =
    egoTaskSnippet(space) +
    egoPageSnippet(space) +
    `await page.click(${JSON.stringify(target)}, { label: "Can click" });\n` +
    'console.log("CAN_RESULT " + JSON.stringify({ clicked: true, url: await page.url(), title: await page.title() }));\n';
  const r = await runEgo(script);
  return JSON.stringify(r);
}

async function toolEgoType(args) {
  const space = args && args.space === "user" ? "user" : "can";
  const target = String((args && args.target) || "");
  const text = String((args && args.text) ?? "");
  if (!target) throw new Error("target is required (a snapshot ref like @21 or a selector)");
  const script =
    egoTaskSnippet(space) +
    egoPageSnippet(space) +
    `await page.fill(${JSON.stringify(target)}, ${JSON.stringify(text)});\n` +
    'console.log("CAN_RESULT " + JSON.stringify({ filled: true, url: await page.url() }));\n';
  const r = await runEgo(script);
  return JSON.stringify(r);
}

async function toolEgoFinish() {
  const script =
    egoTaskSnippet("can") +
    "await task.finish({ keep: [] });\n" +
    'console.log("CAN_RESULT " + JSON.stringify({ finished: true }));\n';
  const r = await runEgo(script);
  return JSON.stringify(r);
}

/* ------------------------------------------------- desktop (UI automation) */
/* Desktop layer: Can drives ANY app's window from the outside via the
 * Cua Driver, which runs INSIDE this agent as a private internal
 * engine (the product surface stays Can; Cua is never exposed to the
 * user or the brain). The agent spawns `cua-driver mcp` (stdio)
 * lazily and speaks MCP/JSON-RPC to it over the child's pipes.
 * Flow mirrors the other layers: list windows / open app -> snapshot
 * (accessibility elements with refs d1, d2, ...) -> click / type /
 * key by ref. Actions run in the background (no focus steal) and are
 * fence-gated (see the fence section). This layer is also how Can
 * operates browsers other than ego (e.g. Chrome): snapshot the
 * browser's window and click its elements -- no plugin anywhere
 * (the extension route was built, verified, then dropped on the
 * owner's decision, 2026-11-05). */
const CUA_BIN = cfg.cuaPath || "/Users/cyou/.local/bin/cua-driver";
// Unique per agent process: the driver daemon tombstones a session
// label when the transport that created it dies, so reusing a fixed
// label across agent restarts ends in "session has ended" /
// "session is not available to this transport" (verified 2026-11-05).
const CUA_SESSION = "can-" + process.pid;
let cuaChild = null;
let cuaBuf = "";
let cuaSeq = 0;
const cuaPending = new Map();
let cuaReady = null;
let deskLast = null; // { pid, window_id, app, title }
const deskSnaps = new Map(); // "pid:window_id" -> { tokens: Map<index, token> }

function cuaSpawn() {
  const child = spawn(CUA_BIN, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  cuaChild = child;
  cuaBuf = "";
  child.stdout.on("data", (d) => {
    cuaBuf += d.toString("utf8");
    let i;
    while ((i = cuaBuf.indexOf("\n")) >= 0) {
      const line = cuaBuf.slice(0, i);
      cuaBuf = cuaBuf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id !== undefined && cuaPending.has(m.id)) {
        const p = cuaPending.get(m.id);
        cuaPending.delete(m.id);
        if (m.error) p.reject(new Error("cua: " + String((m.error && m.error.message) || JSON.stringify(m.error)).slice(0, 300)));
        else p.resolve(m.result);
      }
    }
  });
  child.stderr.on("data", () => {});
  const drop = () => {
    if (cuaChild === child) { cuaChild = null; cuaReady = null; }
    deskSnaps.clear();
    for (const [id, p] of cuaPending) { cuaPending.delete(id); p.reject(new Error("cua driver exited")); }
  };
  child.on("exit", drop);
  child.on("error", drop);
  cuaReady = (async () => {
    const r = await cuaRequest("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "can-agent", version: AGENT_VERSION },
    });
    try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); } catch (e) {}
    // The driver daemon ties tool calls to a named session; open ours
    // explicitly (a bare tools/call works only while an implicit
    // session happens to be alive, and it dies with our child process).
    try {
      await cuaRequest("tools/call", { name: "start_session", arguments: { session: CUA_SESSION } });
    } catch (e) { log("cua start_session note: " + String(e && e.message || e).slice(0, 160)); }
    log("cua driver connected (internal desktop engine)");
    return r;
  })();
  return cuaReady;
}

function cuaRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!cuaChild || !cuaChild.stdin.writable) return reject(new Error("cua driver not running"));
    const id = ++cuaSeq;
    const timer = setTimeout(() => { cuaPending.delete(id); reject(new Error("cua call timed out: " + method)); }, 60000);
    cuaPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    cuaChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
}

function cuaText(result) {
  try {
    const parts = (result && result.content) || [];
    for (const p of parts) if (p && p.type === "text" && p.text) return p.text;
  } catch (e) {}
  return "";
}

async function cuaCallFull(name, args, retried) {
  if (!cuaChild) cuaSpawn();
  await cuaReady;
  const result = await cuaRequest("tools/call", {
    name, arguments: Object.assign({ session: CUA_SESSION }, args || {}),
  });
  if (result && result.isError) {
    const msg = cuaText(result) || ("cua tool failed: " + name);
    // The daemon-side session can end under us (e.g. our previous
    // child died); reopen it and retry the call exactly once.
    if (!retried && /session has ended|start_session/i.test(msg) && name !== "start_session") {
      try { await cuaRequest("tools/call", { name: "start_session", arguments: { session: CUA_SESSION } }); } catch (e) {}
      return cuaCallFull(name, args, true);
    }
    throw new Error(msg);
  }
  return { sc: (result && result.structuredContent) || null, text: cuaText(result), raw: result || {} };
}

async function cuaCall(name, args) {
  const { sc, text } = await cuaCallFull(name, args);
  if (sc) return sc;
  if (text) { try { return JSON.parse(text); } catch (e) { return { text }; } }
  return {};
}

async function cuaListWindows(app) {
  // Always fetch the unfiltered list and match locally: the driver's
  // own app filter matches localized app names only (Calculator ->
  // 0 hits while it runs as 计算器) and misses off-screen windows.
  const r = await cuaCall("list_windows", {});
  let wins = Array.isArray(r) ? r : (r.windows || []);
  if (!Array.isArray(wins)) wins = [];
  if (app) {
    const q = String(app).toLowerCase();
    wins = wins.filter((w) => {
      const n = String(w.app_name || w.app || "").toLowerCase();
      return n && (n.includes(q) || q.includes(n));
    });
  }
  return wins;
}

function deskKey(pid, wid) { return pid + ":" + wid; }

async function deskResolveWindow(args) {
  const a = args || {};
  if (a.pid && a.window_id) {
    return { pid: Number(a.pid), window_id: Number(a.window_id), app: "", title: "" };
  }
  if (a.app) {
    const wins = await cuaListWindows(String(a.app));
    if (wins.length) {
      const w = wins.find((x) => x.is_on_screen) || wins[0];
      return { pid: w.pid, window_id: w.window_id, app: w.app_name || String(a.app), title: w.title || "" };
    }
    // No local match (the app may run under a localized name, e.g.
    // Calculator runs as 计算器): let the driver's launch_app resolve
    // the name -- on an already-running app it returns its windows.
    const r = await cuaCall("launch_app", { name: String(a.app) });
    const lw = Array.isArray(r.windows) ? r.windows : [];
    const w = lw.find((x) => x.is_on_screen) || lw[0];
    if (w) return { pid: w.pid, window_id: w.window_id, app: String(a.app), title: w.title || "" };
    throw new Error("no open window found for app: " + a.app);
  }
  if (deskLast) return deskLast;
  throw new Error("no window selected yet: call can_desktop_windows, can_desktop_open_app, or can_desktop_snapshot with an app name first");
}

async function toolDesktopWindows(args) {
  const wins = await cuaListWindows((args && args.app) || "");
  return JSON.stringify({
    count: wins.length,
    windows: wins.slice(0, 60).map((w) => ({
      pid: w.pid, window_id: w.window_id,
      app: w.app_name || w.app || "", title: String(w.title || "").slice(0, 120),
      on_screen: Boolean(w.is_on_screen),
    })),
  });
}

async function toolDesktopOpenApp(args) {
  const name = String((args && args.name) || "").trim();
  if (!name) throw new Error("name is required (e.g. Calculator, Google Chrome, Notes)");
  const r = await cuaCall("launch_app", { name });
  let wins = Array.isArray(r.windows) ? r.windows : [];
  const pid = r.pid || (wins[0] && wins[0].pid) || 0;
  if (!wins.length && pid) {
    const all = await cuaListWindows("");
    wins = all.filter((w) => w.pid === pid);
  }
  const w = wins.find((x) => x.is_on_screen) || wins[0];
  if (w) deskLast = { pid: w.pid, window_id: w.window_id, app: name, title: w.title || "" };
  return JSON.stringify({
    launched: true, app: name, pid,
    windows: wins.map((x) => ({
      pid: x.pid, window_id: x.window_id,
      title: String(x.title || "").slice(0, 120), on_screen: Boolean(x.is_on_screen),
    })),
  });
}

async function toolDesktopSnapshot(args) {
  const win = await deskResolveWindow(args);
  const full = await cuaCallFull("get_window_state", {
    pid: win.pid, window_id: win.window_id,
    tree_format: "both", include_screenshot: false,
  });
  const r = full.sc || {};
  // The markdown rendering carries readouts some apps never expose as
  // elements (e.g. the Calculator display); pass it through, trimmed.
  let treeText = "";
  if (full.text && full.text.trim() && !full.text.trim().startsWith("{")) {
    treeText = full.text.slice(0, 6000);
  }
  const els = Array.isArray(r.elements) ? r.elements : [];
  const tokens = new Map();
  const out = [];
  for (const el of els) {
    if (el.element_index === undefined || !el.element_token) continue;
    tokens.set(Number(el.element_index), el.element_token);
    out.push({
      ref: "d" + el.element_index,
      role: String(el.role || "").slice(0, 40),
      label: String(el.label || "").slice(0, 120),
      value: el.value === undefined || el.value === null ? "" : String(el.value).slice(0, 120),
    });
  }
  deskSnaps.set(deskKey(win.pid, win.window_id), { tokens });
  deskLast = {
    pid: win.pid, window_id: win.window_id,
    app: win.app || (deskLast && deskLast.app) || "",
    title: win.title || (deskLast && deskLast.title) || "",
  };
  return JSON.stringify({
    window: { pid: win.pid, window_id: win.window_id, app: deskLast.app, title: deskLast.title },
    count: out.length, truncated: Boolean(r.truncated),
    elements: out, tree: treeText || undefined,
  });
}

async function deskResolveAction(args) {
  const win = await deskResolveWindow(args);
  const ref = String((args && args.ref) || "");
  if (!/^d\d+$/.test(ref)) throw new Error("ref must come from can_desktop_snapshot (e.g. d3)");
  const snap = deskSnaps.get(deskKey(win.pid, win.window_id));
  if (!snap) throw new Error("no snapshot for this window yet: call can_desktop_snapshot first");
  const token = snap.tokens.get(Number(ref.slice(1)));
  if (!token) throw new Error("ref " + ref + " is not in the latest snapshot of this window; take a fresh snapshot");
  return { win, token };
}

async function toolDesktopClick(args) {
  const { win, token } = await deskResolveAction(args);
  await cuaCall("click", { pid: win.pid, window_id: win.window_id, element_token: token, action: "press" });
  return JSON.stringify({ clicked: true, ref: args.ref, window: { pid: win.pid, window_id: win.window_id } });
}

async function toolDesktopType(args) {
  const { win, token } = await deskResolveAction(args);
  const text = String((args && args.text) || "");
  try {
    await cuaCall("type_text", { pid: win.pid, window_id: win.window_id, element_token: token, text });
  } catch (e) {
    // Some elements only accept a direct value write.
    await cuaCall("set_value", { pid: win.pid, window_id: win.window_id, element_token: token, value: text });
  }
  return JSON.stringify({ typed: true, ref: args.ref });
}

async function toolDesktopKey(args) {
  const win = await deskResolveWindow(args);
  const key = String((args && args.key) || "").trim().toLowerCase();
  if (!key) throw new Error("key is required (e.g. return, tab, escape)");
  const callArgs = { pid: win.pid, window_id: win.window_id, key };
  const ref = String((args && args.ref) || "");
  if (ref) {
    if (!/^d\d+$/.test(ref)) throw new Error("ref must come from can_desktop_snapshot (e.g. d3)");
    const snap = deskSnaps.get(deskKey(win.pid, win.window_id));
    const token = snap && snap.tokens.get(Number(ref.slice(1)));
    if (!token) throw new Error("ref " + ref + " is not in the latest snapshot of this window; take a fresh snapshot");
    callArgs.element_token = token;
  }
  await cuaCall("press_key", callArgs);
  return JSON.stringify({ pressed: true, key });
}

// Run a whole sequence of desktop actions in ONE tool call, locally, without
// a network/model round trip per step. This is the main speed lever for
// multi-step desktop work: the model plans the sequence once, the agent
// executes it end to end and returns per-step results plus the last snapshot.
async function toolDesktopBatch(args) {
  const steps = Array.isArray(args && args.steps) ? args.steps.slice(0, 12) : [];
  if (!steps.length) throw new Error("steps must be a non-empty array");
  const out = [];
  let lastSnapshot = null;
  // click/type steps may name an element by its visible label instead of a
  // ref; resolve against the latest in-batch snapshot so the model can plan
  // a whole sequence in one call without knowing refs in advance.
  const resolveRef = (s) => {
    if (s.ref) return s.ref;
    if (!s.label || !lastSnapshot) return s.ref;
    const els = lastSnapshot.elements || [];
    const want = String(s.label);
    const hit = els.find((e) => e.label === want) || els.find((e) => e.label && e.label.includes(want));
    return hit ? hit.ref : s.ref;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const op = String(s.op || "");
    try {
      if (op === "open_app") {
        const r = JSON.parse(await toolDesktopOpenApp({ name: s.name }));
        out.push({ step: i, op, ok: true, pid: r.pid });
      } else if (op === "snapshot") {
        lastSnapshot = JSON.parse(await toolDesktopSnapshot(s));
        out.push({ step: i, op, ok: true, count: lastSnapshot.count });
      } else if (op === "click") {
        const ref = resolveRef(s);
        if (!ref) {
          const labels = ((lastSnapshot && lastSnapshot.elements) || []).map((e) => e.label).filter(Boolean).slice(0, 40).join(" | ");
          throw new Error("click step needs a ref or a label matching the last snapshot" + (s.label ? ` (no element labelled "${s.label}")` : "") + (labels ? `; available labels: ${labels}` : ""));
        }
        await toolDesktopClick({ ...s, ref });
        out.push({ step: i, op, ok: true, ref });
      } else if (op === "type") {
        const ref = resolveRef(s);
        await toolDesktopType(ref ? { ...s, ref } : s);
        out.push({ step: i, op, ok: true, ref: ref || undefined });
      } else if (op === "key") {
        await toolDesktopKey(s);
        out.push({ step: i, op, ok: true });
      } else if (op === "wait") {
        const ms = Math.min(Math.max(Number(s.ms) || 500, 0), 5000);
        await new Promise((r) => setTimeout(r, ms));
        out.push({ step: i, op, ok: true });
      } else {
        out.push({ step: i, op, ok: false, error: "unknown op: " + op });
        break;
      }
    } catch (e) {
      out.push({ step: i, op, ok: false, error: String((e && e.message) || e) });
      break;
    }
  }
  const res = { steps: out, completed: out.filter((x) => x.ok).length, total: steps.length };
  if (lastSnapshot) res.final_snapshot = lastSnapshot;
  return JSON.stringify(res);
}

// Convert a PNG screenshot to JPEG with macOS's built-in sips: same picture,
// a fraction of the bytes. ChatGPT's conversation UI failed to render the
// large PNG payloads the engine returns (broken placeholder / dropped image)
// while the model itself received them fine, so screenshots go out as JPEG.
async function pngToJpeg(pngBuffer, maxDim) {
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "can-shot-"));
  const inP = path.join(dir, "shot.png");
  const outP = path.join(dir, "shot.jpg");
  try {
    fs.writeFileSync(inP, pngBuffer);
    await new Promise((resolve, reject) => {
      const p = spawn("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "62", "-Z", String(maxDim), inP, "--out", outP], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("sips failed: " + err.slice(0, 200)))));
    });
    return fs.readFileSync(outP);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function toolDesktopScreenshot(args) {
  const maxDim = Math.min(Math.max(Number((args && args.max_dim) || 1600), 320), 2560);
  const full = await cuaCallFull("get_desktop_state", { max_image_dimension: maxDim });
  const content = (full.raw && full.raw.content) || [];
  let img = null;
  for (const block of content) {
    if (block && block.type === "image" && block.data) { img = block; break; }
  }
  const sc = full.sc || {};
  if (!img) {
    // Fallback: some builds carry the payload inside structuredContent.
    for (const k of Object.keys(sc)) {
      if (typeof sc[k] === "string" && sc[k].length > 20000) {
        img = { data: sc[k], mimeType: sc.screenshot_mime_type || "image/png" };
        break;
      }
    }
  }
  if (!img) throw new Error("the desktop engine returned no screenshot image");
  let payload = img.data;
  let mime = img.mimeType || sc.screenshot_mime_type || "image/png";
  if (mime === "image/png") {
    try {
      const jpg = await pngToJpeg(Buffer.from(img.data, "base64"), maxDim);
      if (jpg && jpg.length > 1000) { payload = jpg.toString("base64"); mime = "image/jpeg"; }
    } catch { /* sips unavailable or failed: keep the PNG */ }
  }
  return JSON.stringify({
    screenshot_png_b64: payload,
    mime,
    screen_width: sc.screen_width, screen_height: sc.screen_height,
    screenshot_width: sc.screenshot_width, screenshot_height: sc.screenshot_height,
  });
}

/* ------------------------------------------------------------ the fence */
/* Step 4. Three layers, all enforced HERE on the owner's computer:
 * 1) Hard blocks: catastrophic command patterns never run (BLOCKED).
 * 2) Owner confirmation: sensitive tools (can_run_command, ego click /
 *    type in the logged-in daily browser) pop a native dialog ON THIS
 *    MAC; the action runs only if the owner clicks 允许. Deny, cancel
 *    and timeout all fail closed. A remote brain cannot bypass it.
 * 3) Audit: every tool call and fence decision is appended to
 *    audit.log as a JSON line; can_audit_log reads it back.
 * Config (config.json "fence"): confirmEgo / confirmRun / confirmDesktop
 * default true (confirmDesktop falls back to confirmEgo when unset),
 * dialogTimeoutS defaults 60, trustWindowMin (default 0) skips dialogs
 * for N minutes after one approval. Plus a light rate limit: 30
 * confirmed sensitive actions per hour. */
const AUDIT = path.join(DIR, "audit.log");
const FENCE = (cfg.fence && typeof cfg.fence === "object") ? cfg.fence : {};
const CONFIRM_EGO = FENCE.confirmEgo !== false;
const CONFIRM_RUN = FENCE.confirmRun !== false;
const CONFIRM_DESKTOP = FENCE.confirmDesktop !== undefined ? FENCE.confirmDesktop !== false : CONFIRM_EGO;
// Trust window: after one owner approval, skip dialogs for this many
// minutes (config fence.trustWindowMin, default 0 = always ask).
const TRUST_WINDOW_MIN = Math.min(Math.max(Number(FENCE.trustWindowMin || 0), 0), 240);
let trustUntil = 0;
const DIALOG_TIMEOUT_S = Math.min(Math.max(Number(FENCE.dialogTimeoutS || 60), 10), 120);
const SENSITIVE = new Set(["can_run_command", "can_ego_click", "can_ego_type", "can_desktop_click", "can_desktop_type", "can_desktop_key", "can_desktop_batch", "can_desktop_click_xy", "can_desktop_drag_xy"]);
const sensitiveHits = [];

// --- Pixel fallback -----------------------------------------------------------
// The structural snapshot cannot see canvas / WebGL / custom-drawn surfaces.
// These tools work in image space: the model reads coordinates off an image
// it received (a window shot, the full-screen screenshot, or a zoom crop)
// and passes img_w/img_h saying which image. The agent rescales them into
// the pixel space of the driver's current capture for that target.
const deskShotDims = new Map(); // "pid:window_id" -> { w, h } of the latest window capture

function extractImageBlock(full) {
  const content = (full.raw && full.raw.content) || [];
  for (const block of content) {
    if (block && block.type === "image" && block.data) return block;
  }
  const sc = full.sc || {};
  for (const k of Object.keys(sc)) {
    if (typeof sc[k] === "string" && sc[k].length > 20000) {
      return { data: sc[k], mimeType: sc.screenshot_mime_type || "image/png" };
    }
  }
  return null;
}

async function imageResultJson(full, extra) {
  const img = extractImageBlock(full);
  if (!img) throw new Error("the desktop engine returned no image");
  const sc = full.sc || {};
  let payload = img.data;
  let mime = img.mimeType || sc.screenshot_mime_type || "image/png";
  if (mime === "image/png") {
    try {
      // The driver's window captures can be supersampled (several times the
      // reported screenshot size). Shrink to the reported capture dims so
      // the image the model receives matches screenshot_width/height.
      const target = Math.max(Number(sc.screenshot_width) || 0, Number(sc.screenshot_height) || 0) || 4096;
      const jpg = await pngToJpeg(Buffer.from(img.data, "base64"), target);
      if (jpg && jpg.length > 1000) { payload = jpg.toString("base64"); mime = "image/jpeg"; }
    } catch { /* keep the PNG */ }
  }
  return JSON.stringify({
    screenshot_png_b64: payload, mime,
    screenshot_width: sc.screenshot_width, screenshot_height: sc.screenshot_height,
    ...(extra || {}),
  });
}

async function toolDesktopWindowShot(args) {
  const win = await deskResolveWindow(args);
  const full = await cuaCallFull("get_window_state", {
    pid: win.pid, window_id: win.window_id, tree_format: "markdown", include_screenshot: true,
  });
  const sc = full.sc || {};
  if (sc.screenshot_width && sc.screenshot_height) {
    deskShotDims.set(deskKey(win.pid, win.window_id), { w: Number(sc.screenshot_width), h: Number(sc.screenshot_height) });
  }
  return imageResultJson(full, {
    window: { pid: win.pid, window_id: win.window_id },
    screen_width: sc.screenshot_width, screen_height: sc.screenshot_height,
  });
}

function scaleToCapture(x, y, imgW, imgH, capW, capH) {
  const iw = Number(imgW) || capW, ih = Number(imgH) || capH;
  return {
    x: Math.round(capW && iw ? (x * capW) / iw : x),
    y: Math.round(capH && ih ? (y * capH) / ih : y),
  };
}

async function pixelTarget(args) {
  const space = String((args && args.space) || "window");
  if (space === "desktop") {
    const full = await cuaCallFull("get_desktop_state", {});
    const sc = full.sc || {};
    return { mode: "desktop", capW: Number(sc.screenshot_width) || 0, capH: Number(sc.screenshot_height) || 0, captureId: sc.capture_id };
  }
  const win = await deskResolveWindow(args);
  let dims = deskShotDims.get(deskKey(win.pid, win.window_id));
  if (!dims || !dims.w || !dims.h) {
    const full = await cuaCallFull("get_window_state", { pid: win.pid, window_id: win.window_id, tree_format: "markdown", include_screenshot: true });
    const sc = full.sc || {};
    dims = { w: Number(sc.screenshot_width) || 0, h: Number(sc.screenshot_height) || 0 };
    if (dims.w && dims.h) deskShotDims.set(deskKey(win.pid, win.window_id), dims);
  }
  return { mode: "window", win, capW: dims.w, capH: dims.h };
}

async function toolDesktopClickXY(args) {
  const a = args || {};
  const x = Number(a.x), y = Number(a.y);
  if (!isFinite(x) || !isFinite(y)) throw new Error("x and y are required (pixels in the image you are looking at)");
  if (a.from_zoom) {
    const win = await deskResolveWindow(a);
    await cuaCall("click", { pid: win.pid, window_id: win.window_id, x, y, from_zoom: true });
    return JSON.stringify({ clicked: true, space: "zoom", at: [x, y], window: { pid: win.pid, window_id: win.window_id } });
  }
  const t = await pixelTarget(a);
  const p = scaleToCapture(x, y, a.img_w, a.img_h, t.capW, t.capH);
  if (t.mode === "desktop") {
    const params = { scope: "desktop", x: p.x, y: p.y };
    if (t.captureId) params.capture_id = t.captureId;
    await cuaCall("click", params);
    return JSON.stringify({ clicked: true, space: "desktop", at: [p.x, p.y], capture: [t.capW, t.capH] });
  }
  await cuaCall("click", { pid: t.win.pid, window_id: t.win.window_id, x: p.x, y: p.y });
  return JSON.stringify({ clicked: true, space: "window", at: [p.x, p.y], window: { pid: t.win.pid, window_id: t.win.window_id }, capture: [t.capW, t.capH] });
}

async function toolDesktopDragXY(args) {
  const a = args || {};
  const fx = Number(a.from_x), fy = Number(a.from_y), tx = Number(a.to_x), ty = Number(a.to_y);
  if (![fx, fy, tx, ty].every(isFinite)) throw new Error("from_x, from_y, to_x, to_y are required");
  const dur = Number(a.duration_ms) || 600;
  if (a.from_zoom) {
    const win = await deskResolveWindow(a);
    await cuaCall("drag", { pid: win.pid, window_id: win.window_id, from_x: fx, from_y: fy, to_x: tx, to_y: ty, from_zoom: true, duration_ms: dur });
    return JSON.stringify({ dragged: true, space: "zoom", window: { pid: win.pid, window_id: win.window_id } });
  }
  const t = await pixelTarget(a);
  const p1 = scaleToCapture(fx, fy, a.img_w, a.img_h, t.capW, t.capH);
  const p2 = scaleToCapture(tx, ty, a.img_w, a.img_h, t.capW, t.capH);
  const base = { from_x: p1.x, from_y: p1.y, to_x: p2.x, to_y: p2.y, duration_ms: dur };
  if (t.mode === "desktop") {
    await cuaCall("drag", { ...base, scope: "desktop" });
    return JSON.stringify({ dragged: true, space: "desktop", from: [p1.x, p1.y], to: [p2.x, p2.y] });
  }
  await cuaCall("drag", { ...base, pid: t.win.pid, window_id: t.win.window_id });
  return JSON.stringify({ dragged: true, space: "window", from: [p1.x, p1.y], to: [p2.x, p2.y], window: { pid: t.win.pid, window_id: t.win.window_id } });
}

async function toolDesktopZoom(args) {
  const a = args || {};
  const win = await deskResolveWindow(a);
  // The driver requires a current screenshot context for zoom; a fresh
  // window state read establishes it and gives the capture's pixel space.
  const fresh = await cuaCallFull("get_window_state", { pid: win.pid, window_id: win.window_id, tree_format: "markdown", include_screenshot: true });
  const sc0 = fresh.sc || {};
  const capW = Number(sc0.screenshot_width) || 0, capH = Number(sc0.screenshot_height) || 0;
  if (capW && capH) deskShotDims.set(deskKey(win.pid, win.window_id), { w: capW, h: capH });
  const p1 = scaleToCapture(Number(a.x1) || 0, Number(a.y1) || 0, a.img_w, a.img_h, capW, capH);
  const p2 = scaleToCapture(Number(a.x2) || 0, Number(a.y2) || 0, a.img_w, a.img_h, capW, capH);
  const full = await cuaCallFull("zoom", { pid: win.pid, window_id: win.window_id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
  return imageResultJson(full, { window: { pid: win.pid, window_id: win.window_id }, zoom_of: [p1.x, p1.y, p2.x, p2.y] });
}

function audit(tool, argsSum, decision, detail) {
  const line = JSON.stringify({
    ts: new Date().toISOString(), tool, args: argsSum, decision,
    detail: detail || "",
  }) + "\n";
  try { fs.appendFileSync(AUDIT, line); } catch (e) {}
  log(`audit ${tool} -> ${decision}`);
}

function argsSummary(tool, args) {
  try {
    const a = args || {};
    let s = "";
    if (tool === "can_run_command") s = String(a.command || "");
    else if (tool === "can_read_file" || tool === "can_write_file" || tool === "can_list_files") s = String(a.path || "");
    else if (tool === "can_browser_open" || tool === "can_ego_open") s = String(a.url || "");
    else if (tool === "can_ego_click" || tool === "can_ego_type") s = `${a.space || "can"} ${a.target || ""} ${a.text || ""}`;
    else if (tool === "can_desktop_click" || tool === "can_desktop_type" || tool === "can_desktop_key") s = `${a.ref || ""} ${a.key || ""} ${a.text || ""} pid=${a.pid || ""} win=${a.window_id || ""}`;
    else if (tool === "can_desktop_open_app") s = String(a.name || "");
    else if (tool === "can_desktop_snapshot" || tool === "can_desktop_windows") s = String(a.app || "");
    else if (tool === "can_browser_click" || tool === "can_browser_type") s = `${a.ref || ""} ${a.text || ""}`;
    else if (tool === "can_ego_claim") s = `space ${a.space_id}`;
    else if (tool === "can_write_note") s = String(a.text || "");
    else if (tool === "can_ego_snapshot") s = String(a.space || "can");
    else s = JSON.stringify(a);
    return s.replace(/\s+/g, " ").slice(0, 200);
  } catch (e) { return ""; }
}

function macConfirm(summary) {
  return new Promise((resolve) => {
    const script = [
      "on run argv",
      "set msg to item 1 of argv",
      `display dialog msg with title "Can 需要你确认" buttons {"拒绝", "允许"} default button "拒绝" cancel button "拒绝" with icon caution giving up after ${DIALOG_TIMEOUT_S}`,
      "end run",
    ].join("\n");
    execFile("osascript", ["-e", script, "--", summary],
      { timeout: (DIALOG_TIMEOUT_S + 15) * 1000 }, (err, stdout) => {
        if (err) return resolve(false);
        const out = String(stdout || "");
        resolve(/button returned:\s*允许/.test(out) && !/gave up:\s*true/.test(out));
      });
  });
}

function sensitiveSummary(tool, args) {
  const a = args || {};
  if (tool === "can_run_command") {
    return "Can 想在这台电脑的工作文件夹里执行命令：\n" + String(a.command || "").slice(0, 300);
  }
  const where = a.space === "user" ? "你自己的浏览器空间" : "Can 的浏览器空间";
  if (tool === "can_ego_click") {
    return `Can 想在你的日常浏览器（${where}）中点击：\n` + String(a.target || "").slice(0, 120);
  }
  if (tool === "can_ego_type") {
    return `Can 想在你的日常浏览器（${where}）中输入：\n目标 ${String(a.target || "").slice(0, 60)}\n内容「${String(a.text || "").slice(0, 40)}」`;
  }
  if (tool === "can_desktop_click") {
    return "Can 想在一个应用窗口里点击元素：\n" + String(a.ref || "").slice(0, 60);
  }
  if (tool === "can_desktop_type") {
    return `Can 想在一个应用窗口里输入：\n目标 ${String(a.ref || "").slice(0, 60)}\n内容「${String(a.text || "").slice(0, 40)}」`;
  }
  if (tool === "can_desktop_key") {
    return "Can 想在一个应用窗口里按键：\n" + String(a.key || "").slice(0, 40);
  }
  return tool;
}

function rateOk() {
  const now = Date.now();
  while (sensitiveHits.length && now - sensitiveHits[0] > 3600000) sensitiveHits.shift();
  return sensitiveHits.length < 30;
}

async function guardedExecute(tool, args) {
  const sum = argsSummary(tool, args);
  // Hard blocks fire BEFORE any confirmation prompt: the owner is never
  // asked to approve a command that would be refused anyway.
  if (tool === "can_run_command" && blockedByPattern(String((args || {}).command || ""))) {
    audit(tool, sum, "blocked_pattern");
    return JSON.stringify({
      error: "blocked_pattern",
      detail: "This command matches a blocked catastrophic pattern and was not run.",
      command: String((args || {}).command || ""),
    });
  }
  if (SENSITIVE.has(tool)) {
    const needsConfirm = tool === "can_run_command" ? CONFIRM_RUN
      : (tool === "can_desktop_click" || tool === "can_desktop_type" || tool === "can_desktop_key") ? CONFIRM_DESKTOP
      : CONFIRM_EGO;
    if (needsConfirm && TRUST_WINDOW_MIN > 0 && Date.now() < trustUntil) {
      audit(tool, sum, "trust_window");
    } else if (needsConfirm) {
      if (!rateOk()) {
        audit(tool, sum, "rate_limited");
        return JSON.stringify({
          error: "rate_limited",
          detail: "Too many sensitive actions in the last hour; the fence paused them. Try again later.",
        });
      }
      audit(tool, sum, "confirmation_requested");
      const ok = await macConfirm(sensitiveSummary(tool, args));
      if (!ok) {
        audit(tool, sum, "owner_denied_or_timeout");
        return JSON.stringify({
          error: "owner_denied",
          detail: "The owner did not approve this action on the computer (denied, or no answer before the timeout). Nothing was executed.",
        });
      }
      audit(tool, sum, "owner_confirmed");
      if (TRUST_WINDOW_MIN > 0) trustUntil = Date.now() + TRUST_WINDOW_MIN * 60000;
    }
  }
  try {
    const result = await execute(tool, args);
    let decision = "executed";
    try {
      const p = JSON.parse(result);
      if (p && p.error === "blocked_pattern") decision = "blocked_pattern";
    } catch (e) {}
    audit(tool, sum, decision);
    if (SENSITIVE.has(tool)) sensitiveHits.push(Date.now());
    return result;
  } catch (e) {
    audit(tool, sum, "error", String(e && e.message || e).slice(0, 200));
    throw e;
  }
}

async function toolAuditLog(args) {
  const n = Math.min(Math.max(Number((args && args.lines) || 20), 1), 100);
  let lines = [];
  try {
    lines = fs.readFileSync(AUDIT, "utf8").split("\n").filter((l) => l.trim());
  } catch (e) {}
  return JSON.stringify({
    total: lines.length,
    entries: lines.slice(-n).map((l) => {
      try { return JSON.parse(l); } catch (e) { return { raw: l }; }
    }),
  });
}

/* ------------------------------------------------------------ dispatch */
async function execute(tool, args) {
  switch (tool) {
    case "can_status":
      return JSON.stringify({
        product: "Can", status: "online", agent: "mac",
        computer: COMPUTER, hostname: os.hostname(), macos: MACOS,
        agent_uptime_s: Math.round((Date.now() - STARTED) / 1000),
        nonce: "CAN-STATUS-1105",
      });
    case "can_write_note": {
      const text = String((args && args.text) || "");
      fs.appendFileSync(WRITELOG, `${new Date().toISOString()} ${text}\n`);
      return JSON.stringify({
        written: true, echo: text, nonce: "CAN-WRITE-1105",
        computer: COMPUTER,
      });
    }
    case "can_list_files": return toolListFiles(args);
    case "can_read_file": return toolReadFile(args);
    case "can_write_file": return toolWriteFile(args);
    case "can_run_command": return toolRunCommand(args);
    case "can_browser_open": return toolBrowserOpen(args);
    case "can_browser_snapshot": return toolBrowserSnapshot();
    case "can_browser_click": return toolBrowserClick(args);
    case "can_browser_type": return toolBrowserType(args);
    case "can_browser_close": return toolBrowserClose();
    case "can_ego_spaces": return toolEgoSpaces();
    case "can_ego_claim": return toolEgoClaim(args);
    case "can_ego_open": return toolEgoOpen(args);
    case "can_ego_snapshot": return toolEgoSnapshot(args);
    case "can_ego_click": return toolEgoClick(args);
    case "can_ego_type": return toolEgoType(args);
    case "can_ego_finish": return toolEgoFinish();
    case "can_audit_log": return toolAuditLog(args);
    case "can_desktop_windows": return toolDesktopWindows(args);
    case "can_desktop_open_app": return toolDesktopOpenApp(args);
    case "can_desktop_snapshot": return toolDesktopSnapshot(args);
    case "can_desktop_click": return toolDesktopClick(args);
    case "can_desktop_type": return toolDesktopType(args);
    case "can_desktop_key": return toolDesktopKey(args);
    case "can_desktop_screenshot": return toolDesktopScreenshot(args);
    case "can_desktop_batch": return toolDesktopBatch(args);
    case "can_desktop_window_shot": return toolDesktopWindowShot(args);
    case "can_desktop_click_xy": return toolDesktopClickXY(args);
    case "can_desktop_drag_xy": return toolDesktopDragXY(args);
    case "can_desktop_zoom": return toolDesktopZoom(args);
    default: throw new Error("unknown tool: " + tool);
  }
}

async function pollOnce() {
  const resp = await api("GET", "/agent/poll?wait=25", null, 40000);
  if (resp.status === 204) return;
  if (!resp.ok) throw new Error("poll HTTP " + resp.status);
  const job = await resp.json();
  if (!job || !job.job_id) return;
  log(`job ${job.job_id} tool=${job.tool} args=${JSON.stringify(job.arguments || {}).slice(0, 200)}`);
  let ok = true, result;
  try { result = await guardedExecute(job.tool, job.arguments || {}); }
  catch (e) { ok = false; result = String(e && e.message || e); }
  await api("POST", "/agent/result", { job_id: job.job_id, ok, result }, 10000);
  writeStatus("connected", { last_job: { tool: job.tool, at: new Date().toISOString(), ok } });
  log(`job ${job.job_id} done ok=${ok}`);
}

async function main() {
  log(`Can agent ${AGENT_VERSION} starting; gateway=${GATEWAY} computer=${COMPUTER} macos=${MACOS} workRoot=${ROOT}`);
  writeStatus("starting");
  // Heartbeat runs on its own timer so long jobs (ego) cannot starve it.
  setInterval(() => { heartbeat().catch(() => {}); }, 20000);
  heartbeat().catch(() => {});
  for (;;) {
    try {
      await pollOnce();
    } catch (e) {
      log("loop error: " + (e && e.message || e));
      writeStatus("reconnecting", { last_error: String(e && e.message || e) });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();

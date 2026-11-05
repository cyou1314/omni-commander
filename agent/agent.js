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
 * File tools are confined to the work folder (config.workRoot):
 * absolute paths, ".." escapes and symlink escapes are refused.
 * can_run_command has a 30s timeout, capped output, and a starter
 * blocklist of catastrophic patterns; the full stop-list fence
 * (delete/publish/overwrite confirmations) is Step 4's work.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, exec, spawn } = require("child_process");

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
const AGENT_VERSION = "0.5.0";

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
  /\bmkfs\b|\bdd\s+[^|]*\bif=/,
  /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|disk|rdisk)/,
  /launchctl\s+(bootout|unload)\b[^|]*can/i,
];

function toolRunCommand(args) {
  const command = String((args && args.command) || "");
  if (!command.trim()) throw new Error("empty command");
  for (const re of BLOCKED) {
    if (re.test(command)) {
      return Promise.resolve(JSON.stringify({
        error: "blocked_pattern",
        detail: "This command matches a blocked catastrophic pattern and was not run.",
        command,
      }));
    }
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
  if (!Number.isFinite(id) || id <= 0) throw new Error("space_id must be a positive number from can_ego_spaces");
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
  try { result = await execute(job.tool, job.arguments || {}); }
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

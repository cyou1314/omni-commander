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
 * File tools are confined to the work folder (config.workRoot):
 * absolute paths, ".." escapes and symlink escapes are refused.
 * can_run_command has a 30s timeout, capped output, and a starter
 * blocklist of catastrophic patterns; the full stop-list fence
 * (delete/publish/overwrite confirmations) is Step 4's work.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, exec } = require("child_process");

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
const AGENT_VERSION = "0.3.0";

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
  let lastHb = 0;
  for (;;) {
    try {
      if (Date.now() - lastHb > 20000) { await heartbeat(); lastHb = Date.now(); }
      await pollOnce();
    } catch (e) {
      log("loop error: " + (e && e.message || e));
      writeStatus("reconnecting", { last_error: String(e && e.message || e) });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();

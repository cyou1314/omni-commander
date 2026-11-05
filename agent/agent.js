#!/usr/bin/env node
"use strict";
/* Can agent — omni-commander V2, Step 2.
 * Runs on the owner's Mac. Dials OUT to the Can gateway (no inbound
 * ports): heartbeat every 20s, long-polls for tool jobs, executes them
 * locally, posts results back. Node built-ins only.
 * Tools (Step 2 scope, harmless):
 *   can_status     -> this computer's identity + liveness
 *   can_write_note -> append a line to write-log.txt in this folder
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const GATEWAY = String(cfg.gateway || "").replace(/\/+$/, "");
const KEY = cfg.agentKey || "";
const NAME = cfg.name || "Can agent (Mac)";
const STARTED = Date.now();
const LOG = path.join(DIR, "agent.log");
const STATUS = path.join(DIR, "status.json");
const WRITELOG = path.join(DIR, "write-log.txt");

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
    os: `macOS ${MACOS}`, version: "0.2.0",
  }, 10000);
  if (!resp.ok) throw new Error("heartbeat HTTP " + resp.status);
  writeStatus("connected", { last_heartbeat: new Date().toISOString() });
}

function execute(tool, args) {
  if (tool === "can_status") {
    return JSON.stringify({
      product: "Can", status: "online", agent: "mac",
      computer: COMPUTER, hostname: os.hostname(), macos: MACOS,
      agent_uptime_s: Math.round((Date.now() - STARTED) / 1000),
      nonce: "CAN-STATUS-1105",
    });
  }
  if (tool === "can_write_note") {
    const text = String((args && args.text) || "");
    fs.appendFileSync(WRITELOG, `${new Date().toISOString()} ${text}\n`);
    return JSON.stringify({
      written: true, echo: text, nonce: "CAN-WRITE-1105",
      computer: COMPUTER,
    });
  }
  throw new Error("unknown tool: " + tool);
}

async function pollOnce() {
  const resp = await api("GET", "/agent/poll?wait=25", null, 40000);
  if (resp.status === 204) return;
  if (!resp.ok) throw new Error("poll HTTP " + resp.status);
  const job = await resp.json();
  if (!job || !job.job_id) return;
  log(`job ${job.job_id} tool=${job.tool}`);
  let ok = true, result;
  try { result = execute(job.tool, job.arguments || {}); }
  catch (e) { ok = false; result = String(e && e.message || e); }
  await api("POST", "/agent/result", { job_id: job.job_id, ok, result }, 10000);
  writeStatus("connected", { last_job: { tool: job.tool, at: new Date().toISOString(), ok } });
  log(`job ${job.job_id} done ok=${ok}`);
}

async function main() {
  log(`Can agent starting; gateway=${GATEWAY} computer=${COMPUTER} macos=${MACOS}`);
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

#!/usr/bin/env node
/* Can native messaging host (com.can.agent).
 * Chrome spawns this process when the Can extension connects.
 * It bridges Chrome's length-prefixed stdio protocol to the Can
 * agent's local bridge (TCP 127.0.0.1:18792, newline-delimited JSON).
 * Protocol both ways: {type:"hello"} / {type:"call", id, cmd, args} /
 * {type:"result", id, ok, result|error}. */
"use strict";

const net = require("net");

const AGENT_PORT = 18792;
const sock = net.connect(AGENT_PORT, "127.0.0.1");
let sockBuf = "";

sock.on("connect", () => {
  sock.write(JSON.stringify({ type: "hello", browser: "chrome-family" }) + "\n");
});
sock.on("data", (d) => {
  sockBuf += d.toString("utf8");
  let i;
  while ((i = sockBuf.indexOf("\n")) >= 0) {
    const line = sockBuf.slice(0, i);
    sockBuf = sockBuf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "call") writeChrome(msg);
    } catch (e) {}
  }
});
sock.on("error", () => process.exit(0));
sock.on("close", () => process.exit(0));

function writeChrome(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

let inBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const payload = inBuf.slice(4, 4 + len).toString("utf8");
    inBuf = inBuf.slice(4 + len);
    try {
      const msg = JSON.parse(payload);
      if (msg.type === "result") sock.write(JSON.stringify(msg) + "\n");
    } catch (e) {}
  }
});
process.stdin.on("end", () => process.exit(0));

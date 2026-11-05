/* Can extension service worker.
 * Bridges the browser to the local Can agent through a native
 * messaging host (com.can.agent). The agent sends {type:"call", id,
 * cmd, args}; this worker executes the command with chrome.* APIs and
 * page scripting, then replies {type:"result", id, ok, result|error}.
 * It never initiates page actions on its own. */
"use strict";

const HOST = "com.can.agent";
let port = null;

function connect() {
  if (port) return true;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    return false;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => { port = null; });
  try { port.postMessage({ type: "hello", from: "can-extension" }); } catch (e) {}
  return true;
}

async function onHostMessage(msg) {
  if (!msg || msg.type !== "call") return;
  let out;
  try {
    const result = await handleCall(msg.cmd, msg.args || {});
    out = { type: "result", id: msg.id, ok: true, result };
  } catch (e) {
    out = { type: "result", id: msg.id, ok: false, error: String(e && e.message || e) };
  }
  try { port.postMessage(out); } catch (e) {}
}

/* ------------------------------------------------------------ commands */
async function handleCall(cmd, args) {
  switch (cmd) {
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, active: t.active, windowId: t.windowId,
        title: t.title || "", url: t.url || "",
      }));
    }
    case "open": {
      const tab = await chrome.tabs.create({ url: args.url, active: false });
      const ready = await waitForTab(tab.id, 20000);
      return { tabId: tab.id, url: ready.url || args.url, title: ready.title || "" };
    }
    case "snapshot": {
      const tabId = args.tabId;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId }, func: canSnapshotFn,
      });
      if (!res || !res.result) throw new Error("snapshot failed (page may block scripting)");
      return res.result;
    }
    case "click": {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: args.tabId }, func: canClickFn, args: [args.ref],
      });
      if (!res || !res.result) throw new Error("click failed");
      if (!res.result.ok) throw new Error(res.result.error || "click failed");
      await sleep(600);
      const tab = await chrome.tabs.get(args.tabId).catch(() => null);
      return { ok: true, url: tab ? tab.url : res.result.url };
    }
    case "type": {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: args.tabId }, func: canTypeFn, args: [args.ref, args.text],
      });
      if (!res || !res.result) throw new Error("type failed");
      if (!res.result.ok) throw new Error(res.result.error || "type failed");
      return { ok: true };
    }
    case "close": {
      await chrome.tabs.remove(args.tabId);
      return { ok: true };
    }
    default:
      throw new Error("unknown command: " + cmd);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForTab(tabId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return {};
    if (tab.status === "complete" || Date.now() - start > timeoutMs) return tab;
    await sleep(400);
  }
}

/* --------------------------------------- page functions (serialized) */
function canSnapshotFn() {
  const els = [];
  const nodes = document.querySelectorAll(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="tab"], [contenteditable="true"]'
  );
  let n = 0;
  nodes.forEach((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.display === "none") return;
    n += 1;
    const ref = "e" + n;
    el.setAttribute("data-can-ref", ref);
    const label = (el.innerText || el.value || el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") || el.name || "")
      .trim().replace(/\s+/g, " ").slice(0, 80);
    const item = { ref, tag: el.tagName.toLowerCase(), text: label };
    const type = el.getAttribute("type");
    if (type) item.type = type;
    if (el.tagName === "A") item.href = el.href;
    els.push(item);
  });
  return {
    url: location.href,
    title: document.title,
    elements: els.slice(0, 200),
    text: (document.body ? document.body.innerText : "").slice(0, 1500),
  };
}

function canClickFn(ref) {
  const el = document.querySelector('[data-can-ref="' + ref + '"]');
  if (!el) return { ok: false, error: "ref not found: " + ref };
  el.scrollIntoView({ block: "center" });
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
  return { ok: true, url: location.href };
}

function canTypeFn(ref, text) {
  const el = document.querySelector('[data-can-ref="' + ref + '"]');
  if (!el) return { ok: false, error: "ref not found: " + ref };
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
  } else {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

/* ------------------------------------------------------------- wiring */
chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.runtime.onStartup.addListener(() => { connect(); });
chrome.alarms.create("can-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { if (!port) connect(); });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "can-status") {
    sendResponse({ connected: Boolean(port) || connect() });
  }
  if (msg && msg.type === "can-reconnect") {
    port = null;
    sendResponse({ connected: connect() });
  }
  return false;
});
connect();

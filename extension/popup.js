function show(connected) {
  document.getElementById("status").textContent =
    "状态：" + (connected ? "已连接 Can agent" : "未连接（agent 没在跑，或桥未装好）");
}
chrome.runtime.sendMessage({ type: "can-status" }, (r) => show(Boolean(r && r.connected)));
document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "can-reconnect" }, (r) => show(Boolean(r && r.connected)));
});

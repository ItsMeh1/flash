/* Flash — log.js : in-memory request log + metrics. */
(function (global) {
  "use strict";
  const entries = [];
  const MAX = 500;
  function push(e) {
    e.ms = null;
    entries.unshift(e);
    if (entries.length > MAX) entries.pop();
    render();
    return e;
  }
  function update(e) {
    render();
  }
  function clear() {
    entries.length = 0;
    render();
  }
  function all() { return entries.slice(); }
  function render() {
    const el = document.getElementById("reqLog");
    if (!el) return;
    const q = (document.getElementById("reqFilter")?.value || "").toLowerCase();
    const rows = entries
      .filter((e) => !q || (e.url || "").toLowerCase().includes(q) || String(e.status).includes(q))
      .slice(0, 120)
      .map((e) => {
        const badge = e.status >= 400 ? "err" : e.status >= 300 ? "warn" : "ok";
        return `<div class="req-row"><span class="badge ${badge}">${e.status || "…"}</span>
          <span class="req-m">${global.FlashUtil.escapeHtml(e.method || "GET")}</span>
          <span class="req-u" title="${global.FlashUtil.escapeHtml(e.url)}">${global.FlashUtil.escapeHtml((e.url || "").slice(0, 110))}</span>
          <span class="req-meta">${global.FlashUtil.escapeHtml(e.engine || "")} ${e.ms != null ? global.FlashUtil.fmtMs(e.ms) : ""} ${e.bytes ? global.FlashUtil.fmtBytes(e.bytes) : ""}</span></div>`;
      }).join("");
    el.innerHTML = rows || `<div class="empty">No requests yet. Navigate somewhere.</div>`;
    const c = document.getElementById("reqCount");
    if (c) c.textContent = entries.length + " requests";
  }
  global.FlashLog = { push, update, clear, all, render };
})(window);

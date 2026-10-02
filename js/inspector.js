/* Flash — inspector.js : request metrics, DOM snapshot, element picker results. */
(function (global) {
  "use strict";

  const U = () => global.FlashUtil;
  const esc = (s) => U().escapeHtml(s == null ? "" : String(s));

  function metrics() {
    const m = { heap: null, net: global.FlashLog.all().slice(0, 20), timing: null };
    try {
      if (performance.memory) {
        m.heap = {
          used: U().fmtBytes(performance.memory.usedJSHeapSize),
          total: U().fmtBytes(performance.memory.totalJSHeapSize),
          limit: U().fmtBytes(performance.memory.jsHeapSizeLimit),
        };
      }
    } catch {}
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) m.timing = { dom: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) };
    } catch {}
    return m;
  }

  function renderMetrics() {
    const el = document.getElementById("metricsBox");
    if (!el) return;
    const m = metrics();
    el.innerHTML = `
      <div class="m-row"><span>JS heap</span><b>${m.heap ? `${m.heap.used} / ${m.heap.total}` : "n/a (non-Chromium)"}</b></div>
      <div class="m-row"><span>Transport</span><b>${esc(JSON.stringify(global.FlashTransport.getStatus()))}</b></div>
      <div class="m-row"><span>Tabs</span><b>${global.FlashTabs.all().length}</b></div>
      <div class="m-row"><span>ServiceWorkers</span><b>${"serviceWorker" in navigator ? "present in browser, never used by Flash" : "unsupported"}</b></div>`;
  }

  function activeFrame() {
    const t = global.FlashTabs.active();
    if (!t || t.view !== "web") return null;
    return document.getElementById("frame-" + t.id);
  }

  function postToFrame(msg) {
    const f = activeFrame();
    if (!f) return false;
    try {
      const t = global.FlashTabs.active();
      f.contentWindow.postMessage({ __flash: 2, tab: t.id, ...msg }, "*");
      return true;
    } catch {
      return false;
    }
  }

  // ---- full-page snapshot (now actually answered by the runtime) ----
  function inspectActive() {
    const t = global.FlashTabs.active();
    const out = document.getElementById("domBox");
    if (!t || !out) return;
    const f = document.getElementById("frame-" + t.id);
    if (!f || t.view !== "web") {
      out.textContent = "Snapshot needs the active tab to show a proxied page.";
      return;
    }
    const id = "snap" + Date.now();
    const onMsg = (e) => {
      if (e.data && e.data.__flash === 1 && e.data.tab === t.id && e.data.type === "dom-snapshot" && e.data.data.id === id) {
        window.removeEventListener("message", onMsg);
        out.textContent = (e.data.data.html || "").slice(0, 20000) || "(empty)";
      }
    };
    window.addEventListener("message", onMsg);
    if (!postToFrame({ type: "inspect-snapshot", id })) {
      window.removeEventListener("message", onMsg);
      out.textContent = "(could not reach page)";
      return;
    }
    out.textContent = "Waiting for page snapshot…";
    setTimeout(() => window.removeEventListener("message", onMsg), 5000);
  }

  // ---- click-to-inspect picker ----
  let picking = null;

  function isPicking() { return !!picking; }

  function startPicker() {
    const t = global.FlashTabs.active();
    if (!t || t.view !== "web" || !postToFrame({ type: "inspect-start" })) {
      toast("Open a proxied page first, then inspect.");
      return;
    }
    picking = t.id;
    const box = document.getElementById("inspectResult");
    if (box) box.innerHTML = `<div class="empty">Hover the page to highlight, click an element to inspect it.<br>Esc cancels.</div>`;
    toast("Inspecting — click any element (Esc cancels)");
  }

  function stopPicker(silent) {
    if (!picking) return;
    const t = global.FlashTabs.get(picking);
    picking = null;
    if (t) {
      const f = document.getElementById("frame-" + t.id);
      try {
        f.contentWindow.postMessage({ __flash: 2, tab: t.id, type: "inspect-stop" }, "*");
      } catch {}
    }
    if (!silent) toast("Inspector off");
  }

  function onResult(e) {
    const m = e.data;
    if (!m || m.__flash !== 1 || m.type !== "inspect-result" || !m.data || !m.data.node) return;
    if (m.tab !== picking && picking) return;
    stopPicker(true);
    renderNode(m.data.node);
  }

  function renderNode(n) {
    const box = document.getElementById("inspectResult");
    if (!box || !n) return;
    const sel = `${esc(n.tag)}${n.id ? "#" + esc(n.id) : ""}${n.classes ? "." + esc(String(n.classes).trim().split(/\s+/).join(".")) : ""}`;
    const r = n.rect || {};
    const st = n.styles || {};
    const px = (v) => esc(v || "0px");
    const boxHtml = `
      <div class="bxm"><span class="bxlab">margin ${px(st["margin-top"])} · ${px(st["margin-right"])} · ${px(st["margin-bottom"])} · ${px(st["margin-left"])}</span>
      <div class="bxb"><span class="bxlab">border ${px(st["border-top-width"])} · ${px(st["border-right-width"])} · ${px(st["border-bottom-width"])} · ${px(st["border-left-width"])}</span>
      <div class="bxp"><span class="bxlab">padding ${px(st["padding-top"])} · ${px(st["padding-right"])} · ${px(st["padding-bottom"])} · ${px(st["padding-left"])}</span>
      <div class="bxc">${r.w != null ? `${r.w} × ${r.h}` : "—"}</div>
      </div></div></div>`;
    const attrs = (n.attrs || []).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b><code>${esc(v)}</code></b></div>`).join("") || `<div class="empty">No attributes.</div>`;
    const styleRows = Object.keys(st).filter((k) => st[k] != null && String(st[k]).trim() !== "").map((k) =>
      `<div class="kv"><span>${esc(k)}</span><b><code>${esc(st[k])}</code></b></div>`).join("");
    box.innerHTML = `
      <div class="insp-head"><code>${sel}</code><span class="hint">${r.x != null ? `${r.x},${r.y}` : ""}</span></div>
      ${(n.path || []).length ? `<div class="insp-path">${n.path.map(esc).join(" &gt; ")}</div>` : ""}
      ${boxHtml}
      <div class="insp-sec">Attributes</div>${attrs}
      <div class="insp-sec">Computed styles</div>${styleRows || `<div class="empty">—</div>`}
      ${n.text ? `<div class="insp-sec">Text</div><div class="insp-text">${esc(n.text)}</div>` : ""}
      <div class="insp-sec">HTML</div><pre class="insp-html">${esc(n.html || "")}</pre>`;
  }

  function toast(msg) {
    if (global.FlashApp && global.FlashApp.toast) global.FlashApp.toast(msg);
  }

  window.addEventListener("message", onResult);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) stopPicker();
  });

  global.FlashInspector = { renderMetrics, inspectActive, startPicker, stopPicker, isPicking };
})(window);

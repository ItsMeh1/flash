/* Flash — settings.js : settings store + form fill/collect for the
 * flash://settings internal page + WISP pool + shortcuts + reset.
 * All form access is scoped to a container element (per-tab pages).
 */
(function (global) {
  "use strict";

  let shortcuts = [];

  function current() { return global.FlashStore.getSettings(); }

  // Fill every [data-f] field inside root from stored settings.
  function fillForm(root) {
    const s = current();
    root.querySelectorAll("[data-f]").forEach((el) => {
      const k = el.dataset.f;
      if (k === "pipedInstances") {
        el.value = (s.pipedInstances || []).join("\n");
        return;
      }
      if (el.type === "checkbox") el.checked = !!s[k];
      else if (k in s) el.value = s[k] == null ? "" : s[k];
    });
    const poolBox = root.querySelector(".pool-list");
    if (poolBox) renderPoolInto(poolBox);
    const scBox = root.querySelector(".shortcut-list");
    if (scBox) renderShortcutsInto(scBox);
    const thBox = root.querySelector(".theme-grid");
    if (thBox) renderThemeInto(thBox);
    const tbBox = root.querySelector(".toolbar-list");
    if (tbBox) renderToolbarInto(tbBox);
  }

  // Read every [data-f] field inside root, persist, apply.
  // Generic: checkboxes -> bool, number inputs -> int, everything else ->
  // trimmed string (numbers for known numeric keys are clamped). Pool list,
  // piped instances, toolbar and shortcuts keep their special handling below.
  const INT_KEYS = {
    fontScale: [70, 160], fontSize: [10, 24], panelWidth: [240, 640],
    idleThreads: [1, 16], activeThreads: [1, 32], maxConnections: [1, 32],
    requestRetries: [0, 10], mainRetries: [0, 10], fallbackRetries: [0, 10],
    retryDelayMs: [0, 30000], scriptLimit: [0, 2000], imageLimit: [0, 2000],
  };
  function collectFrom(root) {
    const patch = {};
    root.querySelectorAll("[data-f]").forEach((el) => {
      const k = el.dataset.f;
      if (!k || k === "pipedInstances" || k === "theme") return; // handled below
      if (el.type === "checkbox") { patch[k] = !!el.checked; return; }
      if (k in INT_KEYS) {
        const n = parseInt(el.value, 10);
        const fb = current()[k];
        const [lo, hi] = INT_KEYS[k];
        patch[k] = isNaN(n) ? fb : Math.min(hi, Math.max(lo, n));
        return;
      }
      patch[k] = (el.value || "").trim();
      // Untrimmed for textareas (filter rules, allowlists keep newlines).
      if (el.tagName === "TEXTAREA") patch[k] = el.value;
    });
    // Back-compat aliases + coercions.
    if (patch.fontSize != null && patch.fontScale == null) {
      patch.fontScale = Math.min(160, Math.max(70, Math.round(patch.fontSize / 14 * 100)));
    }
    if (patch.showBookmarksBar != null && patch.bookmarksBar == null) patch.bookmarksBar = !!patch.showBookmarksBar;
    if (patch.bookmarksBar != null) patch.showBookmarksBar = !!patch.bookmarksBar;
    if (!patch.transport) patch.transport = "auto";
    if (!patch.searchEngine) patch.searchEngine = "brave";
    if (patch.wispUrl !== undefined && !patch.wispUrl) patch.wispUrl = global.FlashConfig.DEFAULT_WISP;
    if (patch.fallbackUrl !== undefined && !patch.fallbackUrl) patch.fallbackUrl = global.FlashConfig.DEFAULT_WISP;
    const pool = [];
    root.querySelectorAll(".pool-row input").forEach((i) => {
      const u = i.value.trim();
      if (u) pool.push(u);
    });
    if (pool.length) patch.poolList = pool;
    const pi = root.querySelector('[data-f="pipedInstances"]');
    if (pi) {
      const lines = pi.value.split("\n").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
      if (lines.length) patch.pipedInstances = lines;
    }
    const tb = {};
    root.querySelectorAll("[data-tb]").forEach((c) => { tb[c.dataset.tb] = c.checked; });
    if (Object.keys(tb).length) patch.toolbar = tb;
    const next = global.FlashStore.saveSettings(patch);
    applyAppearance();
    applyToolbar();
    global.FlashChrome.renderBookmarks();
    global.FlashTabs.updateChrome();
    return next;
  }

  function renderPoolInto(box) {
    const s = current();
    const list = s.poolList && s.poolList.length ? s.poolList : [s.wispUrl];
    box.innerHTML = list.map((u) =>
      `<div class="pool-row"><input value="${global.FlashUtil.escapeHtml(u)}" placeholder="wss://…"><button class="btn small" data-act="del" title="Remove">×</button></div>`
    ).join("") + `<div class="f-row"><button class="btn small pool-add">Add server</button>
      <button class="btn small pool-bench">Benchmark</button> <span class="hint pool-status"></span></div>`;
    box.querySelectorAll("[data-act=del]").forEach((b, i) => {
      b.onclick = () => {
        const cur = current();
        const l = (cur.poolList || []).slice();
        l.splice(i, 1);
        global.FlashStore.saveSettings({ poolList: l.length ? l : [cur.wispUrl] });
        renderPoolInto(box);
      };
    });
    box.querySelector(".pool-add").onclick = () => {
      const cur = current();
      const l = (cur.poolList || []).slice();
      l.push("wss://");
      global.FlashStore.saveSettings({ poolList: l });
      renderPoolInto(box);
    };
    box.querySelector(".pool-bench").onclick = async (e) => {
      const btn = e.currentTarget;
      const st = box.querySelector(".pool-status");
      btn.disabled = true;
      st.textContent = "Benchmarking relays…";
      try {
        const res = await global.FlashTransport.benchmarkPool(8000);
        const short = (u) => { try { return new URL(u).hostname; } catch { return u.slice(0, 24); } };
        st.textContent = res.map((r) => `${r.ok ? r.ms + "ms" : "fail"} ${short(r.url)}`).join(" · ");
        const ordered = res.filter((r) => r.ok).map((r) => r.url)
          .concat(res.filter((r) => !r.ok).map((r) => r.url));
        global.FlashStore.saveSettings({ poolList: ordered });
        renderPoolInto(box);
      } catch (err) {
        st.textContent = "Benchmark failed: " + String(err.message || err).slice(0, 100);
        btn.disabled = false;
      }
    };
  }

  function applyTheme(id) {
    const all = global.FlashConfig.THEMES || {};
    const th = all[id] || all.abyss;
    if (!th) return;
    const root = document.documentElement.style;
    for (const k of Object.keys(th.vars)) root.setProperty("--" + k, th.vars[k]);
  }

  function renderThemeInto(box) {
    const all = global.FlashConfig.THEMES || {};
    const cur = current().theme || "abyss";
    box.innerHTML = Object.keys(all).map((id) => {
      const th = all[id];
      return `<button class="swatch${cur === id ? " sel" : ""}" data-th="${id}" title="${global.FlashUtil.escapeHtml(th.name)}">
        <span class="dots"><i style="background:${th.vars.bg}"></i><i style="background:${th.vars.panel2}"></i><i style="background:${th.vars.acc}"></i></span>
        <span>${global.FlashUtil.escapeHtml(th.name)}</span></button>`;
    }).join("");
    box.querySelectorAll(".swatch").forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.th;
        global.FlashStore.saveSettings({ theme: id });
        applyAppearance();
        // keep the hidden form field in sync for collectFrom()
        const hid = box.parentElement.querySelector('[data-f="theme"]');
        if (hid) hid.value = id;
        renderThemeInto(box);
      };
    });
  }

  // Top-bar buttons the user wants visible. Star/go/omnibox are fixed.
  const TOOLBAR_BUTTONS = [
    { key: "apps", icon: "grid", label: "Menu", el: "btnApps" },
    { key: "back", icon: "back", label: "Back", el: "btnBack" },
    { key: "fwd", icon: "fwd", label: "Forward", el: "btnFwd" },
    { key: "reload", icon: "reload", label: "Reload", el: "btnReload" },
    { key: "home", icon: "home", label: "Home", el: "btnHome" },
    { key: "settings", icon: "settings", label: "Settings", el: "btnSettings" },
    { key: "devtools", icon: "code", label: "Diagnostics", el: "btnCode" },
    { key: "assistant", icon: "sparkles", label: "AI Assistant", el: "btnAssistant" },
    { key: "protect", icon: "shield", label: "Shields", el: "protectPill" },
  ];

  function toolbarState() {
    const s = current();
    const tb = s.toolbar || {};
    const out = {};
    for (const b of TOOLBAR_BUTTONS) out[b.key] = tb[b.key] !== false;
    return out;
  }

  function applyToolbar() {
    const st = toolbarState();
    for (const b of TOOLBAR_BUTTONS) {
      const el = document.getElementById(b.el);
      if (el) el.style.display = st[b.key] ? "" : "none";
    }
  }

  function renderToolbarInto(box) {
    const st = toolbarState();
    box.innerHTML = Object.keys(st).map((k) => {
      const b = TOOLBAR_BUTTONS.find((x) => x.key === k);
      return `<div class="switch-row"><div><div class="t">${b.label}</div></div>
        <label class="switch"><input type="checkbox" data-tb="${k}"${st[k] ? " checked" : ""}><span class="tr"></span></label></div>`;
    }).join("") + `<label class="f-label">Preview</label><div class="tb-preview"></div>`;
    const draw = () => {
      const pv = box.querySelector(".tb-preview");
      const on = [];
      box.querySelectorAll("[data-tb]").forEach((c) => { if (c.checked) on.push(c.dataset.tb); });
      pv.innerHTML = on.map((k) => {
        const b = TOOLBAR_BUTTONS.find((x) => x.key === k);
        return global.FlashIcons.svg(b.icon, 15);
      }).join("") + `<span class="mock-omni"></span>`;
    };
    box.querySelectorAll("[data-tb]").forEach((c) => { c.onchange = draw; });
    draw();
  }

  function applyAppearance() {
    const s = current();
    applyTheme(s.theme);
    const scale = (s.fontScale != null ? s.fontScale : 100) / 100;
    document.documentElement.style.setProperty("--flash-font-scale", scale.toFixed(2));
    // Panel width + side (GUST parity: persistence + left/right).
    try {
      const w = Math.min(640, Math.max(240, s.panelWidth || 340));
      document.documentElement.style.setProperty("--panel-w", w + "px");
      for (const p of document.querySelectorAll(".sidepanel")) {
        if (s.rememberPanelWidth !== false) p.style.width = w + "px";
        else p.style.width = "";
        p.style.left = s.panelSide === "left" ? "10px" : "";
        p.style.right = s.panelSide === "left" ? "auto" : "";
      }
    } catch {}
    // Spellcheck inside Flash's own UI (proxied pages are unaffected).
    try {
      const sc = s.spellcheck !== false;
      for (const inp of document.querySelectorAll("#omnibox, #chatInput, .nt-input, #findInput, #reqFilter")) {
        inp.spellcheck = sc;
      }
    } catch {}
  }

  // Keyboard shortcuts: editable list of {keys, action}.
  // All combos use modifiers, so they never fire while typing plain text.
  // They intentionally override browser keys while Flash is focused
  // (same tradeoff every in-browser browser makes).
  function defaultShortcuts() {
    return [
      { keys: "ctrl+t", action: "newtab", label: "New tab" },
      { keys: "ctrl+w", action: "closetab", label: "Close tab" },
      { keys: "ctrl+l", action: "focus-url", label: "Focus address bar" },
      { keys: "ctrl+f", action: "find", label: "Find in page" },
      { keys: "ctrl+=", action: "zoom-in", label: "Zoom in" },
      { keys: "ctrl+-", action: "zoom-out", label: "Zoom out" },
      { keys: "ctrl+0", action: "zoom-reset", label: "Reset zoom" },
      { keys: "ctrl+shift+t", action: "reopen", label: "Reopen closed tab" },
      { keys: "ctrl+r", action: "reload", label: "Reload" },
      { keys: "ctrl+d", action: "bookmark", label: "Bookmark this page" },
      { keys: "ctrl+m", action: "mute", label: "Mute / unmute tab" },
      { keys: "ctrl+.", action: "assistant", label: "Toggle AI Assistant" },
      { keys: "ctrl+shift+d", action: "devtools", label: "Toggle request log" },
      { keys: "alt+home", action: "home", label: "Go home" },
      { keys: "alt+left", action: "back", label: "Back" },
      { keys: "alt+right", action: "forward", label: "Forward" },
    ];
  }
  function loadShortcuts() {
    shortcuts = global.FlashStore.get("shortcuts", null) || defaultShortcuts();
    return shortcuts;
  }
  function renderShortcutsInto(box) {
    loadShortcuts();
    box.innerHTML = shortcuts.map((s, i) =>
      `<div class="sc-row"><input data-i="${i}" value="${global.FlashUtil.escapeHtml(s.keys)}"><span>${global.FlashUtil.escapeHtml(s.label || s.action)}</span></div>`
    ).join("");
    box.querySelectorAll("input").forEach((inp) => {
      inp.onchange = () => {
        shortcuts[+inp.dataset.i].keys = inp.value.toLowerCase().trim();
        global.FlashStore.set("shortcuts", shortcuts);
      };
    });
  }

  function matchesShortcut(e) {
    try {
      if (current().shortcutsEnabled === false) return null;
    } catch {}
    const combo = [
      e.ctrlKey || e.metaKey ? "ctrl" : null,
      e.altKey ? "alt" : null,
      e.shiftKey ? "shift" : null,
      e.key.toLowerCase(),
    ].filter(Boolean).join("+");
    for (const s of loadShortcuts()) {
      if (s.keys === combo || s.keys === combo.replace("ctrl+shift+", "ctrl+")) {
        return s.action;
      }
    }
    return null;
  }

  function resetAll() {
    if (!confirm("Reset Flash? Clears settings, history, bookmarks, cookies, chat.")) return;
    for (const k of ["settings", "history", "bookmarks", "favorites", "favSeeded", "cookies", "shortcuts", "chat", "wallpaperIdx", "blockedTotal", "extensions", "extState", "boltLast", "watchQ", "bmCollapsed"]) {
      global.FlashStore.remove(k);
    }
    location.reload();
  }

  function exportStandaloneHint() {
    global.FlashApp.toast("This file IS the single-file build — it lives at the repo root and opens via file:// directly. Rebuild: python3 tools/build-single-file.py");
  }

  global.FlashSettings = {
    fillForm, collectFrom, renderPoolInto, renderShortcutsInto, renderThemeInto, renderToolbarInto,
    applyAppearance, applyToolbar,
    resetAll, exportStandaloneHint, matchesShortcut, loadShortcuts, current,
  };
})(window);

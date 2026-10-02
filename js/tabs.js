/* Flash — tabs.js : multi-tab manager with a view router.
 * Each tab shows either a sandboxed web iframe or a gorgeous flash:// page.
 * chrome omnibox always displays the real URL (https://… or flash://…).
 */
(function (global) {
  "use strict";

  const tabs = [];
  let activeId = null;
  const closedStack = []; // {url, title} for reopen-closed-tab, max 10

  function active() { return tabs.find((t) => t.id === activeId) || null; }
  function all() { return tabs.slice(); }
  function get(id) { return tabs.find((t) => t.id === id) || null; }

  function create(url, opts) {
    opts = opts || {};
    const tab = {
      id: global.FlashUtil.uid("tab"),
      url: url || "flash://newtab",
      title: "New Tab",
      view: "internal",
      internal: "newtab",
      history: [], hIndex: -1,
      zoom: 100,
      pageCache: new Map(), // finalUrl -> {srcdoc, title, t, bytes} (instant back/forward)
      loading: false,
      muted: false,
    };
    tabs.push(tab);
    if (!opts.background) setActive(tab.id);
    renderTabStrip();
    const internal = global.FlashInternal.parse(tab.url);
    if (internal) {
      showInternal(tab, internal, { push: true });
    } else {
      global.FlashApp.loadInTab(tab, tab.url, { push: true });
    }
    return tab;
  }

  function close(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const [gone] = tabs.splice(i, 1);
    if (gone.url && !gone.url.startsWith("flash://newtab")) {
      closedStack.push({ url: gone.url, title: gone.title });
      if (closedStack.length > 10) closedStack.shift();
    }
    try {
      const f = document.getElementById("frame-" + gone.id);
      if (f) {
        if (f._flashBlob) { try { URL.revokeObjectURL(f._flashBlob); } catch {} }
        f.remove();
      }
    } catch {}
    document.getElementById("stage")?.querySelectorAll(`[data-iv="${gone.id}"]`).forEach((n) => n.remove());
    try { global.FlashYT.dispose(gone.id); } catch {}
    if (activeId === id) {
      const next = tabs[Math.max(0, i - 1)];
      if (next) setActive(next.id);
      else create("flash://newtab");
    }
    renderTabStrip();
    updateChrome();
  }

  function setActive(id) {
    activeId = id;
    global.FlashInternal.syncAll();
    global.FlashYT.syncAll();
    renderTabStrip();
    updateChrome();
  }

  function showNewtab(tab) {
    showInternal(tab, "newtab", { push: false });
  }

  function showInternal(tab, name, opts) {
    opts = opts || {};
    global.FlashInternal.render(tab, name);
    if (opts.push) {
      tab.history = tab.history.slice(0, tab.hIndex + 1);
      if (tab.history[tab.history.length - 1] !== tab.url) {
        tab.history.push(tab.url);
        tab.hIndex = tab.history.length - 1;
      }
    }
    if (tab.id === activeId) updateChrome();
  }

  // Show the web iframe for a tab (used by viewers + pipeline).
  function showWeb(tab) {
    const stage = document.getElementById("stage");
    stage?.querySelectorAll(`[data-iv="${tab.id}"]`).forEach((n) => {
      n.style.display = "none";
    });
    try { global.FlashYT.dispose(tab.id); } catch {}
    const f = ensureFrame(tab, true);
    tab.view = "web";
    if (tab.id === activeId) f.style.display = "";
    return f;
  }

  function ensureFrame(tab, skipShow) {
    let f = document.getElementById("frame-" + tab.id);
    if (!f) {
      f = document.createElement("iframe");
      f.id = "frame-" + tab.id;
      // Sandboxed: scripts OK, top-escape NOT allowed. No allow-same-origin
      // so proxied origin stays opaque (cookie/storage spoofed by runtime).
      f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock");
      f.setAttribute("allow", "fullscreen; autoplay; encrypted-media; picture-in-picture;");
      f.referrerPolicy = "no-referrer";
      f.style.display = "none";
      f._flashTab = tab.id;
      f._watchArmed = true;
      // Leak watchdog: any document load we didn't cause (a navigation that
      // escaped the traps would hit the filter raw and die) reloads the last
      // good tunneled page instead of stranding the user on an error page.
      // Our own assignments are counted exactly (see noteFrameAssign): each
      // one produces exactly one load event, consumed below no matter how
      // slow the parse is. The time/cooldown guards remain as backup.
      f.addEventListener("load", () => {
        try {
          if ((f._flashPending || 0) > 0) { f._flashPending--; return; }
          const t = global.FlashTabs.get(f._flashTab);
          if (!t || t.view !== "web" || t.loading) return;
          if (Date.now() - (f._lastAssign || 0) < 4000) return;
          if (t._lastRecover && Date.now() - t._lastRecover < 8000) return;
          if (!t.url || !/^https?:/i.test(t.url)) return;
          if (t._recoveredFor === t.url) return; // one recovery per URL max
          t._lastRecover = Date.now();
          // Prefer the pre-rewrite gesture target (redirector-aware): a fresh
          // click destination reached via tunnel beats reloading the old page.
          // Otherwise fall back to the last good tunneled page. Either way the
          // user never sits on a raw filter error page.
          const g = t._gesture;
          t._gesture = null; // single use — never retry a stale guess
          t._recovering = true;
          if (g && Date.now() - g.t < 10000 && g.url !== t.url && /^https?:/i.test(g.url)) {
            t._recoveredFor = g.url;
            global.FlashApp.toast("Recovered blocked navigation");
            global.FlashApp.loadInTab(t, g.url, { push: true });
            return;
          }
          t._recoveredFor = t.url;
          global.FlashApp.toast("Stopped a direct connection — reloaded last page");
          global.FlashApp.loadInTab(t, t.url, { push: false });
        } catch {}
      });
      document.getElementById("stage").appendChild(f);
    }
    if (!skipShow && tab.view === "web" && tab.id === activeId) f.style.display = "";
    return f;
  }

  function tabFavicon(t) {
    if (t.view === "internal") {
      const ic = global.FlashInternal.ICONS[t.internal] || "zap";
      return `<span class="tab-fav"><i data-icon="${ic}" data-size="12"></i></span>`;
    }
    try {
      const blob = global.FlashApp.faviconFor(t.url);
      if (blob) return `<img class="tab-fav-img" src="${blob}" alt="">`;
    } catch {}
    const h = global.FlashUtil.hostOf(t.url);
    return `<span class="tab-fav">${global.FlashUtil.escapeHtml(((h || "?")[0] || "?").toUpperCase())}</span>`;
  }

  // Drag-to-reorder tab strip (HTML5 DnD, minimal).
  function renderTabStrip() {
    const strip = document.getElementById("tabStrip");
    if (!strip) return;
    let s = {};
    try { s = global.FlashStore.getSettings(); } catch {}
    const dragOn = s.tabDrag !== false;
    const muteOn = s.tabMuteControls !== false;
    strip.innerHTML = "";
    for (const t of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === activeId ? " on" : "") + (t.loading ? " loading" : "");
      el.draggable = !!dragOn;
      el.dataset.id = t.id;
      el.innerHTML = `${tabFavicon(t)}<span class="tab-t">${global.FlashUtil.escapeHtml((t.title || "New Tab").slice(0, 26))}</span>
        ${(t.muted && muteOn) ? `<span class="tab-m" title="Muted — double-click tab to unmute"><i data-icon="mute" data-size="12"></i></span>` : ""}
        <span class="tab-x" title="Close">${global.FlashIcons.svg("x", 13)}</span>`;
      el.onclick = (e) => {
        if (e.target.closest && e.target.closest(".tab-x")) close(t.id);
        else setActive(t.id);
      };
      if (muteOn) {
        el.ondblclick = () => toggleMute(t.id);
        el.querySelector(".tab-m")?.addEventListener("click", (e) => { e.stopPropagation(); toggleMute(t.id); });
      } else {
        el.ondblclick = null;
      }
      if (dragOn) {
        el.ondragstart = (e) => e.dataTransfer.setData("text/tab", t.id);
        el.ondragover = (e) => e.preventDefault();
        el.ondrop = (e) => {
          e.preventDefault();
          const from = e.dataTransfer.getData("text/tab");
          moveTab(from, t.id);
        };
      } else {
        el.ondragstart = null; el.ondragover = null; el.ondrop = null;
      }
      if (s.tabContextMenu !== false) {
        el.oncontextmenu = (e) => {
          e.preventDefault();
          showTabMenu(t, e.clientX, e.clientY);
        };
      } else {
        el.oncontextmenu = null;
      }
      strip.appendChild(el);
    }
    // New-tab button lives inside the strip so it always trails the last tab;
    // sticky keeps it pinned visible even when the strip overflows.
    const add = document.createElement("button");
    add.className = "tab-add";
    add.innerHTML = `<i data-icon="plus" data-size="16"></i>`;
    add.title = "New tab";
    add.setAttribute("aria-label", "New tab");
    add.onclick = () => create("flash://newtab");
    strip.appendChild(add);
    global.FlashIcons.apply(strip);
  }

  function showTabMenu(t, x, y) {
    try {
      document.getElementById("tabCtxMenu")?.remove();
      const m = document.createElement("div");
      m.id = "tabCtxMenu";
      m.style.cssText = `position:fixed;left:${Math.min(x, innerWidth - 200)}px;top:${y}px;z-index:60;min-width:180px;background:var(--panel3);border:1px solid var(--line2);border-radius:12px;padding:6px;box-shadow:var(--sh-menu);`;
      const item = (label, fn) => {
        const b = document.createElement("button");
        b.className = "item";
        b.style.cssText = "display:flex;width:100%;text-align:left;padding:8px 10px;border-radius:8px;font-size:13px;color:var(--txt);";
        b.textContent = label;
        b.onmouseenter = () => { b.style.background = "rgba(255,255,255,.07)"; };
        b.onmouseleave = () => { b.style.background = ""; };
        b.onclick = () => { m.remove(); fn(); };
        m.appendChild(b);
      };
      item(t.muted ? "Unmute tab" : "Mute tab", () => toggleMute(t.id));
      item("Duplicate tab", () => duplicate());
      item("Reload tab", () => global.FlashApp.reload());
      item("Close tab", () => close(t.id));
      item("Close other tabs", () => {
        for (const o of all()) if (o.id !== t.id) close(o.id);
      });
      document.body.appendChild(m);
      const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("click", off); } };
      setTimeout(() => document.addEventListener("click", off), 10);
    } catch {}
  }

  function reopen() {
    const last = closedStack.pop();
    if (!last) {
      global.FlashApp.toast("Nothing to reopen");
      return null;
    }
    return create(last.url);
  }

  function duplicate() {
    const t = active();
    if (!t) return null;
    const nt = create(t.url);
    if (nt && t.view === "web") nt.zoom = t.zoom || 100;
    return nt;
  }

  function moveTab(fromId, toId) {
    const fi = tabs.findIndex((t) => t.id === fromId);
    const ti = tabs.findIndex((t) => t.id === toId);
    if (fi === -1 || ti === -1) return;
    const [m] = tabs.splice(fi, 1);
    tabs.splice(ti, 0, m);
    renderTabStrip();
  }

  function toggleMute(id) {
    const t = get(id || activeId);
    if (!t) return;
    t.muted = !t.muted;
    const f = document.getElementById("frame-" + t.id);
    try {
      f?.contentWindow?.postMessage({ __flash: 2, tab: t.id, type: "mute", muted: t.muted }, "*");
    } catch {}
    renderTabStrip();
  }

  function setLoading(tab, on) {
    tab.loading = on;
    renderTabStrip();
    const anyLoading = tabs.some((x) => x.loading && x.id === activeId);
    document.body.classList.toggle("is-loading", anyLoading);
  }

  function setTitle(tab, title) {
    tab.title = title || tab.url;
    if (tab.id === activeId) updateChrome();
    renderTabStrip();
  }

  function updateChrome() {
    const t = active();
    const s = global.FlashStore.getSettings();
    const omni = document.getElementById("omnibox");
    if (omni) omni.value = t ? t.url : "";
    // lock vs flash glyph in the omnibox
    const oi = document.getElementById("omniIcon");
    if (oi && t) {
      const isFlash = t.url.startsWith("flash://");
      oi.classList.toggle("flash", isFlash);
      oi.innerHTML = global.FlashIcons.svg(isFlash ? "zap" : "lock", 15);
    }
    const star = document.getElementById("btnStar");
    if (star && t) {
      const web = t.url && !t.url.startsWith("flash://");
      const bmOff = (() => { try { return global.FLASH_FEATURES && global.FLASH_FEATURES.bookmarks === false; } catch { return false; } })();
      star.disabled = !web || bmOff;
      const marked = web && global.FlashBookmarks.all().some((b) => b.url === t.url);
      star.classList.toggle("starred", !!marked);
      star.title = !web ? "Bookmarks only apply to web pages" : marked ? "Bookmarked — click to remove" : "Bookmark this page";
    }
    // Shields button: green = all guards on, blue = partial, red = adblock off.
    const pill = document.getElementById("protectPill");
    if (pill) {
      const state = !s.adblockEnabled ? "red" : s.blockWebRTC ? "green" : "blue";
      pill.classList.remove("st-green", "st-blue", "st-red");
      pill.classList.add("st-" + state);
      pill.title = state === "green" ? "Shields up — click to adjust"
        : state === "blue" ? "Partial shields (WebRTC guard off) — click to adjust"
        : "Ad blocker off — click to adjust";
    }
    document.title = "Flash";
    tickClock();
  }

  function tickClock() {
    const s = global.FlashStore.getSettings();
    const show = s.showClock !== false;
    const now = new Date();
    const timeStr = s.clock24h
      ? now.toTimeString().slice(0, 5)
      : now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    document.querySelectorAll(".nt-time").forEach((el) => { el.style.display = show ? "" : "none"; });
    document.querySelectorAll(".nt-time-text").forEach((el) => { el.textContent = timeStr; });
    document.querySelectorAll(".nt-date").forEach((el) => { el.textContent = dateStr; });
  }
  setInterval(tickClock, 5000);

  // Every programmatic frame assignment produces exactly one load event.
  // Call this at each site so the watchdog consumes its own loads exactly
  // instead of guessing with timers (slow parses outlast any fixed window).
  function noteFrameAssign(frame) {
    try {
      frame._flashPending = (frame._flashPending || 0) + 1;
    } catch {}
  }

  global.FlashTabs = {
    active, all, get, create, close, reopen, duplicate, setActive, showNewtab, showInternal, showWeb,
    ensureFrame, setLoading, setTitle, renderTabStrip, updateChrome, toggleMute, noteFrameAssign,
  };
})(window);

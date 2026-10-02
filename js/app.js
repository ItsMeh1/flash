/* Flash — app.js : boot, omnibox, navigation pipeline, iframe message bridge.
 *
 * Pipeline (per navigation):
 *  1. normalize input -> absolute https URL (or flash://newtab)
 *  2. adblock host check -> block page
 *  3. FlashTransport.fetchViaTransport (Epoxy over WISP, pool failover, direct fallback)
 *  4. sniff content-kind -> page (rewrite+inject+srcdoc) or viewer (pdf/img/video/audio/text)
 *  5. push tab history, update chrome, record browser history
 *
 * The only network the filter sees is the WISP WebSocket (wss://...).
 * There are zero ServiceWorkers, zero server-side proxy endpoints.
 */
(function (global) {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function T(k) {
    try {
      return global.FlashI18n.t(k);
    } catch {
      return k;
    }
  }

  // Dynamic labels that static [data-i18n] markup can't reach. Called on boot
  // and after Settings save (language switch).
  function applyI18nLabels() {
    try { global.FlashI18n.apply(); } catch {}
    try {
      const pp = $("pmPause");
      if (pp) pp.textContent = T("pauseSite");
    } catch {}
    try {
      const box = $("domBox");
      if (box && box.textContent === "(no snapshot yet)") box.textContent = T("noSnapshot");
    } catch {}
  }

  function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._to);
    t._to = setTimeout(() => t.classList.remove("show"), ms || 2600);
  }

  function navigate(input, opts) {
    opts = opts || {};
    const tab = global.FlashTabs.active() || global.FlashTabs.create("flash://newtab");
    const s = global.FlashStore.getSettings();
    const url = global.FlashUtil.normalizeInput(input, s.searchEngine);
    loadInTab(tab, url, { push: true, manual: true, ...opts });
  }

  async function loadInTab(tab, url, opts) {
    opts = opts || {};
    if (!url) return;
    try {
      if (global.FlashAdblock) global.FlashAdblock.newPage();
    } catch {}
    // Internal pages render locally — no network, no proxying.
    const internal = global.FlashInternal.parse(url);
    if (internal) {
      global.FlashTabs.showInternal(tab, internal, { push: opts.push });
      setStatus("Internal page");
      return;
    }
    // YouTube gets its built-in theater (stream extraction + blob playback).
    // Skipped in raw mode and in builds without the feature.
    let ytOff = false;
    try {
      ytOff = global.FLASH_FEATURES && global.FLASH_FEATURES.youtube === false;
    } catch {}
    if (!opts.raw && !ytOff && global.FlashYT.isYouTube(url)) {
      const ytId = global.FlashYT.extractId(url);
      if (ytId) {
        tab._ytStart = global.FlashYT.parseStart(url) || 0;
        global.FlashYT.open(tab, ytId);
        if (opts.push) pushTabHistory(tab, tab.url);
        global.FlashHistory.push(tab.url, tab.title);
        setStatus("YouTube theater");
        global.FlashTabs.setLoading(tab, false);
        global.FlashTabs.updateChrome();
        return;
      }
      // Non-video YouTube URLs (homepage, channels, playlists, search pages):
      // never proxy the SPA — it redirect-loops straight out of the tunnel.
      // Land on the watch hub instead (carrying any search query).
      try {
        const q = new URL(url).searchParams.get("search_query");
        if (q) global.FlashStore.set("watchQ", q);
      } catch {}
      loadInTab(tab, "flash://watch", opts);
      return;
    }
    // Hard gate: only http(s) ever reaches the tunnel. Anything else is a
    // page bug or an escaped internal URL — refuse loudly instead of failing
    // deep inside the transport with a cryptic error.
    if (!/^https?:\/\//i.test(url)) {
      global.FlashTabs.setLoading(tab, false);
      toast("Refused navigation to non-web URL");
      return;
    }
    // Blocklist short-circuit.
    if (global.FlashAdblock.isBlocked(url)) {
      blockPage(tab, url);
      return;
    }
    tab.view = "web";
    tab.internal = null;
    // Auto-reload loop breaker: page boot-error reloads (and watchdog
    // recoveries) to the same pipeline in rapid succession stop at an error
    // card instead of spinning forever. Explicit user actions pass
    // manual:true, which bypasses and resets the counter.
    const nowAuto = Date.now();
    tab._autoLoads = (tab._autoLoads || []).filter((t) => nowAuto - t < 15000);
    if (opts.manual) {
      tab._autoLoads = [];
    } else {
      tab._autoLoads.push(nowAuto);
      if (tab._autoLoads.length > 4) {
        tab._autoLoads = [];
        const frame0 = global.FlashTabs.showWeb(tab);
        paintError(frame0, url, new Error("Stopped an automatic reload loop (5 rapid loads in 15s). The page kept requesting a reload before it finished — usually a failed boot script. Fix relays with Benchmark, then Retry."));
        global.FlashTabs.setLoading(tab, false);
        global.FlashTabs.updateChrome();
        setStatus("Stopped a reload loop");
        return;
      }
    }
    const frame = global.FlashTabs.showWeb(tab);
    global.FlashTabs.setLoading(tab, true);
    // While enrichment is pending, the base page may still be settling —
    // same-URL reloads arriving now are premature (live enrichment is still
    // filling the page), so the bridge drops them instead of restarting
    // the pipeline.
    tab._enrichPending = true;
    // Staged status: first visit still boots the ~2MB WASM engine from CDN,
    // so say so instead of a generic "Connecting" while it downloads.
    try {
      setStatus(global.FlashTransport.getStatus().ready
        ? "Connecting via " + shortWisp() + " …"
        : "Loading proxy engine (first visit downloads ~2MB) …");
    } catch {
      setStatus("Connecting via " + shortWisp() + " …");
    }
    // No interstitial: the previous page stays visible while the next loads.
    // Fresh tabs (nothing rendered yet) get a flat backdrop: no white flash.
    if (!frame.getAttribute("srcdoc") && !frame._flashBlob && !frame.getAttribute("src")) paintFreshBackdrop(frame);
    // The whole pipeline gets 60s. Tunnel fetches to filtered hosts can hang
    // (TCP blackholes don't RST), and a hung main fetch used to sit on the
    // loadbar forever. Now it becomes an error card with a retry button.
    const LOAD_TIMEOUT_MS = 60000;
    const loadTimeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Timed out loading page (60s) — try another relay")), LOAD_TIMEOUT_MS));
    let loadedKind = null;
    try {
      const { kind, srcdoc, title, resp, enrich, iconUrl } = await Promise.race([
        global.FlashRewrite.loadPage(url, { tabId: tab.id, zoom: tab.zoom || 100 }),
        loadTimeout,
      ]);
      loadedKind = kind;
      tab.url = resp.finalUrl || url;
      // A normal successful load resets recovery state (fresh slate for future
      // leaks); recovery-triggered loads preserve it (one recovery per URL).
      if (!tab._recovering) tab._recoveredFor = null;
      tab._recovering = false;
      if (kind === "page") {
        // Phase 1: paint the base document instantly.
        global.FlashRewrite.setFrameHtml(frame, srcdoc);
        global.FlashTabs.setTitle(tab, title);
        cachePage(tab, tab.url, srcdoc, title);
        fetchFavicon(tab, tab.url, iconUrl);
        // Phase 2: enrich in the background. Images/frames are live-patched
        // into the running page (no document swap: scripts never re-execute,
        // media never restarts, scroll never jumps). The enriched HTML still
        // lands in the per-tab cache so back/forward stays instant.
        const tok = (tab._renderToken = (tab._renderToken || 0) + 1);
        const finalUrl = tab.url;
        if (global.FlashRewrite.enrichDoc) {
          Promise.resolve().then(async () => {
            try {
              const full = await enrich((patch) => {
                if (tab._renderToken !== tok || tab.url !== finalUrl) return;
                const f = document.getElementById("frame-" + tab.id);
                if (!f || !f.contentWindow) return;
                try {
                  if (patch.dataUrl) {
                    f.contentWindow.postMessage({ __flash: 2, tab: tab.id, type: "img-patch", items: [{ url: patch.url, data: patch.dataUrl }] }, "*");
                  } else if (patch.frameSrcdoc != null) {
                    f.contentWindow.postMessage({ __flash: 2, tab: tab.id, type: "frame-patch", url: patch.url, srcdoc: patch.frameSrcdoc }, "*");
                  }
                } catch {}
              });
              if (tab._renderToken !== tok || tab.url !== finalUrl) return;
              cachePage(tab, finalUrl, full, tab.title);
            } catch {}
            tab._enrichPending = false;
          });
        } else {
          tab._enrichPending = false;
        }
      } else {
        await global.FlashViewers.renderNonHtml(tab, kind, resp);
      }
      if (opts.push) pushTabHistory(tab, tab.url);
      global.FlashHistory.push(tab.url, tab.title);
      setStatus(resp.engine === "direct" ? "Loaded via direct fallback (filter-visible)" : "Loaded via WISP (" + resp.engine + ")");
    } catch (e) {
      paintError(frame, url, e);
      setStatus("Failed: " + String((e && e.message) || e).slice(0, 160));
    } finally {
      // Pages clear the flag when live enrichment finishes (async, above); every
      // other path clears it here so reload suppression never sticks.
      if (loadedKind !== "page") tab._enrichPending = false;
      global.FlashTabs.setLoading(tab, false);
      global.FlashTabs.updateChrome();
    }
  }

  // Tab favicons: fetched through the tunnel once per origin, cached as blob
  // URLs (same-document use, so no origin issues). Letter avatar fallback.
  const favCache = new Map();
  const FAV_MAX_BYTES = 100 * 1024;

  function faviconFor(url) {
    try {
      const o = new URL(url).origin;
      return favCache.get(o) || null;
    } catch {
      return null;
    }
  }

  function fetchFavicon(tab, pageUrl, iconUrl) {
    const myUrl = pageUrl;
    Promise.resolve().then(async () => {
      try {
        // Favicon proxy toggle: off = Google's favicon service (may fail on
        // some networks, but avoids tunnel bytes); on = tunnel + blob cache.
        let useGoogle = false;
        try { useGoogle = global.FlashStore.getSettings().faviconProxy === false; } catch {}
        if (useGoogle) {
          try {
            const host = new URL(pageUrl).hostname;
            const g = "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(host) + "&sz=64";
            favCache.set(new URL(pageUrl).origin, g);
            if (tab.url === myUrl) global.FlashTabs.renderTabStrip();
          } catch {}
          return;
        }
        if (!iconUrl || faviconFor(pageUrl)) return;
        const resp = await global.FlashTransport.fetchViaTransport(iconUrl, { kind: "image", pageUrl });
        const ct = ((resp.headers["content-type"] || "").split(";")[0] || "").trim().toLowerCase();
        if (!resp.body || !resp.body.length || resp.body.length > FAV_MAX_BYTES) return;
        if (ct && !ct.startsWith("image/") && !ct.includes("icon")) return;
        const blob = URL.createObjectURL(new Blob([resp.body], { type: ct || "image/x-icon" }));
        try {
          favCache.set(new URL(pageUrl).origin, blob);
        } catch {}
        while (favCache.size > 100) {
          const first = favCache.keys().next().value;
          try { URL.revokeObjectURL(favCache.get(first)); } catch {}
          favCache.delete(first);
        }
        if (tab.url === myUrl) global.FlashTabs.renderTabStrip();
      } catch {}
    });
  }

  function pushTabHistory(tab, url) {
    tab.history = tab.history.slice(0, tab.hIndex + 1);
    if (tab.history[tab.history.length - 1] !== url) {
      tab.history.push(url);
      tab.hIndex = tab.history.length - 1;
    }
  }

  // Rendered-page cache: back/forward restore instantly with zero network.
  // Capped per tab (count + bytes, oldest evicted). Reload always refetches.
  const PAGE_CACHE_MAX = 20;
  const PAGE_CACHE_BYTES = 24 * 1024 * 1024;

  function cachePage(tab, url, srcdoc, title) {
    try {
      if (global.FlashStore.getSettings().tabCache === false) return;
    } catch {}
    if (!tab.pageCache) tab.pageCache = new Map();
    tab.pageCache.set(url, { srcdoc, title, t: Date.now(), bytes: srcdoc.length });
    let total = 0;
    const entries = Array.from(tab.pageCache.entries()).sort((a, b) => a[1].t - b[1].t);
    for (const [, e] of entries) total += e.bytes;
    for (const [u] of entries) {
      if (tab.pageCache.size <= PAGE_CACHE_MAX && total <= PAGE_CACHE_BYTES) break;
      total -= tab.pageCache.get(u).bytes;
      tab.pageCache.delete(u);
    }
  }

  function step(dir) {
    const t = global.FlashTabs.active();
    if (!t) return;
    const ni = t.hIndex + dir;
    if (ni < 0 || ni >= t.history.length) return;
    t.hIndex = ni;
    const url = t.history[ni];
    // Internal pages and uncached URLs go through the normal pipeline.
    let hit = null;
    try {
      const cacheOn = global.FlashStore.getSettings().tabCache !== false;
      hit = (!global.FlashInternal.parse(url) && cacheOn && t.pageCache) ? t.pageCache.get(url) : null;
    } catch {}
    if (hit && hit.srcdoc) {
      t.url = url;
      t.view = "web";
      t.internal = null;
      const frame = global.FlashTabs.showWeb(t);
      global.FlashRewrite.setFrameHtml(frame, hit.srcdoc);
      global.FlashTabs.setTitle(t, hit.title);
      return;
    }
    loadInTab(t, url, { push: false, manual: true });
  }

  function goBack() { step(-1); }
  function goForward() { step(1); }
  function reload() {
    const t = global.FlashTabs.active();
    if (!t) return;
    if (t.view === "internal") { global.FlashInternal.render(t, t.internal); return; }
    loadInTab(t, t.url, { push: false, manual: true });
  }

  function shortWisp() {
    const s = global.FlashStore.getSettings();
    try { return new URL(s.wispUrl).hostname; } catch { return s.wispUrl.slice(0, 24); }
  }

  function setStatus(s) {
    // No status bar by design — status lives in the pill tooltip.
    const pill = $("statusPill");
    if (pill && s) pill.title = s;
  }

  // Styling comes ONLY from css/flash.css [standalone-docs], injected here
  // as window.FlashInjectedCSS (generated by tools/build-single-file.py).
  // Never write raw CSS in these templates.
  function docCss() {
    return (global.FlashInjectedCSS || "");
  }

  // Flat dark backdrop for tabs with no content yet. Deliberately empty —
  // no text, no spinner. The loadbar in the chrome is the loading indicator.
  function paintFreshBackdrop(frame) {
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${docCss()}</style></head><body class="fdoc"></body></html>`;
    frame._lastAssign = Date.now();
    try { global.FlashTabs.noteFrameAssign(frame); } catch {}
  }

  function paintError(frame, url, e) {
    const msg = global.FlashUtil.escapeHtml(String((e && e.message) || e).slice(0, 500));
    const alert = global.FlashIcons.svg("alert", 22);
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${docCss()}</style></head>
      <body class="fcard-page">
      <div class="fcard"><div class="fcard-alert"><span class="fcard-ic">${alert}</span><div><h3>Flash couldn't load this page</h3><div class="fcard-url">${global.FlashUtil.escapeHtml(url)}</div></div></div>
      <code>${msg}</code>
      <div class="fcard-actions"><button class="fbtn-p" onclick="parent.postMessage({__flash:1,tab:'*',type:'ui-retry',data:{}},'*')">Retry</button><button class="fbtn" onclick="parent.postMessage({__flash:1,tab:'*',type:'ui-settings',data:{}},'*')">Change relay</button></div>
      <p class="fcard-tip">Tip: open Settings → Benchmark the pool, or pick another WISP server. Some sites only work through certain relays.</p></div></body></html>`;
    frame._lastAssign = Date.now();
    try { global.FlashTabs.noteFrameAssign(frame); } catch {}
  }

  function blockPage(tab, url) {
    try { if (global.FlashAdblock) global.FlashAdblock.noteBlocked(url); } catch {}
    const frame = global.FlashTabs.showWeb(tab);
    tab.url = url;
    tab.view = "web";
    const shield = global.FlashIcons.svg("shield", 20);
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${docCss()}</style></head><body class="fcard-page"><div class="fcard"><div class="fcard-ok"><span class="fcard-ic ok">${shield}</span><div><h3>Blocked by Flash shields</h3><div class="fcard-url">${global.FlashUtil.escapeHtml(url)}</div></div></div><p class="fcard-tip">This host is on the ad/tracker blocklist. Allow it in Settings → Privacy, or pause shields for this site from the toolbar.</p></div></body></html>`;
    frame._lastAssign = Date.now();
    try { global.FlashTabs.noteFrameAssign(frame); } catch {}
    frame.style.display = "";
    global.FlashTabs.setTitle(tab, "[blocked] " + url);
    global.FlashTabs.updateChrome();
  }

  // ---- iframe message bridge ----
  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || m.__flash !== 1) return;
    if (m.type === "ui-retry") {
      const t = global.FlashTabs.active();
      if (t) loadInTab(t, t.url, { push: false, manual: true });
      return;
    }
    if (m.type === "ui-settings") {
      navigate("flash://settings");
      return;
    }
    const tab = m.tab === "*" ? global.FlashTabs.active() : global.FlashTabs.get(m.tab);
    if (!tab) return;
    const d = m.data || {};
    switch (m.type) {
      case "navigate": {
        // Premature same-URL reloads while enrichment is still filling the
        // page are dropped — the live enrichment in flight fixes what the page is
        // complaining about (boot-error reload loops die here). Anything
        // else, or anything post-swap, loads normally.
        const sameReload = d.url && tab.url &&
          d.url.replace(/\/$/, "") === String(tab.url).replace(/\/$/, "");
        if (sameReload && tab._enrichPending) break;
        loadInTab(tab, d.url, { push: true });
        break;
      }
      case "gesture":
        // Pre-rewrite click target, captured before redirectors mutate it.
        // Used only for leak recovery below — never navigated directly.
        if (d.url && /^https?:/i.test(d.url)) tab._gesture = { url: d.url, t: Date.now() };
        break;
      case "leaving": {
        // A navigation escaped the traps (e.g. location.href = …) and is
        // heading out as a raw request. Re-capture it through the tunnel.
        // Guards: same-URL and a 3s cooldown stop redirect loops from spinning.
        const now = Date.now();
        if (d.url && /^https?:/i.test(d.url) && tab.view === "web" && !tab.loading &&
            d.url !== tab.url && (!tab._lastTrip || now - tab._lastTrip > 3000)) {
          tab._lastTrip = now;
          loadInTab(tab, d.url, { push: true });
        }
        break;
      }
      case "popup": {
        // Popup-storm guard: a page spawning tabs in a loop gets cut off.
        const pn = Date.now();
        if (!tab._pop || pn - tab._pop.t > 5000) tab._pop = { n: 0, t: pn };
        tab._pop.n += 1;
        if (tab._pop.n > 3) {
          if (tab._pop.n === 4) toast("Blocked a popup storm from this page");
          break;
        }
        global.FlashTabs.create(d.url);
        break;
      }
      case "form-post": {
        // Re-POST through the transport, then render result.
        try {
          const resp = await global.FlashTransport.fetchViaTransport(d.url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new TextEncoder().encode(d.body || ""),
            kind: "navigate",
            pageUrl: tab.url,
          });
          const { srcdoc, title } = await global.FlashRewrite.renderHtml(resp.body, resp.finalUrl, {
            tabId: tab.id, settings: global.FlashStore.getSettings(),
          });
          tab.url = resp.finalUrl;
          const f = document.getElementById("frame-" + tab.id);
          global.FlashRewrite.setFrameHtml(f, srcdoc);
          global.FlashTabs.setTitle(tab, title);
          pushTabHistory(tab, tab.url);
          global.FlashTabs.updateChrome();
        } catch (err) {
          toast("Form submit failed: " + String(err.message || err).slice(0, 120));
        }
        break;
      }
      case "subfetch": {
        // Runtime bridge: fetch subresource via WISP, return base64 to iframe.
        const frame = document.getElementById("frame-" + tab.id);
        const reply = (payload) => {
          try {
            frame.contentWindow.postMessage({ __flash: 2, tab: tab.id, id: d.id, ...payload }, "*");
          } catch {}
        };
        try {
          if (!/^https?:\/\//i.test(d.url || "")) {
            reply({ ok: false, error: "non-web URL" });
            break;
          }
          if (global.FlashAdblock.isBlocked(d.url)) {
            try { global.FlashAdblock.noteBlocked(d.url); } catch {}
            reply({ ok: false, error: "blocked by adblock" });
            break;
          }
          const resp = await global.FlashTransport.fetchViaTransport(d.url, {
            method: (d.opts && d.opts.method) || "GET",
            headers: (d.opts && d.opts.headers) || {},
            kind: "fetch",
            pageUrl: tab.url,
            body: (() => {
              const b = d.opts && d.opts.body;
              if (b == null) return undefined;
              // Structured-cloned ArrayBuffers arrive intact; rewrap as bytes.
              if (d.opts.bin) { try { return new Uint8Array(b); } catch { return undefined; } }
              return b;
            })(),
          });
          // Cap bridge payloads at ~8MB to avoid postMessage blowup.
          if (resp.body.length > 8 * 1024 * 1024) {
            reply({ ok: false, error: "bridge payload too large" });
            break;
          }
          // btoa in chunks
          let bin = "";
          const CH = 0x8000;
          for (let i = 0; i < resp.body.length; i += CH) {
            bin += String.fromCharCode.apply(null, resp.body.subarray(i, i + CH));
          }
          reply({ ok: true, status: resp.status, headers: resp.headers, b64: btoa(bin) });
        } catch (err) {
          reply({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
        }
        break;
      }
      case "title":
        if (d.title) global.FlashTabs.setTitle(tab, d.title);
        break;
      case "ready":
        // could update favicon/title here
        break;
    }
  });

  // ---- find in page (native window.find inside the frame) ----
  let findState = { tab: null, q: "", seq: 0 };

  function findOpen() {
    const t = global.FlashTabs.active();
    if (!t || t.view !== "web") {
      toast("Find works on web pages");
      return;
    }
    const bar = $("findBar");
    bar.hidden = false;
    const inp = $("findInput");
    inp.value = "";
    setFindCount("", "");
    findState = { tab: t.id, q: "", seq: 0 };
    inp.focus();
    inp.select();
  }

  function findClose() {
    $("findBar").hidden = true;
  }

  function setFindCount(text, cls) {
    const el = $("findCount");
    el.textContent = text;
    el.className = cls || "";
  }

  function findAsk(backwards) {
    const q = $("findInput").value;
    const t = global.FlashTabs.get(findState.tab);
    const f = t ? document.getElementById("frame-" + t.id) : null;
    if (!q || !f) {
      setFindCount(q ? "—" : "", "");
      return;
    }
    findState.q = q;
    const mySeq = ++findState.seq;
    const id = "find" + Date.now() + mySeq;
    const onMsg = (e) => {
      const m = e.data;
      if (!m || m.__flash !== 1 || m.type !== "find-result" || !m.data || m.data.id !== id) return;
      window.removeEventListener("message", onMsg);
      if (mySeq !== findState.seq) return; // superseded by newer keystroke
      setFindCount(m.data.found ? "found" : "no matches", m.data.found ? "hit" : "miss");
    };
    window.addEventListener("message", onMsg);
    try {
      f.contentWindow.postMessage({ __flash: 2, tab: t.id, type: "find", query: q, backwards: !!backwards, id }, "*");
    } catch {
      window.removeEventListener("message", onMsg);
    }
    setTimeout(() => window.removeEventListener("message", onMsg), 4000);
  }

  const findDebounced = (() => {
    let to = 0;
    return () => {
      clearTimeout(to);
      to = setTimeout(() => findAsk(false), 200);
    };
  })();

  // ---- per-tab zoom (baked into renders + live-applied with retries) ----
  const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

  function sendZoom(tab, tries) {
    const f = document.getElementById("frame-" + tab.id);
    if (!f) return;
    try {
      f.contentWindow.postMessage({ __flash: 2, tab: tab.id, type: "zoom", level: tab.zoom || 100 }, "*");
    } catch {}
    if ((tries || 0) < 2) {
      setTimeout(() => {
        if (global.FlashTabs.get(tab.id) === tab) sendZoom(tab, (tries || 0) + 1);
      }, 200);
    }
  }

  function setZoom(tab, level) {
    tab.zoom = Math.min(200, Math.max(50, level));
    sendZoom(tab, 0);
    toast("Zoom " + tab.zoom + "%");
  }

  function stepZoom(tab, dir) {
    const cur = tab.zoom || 100;
    let idx = 0;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      if (ZOOM_STEPS[i] <= cur) idx = i;
    }
    idx = Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + dir));
    setZoom(tab, ZOOM_STEPS[idx]);
  }
  // ---- cloaking / portability ----
  function openAboutBlank() {
    const html = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
    const w = window.open("about:blank", "_blank");
    if (!w) { toast("Popup blocked — allow popups first"); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function downloadStandaloneHint() {
    global.FlashSettings.exportStandaloneHint();
  }

  function copyLink() {
    const t = global.FlashTabs.active();
    const txt = t ? t.url : location.href;
    navigator.clipboard?.writeText(txt).then(() => toast("URL copied"));
  }

  // ---- boot ----
  function boot() {
    if ("serviceWorker" in navigator) {
      // Assert: Flash never registers one (filters kill SW-based proxies).
      // We don't touch navigator.serviceWorker at all.
    }
    // Accessibility: every titled control gets an accessible name.
    document.querySelectorAll("button[title]:not([aria-label])").forEach((b) => {
      b.setAttribute("aria-label", b.title);
    });
    // Engine state stays queryable via FlashTransport.getStatus() (About page,
    // Assistant status). No chrome readout by design.
    global.FlashSettings.applyAppearance();
    global.FlashSettings.applyToolbar();
    // Full UI translation (chrome, new tab, store, tutorial, assistant).
    try { global.FlashI18n.apply(); } catch {}
    try { global.FlashTutorial.init(); } catch {}
    // Customizer builds: hide whole features before first paint.
    try {
      const ff = global.FLASH_FEATURES || {};
      const hasAssistant = global.FlashAssistant && typeof global.FlashAssistant.init === "function";
      if (ff.bolt === false || ff.showAI === false || ff.modBolt === false) {
        const b = document.getElementById("btnAssistant");
        if (b) b.style.display = "none";
        const p = document.getElementById("assistantPanel");
        if (p) p.style.display = "none";
      } else if (hasAssistant) {
        global.FlashAssistant.init();
      }
      if (ff.devtools === false || ff.modDevtools === false) {
        const d = document.getElementById("btnCode");
        if (d) d.style.display = "none";
      }
      if (ff.shieldButton === false || ff.privacyBlocking === false) {
        const sh = document.getElementById("protectPill");
        if (sh) sh.style.display = "none";
      }
    } catch {}
    // Fullscreen on launch (best-effort: browsers require a gesture, so a
    // rejection just means the user stays windowed).
    try {
      if (global.FlashStore.getSettings().fullscreenOnLaunch) {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      }
    } catch {}
    global.FlashTabs.create("flash://newtab");
    global.FlashChrome.renderBookmarks();
    bindChrome();
    applyDevtoolsVisibility();
    applyI18nLabels();
    // Warm the WASM engine in the background so the first navigation
    // doesn't pay the CDN download cost. Silent on failure (lazy path remains).
    try { global.FlashTransport.warmup(); } catch {}
    // Fastest-relay-first: when idle, handshake the pool in parallel and
    // reorder (stale >12h or never). Browsing then starts on the quickest
    // relay instead of list order. Silent; manual Benchmark still exists.
    try {
      const runBench = () => {
        try {
          const s = global.FlashStore.getSettings();
          if (!s.poolEnabled) return;
          const last = global.FlashStore.get("poolBenchmarkAt", 0) || 0;
          if (Date.now() - last > 12 * 3600 * 1000) {
            Promise.resolve(global.FlashTransport.backgroundBenchmark()).catch(() => {});
          }
        } catch {}
      };
      if (window.requestIdleCallback) {
        requestIdleCallback(() => setTimeout(runBench, 0), { timeout: 5000 });
      } else {
        setTimeout(runBench, 3000);
      }
    } catch {}
    setStatus("Ready");
    document.dispatchEvent(new CustomEvent("flash:ready"));
    // First-run tutorial overlay.
    try {
      const s = global.FlashStore.getSettings();
      const ff = global.FLASH_FEATURES || {};
      const tutOff = ff.tutorial === false || ff.showTutorial === false || ff.tutorialInclude === false;
      if (!tutOff && !s.tutorialDone && s.tutorialAutoStart !== false) {
        setTimeout(() => startTutorial(false), 600);
      }
    } catch {}
  }

  // Devtools split toggles: hide individual Diagnostics tabs at runtime.
  function applyDevtoolsVisibility() {
    let s = {};
    try { s = global.FlashStore.getSettings(); } catch {}
    const map = { requests: "showLogs", dom: "showInspector", metrics: "showMetrics" };
    for (const [pane, key] of Object.entries(map)) {
      const on = s[key] !== false;
      document.querySelectorAll(`#diagPanel .ptab[data-pane="${pane}"]`).forEach((el) => { el.style.display = on ? "" : "none"; });
      const pg = document.getElementById("pane-" + pane);
      if (pg && !on) pg.classList.remove("on");
    }
    // If the active tab got hidden, fall back to the first visible one.
    try {
      const anyOn = document.querySelector("#diagPanel .pane.on");
      if (!anyOn) {
        const first = Object.keys(map).find((p) => (s[map[p]] !== false));
        if (first) openDiag(first);
      }
    } catch {}
  }

  // Guided tour: delegated to the spotlight engine (js/tutorial.js).
  function startTutorial(fromSettings) {
    try {
      const ff = global.FLASH_FEATURES || {};
      if (ff.tutorial === false || ff.showTutorial === false || ff.tutorialInclude === false) {
        if (fromSettings) toast("Tutorial isn't included in this build");
        return;
      }
    } catch {}
    try {
      global.FlashTutorial.start();
    } catch {}
  }

  // Two independent floating windows: assistant and diagnostics.
  function openDiag(pane) {
    const p = $("diagPanel");
    if (!p) return;
    let s = {};
    try { s = global.FlashStore.getSettings(); } catch {}
    const map = { requests: "showLogs", dom: "showInspector", metrics: "showMetrics" };
    if (pane && s[map[pane]] === false) {
      pane = Object.keys(map).find((k) => s[map[k]] !== false) || null;
      if (!pane) { toast("All diagnostics panels are disabled in Settings"); return; }
    }
    p.classList.add("open");
    if (pane) {
      document.querySelectorAll("#diagPanel .ptab").forEach((x) => x.classList.toggle("on", x.dataset.pane === pane));
      document.querySelectorAll("#diagPanel .pane").forEach((pg) => pg.classList.toggle("on", pg.id === "pane-" + pane));
    }
    if (!pane || pane === "metrics") global.FlashInspector.renderMetrics();
    if (!pane || pane === "requests") global.FlashLog.render();
  }

  function toggleDiag(pane) {
    const p = $("diagPanel");
    if (!p) return;
    const target = pane || "requests";
    const paneEl = document.getElementById("pane-" + target);
    if (p.classList.contains("open") && paneEl && paneEl.classList.contains("on")) {
      p.classList.remove("open");
      return;
    }
    openDiag(target);
  }

  function toggleAssistant() {
    try {
      const ff = global.FLASH_FEATURES || {};
      if (ff.bolt === false || ff.showAI === false || ff.modBolt === false) {
        toast("AI Assistant isn't included in this build");
        return;
      }
    } catch {}
    const p = $("assistantPanel");
    if (!p) return;
    p.classList.toggle("open");
  }

  function syncProtectMenu() {
    const s = global.FlashStore.getSettings();
    const set = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    set("pmAdblock", s.adblockEnabled);
    set("pmCosmetic", s.cosmeticFiltering);
    set("pmWebRTC", s.blockWebRTC);
    const c = $("pmCount");
    if (c) {
      try {
        const st = global.FlashAdblock.stats();
        c.textContent = `${st.page} blocked on this page · ${st.total} total`;
      } catch {
        c.textContent = "";
      }
    }
  }

  // Safe binder: stripped builds lack some controls; never crash boot.
  function on(id, ev, fn) {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
  }

  function bindChrome() {
    const omni = $("omnibox");
    const go = () => navigate(omni.value);
    $("btnGo").onclick = go;
    omni.onkeydown = (e) => { if (e.key === "Enter") go(); };
    $("btnBack").onclick = goBack;
    $("btnFwd").onclick = goForward;
    $("btnReload").onclick = reload;
    $("btnHome").onclick = () => navigate("flash://newtab");
    $("btnSettings").onclick = () => navigate("flash://settings");
    on("btnCode", "click", () => toggleDiag("requests"));
    on("btnAssistant", "click", () => toggleAssistant());
    on("assistantClose", "click", () => toggleAssistant());
    on("diagClose", "click", () => { const p = $("diagPanel"); if (p) p.classList.remove("open"); });
    // Shields popup (absent when adblock is stripped).
    const pmenu = $("protectMenu");
    if (pmenu && $("protectPill")) {
    $("protectPill").onclick = (e) => {
      e.stopPropagation();
      syncProtectMenu();
      pmenu.classList.toggle("open");
    };
    document.addEventListener("click", (e) => {
      if (!pmenu.contains(e.target)) pmenu.classList.remove("open");
    });
    const saveShields = () => {
      global.FlashStore.saveSettings({
        adblockEnabled: $("pmAdblock").checked,
        cosmeticFiltering: $("pmCosmetic").checked,
        blockWebRTC: $("pmWebRTC").checked,
      });
      global.FlashTabs.updateChrome();
    };
    on("pmAdblock", "change", saveShields);
    on("pmCosmetic", "change", saveShields);
    on("pmWebRTC", "change", saveShields);
    on("pmSettings", "click", () => { pmenu.classList.remove("open"); navigate("flash://settings"); });
    // Per-site pause: adds the current host to the allowlist (Settings → Privacy).
    if (!$("pmPause")) {
      const b = document.createElement("button");
      b.className = "btn small";
      b.id = "pmPause";
      b.style.margin = "4px 6px 6px";
      b.style.width = "calc(100% - 12px)";
      b.style.justifyContent = "center";
      b.textContent = T("pauseSite");
      b.onclick = () => {
        const t = global.FlashTabs.active();
        const host = t ? global.FlashUtil.hostOf(t.url) : "";
        if (!host || t.url.startsWith("flash://")) { toast("Open a web page first"); return; }
        const cur = global.FlashStore.getSettings().pausedSites || "";
        const list = String(cur).split(/[\n,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (!list.includes(host)) list.push(host);
        global.FlashStore.saveSettings({ pausedSites: list.join("\n") });
        pmenu.classList.remove("open");
        toast("Adblock paused for " + host);
      };
      pmenu.appendChild(b);
    }
    }
    on("btnStar", "click", toggleBookmarkCurrent);
    // Apps menu (overflow actions).
    const menu = $("appsMenu");
    $("btnApps").onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle("open");
      const t = global.FlashTabs.active();
      const m = document.querySelector("#mMute span");
      if (m && t) m.textContent = t.muted ? T("mUnmute") : T("mMute");
      const bb = document.querySelector("#mBar span");
      if (bb) bb.textContent = global.FlashStore.getSettings().bookmarksBar ? T("mBarHide") : T("mBarShow");
    };
    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target)) menu.classList.remove("open");
    });
    $("mNewTab").onclick = () => { menu.classList.remove("open"); global.FlashTabs.create("flash://newtab"); };
    $("mHome").onclick = () => { menu.classList.remove("open"); navigate("flash://newtab"); };
    $("mHist").onclick = () => { menu.classList.remove("open"); navigate("flash://history"); };
    $("mMute").onclick = () => { menu.classList.remove("open"); global.FlashTabs.toggleMute(); };
    $("mBar").onclick = () => {
      menu.classList.remove("open");
      const s = global.FlashStore.getSettings();
      const next = !s.bookmarksBar;
      global.FlashStore.saveSettings({ bookmarksBar: next, showBookmarksBar: next });
      global.FlashChrome.renderBookmarks();
    };
    $("mCopy").onclick = () => { menu.classList.remove("open"); copyLink(); };
    $("mBlank").onclick = () => { menu.classList.remove("open"); openAboutBlank(); };
    $("mSave").onclick = () => { menu.classList.remove("open"); downloadStandaloneHint(); };
    $("mDup").onclick = () => { menu.classList.remove("open"); global.FlashTabs.duplicate(); };
    $("mReopen").onclick = () => { menu.classList.remove("open"); global.FlashTabs.reopen(); };
    $("mReset").onclick = () => { menu.classList.remove("open"); global.FlashSettings.resetAll(); };
    // panel tabs (diagnostics window; absent when devtools stripped)
    document.querySelectorAll("#diagPanel .ptab").forEach((b) => {
      b.onclick = () => openDiag(b.dataset.pane);
    });
    on("reqFilter", "input", () => global.FlashLog.render());
    on("reqClear", "click", () => global.FlashLog.clear());
    on("btnInspect", "click", () => global.FlashInspector.inspectActive());
    on("btnPick", "click", () => {
      if (global.FlashInspector.isPicking()) global.FlashInspector.stopPicker();
      else { openDiag("dom"); global.FlashInspector.startPicker(); }
    });
    // find bar
    $("findInput").oninput = findDebounced;
    $("findInput").onkeydown = (e) => {
      if (e.key === "Enter") findAsk(e.shiftKey);
      else if (e.key === "Escape") findClose();
    };
    $("findNext").onclick = () => findAsk(false);
    $("findPrev").onclick = () => findAsk(true);
    $("findClose").onclick = findClose;
    // Fast search suggestions under the omnibox.
    try {
      if (global.FlashSuggest) {
        global.FlashSuggest.attach($("omnibox"), $("suggestBox"), (v) => navigate(v));
      }
    } catch {}
    function toggleBookmarkCurrent() {
    const t = global.FlashTabs.active();
    if (t && t.url && !t.url.startsWith("flash://")) {
      global.FlashBookmarks.toggle(t.url, t.title);
      global.FlashTabs.updateChrome();
    }
  }

    // global shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("findBar").hidden) {
        // Don't steal Esc from the inspector picker modeless state.
        if (document.activeElement === $("findInput") || !global.FlashInspector.isPicking()) findClose();
        return;
      }
      const act = global.FlashSettings.matchesShortcut(e);
      if (!act) return;
      e.preventDefault();
      if (act === "newtab") global.FlashTabs.create("flash://newtab");
      if (act === "closetab") { const t = global.FlashTabs.active(); if (t) global.FlashTabs.close(t.id); }
      if (act === "reopen") global.FlashTabs.reopen();
      if (act === "focus-url") omni.focus(), omni.select();
      if (act === "find") findOpen();
      if (act === "zoom-in") { const t = global.FlashTabs.active(); if (t) stepZoom(t, 1); }
      if (act === "zoom-out") { const t = global.FlashTabs.active(); if (t) stepZoom(t, -1); }
      if (act === "zoom-reset") { const t = global.FlashTabs.active(); if (t) setZoom(t, 100); }
      if (act === "reload") reload();
      if (act === "back") goBack();
      if (act === "forward") goForward();
      if (act === "bookmark") toggleBookmarkCurrent();
      if (act === "mute") global.FlashTabs.toggleMute();
      if (act === "home") navigate("flash://newtab");
      if (act === "assistant") toggleAssistant();
      if (act === "devtools") toggleDiag("requests");
    });
  }

  global.FlashApp = { boot, navigate, loadInTab, goBack, goForward, reload, openAboutBlank, toast, openDiag, toggleDiag, toggleAssistant, faviconFor, startTutorial, applyDevtoolsVisibility, applyI18nLabels };
})(window);

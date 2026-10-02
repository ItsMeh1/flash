/* Flash — internal.js : gorgeous flash:// pages (newtab, settings, history,
 * bookmarks, about). Each tab owns one `.iv` div per internal view; the tab
 * router (tabs.js) shows/hides them exactly like iframes.
 */
(function (global) {
  "use strict";

  const U = () => global.FlashUtil;
  const I = () => global.FlashIcons.svg;

  const TITLES = {
    newtab: "New Tab",
    settings: "Settings",
/* FEATURE:history:begin */     history: "History", /* FEATURE:history:end */
/* FEATURE:bookmarks:begin */     bookmarks: "Bookmarks", /* FEATURE:bookmarks:end */
    about: "About Flash",
/* FEATURE:watch:begin */     watch: "Watch", /* FEATURE:watch:end */
    store: "Store",
  };
  const ICONS = {
    newtab: "globe",
    settings: "settings",
/* FEATURE:history:begin */     history: "rewind", /* FEATURE:history:end */
/* FEATURE:bookmarks:begin */     bookmarks: "bookmark", /* FEATURE:bookmarks:end */
    about: "zap",
/* FEATURE:watch:begin */     watch: "play", /* FEATURE:watch:end */
    store: "grid",
  };

  function parse(url) {
    if (!url || typeof url !== "string") return null;
    const m = /^flash:\/\/([a-z]+)/i.exec(url.trim());
    if (!m) return null;
    const name = m[1].toLowerCase();
    return TITLES[name] ? name : "newtab";
  }

  function stage() { return document.getElementById("stage"); }

  function render(tab, name) {
    name = TITLES[name] ? name : "newtab";
    // Drop any previous internal view for this tab.
    stage().querySelectorAll(`[data-iv="${tab.id}"]`).forEach((n) => n.remove());
    try { global.FlashYT.dispose(tab.id); } catch {}
    const frame = document.getElementById("frame-" + tab.id);
    if (frame) frame.style.display = "none";

    const div = document.createElement("div");
    div.className = "iv iv-" + name;
    div.dataset.iv = tab.id;
    div.innerHTML = TPL[name]();
    stage().appendChild(div);

    tab.view = "internal";
    tab.internal = name;
    tab.url = "flash://" + name;
    BIND[name](div, tab);
    global.FlashIcons.apply(div);
    global.FlashTabs.setTitle(tab, TITLES[name]);
    // Only this tab's view visible if it's the active tab.
    syncVisibility(tab);
    return div;
  }

  function syncVisibility(tab) {
    const on = global.FlashTabs.active() === tab;
    stage().querySelectorAll(`[data-iv="${tab.id}"]`).forEach((n) => {
      n.style.display = on ? "" : "none";
    });
    const frame = document.getElementById("frame-" + tab.id);
    if (frame) frame.style.display = on && tab.view === "web" ? "" : "none";
  }

  function syncAll() {
    for (const t of global.FlashTabs.all()) syncVisibility(t);
  }

  // Re-render the active tab if it shows one of the given pages (used after
  // bookmark/history/settings mutations so pages never go stale).
  function refreshIfActive(names) {
    const t = global.FlashTabs.active();
    if (t && t.view === "internal" && names.includes(t.internal)) {
      render(t, t.internal);
    }
  }

  /* ── newtab ─────────────────────────────────────────── */
  function T(k) {
    try {
      return global.FlashI18n.t(k);
    } catch {
      return k;
    }
  }

  function tplNewtab() {
    const s = global.FlashStore.getSettings();
    return `
      <div class="nt-top"><div class="nt-date">…</div>
        <div class="nt-time"><span class="nt-time-text">…</span><i data-icon="sun" data-size="17"></i></div></div>
      <div class="nt-center">
        <div class="wordmark"><h1>flashnext</h1><span class="ver-badge">v${global.FlashConfig.VERSION}</span></div>
        <div class="nt-sub">${U().escapeHtml(T("tagline"))}</div>
        <div class="nt-searchrow">
          <select class="eng-select" title="Search engine">
            <option value="brave">Brave</option>
            <option value="bing">Bing</option>
            <option value="duck">DuckDuckGo</option>
            <option value="custom">Custom</option>
          </select>
          <div class="nt-searchbox">
            <input class="nt-input" placeholder="${U().escapeHtml(T("searchPh"))}" autocomplete="off" spellcheck="false">
            <button class="nt-go" title="${U().escapeHtml(T("go"))}"><i data-icon="arrowRight" data-size="19"></i></button>
            <div class="nt-suggest" hidden></div>
          </div>
        </div>
        <div class="nt-favwrap"></div>
      </div>
      <div class="nt-corners">
        <div class="corner-bl">
          <button class="corner-btn nt-bm" title="${U().escapeHtml(T("mBarShow"))}"><i data-icon="bookmark" data-size="19"></i></button>
        </div>
      </div>
      <div class="fav-modal" hidden>
        <div class="fav-dialog" role="dialog" aria-label="${U().escapeHtml(T("favTitle"))}">
          <h3>${U().escapeHtml(T("favTitle"))}</h3>
          <p class="hint tight">${U().escapeHtml(T("favDesc"))}</p>
          <label class="f-label">${U().escapeHtml(T("favUrlL"))}</label>
          <input class="fav-url" placeholder="https://…" autocomplete="off" spellcheck="false">
          <label class="f-label">${U().escapeHtml(T("favNameL"))}</label>
          <input class="fav-title" placeholder="…" autocomplete="off" spellcheck="false">
          <label class="f-label">${U().escapeHtml(T("favPickL"))}</label>
          <select class="fav-pick"><option value="">Choose…</option></select>
          <div class="f-row fav-actions">
            <button class="btn primary fav-save">${U().escapeHtml(T("favSave"))}</button>
            <button class="btn fav-cancel">${U().escapeHtml(T("favCancel"))}</button>
          </div>
        </div>
      </div>`;
  }

  function bindNewtab(div, tab) {
    const s = global.FlashStore.getSettings();
    if (s.wallpaper) {
      div.style.backgroundImage = `url("${s.wallpaper.replace(/"/g, "")}")`;
      div.style.backgroundSize = "cover";
    }
    const sel = div.querySelector(".eng-select");
    sel.value = s.searchEngine || "brave";
    sel.onchange = () => {
      global.FlashStore.saveSettings({ searchEngine: sel.value });
      div.querySelector(".nt-input").focus();
    };
    const inp = div.querySelector(".nt-input");
    const go = () => {
      const v = inp.value.trim();
      if (!v) return;
      global.FlashStore.saveSettings({ searchEngine: sel.value });
      global.FlashApp.navigate(v);
    };
    div.querySelector(".nt-go").onclick = go;
    // Enter always navigates as typed; arrowing through suggestions already
    // writes the highlighted pick into the input first.
    inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
    try {
      const sugBox = div.querySelector(".nt-suggest");
      if (sugBox && global.FlashSuggest) {
        global.FlashSuggest.attach(inp, sugBox, (v) => {
          global.FlashStore.saveSettings({ searchEngine: sel.value });
          global.FlashApp.navigate(v);
        });
      }
    } catch {}
    div.querySelector(".nt-bm").onclick = () => global.FlashApp.navigate("flash://bookmarks");
    renderFavTiles(div);
    setTimeout(() => { try { inp.focus(); } catch {} }, 50);
  }

  function renderFavTiles(div) {
    const box = div.querySelector(".nt-favwrap");
    if (!box) return;
    global.FlashFavorites.seedIfEmpty();
    const list = global.FlashFavorites.all().slice(0, 7);
    box.innerHTML =
      list.map((b) => {
        const h = U().hostOf(b.url);
        const letter = U().escapeHtml((h || "?")[0].toUpperCase());
        return `<button class="fav-tile" data-url="${U().escapeHtml(b.url)}" title="${U().escapeHtml(b.url)}">
          <span class="fav-box">${letter}</span><span class="lbl">${U().escapeHtml(b.title || b.url)}</span></button>`;
      }).join("") +
      `<button class="fav-tile dashed" data-add="1" title="${U().escapeHtml(T("addFav"))}">
        <span class="fav-box"><i data-icon="plus" data-size="22"></i></span><span class="lbl">${U().escapeHtml(T("addFav"))}</span></button>`;
    global.FlashIcons.apply(box);
    box.querySelectorAll(".fav-tile[data-url]").forEach((el) => {
      el.onclick = () => global.FlashApp.navigate(el.dataset.url);
    });
    const add = box.querySelector("[data-add]");
    if (add) add.onclick = () => openFavDialog(div);
  }

  function openFavDialog(div) {
    const modal = div.querySelector(".fav-modal");
    if (!modal) return;
    const urlIn = modal.querySelector(".fav-url");
    const titleIn = modal.querySelector(".fav-title");
    const pick = modal.querySelector(".fav-pick");
    urlIn.value = "";
    titleIn.value = "";
    pick.innerHTML = `<option value="">Choose…</option>` + global.FlashBookmarks.all().map((b) =>
      `<option value="${U().escapeHtml(b.url)}">${U().escapeHtml((b.title || b.url).slice(0, 40))}</option>`).join("");
    const close = () => { modal.hidden = true; };
    modal.querySelector(".fav-cancel").onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    modal.querySelector(".fav-save").onclick = () => {
      let url = urlIn.value.trim() || pick.value;
      if (!url) { global.FlashApp.toast("Enter a URL first"); return; }
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
      try {
        url = new URL(url).href;
      } catch {
        global.FlashApp.toast("That URL doesn't look valid");
        return;
      }
      if (!/^https?:/i.test(url)) { global.FlashApp.toast("Only web URLs can be favorites"); return; }
      const title = titleIn.value.trim() || U().hostOf(url) || url;
      global.FlashFavorites.add(url, title);
      close();
      renderFavTiles(div);
      global.FlashApp.toast("Favorite added");
    };
    modal.hidden = false;
    setTimeout(() => { try { urlIn.focus(); } catch {} }, 30);
  }

  /* ── settings ───────────────────────────────────────── */
  function tplSettings() {
    return `
    <div class="pg">
      <div class="pg-head"><span class="pg-ic"><i data-icon="settings" data-size="22"></i></span><h2>Settings</h2></div>
      <p class="pg-sub">Stored locally per browser (<code>flash:*</code>). Applies instantly on save.</p>

      <div class="card" data-section="connection"><h3><i data-icon="server" data-size="16"></i>${T("cConnection")}</h3>
        <label class="f-label">WISP WebSocket URL</label>
        <input data-f="wispUrl" placeholder="wss://…">
        <label class="f-label">WASM engine (TLS-in-page)</label>
        <select data-f="transport">
          <option value="auto">Auto — Epoxy speed, libcurl.js fallback (default)</option>
          <option value="epoxy">Epoxy (fast Rust stack)</option>
          <option value="libcurl">libcurl.js (curl compatibility)</option>
        </select>
        <div class="switch-row"><div><div class="t">Pool round-robin</div>
          <div class="d">Rotate fast relays; dead ones are skipped per site.</div></div>
          <label class="switch"><input type="checkbox" data-f="poolEnabled"><span class="tr"></span></label></div>
        <label class="f-label">Server pool (5 verified relays)</label>
        <div class="pool-list"></div>
        <div class="f-row" style="margin-top:8px;">
          <div style="flex:1;min-width:90px;"><label class="f-label">Idle threads</label><input data-f="idleThreads" type="number" min="1" max="16" step="1"></div>
          <div style="flex:1;min-width:90px;"><label class="f-label">Active threads</label><input data-f="activeThreads" type="number" min="1" max="32" step="1"></div>
          <div style="flex:1;min-width:90px;"><label class="f-label">Retries</label><input data-f="requestRetries" type="number" min="0" max="10" step="1"></div>
        </div>
        <label class="f-label">Max connections per host</label>
        <input data-f="maxConnections" type="number" min="1" max="32" step="1">
        <div class="switch-row"><div><div class="t">Smart request headers</div>
          <div class="d">Spoof Sec-Fetch-* + Referer bundle. Off = minimal headers (some CDNs may reject).</div></div>
          <label class="switch"><input type="checkbox" data-f="smartHeaders"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="fallback"><h3><i data-icon="rewind" data-size="16"></i>${T("cFallback")}</h3>
        <div class="switch-row"><div><div class="t">Enable fallback relay</div>
          <div class="d">If the primary relay fails, retry through the fallback before showing an error.</div></div>
          <label class="switch"><input type="checkbox" data-f="fallbackEnabled"><span class="tr"></span></label></div>
        <label class="f-label">Fallback server URL</label>
        <input data-f="fallbackUrl" placeholder="wss://…">
        <div class="f-row" style="margin-top:8px;">
          <div style="flex:1;min-width:90px;"><label class="f-label">Main retries</label><input data-f="mainRetries" type="number" min="0" max="10" step="1"></div>
          <div style="flex:1;min-width:90px;"><label class="f-label">Fallback retries</label><input data-f="fallbackRetries" type="number" min="0" max="10" step="1"></div>
          <div style="flex:1;min-width:90px;"><label class="f-label">Retry delay (ms)</label><input data-f="retryDelayMs" type="number" min="0" max="30000" step="500"></div>
        </div>
        <div class="switch-row"><div><div class="t">Trigger on 5xx</div></div>
          <label class="switch"><input type="checkbox" data-f="fallbackOn5xx"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Trigger on timeout</div></div>
          <label class="switch"><input type="checkbox" data-f="fallbackOnTimeout"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Trigger on DNS failure</div>
          <div class="d">Off by default (generic connection errors still fall back).</div></div>
          <label class="switch"><input type="checkbox" data-f="fallbackOnDns"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="ai"><h3><i data-icon="sparkles" data-size="16"></i>${T("cAI")}</h3>
        <div class="switch-row"><div><div class="t">Online answers</div>
          <div class="d">Free keyless AI when connected; on-device brain when offline.</div></div>
          <label class="switch"><input type="checkbox" data-f="aiOnline"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Page context by default</div>
          <div class="d">Include the current page outline with questions.</div></div>
          <label class="switch"><input type="checkbox" data-f="aiContext"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="search"><h3><i data-icon="search" data-size="16"></i>${T("cSearch")}</h3>
        <label class="f-label">Default search engine</label>
        <select data-f="searchEngine">
          <option value="brave">Brave</option>
          <option value="bing">Bing</option>
          <option value="duck">DuckDuckGo</option>
          <option value="custom">Custom…</option>
        </select>
        <label class="f-label">Custom engine name</label>
        <input data-f="customEngineName" placeholder="My search">
        <label class="f-label">Custom engine URL (use %s for the query)</label>
        <input data-f="customEngineUrl" placeholder="https://search.example/?q=%s">
        <div class="switch-row"><div><div class="t">Spellcheck (Flash UI)</div>
          <div class="d">Only affects Flash's own inputs — never proxied pages.</div></div>
          <label class="switch"><input type="checkbox" data-f="spellcheck"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Proxy tab favicons through WISP</div>
          <div class="d">Off = Google favicon service (may fail on some networks).</div></div>
          <label class="switch"><input type="checkbox" data-f="faviconProxy"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Search suggestions</div>
          <div class="d">Fast dropdown under the address bar and new-tab search. Suggestions ride the tunnel too, so they work on file:// with no CORS issues.</div></div>
          <label class="switch"><input type="checkbox" data-f="searchSuggest"><span class="tr"></span></label></div>
      </div>

/* FEATURE:youtube:begin */
      <div class="card" data-feat="youtube" data-section="video"><h3><i data-icon="zap" data-size="16"></i>${T("cVideo")}</h3>
        <div class="switch-row"><div><div class="t">Piped fallback for YouTube</div>
          <div class="d">When YouTube yields no playable file, resolve through Piped API instances (video + synced audio).</div></div>
          <label class="switch"><input type="checkbox" data-f="pipedEnabled"><span class="tr"></span></label></div>
        <label class="f-label">Piped instances (one hostname per line)</label>
        <textarea data-f="pipedInstances" rows="3" placeholder="pipedapi.kavin.rocks"></textarea>
      </div>
/* FEATURE:youtube:end */

      <div class="card" data-section="privacy"><h3><i data-icon="shield" data-size="16"></i>${T("cPrivacy")}</h3>
/* FEATURE:history:begin */
        <div class="switch-row" data-feat="history"><div><div class="t">Record history</div>
          <div class="d">Off by default. Nothing is recorded unless you opt in.</div></div>
          <label class="switch"><input type="checkbox" data-f="historyEnabled"><span class="tr"></span></label></div>
/* FEATURE:history:end */
/* FEATURE:adblock:begin */
        <div class="switch-row" data-feat="adblock"><div><div class="t">Ad / tracker blocker</div></div>
          <label class="switch"><input type="checkbox" data-f="adblockEnabled"><span class="tr"></span></label></div>
/* FEATURE:adblock:end */
/* FEATURE:adblock:begin */
        <div class="switch-row" data-feat="adblock"><div><div class="t">Cosmetic filtering</div>
          <div class="d">Hide ad slots with CSS.</div></div>
          <label class="switch"><input type="checkbox" data-f="cosmeticFiltering"><span class="tr"></span></label></div>
/* FEATURE:adblock:end */
/* FEATURE:adblock:begin */         <label class="f-label" data-feat="adblock">Extra cosmetic CSS rules</label> /* FEATURE:adblock:end */
/* FEATURE:adblock:begin */         <textarea data-f="customCosmeticRules" data-feat="adblock" rows="2" placeholder=".annoying-popup{display:none!important;}"></textarea> /* FEATURE:adblock:end */
/* FEATURE:adblock:begin */         <label class="f-label" data-feat="adblock">Custom blocked hosts (one per line, plain or ||domain^)</label> /* FEATURE:adblock:end */
/* FEATURE:adblock:begin */         <textarea data-f="customHosts" data-feat="adblock" rows="2" placeholder="||tracker.example^"></textarea> /* FEATURE:adblock:end */
        <label class="f-label">Paused sites (one host per line — adblock off here)</label>
        <textarea data-f="pausedSites" rows="2" placeholder="example.com"></textarea>
        <div class="switch-row"><div><div class="t">Spoof User-Agent</div></div>
          <label class="switch"><input type="checkbox" data-f="spoofUA"><span class="tr"></span></label></div>
        <label class="f-label">Request User-Agent (header, blank = Chrome profile)</label>
        <input data-f="requestUA" placeholder="Mozilla/5.0 …">
        <label class="f-label">Page navigator.userAgent (blank = real value)</label>
        <input data-f="pageUA" placeholder="Mozilla/5.0 …">
        <label class="f-label">Custom UA (legacy alias of request UA)</label>
        <input data-f="customUA" placeholder="Mozilla/5.0 …">
/* FEATURE:webrtc:begin */
        <div class="switch-row" data-feat="webrtc"><div><div class="t">Block WebRTC</div>
          <div class="d">Prevents IP leaks via peer connections.</div></div>
          <label class="switch"><input type="checkbox" data-f="blockWebRTC"><span class="tr"></span></label></div>
/* FEATURE:webrtc:end */
      </div>

      <div class="card" data-section="cache"><h3><i data-icon="rewind" data-size="16"></i>${T("cCache")}</h3>
        <div class="switch-row"><div><div class="t">Keep tabs loaded in background</div>
          <div class="d">Instant back/forward with zero network. Off = always reload.</div></div>
          <label class="switch"><input type="checkbox" data-f="tabCache"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Show Clear Cache / Reset buttons</div></div>
          <label class="switch"><input type="checkbox" data-f="showCacheButtons"><span class="tr"></span></label></div>
        <div class="f-row cache-btns">
          <button class="btn small cache-clear">${T("clearCache")}</button>
          <button class="btn small danger cache-reset">${T("resetAll")}</button>
        </div>
      </div>

      <div class="card" data-section="media"><h3><i data-icon="image" data-size="16"></i>${T("cMedia")}</h3>
        <div class="f-row">
          <div style="flex:1;min-width:90px;"><label class="f-label">Script limit</label><input data-f="scriptLimit" type="number" min="0" max="2000" step="10"></div>
          <div style="flex:1;min-width:90px;"><label class="f-label">Image limit</label><input data-f="imageLimit" type="number" min="0" max="2000" step="10"></div>
        </div>
        <div class="switch-row"><div><div class="t">Range requests (video/audio seeking)</div></div>
          <label class="switch"><input type="checkbox" data-f="rangeRequests"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Auto-download unknown file types</div>
          <div class="d">Off = fail silently instead of downloading.</div></div>
          <label class="switch"><input type="checkbox" data-f="autoDownloadUnknown"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Built-in PDF viewer</div></div>
          <label class="switch"><input type="checkbox" data-f="pdfViewer"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Built-in image viewer</div></div>
          <label class="switch"><input type="checkbox" data-f="imageViewer"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Built-in video player</div></div>
          <label class="switch"><input type="checkbox" data-f="videoViewer"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Built-in audio player</div></div>
          <label class="switch"><input type="checkbox" data-f="audioViewer"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Built-in text / code viewer</div></div>
          <label class="switch"><input type="checkbox" data-f="textViewer"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="appearance"><h3><i data-icon="image" data-size="16"></i>${T("cAppearance")}</h3>
        <label class="f-label">Theme</label>
        <input type="hidden" data-f="theme">
        <div class="theme-grid"></div>
        <div class="switch-row"><div><div class="t">Show bookmarks bar</div></div>
          <label class="switch"><input type="checkbox" data-f="bookmarksBar"><span class="tr"></span></label></div>
        <label class="f-label">UI font scale %</label>
        <input data-f="fontScale" type="number" min="70" max="160" step="5">
        <div class="switch-row"><div><div class="t">Remember panel widths</div>
          <div class="d">Off = panels reset to default width on every load.</div></div>
          <label class="switch"><input type="checkbox" data-f="rememberPanelWidth"><span class="tr"></span></label></div>
        <label class="f-label">Panel width (px)</label>
        <input data-f="panelWidth" type="number" min="240" max="640" step="10">
        <label class="f-label">Panel position</label>
        <select data-f="panelSide">
          <option value="right">Right</option>
          <option value="left">Left</option>
        </select>
        <div class="switch-row"><div><div class="t">Start in fullscreen</div></div>
          <label class="switch"><input type="checkbox" data-f="fullscreenOnLaunch"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="home"><h3><i data-icon="home" data-size="16"></i>${T("cHome")}</h3>
        <label class="f-label">Wallpaper image URL (blank = default)</label>
        <input data-f="wallpaper" placeholder="https://…">
        <div class="switch-row"><div><div class="t">Show clock on new tab</div></div>
          <label class="switch"><input type="checkbox" data-f="showClock"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">24-hour clock</div></div>
          <label class="switch"><input type="checkbox" data-f="clock24h"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="shortcuts"><h3><i data-icon="terminal" data-size="16"></i>${T("cShortcuts")}</h3>
        <div class="switch-row"><div><div class="t">Enable keyboard shortcuts</div></div>
          <label class="switch"><input type="checkbox" data-f="shortcutsEnabled"><span class="tr"></span></label></div>
        <p class="hint tight">Click a combo to rebind it — changes apply on edit. Combos override browser keys while FlashNext is focused.</p>
        <div class="shortcut-list"></div>
      </div>

      <div class="card" data-section="language"><h3><i data-icon="globe" data-size="16"></i>${T("cLanguage")}</h3>
        <label class="f-label">Preferred language</label>
        <select data-f="language">
          <option value="en">English</option>
          <option value="es">Español</option>
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
          <option value="pt">Português</option>
          <option value="ru">Русский</option>
          <option value="zh">中文</option>
          <option value="ja">日本語</option>
          <option value="ar">العربية</option>
          <option value="hi">हिन्दी</option>
        </select>
        <p class="hint tight">Chrome, new tab, store, tutorial and assistant are translated. Settings field labels and internal page bodies stay in English for now.</p>
      </div>

      <div class="card" data-section="tutorial"><h3><i data-icon="zap" data-size="16"></i>${T("cTutorial")}</h3>
        <div class="switch-row"><div><div class="t">Auto-start on first load</div></div>
          <label class="switch"><input type="checkbox" data-f="tutorialAutoStart"><span class="tr"></span></label></div>
        <div class="f-row"><button class="btn small tutorial-restart">${T("restartTut")}</button></div>
      </div>

      <div class="card" data-section="tabs"><h3><i data-icon="copy" data-size="16"></i>${T("cTabs")}</h3>
        <div class="switch-row"><div><div class="t">Drag-to-reorder tabs</div></div>
          <label class="switch"><input type="checkbox" data-f="tabDrag"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Right-click menu on tabs</div></div>
          <label class="switch"><input type="checkbox" data-f="tabContextMenu"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Audio mute controls on tabs</div></div>
          <label class="switch"><input type="checkbox" data-f="tabMuteControls"><span class="tr"></span></label></div>
      </div>

      <div class="card" data-section="devtools"><h3><i data-icon="code" data-size="16"></i>${T("cDevtools")}</h3>
        <div class="switch-row"><div><div class="t">Browser logs (Requests panel)</div></div>
          <label class="switch"><input type="checkbox" data-f="showLogs"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Page inspector (Inspector panel)</div></div>
          <label class="switch"><input type="checkbox" data-f="showInspector"><span class="tr"></span></label></div>
        <div class="switch-row"><div><div class="t">Browser metrics (Metrics panel)</div></div>
          <label class="switch"><input type="checkbox" data-f="showMetrics"><span class="tr"></span></label></div>
      </div>

      <div class="card"><h3><i data-icon="grid" data-size="16"></i>${T("cToolbar")}</h3>
        <p class="hint tight">Choose which controls appear in the top bar. The address bar, star and go button are always shown.</p>
        <div class="toolbar-list"></div>
      </div>

      <div class="card"><h3><i data-icon="file" data-size="16"></i>${T("cLegal")}</h3>
        <div class="kv"><span>Terms of use</span></div>
        <p class="hint">FlashNext is provided as-is for lawful, everyday browsing. You are responsible for complying with your local laws and your network's acceptable-use policies.</p>
        <div class="kv"><span>Privacy</span></div>
        <p class="hint">FlashNext keeps settings, history, bookmarks and cookies only in this browser (localStorage). It sends nothing to its authors — the only network traffic is the pages you choose to visit, plus optional free-AI answers when you ask the assistant.</p>
        <div class="kv"><span>License</span></div>
        <p class="hint">FlashNext interface code is GPL-3.0 (see LICENSE). Bundled WASM engines keep their own licenses.</p>
      </div>

      <div class="card"><h3><i data-icon="alert" data-size="16"></i>${T("cDanger")}</h3>
        <div class="f-row">
          <button class="btn primary set-save">${T("save")}</button>
          <button class="btn danger set-reset">${T("reset")}</button>
        </div>
        <p class="hint">Reset wipes settings, history, bookmarks, cookies and reloads.</p>
      </div>
    </div>`;
  }

  function bindSettings(div) {
    global.FlashSettings.fillForm(div);
    // Hide controls for build-disabled features (legacy data-feat + new sections).
    try {
      const ff = window.FLASH_FEATURES || {};
      div.querySelectorAll("[data-feat]").forEach((el) => {
        if (ff[el.dataset.feat] === false) el.style.display = "none";
      });
      const hidden = global.FlashStore.hiddenSections();
      div.querySelectorAll("[data-section]").forEach((el) => {
        if (hidden.includes(el.dataset.section)) el.style.display = "none";
      });
      // Locked inputs: disable + title so "removed toggles" read as locked.
      const locked = global.FlashStore.lockedSettings();
      div.querySelectorAll("[data-f]").forEach((el) => {
        if (el.dataset.f in locked) {
          el.disabled = true;
          el.title = "Locked by this custom build";
        }
      });
      // Granular build flags hide their single control (label + input).
      const hideField = (name) => {
        const el = div.querySelector(`[data-f="${name}"]`);
        if (!el) return;
        const row = el.closest(".switch-row") || el;
        // Hide the preceding label too when it's a standalone .f-label.
        let lbl = row.previousElementSibling;
        if (row === el && lbl && lbl.classList && lbl.classList.contains("f-label")) lbl.style.display = "none";
        row.style.display = "none";
      };
      if (ff.wispServer === false) hideField("wispUrl");
      if (ff.concurrentRequests === false) ["idleThreads", "activeThreads", "requestRetries", "maxConnections"].forEach(hideField);
      if (ff.fallbackToggle === false) hideField("fallbackEnabled");
      if (ff.fallbackUrl === false) hideField("fallbackUrl");
      if (ff.retryPolicy === false) ["mainRetries", "fallbackRetries", "retryDelayMs"].forEach(hideField);
      if (ff.errorTriggers === false) ["fallbackOn5xx", "fallbackOnTimeout", "fallbackOnDns"].forEach(hideField);
      if (ff.defaultEngine === false) hideField("searchEngine");
      if (ff.customEngine === false) ["customEngineName", "customEngineUrl"].forEach(hideField);
    } catch {}
    // Cache buttons visibility.
    try {
      if (global.FlashStore.getSettings().showCacheButtons === false) {
        div.querySelectorAll(".cache-btns").forEach((el) => { el.style.display = "none"; });
      }
    } catch {}
    div.querySelector(".set-save").onclick = () => {
      let prevLang = "en";
      try { prevLang = global.FlashStore.getSettings().language || "en"; } catch {}
      const next = global.FlashSettings.collectFrom(div);
      try {
        document.documentElement.lang = next.language || "en";
        if (next.showCacheButtons === false) {
          div.querySelectorAll(".cache-btns").forEach((el) => { el.style.display = "none"; });
        } else {
          div.querySelectorAll(".cache-btns").forEach((el) => { el.style.display = ""; });
        }
        // Language switch: retranslate chrome + refresh this page.
        if ((next.language || "en") !== prevLang) {
          global.FlashApp.applyI18nLabels();
          const t = global.FlashTabs.active();
          if (t && t.view === "internal") global.FlashInternal.render(t, t.internal);
        }
      } catch {}
      global.FlashApp.toast("Settings saved");
    };
    div.querySelector(".set-reset").onclick = () => global.FlashSettings.resetAll();
    const cc = div.querySelector(".cache-clear");
    if (cc) cc.onclick = () => {
      try {
        for (const t of global.FlashTabs.all()) { if (t.pageCache) t.pageCache.clear(); }
        global.FlashLog && global.FlashLog.clear();
      } catch {}
      global.FlashApp.toast("Cache cleared");
    };
    const cr = div.querySelector(".cache-reset");
    if (cr) cr.onclick = () => global.FlashSettings.resetAll();
    const tr = div.querySelector(".tutorial-restart");
    if (tr) tr.onclick = () => {
      try { global.FlashStore.saveSettings({ tutorialDone: false }); } catch {}
      global.FlashApp.startTutorial(true);
    };
  }

  /* ── history ────────────────────────────────────────── */
/* FEATURE:history:begin */
  function tplHistory() {
    return `
    <div class="pg">
      <div class="pg-head"><span class="pg-ic"><i data-icon="rewind" data-size="22"></i></span><h2>History</h2></div>
      <p class="pg-sub">Stored only in this browser. Click an entry to revisit it through Flash.</p>
      <div class="card">
        <div class="f-row">
          <input class="h-search" placeholder="Search history…">
          <button class="btn small h-clear">Clear all</button>
        </div>
        <div class="h-list"></div>
      </div>
    </div>`;
  }

  function bindHistory(div) {
    const box = div.querySelector(".h-list");
    const inp = div.querySelector(".h-search");
    const draw = () => {
      if (!global.FlashStore.getSettings().historyEnabled) {
        box.innerHTML = `<div class="empty">History is off — private by default.<br><br><button class="btn primary h-enable">Turn history on</button></div>`;
        const b = box.querySelector(".h-enable");
        if (b) b.onclick = () => {
          global.FlashStore.saveSettings({ historyEnabled: true });
          draw();
        };
        return;
      }
      renderHistoryList(box, inp.value);
    };
    inp.oninput = draw;
    div.querySelector(".h-clear").onclick = () => {
      global.FlashHistory.clear();
      draw();
      refreshIfActive(["history"]);
    };
    draw();
  }

  function renderHistoryList(box, q) {
    const all = global.FlashHistory.all();
    const query = (q || "").toLowerCase();
    const items = all
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => !query || (h.title + " " + h.url).toLowerCase().includes(query));
    if (!items.length) {
      box.innerHTML = `<div class="empty">${all.length ? "No matches." : "No history yet — go browse something."}</div>`;
      return;
    }
    const groups = [["Today", 0], ["Yesterday", 1], ["Earlier", 2]];
    const dayOf = (t) => {
      const d = new Date(t);
      const now = new Date();
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return Math.round((today - day) / 86400000);
    };
    let html = "";
    for (const [label, idx] of groups) {
      const rows = items.filter(({ h }) => {
        const dd = dayOf(h.t);
        return idx === 2 ? dd > 1 : dd === idx;
      });
      if (!rows.length) continue;
      html += `<div class="hist-group">${label}</div>` + rows.map(({ h, i }) => {
        const letter = U().escapeHtml(((U().hostOf(h.url) || "?")[0] || "?").toUpperCase());
        const time = new Date(h.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return `<div class="hist-wrap">
          <button class="hist-row" data-i="${i}">
            <span class="h-fav">${letter}</span>
            <span class="h-main"><span class="hist-t">${U().escapeHtml(h.title || h.url)}</span>
            <span class="hist-u">${U().escapeHtml(h.url)}</span></span>
            <span class="hist-time">${time}</span>
          </button>
          <button class="ibtn hist-del" data-del="${i}" title="Delete">${I()("x", 15)}</button>
        </div>`;
      }).join("");
    }
    box.innerHTML = html || `<div class="empty">No matches.</div>`;
    box.querySelectorAll(".hist-row").forEach((row) => {
      row.onclick = () => {
        const h = global.FlashHistory.all()[+row.dataset.i];
        if (h) global.FlashApp.navigate(h.url);
      };
    });
    box.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        global.FlashHistory.removeAt(+b.dataset.del);
        renderHistoryList(box, q);
      };
    });
  }

  /* ── bookmarks ──────────────────────────────────────── */
/* FEATURE:history:end */
/* FEATURE:bookmarks:begin */
  function tplBookmarks() {
    return `
    <div class="pg">
      <div class="pg-head"><span class="pg-ic"><i data-icon="bookmark" data-size="22"></i></span><h2>Bookmarks</h2></div>
      <p class="pg-sub">Alt-click or right-click a bookmark in the bar to remove it.</p>
      <div class="card">
        <div class="f-row"><button class="btn primary b-addcur">Bookmark this page</button></div>
        <div class="bm-grid"></div>
      </div>
    </div>`;
  }

  function bindBookmarks(div, tab) {
    try {
      if (window.FLASH_FEATURES && window.FLASH_FEATURES.bookmarks === false) {
        div.querySelector(".pg").innerHTML = `
          <div class="pg-head"><span class="pg-ic"><i data-icon="bookmark" data-size="22"></i></span><h2>Bookmarks</h2></div>
          <p class="pg-sub">Bookmarks aren't included in this build.</p>`;
        global.FlashIcons.apply(div);
        return;
      }
    } catch {}
    const draw = () => {
      const grid = div.querySelector(".bm-grid");
      const list = global.FlashBookmarks.all();
      grid.innerHTML = list.length ? list.map((b) => {
        const letter = U().escapeHtml(((U().hostOf(b.url) || "?")[0] || "?").toUpperCase());
        const pinned = global.FlashFavorites.has(b.url);
        return `<div class="bm-card" data-url="${U().escapeHtml(b.url)}" title="${U().escapeHtml(b.url)}">
          <button class="b-x" title="Remove">${I()("x", 14)}</button>
          <button class="b-pin${pinned ? " on" : ""}" title="${pinned ? "Unpin from new tab" : "Pin to new tab"}">${I()("bookmark", 14)}</button>
          <div class="b-fav">${letter}</div>
          <div class="b-t">${U().escapeHtml(b.title || b.url)}</div>
          <div class="b-u">${U().escapeHtml(b.url)}</div></div>`;
      }).join("") : `<div class="empty">No bookmarks yet. Star a page in the address bar.</div>`;
      grid.querySelectorAll(".bm-card").forEach((c) => {
        c.onclick = (e) => {
          if (e.target.closest(".b-x") || e.target.closest(".b-pin")) return;
          global.FlashApp.navigate(c.dataset.url);
        };
      });
      grid.querySelectorAll(".b-pin").forEach((p) => {
        p.onclick = (e) => {
          e.stopPropagation();
          const card = p.closest(".bm-card");
          global.FlashFavorites.toggle(card.dataset.url, card.querySelector(".b-t").textContent);
          draw();
        };
      });
      grid.querySelectorAll(".b-x").forEach((x) => {
        x.onclick = (e) => {
          e.stopPropagation();
          global.FlashBookmarks.remove(x.closest(".bm-card").dataset.url);
          draw();
        };
      });
    };
    div.querySelector(".b-addcur").onclick = () => {
      const t = global.FlashTabs.active();
      if (t && t.url && !t.url.startsWith("flash://")) {
        global.FlashBookmarks.add(t.url, t.title);
        draw();
      } else {
        global.FlashApp.toast("Open a web page first, then bookmark it");
      }
    };
    draw();
  }

  /* ── about ──────────────────────────────────────────── */
/* FEATURE:bookmarks:end */
  function tplAbout() {
    const v = global.FlashConfig.VERSION;
    const st = global.FlashTransport.getStatus();
    return `
    <div class="pg">
      <div class="pg-head"><span class="pg-ic"><i data-icon="zap" data-size="22"></i></span><h2>About Flash</h2></div>
      <p class="pg-sub">A fully static, single-file web proxy. File, not a site — nothing to block.</p>
      <div class="card">
        <div class="f-row">
          <span class="pilltag">v${v}</span>
          <span class="pilltag">no service workers</span>
          <span class="pilltag">WISP + ${U().escapeHtml(st.engine || "—")}</span>
          <span class="pilltag">build #${(global.FlashBuild && global.FlashBuild.n) || 0} ${((global.FlashBuild && global.FlashBuild.state) || "").trim()}${(global.FlashBuild && global.FlashBuild.at) ? " · " + global.FlashBuild.at : ""}</span>
          <span class="spacer"></span>
          <button class="btn small" data-goto="flash://newtab">New tab</button>
        </div>
        <div class="kv"><span>Engine</span><b>Epoxy · libcurl.js (auto failover)</b></div>
        <div class="kv"><span>Tunnel</span><b>WISP over WebSocket</b></div>
        <div class="kv"><span>Filter sees</span><b>only wss:// traffic</b></div>
        <div class="kv"><span>Storage</span><b>localStorage <code>flash:*</code></b></div>
      </div>
      <div class="card"><h3><i data-icon="activity" data-size="16"></i>How a page loads</h3>
        ${[
          ["You type a URL", "normalized or sent to your search engine."],
          ["Fetch via WISP", "TLS runs inside WASM; the relay only sees opaque frames."],
          ["Rewrite + inject", "every URL is absolutized, hostile tags stripped, the Flash runtime goes in first."],
          ["Sandboxed render", "the page runs in an iframe with no top-escape; clicks and fetches bridge back through WISP."],
          ["Viewers + tools", "PDF, media and text render in-page; requests, DOM and metrics live in the side panel."],
        ].map(([b, d], i) => `<div class="step"><span class="n">${i + 1}</span><p><b>${b} — </b>${d}</p></div>`).join("")}
      </div>
      <div class="card"><h3><i data-icon="grid" data-size="16"></i>Internal pages</h3>
        <div class="f-row">
          <button class="btn small" data-goto="flash://settings">Settings</button>
          <button class="btn small" data-goto="flash://history">History</button>
          <button class="btn small" data-goto="flash://bookmarks">Bookmarks</button>
/* FEATURE:watch:begin */           <button class="btn small" data-goto="flash://watch">Watch</button> /* FEATURE:watch:end */
          <button class="btn small" data-goto="flash://store">Store</button>
        </div>
      </div>
      </div>
      <div class="card"><h3><i data-icon="terminal" data-size="16"></i>${T("cShortcuts")}</h3>
        ${shortcutRows()}
      </div>
      <div class="card"><h3><i data-icon="file" data-size="16"></i>What's new</h3>
        ${changelogRows()}
      </div>
      <div class="card"><h3><i data-icon="shield" data-size="16"></i>Credits</h3>
        <p class="hint">Architecture inspired by GUST (Nautilus Labs). WISP + Epoxy by Mercury Workshop · libcurl.js by ading2210 · PDF.js by Mozilla. Flash itself is original code.</p>
      </div>
    </div>`;
  }

  function shortcutRows() {
    return global.FlashSettings.loadShortcuts().map((s) =>
      `<div class="kv"><span>${U().escapeHtml(s.label || s.action)}</span><b><code>${U().escapeHtml(s.keys)}</code></b></div>`
    ).join("");
  }

  function changelogRows() {
    const list = (global.FlashChangelog && global.FlashChangelog.ENTRIES) || [];
    if (!list.length) return `<div class="empty">No entries yet.</div>`;
    return list.map((e) =>
      `<div class="kv"><span>v${U().escapeHtml(e.v)} · ${U().escapeHtml(e.date)}</span></div>` +
      (e.items || []).map((it) => `<div class="step"><span class="n">•</span><p>${U().escapeHtml(it)}</p></div>`).join("")
    ).join("");
  }

  function bindAbout(div) {
    div.querySelectorAll("[data-goto]").forEach((b) => {
      b.onclick = () => global.FlashApp.navigate(b.dataset.goto);
    });
  }

  /* ── watch hub ──────────────────────────────────────────── */
/* FEATURE:youtube:begin */
  function tplWatch() {
    return `
    <div class="pg">
      <div class="pg-head"><span class="pg-ic"><i data-icon="play" data-size="22"></i></span><h2>Watch</h2></div>
      <p class="pg-sub">Search YouTube through Piped. Everything plays in the built-in theater.</p>
      <div class="nt-searchbox yt-searchbox">
        <input class="nt-input yt-q" placeholder="Search videos…" autocomplete="off" spellcheck="false">
        <button class="nt-go yt-go" title="Search"><i data-icon="search" data-size="18"></i></button>
      </div>
      <div class="yt-sec">Trending</div>
      <div class="yt-grid"></div>
    </div>`;
  }

  function ytCard(v) {
    return `<button class="yt-card" data-id="${U().escapeHtml(v.id)}" title="${U().escapeHtml(v.title)}">
      <span class="yt-card-thumb">${v.thumb ? `<img data-tsrc="${U().escapeHtml(v.thumb)}" alt="" loading="lazy">` : ""}
      ${v.duration ? `<span class="yt-dur">${U().escapeHtml(global.FlashYT.fmtDur(v.duration))}</span>` : ""}</span>
      <span class="yt-card-t">${U().escapeHtml(v.title)}</span>
      <span class="yt-card-u">${U().escapeHtml(v.author)}</span></button>`;
  }

  function ytFillThumbs(box) {
    const imgs = Array.from(box.querySelectorAll("img[data-tsrc]")).slice(0, 24);
    for (const img of imgs) {
      const src = img.dataset.tsrc;
      if (!src) continue;
      img.removeAttribute("data-tsrc");
      global.FlashTransport.fetchViaTransport(src, { kind: "image", pageUrl: "https://www.youtube.com/" })
        .then((r) => {
          if (!box.isConnected) return;
          const ct = ((r.headers["content-type"] || "").split(";")[0] || "").trim().toLowerCase();
          if (!r.body || !r.body.length || r.body.length > 400000) return;
          if (ct && !ct.startsWith("image/")) return;
          img.src = URL.createObjectURL(new Blob([r.body], { type: ct || "image/jpeg" }));
        })
        .catch(() => {});
    }
  }

  function bindWatch(div, tab) {
    const grid = div.querySelector(".yt-grid");
    const sec = div.querySelector(".yt-sec");
    const inp = div.querySelector(".yt-q");
    const draw = (items, label) => {
      sec.textContent = label;
      grid.innerHTML = items.length ? items.map(ytCard).join("")
        : `<div class="empty">Nothing found. Try different words.</div>`;
      global.FlashIcons.apply(grid);
      ytFillThumbs(grid);
      grid.querySelectorAll(".yt-card").forEach((c) => {
        c.onclick = () => global.FlashYT.open(tab, c.dataset.id);
      });
    };
    const fail = (e) => {
      grid.innerHTML = `<div class="empty">Couldn't reach any video service.<br>${U().escapeHtml(String((e && e.message) || e).slice(0, 140))}</div>`;
    };
    const search = (q) => {
      q = (q || "").trim();
      if (!q) return;
      grid.innerHTML = `<div class="empty">Searching…</div>`;
      global.FlashYT.searchVideos(q).then((items) => {
        if (!div.isConnected) return;
        draw(items, `Results for “${q}”`);
      }).catch(fail);
    };
    div.querySelector(".yt-go").onclick = () => search(inp.value);
    inp.onkeydown = (e) => { if (e.key === "Enter") search(inp.value); };
    // Bolt handoff ("watch cats") or trending by default.
    let pending = "";
    try {
      pending = global.FlashStore.get("watchQ", "") || "";
      global.FlashStore.remove("watchQ");
    } catch {}
    if (pending) {
      inp.value = pending;
      search(pending);
    } else {
      grid.innerHTML = `<div class="empty">Loading trending…</div>`;
      global.FlashYT.trending("US").then((items) => {
        if (!div.isConnected) return;
        draw(items, "Trending");
      }).catch(fail);
    }
    setTimeout(() => { try { inp.focus(); } catch {} }, 50);
  }

/* FEATURE:youtube:end */
  /* ── store : theme gallery + extension gallery ── */
  function tplStore() {
    return `
    <div class="pg">
      <div class="pg-head"><span class="pg-ic"><i data-icon="grid" data-size="22"></i></span><h2>${U().escapeHtml(T("storeT"))}</h2></div>
      <p class="pg-sub">${U().escapeHtml(T("storeSub"))}</p>
      <div class="card"><h3><i data-icon="image" data-size="16"></i>${U().escapeHtml(T("themesT"))}</h3>
        <div class="theme-grid store-themes"></div>
      </div>
      <div class="card"><h3><i data-icon="zap" data-size="16"></i>${U().escapeHtml(T("extT"))}</h3>
        <div class="store-exts"></div>
      </div>
      <div class="card"><h3><i data-icon="plus" data-size="16"></i>${U().escapeHtml(T("addExtT"))}</h3>
        <label class="f-label">${U().escapeHtml(T("extPasteL"))}</label>
        <textarea class="ext-json" rows="3" placeholder='{"name":"My ext","version":"1.0","desc":"…","js":"…","css":"…"}'></textarea>
        <label class="f-label">${U().escapeHtml(T("extUrlL"))}</label>
        <div class="f-row"><input class="ext-url" placeholder="https://…" style="flex:1;min-width:0;"></div>
        <div class="f-row"><button class="btn primary ext-add">${U().escapeHtml(T("extAddBtn"))}</button></div>
        <p class="hint tight">${U().escapeHtml(T("extFormatNote"))}</p>
      </div>
    </div>`;
  }

  function bindStore(div) {
    const box = div.querySelector(".store-themes");
    const all = global.FlashConfig.THEMES || {};
    const cur = global.FlashStore.getSettings().theme || "abyss";
    box.innerHTML = Object.keys(all).map((id) => {
      const th = all[id];
      return `<button class="swatch${cur === id ? " sel" : ""}" data-th="${id}">
        <span class="dots"><i style="background:${th.vars.bg}"></i><i style="background:${th.vars.panel2}"></i><i style="background:${th.vars.acc}"></i></span>
        <span>${U().escapeHtml(th.name)}</span></button>`;
    }).join("");
    box.querySelectorAll(".swatch").forEach((b) => {
      b.onclick = () => {
        global.FlashStore.saveSettings({ theme: b.dataset.th });
        global.FlashSettings.applyAppearance();
        bindStore(div);
        global.FlashApp.toast(T("installed") + ": " + b.dataset.th);
      };
    });
    // Extensions gallery.
    const draw = () => {
      const list = global.FlashExtensions.all();
      const eb = div.querySelector(".store-exts");
      eb.innerHTML = list.length ? list.map((e) =>
        `<div class="switch-row"><div><div class="t">${U().escapeHtml(e.name)} <span class="pilltag">${U().escapeHtml(e.version || "")}</span>${e.builtin ? "" : ' <span class="pilltag">custom</span>'}</div>
          <div class="d">${U().escapeHtml(e.desc || "")} · ${U().escapeHtml(e.author || "")}</div></div>
          <span style="display:flex;gap:6px;align-items:center;flex:none;">
            <label class="switch"><input type="checkbox" data-ext="${U().escapeHtml(e.id)}"${e.enabled ? " checked" : ""}><span class="tr"></span></label>
            ${e.builtin ? "" : `<button class="btn small danger" data-extrm="${U().escapeHtml(e.id)}">${U().escapeHtml(T("remove"))}</button>`}
          </span></div>`
      ).join("") : `<div class="empty">${U().escapeHtml(T("extEmpty"))}</div>`;
      eb.querySelectorAll("[data-ext]").forEach((c) => {
        c.onchange = () => global.FlashExtensions.setEnabled(c.dataset.ext, c.checked);
      });
      eb.querySelectorAll("[data-extrm]").forEach((b) => {
        b.onclick = () => {
          global.FlashExtensions.remove(b.dataset.extrm);
          draw();
        };
      });
    };
    draw();
    div.querySelector(".ext-add").onclick = async (e) => {
      const btn = e.currentTarget;
      const jit = div.querySelector(".ext-json").value.trim();
      const url = div.querySelector(".ext-url").value.trim();
      btn.disabled = true;
      try {
        if (jit) global.FlashExtensions.addFromJson(jit);
        else if (url) await global.FlashExtensions.addFromUrl(url);
        else { global.FlashApp.toast("…"); return; }
        div.querySelector(".ext-json").value = "";
        div.querySelector(".ext-url").value = "";
        draw();
        global.FlashApp.toast(T("installed"));
      } catch (err) {
        global.FlashApp.toast(String((err && err.message) || err).slice(0, 120));
      } finally {
        btn.disabled = false;
      }
    };
  }

  const TPL = {
    newtab: tplNewtab,
    settings: tplSettings,
/* FEATURE:history:begin */     history: tplHistory, /* FEATURE:history:end */
/* FEATURE:bookmarks:begin */     bookmarks: tplBookmarks, /* FEATURE:bookmarks:end */
    about: tplAbout,
/* FEATURE:watch:begin */     watch: tplWatch, /* FEATURE:watch:end */
    store: tplStore,
  };
  const BIND = {
    newtab: bindNewtab,
    settings: bindSettings,
/* FEATURE:history:begin */     history: bindHistory, /* FEATURE:history:end */
/* FEATURE:bookmarks:begin */     bookmarks: bindBookmarks, /* FEATURE:bookmarks:end */
    about: bindAbout,
/* FEATURE:watch:begin */     watch: bindWatch, /* FEATURE:watch:end */
    store: bindStore,
  };

  global.FlashInternal = { parse, render, syncAll, refreshIfActive, TITLES, ICONS };
})(window);

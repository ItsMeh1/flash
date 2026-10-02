/* Flash — store.js : namespaced localStorage with JSON + listeners. */
(function (global) {
  "use strict";

  const PREFIX = (global.FlashConfig && global.FlashConfig.STORAGE_PREFIX) || "flash:";

  function key(k) {
    return PREFIX + k;
  }

  function get(k, fallback) {
    try {
      const raw = localStorage.getItem(key(k));
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function set(k, v) {
    try {
      localStorage.setItem(key(k), JSON.stringify(v));
      emit(k, v);
    } catch (e) {
      console.warn("[flash] store.set failed", k, e);
    }
  }

  function remove(k) {
    try {
      localStorage.removeItem(key(k));
    } catch {}
  }

  const listeners = new Map();
  function on(k, fn) {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
    return () => listeners.get(k).delete(fn);
  }
  function emit(k, v) {
    const s = listeners.get(k);
    if (s) s.forEach((fn) => { try { fn(v); } catch {} });
  }

  // Build-time feature locks (FlashNext Patcher / GUST parity).
  // Unchecked flags lock their settings to defaults and hide the matching
  // Settings section. Single source of truth for the "61 flags" system:
  // flag key -> { settings: {k: lockedValue}, sections: [data-section names],
  //               legacy: [legacy FLASH_FEATURES keys to also set false] }.
  const FEATURE_LOCKS = {
    // Connection
    showConnection: { settings: {}, sections: ["connection"] },
    wispServer: { settings: {}, sections: [] },
    concurrentRequests: { settings: { idleThreads: 3, activeThreads: 6, requestRetries: 3, maxConnections: 6 }, sections: [] },
    webrtcBlock: { settings: { blockWebRTC: true }, sections: [], legacy: ["webrtc"] },
    smartHeaders: { settings: { smartHeaders: true }, sections: [] },
    // Fallback
    showFallback: { settings: {}, sections: ["fallback"] },
    fallbackToggle: { settings: { fallbackEnabled: false }, sections: [] },
    fallbackUrl: { settings: {}, sections: [] },
    retryPolicy: { settings: { mainRetries: 3, fallbackRetries: 3, retryDelayMs: 3000 }, sections: [] },
    errorTriggers: { settings: { fallbackOn5xx: true, fallbackOnTimeout: true, fallbackOnDns: false }, sections: [] },
    // AI
    showAI: { settings: {}, sections: ["ai"], legacy: ["bolt"] },
    aiContext: { settings: { aiContext: false }, sections: [] },
    // Search
    showSearch: { settings: {}, sections: ["search"] },
    defaultEngine: { settings: { searchEngine: "brave" }, sections: [] },
    customEngine: { settings: { customEngineName: "", customEngineUrl: "" }, sections: [] },
    spellcheck: { settings: { spellcheck: false }, sections: [] },
    favicons: { settings: { faviconProxy: false }, sections: [] },
    // Privacy
    showPrivacy: { settings: {}, sections: ["privacy"] },
    privacyBlocking: { settings: { adblockEnabled: false }, sections: [], legacy: ["adblock"] },
    pauseSite: { settings: {}, sections: [] },
    pausedAllowlist: { settings: { pausedSites: "" }, sections: [] },
    uaSpoof: { settings: { spoofUA: false, requestUA: "", pageUA: "", customUA: "" }, sections: [] },
    blockFilters: { settings: { customCosmeticRules: "", customHosts: "" }, sections: [] },
    // Cache
    showCache: { settings: {}, sections: ["cache"] },
    tabCache: { settings: { tabCache: false }, sections: [] },
    resourceCache: { settings: { showCacheButtons: false }, sections: [] },
    // Files & media
    showMedia: { settings: {}, sections: ["media", "video"] },
    renderLimits: { settings: { scriptLimit: 250, imageLimit: 300 }, sections: [] },
    rangeRequests: { settings: { rangeRequests: false }, sections: [] },
    autoDownload: { settings: { autoDownloadUnknown: false }, sections: [] },
    pdfViewer: { settings: { pdfViewer: false }, sections: [], legacy: ["pdf"] },
    imageViewer: { settings: { imageViewer: false }, sections: [] },
    videoViewer: { settings: { videoViewer: false }, sections: [] },
    audioViewer: { settings: { audioViewer: false }, sections: [] },
    textViewer: { settings: { textViewer: false }, sections: [] },
    // Appearance
    showAppearance: { settings: {}, sections: ["appearance"] },
    fontSize: { settings: { fontScale: 100, fontSize: 14 }, sections: [] },
    panelWidths: { settings: { rememberPanelWidth: false, panelWidth: 340 }, sections: [] },
    panelPosition: { settings: { panelSide: "right" }, sections: [] },
    fullscreen: { settings: { fullscreenOnLaunch: false }, sections: [] },
    // Home
    showHome: { settings: {}, sections: ["home"] },
    bookmarksBar: { settings: { bookmarksBar: false, showBookmarksBar: false }, sections: [] },
    wallpaper: { settings: { wallpaper: "" }, sections: [] },
    clock: { settings: { showClock: false }, sections: [] },
    clock24: { settings: { clock24h: false }, sections: [] },
    // Shortcuts
    showShortcuts: { settings: {}, sections: ["shortcuts"] },
    shortcutsToggle: { settings: { shortcutsEnabled: false }, sections: [] },
    // Language
    showLanguage: { settings: {}, sections: ["language"] },
    languagePick: { settings: { language: "en" }, sections: [] },
    // Tutorial
    showTutorial: { settings: {}, sections: ["tutorial"], legacy: ["tutorial"] },
    tutorialInclude: { settings: { tutorialDone: true }, sections: [], legacy: ["tutorial"] },
    tutorialAuto: { settings: { tutorialAutoStart: false }, sections: [] },
    tutorialNav: { settings: {}, sections: [] },
    // Tabs
    tabDrag: { settings: { tabDrag: false }, sections: [] },
    tabMenu: { settings: { tabContextMenu: false }, sections: [] },
    tabMute: { settings: { tabMuteControls: false }, sections: [] },
    // Modules (legacy product flags)
    modHistory: { settings: { historyEnabled: false }, sections: [], legacy: ["history"] },
    modBookmarks: { settings: { bookmarksBar: false, showBookmarksBar: false }, sections: [], legacy: ["bookmarks"] },
    modYoutube: { settings: { pipedEnabled: false }, sections: ["video"], legacy: ["youtube"] },
    modBolt: { settings: { aiOnline: false }, sections: ["ai"], legacy: ["bolt"] },
    modDevtools: { settings: {}, sections: ["devtools"], legacy: ["devtools"] },
    // Toolbar / panels
    shieldButton: { settings: {}, sections: [] },
    logsPanel: { settings: { showLogs: false }, sections: [] },
    inspectorPanel: { settings: { showInspector: false }, sections: [] },
    metricsPanel: { settings: { showMetrics: false }, sections: [] },
  };

  function featureFlags() {
    try {
      const out = {};
      if (global.FLASH_FEATURES) Object.assign(out, global.FLASH_FEATURES);
      // Legacy 8-flag builds: map onto the new taxonomy so old customs keep working.
      if (out.webrtc === false) out.webrtcBlock = false;
      if (out.adblock === false) out.privacyBlocking = false;
      if (out.bolt === false) { out.showAI = false; out.modBolt = false; }
      if (out.devtools === false) out.modDevtools = false;
      if (out.history === false) out.modHistory = false;
      if (out.bookmarks === false) out.modBookmarks = false;
      if (out.youtube === false) out.modYoutube = false;
      if (out.pdf === false) out.pdfViewer = false;
      return out;
    } catch {
      return {};
    }
  }

  function lockedSettings() {
    const ff = featureFlags();
    const locked = {};
    for (const k of Object.keys(FEATURE_LOCKS)) {
      if (ff[k] === false) Object.assign(locked, FEATURE_LOCKS[k].settings || {});
    }
    return locked;
  }

  function hiddenSections() {
    const ff = featureFlags();
    const out = [];
    for (const k of Object.keys(FEATURE_LOCKS)) {
      if (ff[k] === false) {
        for (const s of (FEATURE_LOCKS[k].sections || [])) if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  function getSettings() {
    const defs = global.FlashConfig.DEFAULT_SETTINGS;
    const saved = get("settings", {});
    const next = Object.assign({}, defs, saved || {}, lockedSettings());
    // One-time migration: drop known-dead relays from saved pools
    // (pruned from defaults after DNS verification).
    try {
      const dead = ["daydream.works", "anura.pro", "shuttlesbuses.shop", "artsploit.com",
        "fallback.lol", "relay.mercurywork.shop", "turbowarp.org", "hyperbeam.dev", "cobalt.tools"];
      const list = next.poolList;
      if (Array.isArray(list) && list.some((u) => dead.some((d) => String(u || "").includes(d)))) {
        const clean = list.filter((u) => !dead.some((d) => String(u || "").includes(d)));
        next.poolList = clean.length ? clean : (defs.poolList || []).slice();
        set("settings", Object.assign({}, defs, saved || {}, { poolList: next.poolList }));
      }
    } catch {}
    return next;
  }
  function saveSettings(patch) {
    const cur = getSettings();
    const lock = lockedSettings();
    const clean = Object.assign({}, patch || {});
    // Locked keys cannot be re-enabled at runtime: drop them from the patch.
    for (const k of Object.keys(lock)) delete clean[k];
    const next = Object.assign({}, cur, clean);
    // Re-assert locks (in case stored settings predate the custom build).
    Object.assign(next, lock);
    set("settings", next);
    return next;
  }

  global.FlashStore = { get, set, remove, on, getSettings, saveSettings, key, FEATURE_LOCKS, featureFlags, lockedSettings, hiddenSections };
})(typeof window !== "undefined" ? window : globalThis);

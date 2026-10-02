/* Flash — config.js
 * Central defaults. All user overrides live in localStorage under flash:*.
 * Original implementation, inspired by the GUST architecture (static file,
 * no service workers, WISP + WASM HTTP client). No GUST code is reused.
 */
(function (global) {
  "use strict";

  const FLASH_VERSION = "1.0.0";

  const DEFAULT_WISP = "wss://wisp.mercurywork.shop/";

  // Public WISP pool (round-robin + benchmark). These are community relays;
  // any WISP-compatible server works. Users can self-host (see README).
  // Every entry is DNS-verified — dead relays were pruned (they cost a
  // handshake timeout each and spam the console for zero benefit).
  const WISP_POOL = [
    "wss://wisp.mercurywork.shop/",
    "wss://wisp.terbiumon.top/wisp/",
    "wss://nebulaproxy.io/wisp/",
    "wss://definitelyscience.com/wisp/",
    "wss://invisiproxy.com/wisp/",
  ];

  const SEARCH_ENGINES = {
    brave: { name: "Brave", url: "https://search.brave.com/search?q=%s" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
    duck: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  };

  // Themes: full variable sets applied to :root (instant, no reload).
  // Kept dark and restrained — only surfaces, hairlines and the one accent move.
  const THEMES = {
    cherry: { name: "Cherry", vars: { bg0: "#0c0708", bg: "#100a0b", panel: "#150c0e", panel2: "#1c1114", panel3: "#25161a", field: "#0d0809", line: "#2b1c20", line2: "#3d2830", "line-focus": "#5a3d47", track: "#33222a", dash: "#453038", "btn-hover": "#241820", txt: "#f3e9ec", dim: "#b89aa4", dim2: "#8a6f79", acc: "#f0a3ae", "acc-deep": "#c25a6e", "acc-glow": "rgba(240,163,174,.30)" } },
    abyss: { name: "Abyss", vars: { bg0: "#060a13", bg: "#0a0f1c", panel: "#0d1424", panel2: "#121b30", panel3: "#17233c", field: "#080d18", line: "#1f2c49", line2: "#2c3d60", "line-focus": "#3d5583", track: "#2a3a5c", dash: "#33456c", "btn-hover": "#1e2c4e", txt: "#e9efff", dim: "#93a5c7", dim2: "#6e81a6", acc: "#a9dcff", "acc-deep": "#5b8cff", "acc-glow": "rgba(169,220,255,.25)" } },
    graphite: { name: "Graphite", vars: { bg0: "#0a0a0c", bg: "#101014", panel: "#15151b", panel2: "#1b1b23", panel3: "#23232e", field: "#0c0c10", line: "#26262f", line2: "#35353f", "line-focus": "#4a4a58", track: "#32323c", dash: "#3f3f4b", "btn-hover": "#26262f", txt: "#ececf1", dim: "#9d9da9", dim2: "#71717e", acc: "#c9d6f2", "acc-deep": "#7d90c2", "acc-glow": "rgba(201,214,242,.20)" } },
    forest: { name: "Forest", vars: { bg0: "#060f0c", bg: "#0a1512", panel: "#0d1a15", panel2: "#12241c", panel3: "#182e24", field: "#081210", line: "#1e3a2e", line2: "#2c5240", "line-focus": "#3d7057", track: "#2a4a3a", dash: "#33584a", "btn-hover": "#1c3329", txt: "#e9f2ec", dim: "#93b8a3", dim2: "#6e8f7d", acc: "#a9e8c3", "acc-deep": "#4fae7c", "acc-glow": "rgba(169,232,195,.22)" } },
    lagoon: { name: "Lagoon", vars: { bg0: "#061013", bg: "#0a151a", panel: "#0d1a21", panel2: "#12242d", panel3: "#183039", field: "#081216", line: "#1e3542", line2: "#2c4e5e", "line-focus": "#3d6a80", track: "#2a4450", dash: "#33505e", "btn-hover": "#1c2f38", txt: "#e9f3f5", dim: "#93b8c4", dim2: "#6e8b99", acc: "#a5e6ef", "acc-deep": "#3fa9c2", "acc-glow": "rgba(165,230,239,.22)" } },
    cobalt: { name: "Cobalt", vars: { bg0: "#070b1c", bg: "#0a1024", panel: "#0d1430", panel2: "#121a3d", panel3: "#17224a", field: "#080c1c", line: "#212c55", line2: "#2f3f73", "line-focus": "#42548f", track: "#2c3760", dash: "#36436e", "btn-hover": "#1c2450", txt: "#e9efff", dim: "#9aa9d4", dim2: "#7580ad", acc: "#a9c6ff", "acc-deep": "#5b7de8", "acc-glow": "rgba(169,198,255,.25)" } },
    plum: { name: "Plum", vars: { bg0: "#0e0a14", bg: "#130e1c", panel: "#170f24", panel2: "#1f1430", panel3: "#291b3d", field: "#0f0a16", line: "#2c2145", line2: "#3f2f5e", "line-focus": "#5a4480", track: "#382a50", dash: "#453463", "btn-hover": "#251a38", txt: "#efe9f7", dim: "#a89cc4", dim2: "#7f739e", acc: "#d3b8ff", "acc-deep": "#8f63d6", "acc-glow": "rgba(211,184,255,.25)" } },
    ember: { name: "Ember", vars: { bg0: "#100808", bg: "#170c0d", panel: "#1d0f10", panel2: "#281416", panel3: "#331b1d", field: "#120a0b", line: "#402528", line2: "#573336", "line-focus": "#7a4a44", track: "#4a302c", dash: "#58403a", "btn-hover": "#33201f", txt: "#f5e9e9", dim: "#c4a3a3", dim2: "#9a7a7a", acc: "#ffb3a6", "acc-deep": "#d6604f", "acc-glow": "rgba(255,179,166,.25)" } },
    dune: { name: "Dune", vars: { bg0: "#0f0c07", bg: "#151009", panel: "#1a140d", panel2: "#241b11", panel3: "#2f2517", field: "#100c07", line: "#3a2f1e", line2: "#52432c", "line-focus": "#705c3d", track: "#4a3d28", dash: "#58503a", "btn-hover": "#33291a", txt: "#f2ecdf", dim: "#c4b498", dim2: "#998a6e", acc: "#f2cd8e", "acc-deep": "#c08c3f", "acc-glow": "rgba(242,205,142,.22)" } },
  };

  const DEFAULT_SETTINGS = {
    // ── Connection ──
    wispUrl: DEFAULT_WISP,
    poolEnabled: true,
    poolList: WISP_POOL.slice(),
    transport: "auto", // auto | epoxy | libcurl — WASM engine preference (auto = fast epoxy first, curl fallback)
    maxConnections: 6, // per-host, forwarded to transport when supported
    idleThreads: 3,
    activeThreads: 6,
    requestRetries: 3,
    smartHeaders: true, // Sec-Fetch-* + Referer spoof bundle
    // ── Fallback WISP ──
    fallbackEnabled: true,
    fallbackUrl: "wss://wisp.terbiumon.top/wisp/",
    mainRetries: 3,
    fallbackRetries: 3,
    retryDelayMs: 3000,
    fallbackOn5xx: true,
    fallbackOnTimeout: true,
    fallbackOnDns: false,
    // ── Search ──
    searchEngine: "brave",
    customEngineName: "",
    customEngineUrl: "",
    searchSuggest: true, // fast suggestions under omnibox + newtab search
    spellcheck: true,
    faviconProxy: true, // tunnel favicons through WISP; off = Google service
    // ── Privacy ──
    homepage: "flash://newtab",
    pipedEnabled: true,
    pipedInstances: [
      "pipedapi.ducks.party",
      "pipedapi.kavin.rocks",
      "pipedapi.adminforge.de",
      "pipedapi.reallyaweso.me",
      "pipedapi.leptons.xyz",
    ],
    adblockEnabled: true,
    cosmeticFiltering: true,
    historyEnabled: false, // private by default: no history recording
    customCosmeticRules: "",
    customHosts: "",
    pausedSites: "", // one host per line — adblock paused here
    blockWebRTC: true,
    spoofUA: true,
    requestUA: "", // blank = browser default / Chrome profile
    pageUA: "", // navigator.userAgent override inside pages
    customUA: "",
    // ── Cache ──
    tabCache: true, // keep rendered pages for instant back/forward
    showCacheButtons: true, // Clear Cache / Reset buttons in Settings
    // ── Files & media ──
    scriptLimit: 250,
    imageLimit: 300,
    rangeRequests: true, // Range support for video/audio seeking
    autoDownloadUnknown: true,
    pdfViewer: true,
    imageViewer: true,
    videoViewer: true,
    audioViewer: true,
    textViewer: true,
    // ── Appearance ──
    bookmarksBar: false,
    clock24h: false,
    showClock: true,
    theme: "cherry",
    toolbar: { apps: true, back: true, fwd: true, reload: true, home: true, settings: true, devtools: true, assistant: true, protect: true },
    wallpaper: "",
    fontScale: 100,
    fontSize: 14, // UI base font px (GUST parity alias of fontScale)
    panelWidth: 340,
    rememberPanelWidth: true,
    panelSide: "right", // right | left
    fullscreenOnLaunch: false,
    // ── Home ──
    showBookmarksBar: false, // alias kept in sync with bookmarksBar
    // ── Shortcuts / language / tutorial ──
    shortcutsEnabled: true,
    language: "en",
    tutorialDone: false,
    tutorialAutoStart: true,
    // ── Tab system ──
    tabDrag: true,
    tabContextMenu: true,
    tabMuteControls: true,
    // ── Devtools (split) ──
    showLogs: true,
    showInspector: true,
    showMetrics: true,
    devtoolsOpen: false,
    // ── AI assistant ──
    aiContext: true, // include current page outline automatically
    aiOnline: true, // use free keyless API when online, offline brain otherwise
  };

  const EPOXY_CDN =
    "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-tls@2.1.19-1/full/epoxy-bundled.js";

  // libcurl.js (curl + Mbed-TLS compiled to WASM, fetch-compatible API).
  // We pin the *single-file* build (WASM inlined as base64, ~2MB) so that
  // file:// works with ZERO relative-path fetches: one classic <script>
  // from CDN, no sibling .wasm download, no local server needed.
  // Loaded lazily via classic script tag (file://-safe) on first navigation
  // when transport is "auto" or "libcurl". Upstream: ading2210/libcurl.js.
  const LIBCURL_CDN =
    "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.1/libcurl_full.js";
  // Mirror(s) tried in order if the primary CDN is blocked or down.
  const LIBCURL_CDNS = [
    LIBCURL_CDN,
    "https://unpkg.com/libcurl.js@0.7.1/libcurl_full.js",
  ];

  const PDFJS_CDN = {
    js: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs",
    worker:
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs",
  };

  const FlashConfig = {
    VERSION: FLASH_VERSION,
    DEFAULT_WISP,
    WISP_POOL,
    SEARCH_ENGINES,
    THEMES,
    DEFAULT_SETTINGS,
    EPOXY_CDN,
    LIBCURL_CDN,
    LIBCURL_CDNS,
    PDFJS_CDN,
    STORAGE_PREFIX: "flash:",
    MESSAGE_NS: "FLASH",
  };

  global.FlashConfig = FlashConfig;
})(typeof window !== "undefined" ? window : globalThis);

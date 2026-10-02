/* Flash — changelog.js : user-facing update log. Newest first. Rendered in About. */
(function (global) {
  "use strict";

  const ENTRIES = [
    {
      v: "1.2.11", date: "2026-10-02",
      items: [
        "Pool pruned to 5 DNS-verified relays (8 dead hostnames removed) + one-time migration for saved pools",
        "Verified end-to-end in headless Chrome: DDG boots with zero console errors on file:// and throttled networks",
        "Repo slimmed: one-shot annotators and the dist duplicate removed; README rewritten short",
      ],
    },
    {
      v: "1.2.10", date: "2026-10-01",
      items: [
        "Killed the blank-page hole: budget expiry now restores unfilled scripts/styles to native instead of stranding them sourceless — pages always end executable, never dead",
      ],
    },
    {
      v: "1.2.9", date: "2026-10-01",
      items: [
        "Fixed Flash reloading pages by itself: the leak watchdog counted own loads with exact counters instead of a 4s timer heavy pages outlast",
      ],
    },
    {
      v: "1.2.8", date: "2026-10-01",
      items: [
        "Pages load exactly once: images/frames live-patch into the running page — no more document swap, no script re-execution, no media restart, no scroll jump",
        "Back/forward still instant: the enriched document keeps landing in the per-tab cache",
      ],
    },
    {
      v: "1.2.7", date: "2026-10-01",
      items: [
        "Scripts + CSS fill before first paint — app pages boot immediately, no dead window for reload loops to start in",
        "One attempt per file (tried-markers), relay blacklist expires in 2 min and clears on success — slow relays stop poisoning the session",
        "Reload-loop protection: premature same-URL reloads dropped mid-enrichment, 5 rapid auto-loads stop at an error card",
        "Restyled status cards: gradient error/blocked pages with icon tiles, code blocks, Retry + Change-relay actions",
      ],
    },
    {
      v: "1.2.6", date: "2026-10-01",
      items: [
        "Reload loops are dead: same-URL reloads arriving while enrichment is in flight are dropped (live enrichment fixes the page); 5 rapid auto-loads in 15s stop at an error card with Retry",
        "Bigger pipes for big bundles: 30s script / 20s CSS / 15s font-frame timeouts, 40s enrichment budget — 1MB+ app bundles survive slow relays",
        "Stylesheets defuse at rewrite like scripts (no base-paint font storm); tunnel failures restore native last-chance, over-cap leftovers restored",
      ],
    },
    {
      v: "1.2.5", date: "2026-10-01",
      items: [
        "Scripts defuse at rewrite time: base paint can no longer execute anything natively (kills module CORS storms, double execution, open-net leaks); enrichment fills tunneled copies, failures restore native last-chance",
        "Inlined JS is </script-escaped — bundler regexes matching closing tags no longer truncate scripts mid-document",
        "Runtime also rewrites loader-injected <style> font URLs through the bridge; font preloads stripped (hints only, all console noise)",
      ],
    },
    {
      v: "1.2.4", date: "2026-10-01",
      items: [
        "Search actually works now: module scripts inline through the tunnel (they died on CORS before, crashing DDG's app), script cap raised for 1MB+ bundles",
        "Runtime catches loader-injected scripts + stylesheets and re-routes them through the bridge; fonts inside dynamic CSS inline as data: URLs",
        "Font pass extended to inline <style> blocks, not just external sheets",
      ],
    },
    {
      v: "1.2.3", date: "2026-10-01",
      items: [
        "Assistant fails silently: online answer attempted first, offline brain takes over with no error preamble; bare “clear” now clears the chat",
        "Suggestions ride the WISP tunnel (DDG → Brave → Bing, 6s cap) — direct fetch is refused by CORS from file://, so it was all console spam and zero results",
        "Webfonts inline through the tunnel as data: URLs — proxied pages no longer lose icons/text to CORS-blocked font loads",
      ],
    },
    {
      v: "1.2.2", date: "2026-10-01",
      items: [
        "Speed: default engine is now Auto (fast epoxy first, curl fallback); subresource storm bounded to active-threads parallelism instead of unlimited",
        "Session cache for shared subresources (libs, fonts, logos) — fetched once, reused across pages",
        "Background fastest-relay benchmark when idle (parallel handshakes, reorders pool, refreshes every 12h)",
      ],
    },
    {
      v: "1.2.1", date: "2026-10-01",
      items: [
        "Speed: every relay fetch bounded (20s), CDN mirrors fail fast (20s each), engine boots with timeouts — dead relays/ CDNs can't hang pages for minutes",
        "WASM engine pre-downloads in the background at launch, so first navigation skips the ~2MB wait",
        "Honest status: first visit says it's loading the proxy engine instead of a generic Connecting…",
      ],
    },
    {
      v: "1.2.0", date: "2026-09-30",
      items: [
        "Full UI translation: chrome, menus, panels, new tab, store, tutorial, assistant in 10 languages (RTL Arabic included)",
        "Extension gallery in flash://store: {name, version, desc, js, css} manifests, 3 built-ins, paste-JSON or tunnel-fetched install, sandboxed page injection",
        "Fast search suggestions under omnibox + new-tab search (DDG → Brave → Bing chain, debounced, keyboard-navigable, toggleable)",
        "Richer guided tour: 7 spotlight steps anchored to real controls, progress dots, back/skip, Esc to exit",
      ],
    },
    {
      v: "1.1.0", date: "2026-09-30",
      items: [
        "Step 1 catch-up: 60+ flag patcher (15 categories) with locked defaults + hidden Settings sections",
        "AI Assistant: free keyless online answers when connected, smarter offline brain when not",
        "Fallback WISP relay with retry policy + 5xx/timeout/DNS triggers; 14 benchmarked relays",
        "Custom search engine, favicon proxy toggle, per-site adblock pause + allowlist, split UA fields",
        "Tab cache toggle, per-viewer toggles, render limits, range-request + auto-download toggles",
        "Tutorial overlay, language preference, mini theme store, panel side/width, fullscreen-on-launch",
        "Bookmark bar fully unmounts when hidden; canonical build renamed to FlashNext.html",
      ],
    },
    {
      v: "1.0.0", date: "2026-09-28",
      items: [
        "Epoxy engine actually engages now (was silently falling through to libcurl on every request)",
        "Request fingerprint: Chrome UA, Accept-Language, per-kind Accept, Referer, classified Sec-Fetch-*",
        "Redirects always land (manual 3xx following, max 5) regardless of engine quirks",
        "Async XHR rides the tunnel; request bodies forwarded (strings, buffers, file-free forms)",
        "Blob-frame rendering, per-tab page cache, image/style/script/subframe inlining",
        "Built-in YouTube theater (mobile-client streams, quality picker, blob playback)",
        "AI Assistant: 30+ commands, page outlines, tab control (answers Bolt only when asked its name)",
        "9 themes, toolbar customizer with preview, editable shortcuts, legal page",
      ],
    },
    {
      v: "0.9.0", date: "2026-09-25",
      items: [
        "Flash browser shell: tabs, omnibox, bookmarks, history, devtools panel",
        "WISP + libcurl.js transport with pool failover and benchmark",
        "PDF/image/video/audio/text viewers, adblock with cosmetic filtering",
        "Single-file FlashNext.html build that runs from file://",
      ],
    },
  ];

  global.FlashChangelog = { ENTRIES };
})(typeof window !== "undefined" ? window : globalThis);

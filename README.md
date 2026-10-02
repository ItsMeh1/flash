# ⚡ FlashNext

A **fully static, single-file web proxy**: no servers, no ServiceWorkers, no
install. Open one HTML file and browse — every request tunnels through a
**WISP WebSocket relay** with **TLS inside WebAssembly**, so filters only see
`wss://` traffic. Original clean-room code (prefix `__flash`, storage
`flash:*`); architecture inspired by [GUST](https://github.com/nautilus-os/gust).

```
┌──────────┐  WISP (one WebSocket)   ┌────────┐  real TLS  ┌─────────────┐
│  Flash   │ ──────────────────────► │ WISP   │ ─────────► │ example.com │
│ (1 HTML) │  opaque binary frames   │ relay  │  end-to-end│             │
└──────────┘                         └────────┘            └─────────────┘
```

A file, not a site: open as `file://`, host statically anywhere, wrap in
`svg/site.svg`, rename freely, cloak into `about:blank`.

## How a page loads

1. Omnibox input → URL (or Brave / Bing / DuckDuckGo / Custom search).
2. Adblock check → block page if matched.
3. Fetch over WISP (`js/engine.js`): fastest relay first (pool + benchmark +
   per-site failover), Auto engine (epoxy speed, libcurl fallback), retries +
   fallback relay on 5xx / timeout / DNS.
4. Rewrite (`js/render.js`): absolutize URLs, strip hostile tags, defuse
   scripts/styles, inject the runtime (`js/sandbox.js`) first.
5. Paint with scripts + CSS filled from the tunnel (bounded); images/frames
   live-patch into the running page — it loads exactly once, never re-parses.
6. Runtime traps (clicks, forms, `fetch`/XHR bridge, UA/cookie spoofing,
   WebRTC guard) report back via `postMessage`; non-HTML renders in viewers.

## Using it

Tabs + omnibox + shields button + bookmark bar + **AI Assistant** (free keyless
AI online, on-device brain offline) + **Diagnostics** (requests, inspector,
metrics). Internal pages: `flash://newtab|settings|history|bookmarks|watch|
store|about` (`home` → newtab, `help` → about). YouTube links open in the
built-in theater (Piped fallback). Private by default (history off).

## Patcher

`patcher.html` builds custom builds offline: 65 flags across 15 categories,
per-category Select all / None. Unchecked flags lock defaults + hide Settings
sections. All local — fetch-or-drop in, download out.

## Develop

```bash
open FlashNext.html            # just use it (file://, no server)
python3 tools/build-single-file.py   # rebuild after editing shell.html / css/ / js/
python3 -m http.server 8000    # optional local hosting
```

Never edit `FlashNext.html` — it's generated. Sources: `shell.html` +
`css/flash.css` + `js/` (engine, render, sandbox, tabs, store, settings,
internal, assistant, suggest, tutorial, extensions, …). WASM engines + PDF.js
stay on CDN (lazy, `file://`-safe).

Default pool (DNS-verified, fastest-first after Benchmark):
`wisp.mercurywork.shop`, `wisp.terbiumon.top/wisp`, `nebulaproxy.io/wisp`,
`definitelyscience.com/wisp`, `invisiproxy.com/wisp`. Self-host with
[wisp-server-python](https://github.com/MercuryWorkshop/wisp-protocol).

## Tech

| Piece | Choice |
|---|---|
| Engines | Epoxy 2.1.19-1 (fast) + libcurl.js 0.7.1 (compatible), Auto default |
| Tunnel | WISP over WebSocket, one socket, dumb relay, end-to-end TLS |
| PDF | pdfjs-dist 4.2.67 (CDN, lazy) |
| Storage | localStorage `flash:*` · Workers: **none, ever** |

## Features

- Tabs (reorder, mute, context menu), omnibox + suggestions, bookmarks + favorites
- Adblock + cosmetic + custom rules, per-site pause, split UA spoof, WebRTC guard
- Toggleable PDF/image/video/audio/text viewers, per-tab cache, fallback relay
- 10-language UI (RTL), themes + extension store, tutorial tour, editable shortcuts
- ~461KB raw (~128KB gzip) — ~8× smaller than GUST's 3693KB

## Limits

- In-page WebSockets ride the bridge (may lag); no ServiceWorkers in pages.
- Very JS-heavy SPAs can have edge cases — use the omnibox for stubborn links.
- Huge videos fetch whole-file; CDN WASM needs network on first use.

## Credits

GUST (Nautilus Labs) for the architecture · Mercury Workshop (WISP + Epoxy) ·
ading2210 (libcurl.js) · Mozilla (PDF.js). Flash code: GPL-3.0, see `LICENSE`.

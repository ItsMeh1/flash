/* Flash — engine.js
 * Transport layer: Epoxy (fast) -> libcurl.js (compatible) -> direct fetch fallback.
 *
 * Why: browsers enforce CORS + expose destination IPs. Flash instead runs
 * TLS *inside* WASM (Epoxy's Rust stack, or curl+MbedTLS via libcurl.js) and
 * only opens ONE WebSocket to a dumb TCP relay speaking WISP. The relay
 * cannot see plaintext (end-to-end TLS); the filter only sees wss:// traffic.
 *
 * libcurl.js support (per request): ading2210/libcurl.js, pinned single-file
 * build `libcurl_full.js` (WASM inlined as base64) so file:// works with no
 * sibling .wasm fetch and no local server. API used:
 *   <script src=".../libcurl_full.js"></script>  -> window.libcurl
 *   await libcurl.load_wasm()                     (waits for WASM ready)
 *   libcurl.set_websocket("wss://host/wisp/")     (trailing slash required)
 *   libcurl.transport = "wisp"
 *   await libcurl.fetch(url, {method, headers, body, redirect})
 *
 * This file never registers a ServiceWorker. Both WASM engines lazy-load
 * from CDN (classic <script> tags = file://-safe) on first navigation.
 */
(function (global) {
  "use strict";

  const status = {
    engine: "none", // none | epoxy | libcurl | direct
    wispUrl: "",
    ready: false,
    latencyMs: null,
    error: "",
  };

  let epoxyClient = null;
  let epoxyWisp = "";
  let epoxyInitPromise = null;
  let libcurlWisp = "";
  let libcurlInitPromise = null;
  let poolIndex = 0;
  const failedForSite = new Map(); // host -> Map(wispUrl -> timestamp)
  const scriptCache = new Map(); // src -> Promise

  // Timeouts: every network step is bounded so a blackholed relay or a
  // filtered CDN fails fast instead of hanging the page for minutes.
  const CDN_TIMEOUT_MS = 20000; // per CDN mirror for the engine script
  const WASM_TIMEOUT_MS = 30000; // engine WASM boot
  const EPOXY_TIMEOUT_MS = 25000; // Epoxy CDN import + WASM boot
  const ATTEMPT_TIMEOUT_MS = 20000; // one fetch attempt over one relay

  function withTimeout(promise, ms, label) {
    let to = 0;
    const timeout = new Promise((_, rej) => {
      to = setTimeout(() => rej(new Error((label || "operation") + " timed out after " + Math.round(ms / 1000) + "s")), ms);
    });
    return Promise.race([promise, timeout]).then(
      (v) => { clearTimeout(to); return v; },
      (e) => { clearTimeout(to); throw e; }
    );
  }

  function settings() {
    return global.FlashStore.getSettings();
  }

  function transportOrder() {
    const t = (settings().transport || "auto").toLowerCase();
    if (t === "epoxy") return ["epoxy"];
    if (t === "libcurl" || t === "curl") return ["libcurl"];
    return ["epoxy", "libcurl"]; // auto: fast Rust stack first, curl correctness second
  }

  // Per-site relay blacklist with expiry: a single slow fetch must not
  // blacklist a good relay for the whole session (death spiral: timeouts
  // shrink the pool until everything funnels to one relay and dies).
  // Marks expire after 2 minutes; any success clears that relay immediately.
  const FAIL_TTL_MS = 120000;
  function failedSet(host) {
    const now = Date.now();
    let set = failedForSite.get(host);
    if (!set) {
      set = new Map();
      failedForSite.set(host, set);
    }
    for (const [u, t] of set) {
      if (now - t > FAIL_TTL_MS) set.delete(u);
    }
    return set;
  }

  function pickWisp(host) {
    const s = settings();
    const bad = failedSet(host);
    if (!s.poolEnabled) return s.wispUrl;
    const pool = (s.poolList && s.poolList.length ? s.poolList : [s.wispUrl]).filter(
      (u) => u && !bad.has(u) && !relayBad(u)
    );
    if (!pool.length) return s.wispUrl;
    poolIndex = (poolIndex + 1) % pool.length;
    return pool[poolIndex];
  }

  function markFailed(host, url, err) {
    try {
      failedSet(host).set(url, Date.now());
    } catch {}
    // Global health: transport failures demote the relay everywhere.
    // HTTP statuses carry __status (the ORIGIN answered, relay is fine).
    try {
      if (!err || !err.__status) noteRelayFail(url);
    } catch {}
  }

  function markOk(host, url) {
    try {
      const set = failedForSite.get(host);
      if (set) set.delete(url);
    } catch {}
    try { noteRelayOk(url); } catch {}
  }

  // Persistent relay health: flapping relays (fast handshake, corrupt or
  // truncated stream) are demoted across sessions until they prove healthy
  // again. Success forgives instantly; failures are forgotten after an hour.
  const RELAY_HEALTH_MAX = 30;
  const RELAY_FAIL_TTL_MS = 3600000;
  const RELAY_FAIL_STRIKES = 2;
  function relayHealth() { try { return global.FlashStore.get("relayHealth", {}) || {}; } catch { return {}; } }
  function saveRelayHealth(h) { try { global.FlashStore.set("relayHealth", h); } catch {} }
  function relayBad(url) {
    let e = null;
    try { e = relayHealth()[url]; } catch { return false; }
    if (!e) return false;
    if (Date.now() - (e.lastFail || 0) > RELAY_FAIL_TTL_MS) return false;
    return (e.fail || 0) >= RELAY_FAIL_STRIKES;
  }
  function noteRelayFail(url) {
    try {
      const h = relayHealth();
      const e = h[url] || { ok: 0, fail: 0, lastFail: 0 };
      e.fail = (e.fail || 0) + 1;
      e.lastFail = Date.now();
      h[url] = e;
      const keys = Object.keys(h);
      if (keys.length > RELAY_HEALTH_MAX) {
        keys.sort((a, b) => (h[a].lastFail || 0) - (h[b].lastFail || 0));
        for (let i = 0; i < keys.length - RELAY_HEALTH_MAX; i++) delete h[keys[i]];
      }
      saveRelayHealth(h);
    } catch {}
  }
  function noteRelayOk(url) {
    try {
      const h = relayHealth();
      if (h[url]) { delete h[url]; saveRelayHealth(h); }
    } catch {}
  }

  // Clean truncation: the relay closed the stream tidily mid-body (valid
  // framing, no error surfaced). Only HTML navigations can be judged: tiny
  // + bodyless + closeless is never a real page. Legit empty statuses pass.
  function looksTruncated(out, kindCtx) {
    try {
      if (out && (out.status === 204 || out.status === 205 || out.status === 304)) return false;
      const kind = (kindCtx && kindCtx.kind) || "";
      if (kind !== "navigate" && kind !== "iframe") return false;
      const body = (out && out.body) || new Uint8Array(0);
      if (!body.length) return true;
      if (body.length >= 2048) return false;
      const ct = String((out.headers && out.headers["content-type"]) || "").split(";")[0].trim().toLowerCase();
      if (ct && !/html/.test(ct)) return false;
      let text = "";
      try { text = new TextDecoder("utf-8", { fatal: false }).decode(body.slice(0, 2048)); } catch { return false; }
      return !/<body[\s>]/i.test(text) && !/<\/html\s*>/i.test(text);
    } catch { return false; }
  }

  function withSlash(u) {
    if (!u) return u;
    return u.endsWith("/") ? u : u + "/";
  }

  // Classic script loader: works from file://, http(s), about:blank, blob:.
  // (ES-module dynamic import() of the same CDN is tried first for Epoxy,
  // but classic scripts are the reliable baseline everywhere.)
  // file:// note: https subresources load fine from file:// pages; the only
  // requirement is network access to the CDN (no local server needed).
  function loadClassicScript(src, timeoutMs) {
    if (scriptCache.has(src)) return scriptCache.get(src);
    const p = new Promise((resolve, reject) => {
      // Already present?
      const present = Array.from(document.scripts || []).some((s) => s.src === src);
      if (present) {
        resolve();
        return;
      }
      const el = document.createElement("script");
      let done = false;
      const to = setTimeout(() => {
        if (done) return;
        done = true;
        scriptCache.delete(src);
        el.remove();
        reject(new Error("CDN load timed out after " + Math.round((timeoutMs || 60000) / 1000) + "s: " + src));
      }, timeoutMs || 60000);
      el.src = src;
      el.async = true;
      el.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        resolve();
      };
      el.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        scriptCache.delete(src);
        reject(new Error("CDN load failed (network or blocked host): " + src));
      };
      document.head.appendChild(el);
    });
    scriptCache.set(src, p);
    return p;
  }

  function libcurlUrls() {
    const primary = global.FlashConfig.LIBCURL_CDN;
    const fallbacks = global.FlashConfig.LIBCURL_CDNS || [];
    return [primary].concat(fallbacks.filter((u) => u && u !== primary));
  }

  // libcurl_full.js wraps itself as `const libcurl = (function(){...})()`.
  // Top-level const in a classic script = global LEXICAL binding, NOT a
  // window property. So window.libcurl is undefined even on success; the
  // bare `libcurl` identifier is how you reach it. Check both.
  function getLibcurlRef() {
    if (global.libcurl) return global.libcurl;
    try {
      if (typeof libcurl !== "undefined" && libcurl) {
        global.libcurl = libcurl; // cache on window for the fast path
        return libcurl;
      }
    } catch {}
    return null;
  }

  // ── Epoxy ────────────────────────────────────────────────
  // Correct usage (verified against the real bundle: epoxy-tls 2.1.19-1):
  // ESM-only module -> await default init() (boots the inlined WASM) ->
  // new EpoxyClient(wispUrlString, EpoxyClientOptions). The old code passed
  // {wisp} objects and never called init(), so construction always threw and
  // every request silently fell through to libcurl. There is deliberately NO
  // classic-script fallback: this file is ESM (bare `import` statements) and
  // cannot execute as a classic script, period.
  async function loadEpoxyModule() {
    const cdn = global.FlashConfig.EPOXY_CDN;
    let mod = null;
    try {
      mod = await withTimeout(import(/* webpackIgnore: true */ cdn), EPOXY_TIMEOUT_MS, "Epoxy CDN import");
    } catch (e) {
      throw new Error("Epoxy CDN import failed: " + String((e && e.message) || e).slice(0, 160));
    }
    if (!mod || typeof mod.default !== "function" || !mod.EpoxyClient || !mod.EpoxyClientOptions) {
      throw new Error("Epoxy CDN loaded but exports look wrong");
    }
    try {
      await withTimeout(mod.default(), EPOXY_TIMEOUT_MS, "Epoxy WASM boot"); // boots the embedded WASM; no-op if already booted
    } catch (e) {
      throw new Error("Epoxy WASM boot failed: " + String((e && e.message) || e).slice(0, 160));
    }
    return mod;
  }

  function makeEpoxyClient(mod, wispUrl) {
    const opts = new mod.EpoxyClientOptions();
    try {
      opts.user_agent = navigator.userAgent;
    } catch {}
    // WISP v1. Verified live: v2 makes public relays reject the WebSocket
    // handshake (no subprotocol selected); v1 connects and fetches fine.
    // Do NOT set wisp_v2 = true unless talking to a v2-only relay.
    try {
      opts.wisp_v2 = false;
    } catch {}
    // Transport is the relay URL string (per upstream docs + verified).
    return new mod.EpoxyClient(wispUrl, opts);
  }

  async function ensureEpoxy(wispUrl) {
    if (epoxyClient && epoxyWisp === wispUrl) return epoxyClient;
    if (!epoxyInitPromise || epoxyWisp !== wispUrl) {
      epoxyWisp = wispUrl;
      epoxyInitPromise = (async () => {
        const t0 = performance.now();
        const mod = await loadEpoxyModule();
        epoxyClient = makeEpoxyClient(mod, wispUrl);
        status.latencyMs = Math.round(performance.now() - t0);
        return epoxyClient;
      })().catch((e) => {
        epoxyInitPromise = null;
        epoxyClient = null;
        throw e;
      });
    }
    return epoxyInitPromise;
  }

  // ── libcurl.js ───────────────────────────────────────────
  async function ensureLibcurl(wispUrl) {
    const want = withSlash(wispUrl);
    const have = getLibcurlRef();
    if (have && have.ready && libcurlWisp === want) {
      return have;
    }
    if (have && have.ready && !libcurlWisp) {
      // Engine ready from an earlier call but socket never pointed at this
      // relay (e.g. pool rotation): just re-point it.
      try {
        have.set_websocket(want);
        libcurlWisp = want;
        return have;
      } catch {}
    }
    if (!libcurlInitPromise || libcurlWisp !== want) {
      libcurlWisp = want;
      libcurlInitPromise = (async () => {
        const t0 = performance.now();
        // Try each CDN mirror in turn (school filters often block one host).
        // 20s each, not 60s: a filtered CDN should fail fast and move on.
        let lastErr = null;
        for (const cdn of libcurlUrls()) {
          try {
            await loadClassicScript(cdn, CDN_TIMEOUT_MS);
          } catch (e) {
            lastErr = e;
            continue;
          }
          if (getLibcurlRef()) break;
          lastErr = new Error("script loaded but library global missing: " + cdn);
        }
        const lc = getLibcurlRef();
        if (!lc) {
          throw lastErr || new Error("libcurl.js failed to load from all CDNs");
        }
        // Wait for the WASM runtime (single-file build still boots async).
        if (!lc.ready) {
          if (typeof lc.load_wasm === "function") {
            // libcurl_full.js: URL arg ignored, call only waits for readiness.
            await withTimeout(lc.load_wasm(), WASM_TIMEOUT_MS, "libcurl WASM boot");
          } else {
            await new Promise((resolve, reject) => {
              const to = setTimeout(() => reject(new Error("libcurl WASM boot timeout")), 30000);
              const done = () => { clearTimeout(to); resolve(); };
              document.addEventListener("libcurl_load", done, { once: true });
              if (lc.onload) {
                const prev = lc.onload;
                lc.onload = () => { try { prev(); } catch {} done(); };
              } else {
                lc.onload = done;
              }
              // Already ready between checks?
              if (lc.ready) done();
            });
          }
        }
        lc.transport = "wisp";
        lc.set_websocket(want); // trailing slash required by libcurl.js
        const s = settings();
        try {
          // Optional per-host connection tuning (shared pool for libcurl.fetch).
          if (lc.HTTPSession && s.maxConnections) {
            // No global setter exists; a throwaway session documents support.
          }
        } catch {}
        status.latencyMs = Math.round(performance.now() - t0);
        return lc;
      })().catch((e) => {
        libcurlInitPromise = null;
        throw e;
      });
    }
    return libcurlInitPromise;
  }

  // Hardcoded modern Chrome UA for tunneled requests. Rationale: bot checks
  // score the UA + Sec-Fetch-* + Accept bundle as one fingerprint. The user's
  // real UA varies (and leaks platform); a fixed current Chrome string is the
  // tested profile. Custom override still wins when set.
  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  const ACCEPTS = {
    navigate: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    iframe: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    style: "text/css,*/*;q=0.1",
    script: "*/*",
    font: "*/*",
    fetch: "*/*",
  };

  function etld1(host) {
    return String(host || "").toLowerCase().split(".").slice(-2).join(".");
  }

  function siteClass(url, pageUrl) {
    try {
      const u = new URL(url);
      const p = new URL(pageUrl);
      if (u.origin === p.origin) return "same-origin";
      if (etld1(u.hostname) === etld1(p.hostname)) return "same-site";
      return "cross-site";
    } catch {
      return "";
    }
  }

  // Build the full browser-grade header set. Explicit caller headers always
  // win; everything else fills Chrome-plausible defaults so bot checks see a
  // coherent fingerprint instead of a bare-bones client.
  // ctx: { kind: navigate|iframe|image|style|script|font|fetch, pageUrl }
  function buildHeaders(url, extra, ctx) {
    ctx = ctx || {};
    const kind = ctx.kind || "navigate";
    const s = settings();
    const raw = Object.assign({}, extra || {});
    // Case-insensitive lookup over caller headers.
    const lower = {};
    for (const k of Object.keys(raw)) lower[String(k).toLowerCase()] = raw[k];
    const h = Object.assign({}, raw);
    const setDefault = (name, val) => {
      if (val == null) return;
      if (!(name.toLowerCase() in lower)) {
        h[name] = val;
        lower[name.toLowerCase()] = val;
      }
    };

    if (s.spoofUA) {
      setDefault("User-Agent", s.requestUA || s.customUA || CHROME_UA);
    }
    // Content negotiation correctness (not spoofing — servers pick variants).
    setDefault("Accept-Language", "en-US,en;q=0.9");
    if (ACCEPTS[kind]) setDefault("Accept", ACCEPTS[kind]);
    else if (kind === "fetch") setDefault("Accept", "*/*");
    // Hotlink-protected assets 403 without a Referer; navigations omit it
    // (typed-URL semantics). Gated by the Smart Headers toggle.
    if (s.smartHeaders !== false && ctx.pageUrl && kind !== "navigate" && kind !== "iframe") {
      try {
        setDefault("Referer", new URL(ctx.pageUrl).origin + "/");
      } catch {}
    }
    // Sec-Fetch-* metadata bundle, classified like a real browser.
    // Gated by the Smart Headers toggle (some CDNs reject missing metadata).
    if (s.spoofUA && s.smartHeaders !== false) {
      if (kind === "navigate") {
        setDefault("Sec-Fetch-Mode", "navigate");
        setDefault("Sec-Fetch-Site", "none");
        setDefault("Sec-Fetch-Dest", "document");
        setDefault("Sec-Fetch-User", "?1");
      } else if (kind === "iframe") {
        setDefault("Sec-Fetch-Mode", "navigate");
        const site = siteClass(url, ctx.pageUrl);
        if (site) setDefault("Sec-Fetch-Site", site);
        setDefault("Sec-Fetch-Dest", "iframe");
      } else {
        const dest = { image: "image", style: "style", script: "script", font: "font" }[kind] || "empty";
        const mode = kind === "fetch" ? "cors" : "no-cors";
        setDefault("Sec-Fetch-Mode", mode);
        const site = siteClass(url, ctx.pageUrl);
        if (site) setDefault("Sec-Fetch-Site", site);
        setDefault("Sec-Fetch-Dest", dest);
      }
    }
    // Cookie jar isolation per origin.
    try {
      const jar = global.FlashCookies ? global.FlashCookies.getHeader(url) : "";
      if (jar && !("cookie" in lower)) h["Cookie"] = jar;
    } catch {}
    return h;
  }

  function splitHeaders(res) {
    const out = {};
    try {
      if (res.headers && typeof res.headers.forEach === "function") {
        res.headers.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
      } else if (Array.isArray(res.headers)) {
        for (const [k, v] of res.headers) out[String(k).toLowerCase()] = v;
      }
    } catch {}
    return out;
  }

  function storeCookies(url, headers, rawHeaders) {
    try {
      const setCookies = headers["set-cookie"] || (rawHeaders && rawHeaders["set-cookie"]);
      if (setCookies && global.FlashCookies) {
        global.FlashCookies.store(url, setCookies);
      }
    } catch {}
  }

  async function fetchWithEngine(engine, targetUrl, req, wispUrl) {
    if (engine === "epoxy") {
      const client = await ensureEpoxy(wispUrl);
      // Deliberately no `redirect` key: the WASM struct may reject unknown
      // fields, and our manual loop in fetchViaTransport follows anyway.
      const res = await client.fetch(targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const headers = splitHeaders(res);
      storeCookies(targetUrl, headers, res.rawHeaders);
      return { status: res.status, headers, rawHeaders: res.rawHeaders || null, body: buf, finalUrl: res.url || targetUrl };
    }
    // libcurl
    const lc = await ensureLibcurl(wispUrl);
    const res = await lc.fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: req.redirect,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    const headers = splitHeaders(res);
    // libcurl exposes multi-value headers via raw_headers (array of pairs).
    const raw = {};
    try {
      if (Array.isArray(res.raw_headers)) {
        for (const [k, v] of res.raw_headers) {
          const lk = String(k).toLowerCase();
          if (raw[lk]) raw[lk] = [].concat(raw[lk], v);
          else raw[lk] = v;
        }
      }
    } catch {}
    storeCookies(targetUrl, headers, raw);
    return { status: res.status, headers, rawHeaders: raw, body: buf, finalUrl: res.url || targetUrl };
  }

  // Main fetch used by the renderer. Returns {status, headers, body, finalUrl, engine, wispUrl}.
  async function fetchViaTransport(targetUrl, opts) {
    opts = opts || {};
    const method = (opts.method || "GET").toUpperCase();
    const host = global.FlashUtil.hostOf(targetUrl);
    const s = settings();
    const kindCtx = { kind: opts.kind || (method === "GET" ? "navigate" : "fetch"), pageUrl: opts.pageUrl };
    const headers = buildHeaders(targetUrl, opts.headers, kindCtx);
    if (opts.range && s.rangeRequests !== false) {
      const end = opts.range.end != null ? opts.range.end : "";
      headers["Range"] = `bytes=${opts.range.start}-${end}`;
    }
    const req = { method, headers, body: opts.body, redirect: opts.redirect || "follow" };

    const logEntry = {
      id: global.FlashUtil.uid("req"),
      url: targetUrl,
      method,
      t0: performance.now(),
      engine: transportOrder()[0],
      status: 0,
      bytes: 0,
    };
    if (global.FlashLog) global.FlashLog.push(logEntry);

    const order = transportOrder();
    let lastErr = null;
    const mainRetries = Math.max(0, Math.min(10, s.mainRetries != null ? s.mainRetries : (s.requestRetries != null ? s.requestRetries : 3)));
    const fbRetries = Math.max(0, Math.min(10, s.fallbackRetries != null ? s.fallbackRetries : 3));
    const retryDelay = Math.max(0, Math.min(30000, s.retryDelayMs != null ? s.retryDelayMs : 3000));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Classify whether a failure should trigger the fallback relay.
    function shouldFallback(err, respStatus) {
      if (respStatus >= 500 && respStatus <= 599) return s.fallbackOn5xx !== false;
      const msg = String((err && err.message) || err || "").toLowerCase();
      if (/timeout|timed out|abort/.test(msg)) return s.fallbackOnTimeout !== false;
      if (/dns|enotfound|getaddrinfo|failed to resolve/.test(msg)) return !!s.fallbackOnDns;
      // Generic connection errors always qualify (5xx/timeout flags only
      // narrow the two named classes; DNS stays opt-in per GUST parity).
      return true;
    }

    // One relay fetch, bounded: a blackholed relay (TCP hangs, no RST)
    // fails fast here instead of hanging the whole page pipeline.
    function engineFetch(engine, url, req, wispUrl) {
      return withTimeout(fetchWithEngine(engine, url, req, wispUrl), ATTEMPT_TIMEOUT_MS, "relay fetch");
    }

    async function attemptOnce(engine, wispUrl) {
      let cur = { url: targetUrl, method, headers, body: req.body };
      let out = await engineFetch(engine, cur.url, {
        method: cur.method, headers: cur.headers, body: cur.body, redirect: req.redirect,
      }, wispUrl);
      // Manual redirect following (max 5). Engines are asked to follow,
      // but if one returns the 3xx unfollowed we finish the job here so
      // redirector links (Bing /ck/a, http→https upgrades) always land.
      let hops = 0;
      while ([301, 302, 303, 307, 308].includes(out.status) && out.headers["location"] && hops < 5) {
        let next = null;
        try {
          next = new URL(out.headers["location"], cur.url).href;
        } catch { break; }
        if (!/^https?:/i.test(next)) break;
        hops += 1;
        let nm = cur.method;
        if (out.status === 303 && nm !== "HEAD") nm = "GET";
        if ((out.status === 301 || out.status === 302) && cur.method === "POST") nm = "GET";
        const nh = buildHeaders(next, opts.headers, kindCtx);
        if (nm === "GET" || nm === "HEAD") {
          delete nh["Content-Length"];
          delete nh["content-length"];
        }
        cur = { url: next, method: nm, headers: nh, body: nm === cur.method ? cur.body : undefined };
        out = await engineFetch(engine, cur.url, {
          method: cur.method, headers: cur.headers, body: cur.body, redirect: req.redirect,
        }, wispUrl);
      }
      if (hops) out = { ...out, finalUrl: cur.url };
      else if (!out.finalUrl) out = { ...out, finalUrl: targetUrl };
      // 5xx with trigger on counts as a fallback-eligible failure, not success.
      if (out.status >= 500 && out.status <= 599 && shouldFallback(null, out.status) && (s.fallbackEnabled !== false) && s.fallbackUrl) {
        throw Object.assign(new Error("HTTP " + out.status + " (fallback trigger)"), { __status: out.status, __resp: out });
      }
      // Clean truncation (relay cut the stream, framing stayed valid):
      // retry elsewhere instead of rendering a hollow page.
      if (looksTruncated(out, kindCtx)) {
        throw new Error("truncated response via relay (retrying elsewhere)");
      }
      return out;
    }

    function done(out, engine, wispUrl, tag) {
      markOk(host, wispUrl);
      logEntry.status = out.status;
      logEntry.bytes = out.body.length;
      logEntry.ms = performance.now() - logEntry.t0;
      logEntry.engine = engine + (tag || "");
      if (global.FlashLog) global.FlashLog.update(logEntry);
      status.engine = engine;
      status.wispUrl = wispUrl;
      status.ready = true;
      status.error = "";
      document.dispatchEvent(new CustomEvent("flash:transport", { detail: { ...status } }));
      return { ...out, engine, wispUrl };
    }

    for (const engine of order) {
      // Primary WISP, then one pool alt on failure.
      const candidates = [opts.wispUrl || pickWisp(host)];
      if (s.poolEnabled) {
        const alt = pickWisp(host);
        if (alt && !candidates.includes(alt)) candidates.push(alt);
      }
      for (const wispUrl of candidates) {
        for (let a = 0; a <= mainRetries; a++) {
          try {
            const out = await attemptOnce(engine, wispUrl);
            return done(out, engine, candidates.indexOf(wispUrl) > 0 ? "(pool)" : "");
          } catch (e) {
            // 5xx-trigger errors carry the response; anything else is a throw.
            lastErr = e;
            markFailed(host, wispUrl);
            logEntry.error = String((e && e.message) || e).slice(0, 300);
            logEntry.engine = engine + "(failed)";
            const qualifies = shouldFallback(e, e && e.__status);
            if (!qualifies) break; // error triggers say: don't retry/fallback this class
            if (a < mainRetries && retryDelay) await sleep(retryDelay);
          }
        }
      }
      // Fallback relay: same engine, configured fallback URL, own retry budget.
      if (s.fallbackEnabled !== false && s.fallbackUrl) {
        for (let b = 0; b <= fbRetries; b++) {
          try {
            const out = await attemptOnce(engine, s.fallbackUrl);
            return done(out, engine, "(fallback)");
          } catch (e) {
            lastErr = e;
            logEntry.error = String((e && e.message) || e).slice(0, 300);
            logEntry.engine = engine + "(fallback-failed)";
            if (b < fbRetries && retryDelay) await sleep(retryDelay);
          }
        }
      }
    }

    // Direct fetch fallback (CORS-limited, filter-visible). Clearly labeled.
    try {
      const r = await fetch(targetUrl, {
        method, headers, body: opts.body, redirect: "follow",
        credentials: "omit",
      });
      const buf = new Uint8Array(await r.arrayBuffer());
      const out = {};
      r.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
      logEntry.status = r.status;
      logEntry.bytes = buf.length;
      logEntry.ms = performance.now() - logEntry.t0;
      logEntry.engine = "direct(fallback)";
      logEntry.warn = "WISP engines failed; used direct fetch (visible to filter, may fail CORS)";
      if (global.FlashLog) global.FlashLog.update(logEntry);
      status.engine = "direct";
      return { status: r.status, headers: out, body: buf, finalUrl: r.url || targetUrl, engine: "direct", wispUrl: "" };
    } catch (e3) {
      logEntry.ms = performance.now() - logEntry.t0;
      logEntry.error = String((e3 && e3.message) || e3).slice(0, 300);
      if (global.FlashLog) global.FlashLog.update(logEntry);
      throw lastErr || e3;
    }
  }

  async function benchmarkPool(timeoutMs) {
    const s = settings();
    const pool = s.poolList && s.poolList.length ? s.poolList : [s.wispUrl];
    const results = [];
    for (const url of pool) {
      const t0 = performance.now();
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
        // Benchmark the WebSocket handshake, not a full page fetch.
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.onopen = () => { ws.close(); resolve(); };
          ws.onerror = reject;
          ctrl.signal.addEventListener("abort", () => { try { ws.close(); } catch {} reject(new Error("timeout")); });
        });
        clearTimeout(to);
        results.push({ url, ms: Math.round(performance.now() - t0), ok: true });
      } catch (e) {
        results.push({ url, ms: Infinity, ok: false, error: String((e && e.message) || e).slice(0, 120) });
      }
    }
    results.sort((a, b) => a.ms - b.ms);
    return results;
  }

  function getStatus() { return { ...status }; }

  // Silent background benchmark: handshake every pool relay in parallel
  // chunks, reorder fastest-first, persist + timestamp. Boot calls this when
  // idle (stale >12h or never) so browsing always starts on the fastest
  // relay instead of whatever the list order happens to be.
  const BENCH_CONCURRENCY = 6;
  const BENCH_TIMEOUT_MS = 5000;
  function handshakeOnce(url) {
    return new Promise((resolve, reject) => {
      let done = false;
      let ws = null;
      const to = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws && ws.close(); } catch {}
        reject(new Error("timeout"));
      }, BENCH_TIMEOUT_MS);
      try {
        ws = new WebSocket(url);
      } catch (e) {
        clearTimeout(to);
        reject(e);
        return;
      }
      ws.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        try { ws.close(); } catch {}
        resolve();
      };
      ws.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(to);
        reject(new Error("connect failed"));
      };
    });
  }
  async function backgroundBenchmark() {
    const s = settings();
    if (!s.poolEnabled) return null;
    const pool = s.poolList && s.poolList.length ? s.poolList : [s.wispUrl];
    if (pool.length < 2) return null;
    const scored = [];
    for (let i = 0; i < pool.length; i += BENCH_CONCURRENCY) {
      const chunk = pool.slice(i, i + BENCH_CONCURRENCY);
      const out = await Promise.all(chunk.map(async (url) => {
        const t0 = performance.now();
        try {
          await handshakeOnce(url);
          return { url, ms: Math.round(performance.now() - t0), ok: true };
        } catch (e) {
          return { url, ms: Infinity, ok: false, error: String((e && e.message) || e).slice(0, 80) };
        }
      }));
      scored.push(...out);
    }
    scored.sort((a, b) => a.ms - b.ms);
    try {
      global.FlashStore.saveSettings({ poolList: scored.map((r) => r.url) });
      global.FlashStore.set("poolBenchmarkAt", Date.now());
    } catch {}
    // Quietly point the engine at the winner so the next navigation is hot.
    try {
      const order = transportOrder();
      const fastest = scored[0].url;
      const p = order[0] === "epoxy" ? ensureEpoxy(fastest) : ensureLibcurl(fastest);
      Promise.resolve(p).catch(() => {});
    } catch {}
    return scored;
  }

  // Background warmup: download + boot the WASM engine at launch (idle),
  // so the first navigation doesn't pay the ~2MB CDN cost. Fire-and-forget;
  // failures are silent and the normal lazy path still applies.
  let warmed = false;
  function warmup() {
    if (warmed) return;
    warmed = true;
    try {
      const order = transportOrder();
      const s = settings();
      const url = s.poolEnabled && s.poolList && s.poolList.length ? s.poolList[0] : s.wispUrl;
      const p = order[0] === "epoxy" ? ensureEpoxy(url) : ensureLibcurl(url);
      Promise.resolve(p).catch(() => {});
    } catch {}
  }

  // Concurrency budgets for the renderer (GUST parity: idle/active steppers).
  function concurrency() {
    const s = settings();
    return {
      idle: Math.max(1, Math.min(16, s.idleThreads != null ? s.idleThreads : 3)),
      active: Math.max(1, Math.min(32, s.activeThreads != null ? s.activeThreads : (s.maxConnections || 6))),
    };
  }

  global.FlashTransport = {
    fetchViaTransport,
    ensureClient: ensureEpoxy, // back-compat alias
    ensureEpoxy,
    ensureLibcurl,
    benchmarkPool,
    getStatus,
    pickWisp,
    concurrency,
    warmup,
    backgroundBenchmark,
  };
})(typeof window !== "undefined" ? window : globalThis);

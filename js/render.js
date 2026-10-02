/* Flash — render.js
 * Fetch -> sniff -> rewrite -> inject -> inline -> blob frame.
 *
 * Rewriting strategy (same class of solution as GUST, original code):
 *  - Parse HTML with DOMParser in the *parent* (never navigates the top frame).
 *  - Rewrite every URL-bearing attribute to an absolute URL (so subresource
 *    loads resolve without leaking relative-base tricks), then let the
 *    injected runtime route them back through Flash via postMessage/fetch bridge.
 *  - Rewrite inline CSS url(...) and <style> blocks.
 *  - Inject __flash runtime as the FIRST script so it wins over page scripts.
 *  - Neutralize <base>, upgrade-insecure-requests CSP, and direct top escapes.
 */
(function (global) {
  "use strict";

  const URL_ATTRS = [
    ["a", "href"], ["area", "href"], ["link", "href"],
    ["img", "src"], ["img", "srcset"], ["source", "src"], ["source", "srcset"],
    ["video", "src"], ["video", "poster"], ["audio", "src"], ["track", "src"],
    ["script", "src"], ["iframe", "src"], ["embed", "src"], ["object", "data"],
    ["input", "src"], ["form", "action"], ["button", "formaction"],
    ["use", "href"], ["image", "href"],
  ];
  const URL_ATTR_SET = new Set(URL_ATTRS.map(([t, a]) => t + "|" + a));

  function absolutize(val, base) {
    if (!val || /^(data:|blob:|javascript:|mailto:|tel:|flash:)/i.test(val.trim())) return val;
    try {
      return new URL(val, base).href;
    } catch { return val; }
  }

  function rewriteSrcset(val, base) {
    return String(val).split(",").map((part) => {
      const seg = part.trim();
      if (!seg) return seg;
      const sp = seg.lastIndexOf(" ");
      if (sp === -1) return absolutize(seg, base);
      return absolutize(seg.slice(0, sp), base) + seg.slice(sp);
    }).join(", ");
  }

  function rewriteCssText(css, base) {
    if (!css) return css;
    // url(...) — skip data: and absolute handling inside absolutize
    return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const t = u.trim();
      if (/^(data:|blob:|#)/i.test(t)) return m;
      return `url(${q}${absolutize(t, base)}${q})`;
    }).replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      if (/^(data:|blob:)/i.test(u)) return m;
      return `@import ${q}${absolutize(u, base)}${q}`;
    });
  }

  function rewriteDocument(doc, baseUrl) {
    // Hostile meta goes. <base> is REPLACED (not stripped) with the real
    // origin: relative import maps, module imports, fonts and workers resolve
    // correctly, while our rewriter + runtime keep using the baked base URL.
    doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
      const v = (m.getAttribute("http-equiv") || "").toLowerCase();
      if (v === "refresh" || v === "content-security-policy") m.remove();
    });
    doc.querySelectorAll("base").forEach((n) => n.remove());
    try {
      if (doc.head) {
        const b = doc.createElement("base");
        b.setAttribute("href", baseUrl);
        doc.head.insertBefore(b, doc.head.firstChild);
      }
    } catch {}
    // Strip resource hints: inside a blob iframe they resolve against the
    // wrong origin, fire outside the tunnel, and break with CORS errors.
    doc.querySelectorAll("link[rel]").forEach((l) => {
      const r = (l.getAttribute("rel") || "").toLowerCase().trim();
      if (["preconnect", "dns-prefetch", "prerender", "prefetch", "modulepreload"].includes(r)) l.remove();
    });

    // Generic attribute pass.
    const all = doc.querySelectorAll("*");
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      for (const attr of ["src", "href", "action", "data", "poster", "formaction", "srcset"]) {
        if (!el.hasAttribute(attr)) continue;
        if (attr === "src" && tag === "script" && el.hasAttribute("data-flash")) continue;
        if (!URL_ATTR_SET.has(tag + "|" + attr)) {
          // Still catch common stragglers like `background`, `cite`, `longdesc`.
          if (!["background", "cite", "longdesc", "profile"].includes(attr)) continue;
        }
        const v = el.getAttribute(attr);
        if (v == null) continue;
        if (attr === "srcset") el.setAttribute(attr, rewriteSrcset(v, baseUrl));
        else el.setAttribute(attr, absolutize(v, baseUrl));
      }
      // Inline style=""
      if (el.hasAttribute("style")) {
        el.setAttribute("style", rewriteCssText(el.getAttribute("style"), baseUrl));
      }
      // form method guard: force GET/POST to stay inside proxy via runtime
      if (tag === "form") el.setAttribute("data-flash-form", "1");
      // open-in-new-tab stays inside Flash
      if (tag === "a" && el.getAttribute("target") === "_top") {
        el.setAttribute("target", "_self");
      }
      // Defuse external scripts: the base document paints BEFORE enrichment
      // inlines tunneled copies, and any surviving src would execute natively
      // first (module CORS errors, double execution, leaks on open nets).
      // The URL is stashed for the enrichment fill (or native last-chance).
      if (tag === "script" && el.hasAttribute("src") && !el.hasAttribute("data-flash")) {
        el.setAttribute("data-flash-src", el.getAttribute("src"));
        el.removeAttribute("src");
      }
      // Defuse external stylesheets the same way: a surviving href loads
      // natively at base paint and its font files die on CORS (the whole
      // console font storm). Stashed for the enrichment fill.
      if (tag === "link" && !el.hasAttribute("data-flash") && el.hasAttribute("href")) {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        if (rel.includes("stylesheet")) {
          el.setAttribute("data-flash-href", el.getAttribute("href"));
          el.removeAttribute("href");
        }
      }
    }
    // <style> blocks
    doc.querySelectorAll("style").forEach((st) => {
      st.textContent = rewriteCssText(st.textContent, baseUrl);
    });
    return doc;
  }

  function injectRuntime(doc, ctx) {
    // ctx: {baseUrl, tabId, settings}
    const head = doc.head || doc.documentElement;
    // Record real origin for the spoof layer.
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "flash:base");
    meta.setAttribute("content", ctx.baseUrl);
    doc.documentElement.insertBefore(meta, doc.documentElement.firstChild);

    const s = doc.createElement("script");
    s.setAttribute("data-flash", "runtime");
    s.textContent = global.FlashRuntime.build(ctx);
    // Must run before any page script: insert at very top of <head>.
    if (head.firstChild) head.insertBefore(s, head.firstChild);
    else head.appendChild(s);

    // Cosmetic adblock CSS (hides common ad slots without breaking layout).
    try {
      const st = global.FlashAdblock ? global.FlashAdblock.cosmeticCss(ctx.baseUrl) : "";
      if (st) {
        const c = doc.createElement("style");
        c.setAttribute("data-flash", "cosmetic");
        c.textContent = st;
        head.appendChild(c);
      }
    } catch {}
    // User extensions (store gallery): CSS appended to head, JS appended at
    // end of body so it runs after page scripts in the sandbox.
    try {
      const ex = global.FlashExtensions ? global.FlashExtensions.pageExtras() : null;
      if (ex && ex.css) {
        const c = doc.createElement("style");
        c.setAttribute("data-flash", "ext-css");
        c.textContent = ex.css;
        head.appendChild(c);
      }
      if (ex && ex.js && doc.body) {
        const s2 = doc.createElement("script");
        s2.setAttribute("data-flash", "ext-js");
        s2.textContent = ex.js;
        doc.body.appendChild(s2);
      } else if (ex && ex.js) {
        const s2 = doc.createElement("script");
        s2.setAttribute("data-flash", "ext-js");
        s2.textContent = ex.js;
        head.appendChild(s2);
      }
    } catch {}
    return doc;
  }

  // Bot-check pages (Cloudflare "Just a moment", Turnstile, etc.): detect by
  // title + known challenge markers. The page still renders — interactive
  // checks can complete in-frame (their API calls ride the bridge, clearance
  // cookies arrive via response headers into the jar). We add one dismissible
  // bar with a one-click relay switch, since egress-IP reputation decides
  // whether the check passes at all.
  function detectChallenge(doc, title) {
    if (/just a moment|attention required|verify you are|verifying you are|checking your browser|security check|ddos.?guard/i.test(title || "")) return true;
    try {
      if (doc.querySelector("#challenge-form,#challenge-running,#cf-challenge-running,#cf-please-wait,.cf-turnstile,input[name=cf-turnstile-response],form[action*=__cf_chl],form[action*=cdn-cgi]")) return true;
    } catch {}
    return false;
  }

  function challengeBar(doc) {
    const shield = (global.FlashIcons && global.FlashIcons.svg("shield", 14)) || "";
    const bar = doc.createElement("div");
    bar.setAttribute("data-flash", "challenge");
    bar.setAttribute("style", "position:sticky;top:0;z-index:2147483647;display:flex;gap:10px;align-items:center;background:#141b28;border-bottom:1px solid #2a364f;color:#e6edf3;font:13px system-ui;padding:8px 12px;");
    bar.innerHTML =
      "<span style=\"display:inline-flex;color:#7ee2a0;\">" + shield + "</span>" +
      "<span>This site is showing a bot check. You can complete it here — if it loops, switching relays usually fixes it.</span>" +
      "<button onclick=\"window.__flashGo&&window.__flashGo('flash://settings')\" style=\"margin-left:auto;background:#1c2534;color:#fff;border:1px solid #2d3a52;border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit;white-space:nowrap;\">Relay settings</button>" +
      "<button onclick=\"this.closest('[data-flash=challenge]').remove()\" style=\"background:none;border:0;color:#9fb2cc;cursor:pointer;font-size:15px;padding:2px 6px;\">×</button>";
    // Prepend without disturbing the page's own layout scripts more than once.
    if (doc.body) {
      if (doc.body.firstChild) doc.body.insertBefore(bar, doc.body.firstChild);
      else doc.body.appendChild(bar);
    }
    return bar;
  }

  // Same font treatment for INLINE <style> blocks (external sheets are
  // handled in inlineStyles; pages like DDG keep @font-face inline).
  async function inlineStyleFonts(doc, pageUrl) {
    const styles = Array.from(doc.querySelectorAll("style")).filter((el) => !el.hasAttribute("data-flash"));
    if (!styles.length) return;
    await eachLimit(styles, activeLimit(), async (el) => {
      try {
        const css = el.textContent || "";
        if (!css || css.indexOf("@font-face") === -1) return;
        const out = await inlineFontFaces(css, pageUrl);
        if (out !== css) el.textContent = out;
      } catch {}
    });
  }
  // first paint, so pages render visually complete instead of with broken
  // image icons on restrictive networks. Bounded: first 30 images, 1.5MB each,
  // all concurrent over the multiplexed tunnel. Failures are ignored per image.
  const IMG_MAX = 30;
  const IMG_MAX_BYTES = 1500 * 1024;
  const CSS_MAX = 15;
  const CSS_MAX_BYTES = 500 * 1024;
  const JS_MAX = 20;
  const JS_MAX_BYTES = 3 * 1024 * 1024;
  const FRAME_MAX = 5;
  const FRAME_MAX_BYTES = 500 * 1024;

  // Runtime-tunable budgets (Settings → Files & Media). GUST defaults are
  // 250 scripts / 300 images; Flash historically inlines far fewer, so the
  // settings act as caps scaled onto the inline pipeline.
  function budgets() {
    let s = {};
    try { s = global.FlashStore.getSettings(); } catch {}
    const imgCap = s.imageLimit != null ? s.imageLimit : 300;
    const jsCap = s.scriptLimit != null ? s.scriptLimit : 250;
    return {
      img: Math.max(0, Math.min(IMG_MAX, Math.ceil(imgCap / 10))),
      js: Math.max(0, Math.min(JS_MAX, Math.ceil(jsCap / 12))),
    };
  }

  // Filtered hosts blackhole TCP (no RST), so subresource fetches would hang
  // the whole render with no failure. Timeouts are per-kind: scripts get the
  // most time (1MB+ bundles must come through the tunnel — modules have no
  // working native fallback), images the least. The entire enrichment phase
  // gets a 40s budget, after which we serialize whatever inlined so far.
  // A slow tracker can never hold the page hostage.
  const FETCH_TIMEOUT_MS = 8000;
  const SCRIPT_FETCH_TIMEOUT_MS = 30000;
  const CSS_FETCH_TIMEOUT_MS = 20000;
  const FONT_FETCH_TIMEOUT_MS = 15000;
  const FRAME_FETCH_TIMEOUT_MS = 15000;
  const ENRICH_BUDGET_MS = 40000;

  function timedOut(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error("fetch timeout")), ms));
  }

  // Session subresource cache: shared libs (jQuery, fonts, logos) fetched once
  // per session instead of on every page. LRU, capped by count + bytes.
  // Only small, cache-friendly bodies are kept (never pages or huge media).
  const SUB_CACHE_MAX = 60;
  const SUB_CACHE_BYTES = 24 * 1024 * 1024;
  const SUB_CACHE_ENTRY_MAX = 1500 * 1024;
  const subCache = new Map(); // url -> {body, ct, bytes, t}
  function subGet(url) {
    const hit = subCache.get(url);
    if (!hit) return null;
    subCache.delete(url); // touch: re-insert as most-recent
    subCache.set(url, hit);
    return hit;
  }
  function subPut(url, body, ct) {
    if (!body || !body.length || body.length > SUB_CACHE_ENTRY_MAX) return;
    if (subCache.has(url)) subCache.delete(url);
    let total = body.length;
    for (const e of subCache.values()) total += e.bytes;
    for (const [u, e] of subCache) {
      if (subCache.size < SUB_CACHE_MAX && total <= SUB_CACHE_BYTES) break;
      total -= e.bytes;
      subCache.delete(u);
    }
    subCache.set(url, { body, ct: ct || "", bytes: body.length, t: Date.now() });
  }

  async function fetchBytes(url, kind, pageUrl, timeoutMs) {
    const hit = subGet(url);
    if (hit) return { body: hit.body, headers: { "content-type": hit.ct } };
    const r = await Promise.race([
      global.FlashTransport.fetchViaTransport(url, { kind: kind || "fetch", pageUrl }),
      timedOut(timeoutMs || FETCH_TIMEOUT_MS),
    ]);
    if (!r || !r.body || !r.body.length) return null;
    try {
      subPut(url, r.body, r.headers["content-type"] || "");
    } catch {}
    return r;
  }

  // Bounded parallelism for the subresource storm: unlimited concurrency over
  // one multiplexed WebSocket congests the WASM stack and gets SLOWER, not
  // faster. Honors the active-threads stepper (default 6).
  function activeLimit() {
    try {
      const c = global.FlashTransport.concurrency();
      if (c && c.active) return Math.max(1, Math.min(16, c.active));
    } catch {}
    return 6;
  }
  async function eachLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const n = Math.max(1, Math.min(limit || 6, items.length));
    const workers = Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch {
          out[idx] = null;
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  function b64encodeBytes(u8) {
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  // Webfont inlining: @font-face files (.woff2/.woff/.ttf/…) referenced by a
  // stylesheet would otherwise load NATIVELY from inside the blob frame and
  // die on CORS (origin `null` on file://) — broken icons, fallback fonts,
  // and sometimes cascading page-JS failures. So fonts ride the tunnel and
  // are inlined as data: URLs, bounded and failure-tolerant like everything
  // else. URLs here are already absolute (rewriteCssText ran first).
  const FONT_EXT_RE = /\.(woff2?|ttf|otf|eot)$/i;
  const FONT_MIME = {
    woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf",
    otf: "font/otf", eot: "application/vnd.ms-fontobject",
  };
  const FONT_MAX = 8;
  const FONT_MAX_BYTES = 300 * 1024;
  async function inlineFontFaces(cssText, pageUrl) {
    const urls = [];
    const seen = new Set();
    const re = /url\(\s*(['"]?)(https?:[^'")]+)\1\s*\)/gi;
    let m;
    while ((m = re.exec(cssText)) && urls.length < FONT_MAX) {
      const u = m[2];
      const bare = u.split("?")[0].split("#")[0];
      if (!FONT_EXT_RE.test(bare)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
    }
    if (!urls.length) return cssText;
    const rows = await eachLimit(urls, activeLimit(), async (u) => {
      try {
        const r = await fetchBytes(u, "font", pageUrl, FONT_FETCH_TIMEOUT_MS);
        if (!r || r.body.length > FONT_MAX_BYTES) return null;
        const ext = (u.split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
        const mime = FONT_MIME[ext] || "font/woff2";
        return { u, data: "data:" + mime + ";base64," + b64encodeBytes(r.body) };
      } catch {
        return null;
      }
    });
    let out = cssText;
    for (const row of rows) {
      if (row) out = out.split(row.u).join(row.data);
    }
    return out;
  }

  // Safety net for budget expiry: anything still stashed (never attempted
  // because the race moved on) gets its URL back for a native attempt.
  // Without this, expired races strand scripts/styles with neither src nor
  // content — a permanently blank, scriptless page no fallback can see.
  // Always safe to call: completed nodes carry no stash.
  function restoreUnfilled(doc) {
    doc.querySelectorAll("script[data-flash-src]").forEach((s) => {
      try {
        const u = s.getAttribute("data-flash-src");
        if (u && /^https?:/i.test(u)) s.setAttribute("src", u);
      } catch {}
      s.removeAttribute("data-flash-src");
      s.setAttribute("data-flash-tried", "1");
    });
    doc.querySelectorAll("link[data-flash-href]").forEach((l) => {
      try {
        const u = l.getAttribute("data-flash-href");
        if (u && /^https?:/i.test(u)) l.setAttribute("href", u);
      } catch {}
      l.removeAttribute("data-flash-href");
      l.setAttribute("data-flash-tried", "1");
    });
  }
  // Fetch page images through the tunnel and inline them as data: URLs before
  // first paint, so pages render visually complete instead of with broken
  // image icons on restrictive networks. Bounded, concurrent, failures ignored.
  async function inlineImages(doc, pageUrl, onPatch) {
    const cap = budgets().img;
    if (!cap) return;
    const imgs = Array.from(doc.querySelectorAll("img[src]")).slice(0, cap)
      .filter((img) => /^https?:/i.test(img.getAttribute("src") || ""));
    await eachLimit(imgs, activeLimit(), async (img) => {
      try {
        const src = img.getAttribute("src") || "";
        const r = await fetchBytes(src, "image", pageUrl);
        if (!r || r.body.length > IMG_MAX_BYTES) return;
        const mime = ((r.headers["content-type"] || "").split(";")[0] || "").trim().toLowerCase();
        if (!mime.startsWith("image/")) return;
        const dataUrl = "data:" + mime + ";base64," + b64encodeBytes(r.body);
        img.setAttribute("src", dataUrl);
        img.removeAttribute("srcset");
        // Live mode: the caller patches the running frame with the same
        // bytes instead of re-parsing the whole document.
        if (onPatch) { try { onPatch({ url: src, dataUrl }); } catch {} }
      } catch {}
    });
  }

  // Stylesheets can't ride the bridge (plain <link> loads natively), so inline
  // them through the tunnel. Preserves the media attribute. Bounded.
  async function inlineStyles(doc, pageUrl) {
    const links = Array.from(doc.querySelectorAll('link[rel]')).filter((l) => {
      if (l.hasAttribute("data-flash") || l.hasAttribute("data-flash-tried")) return false;
      const rel = (l.getAttribute("rel") || "").toLowerCase();
      if (!rel.includes("stylesheet")) return false;
      const href = l.getAttribute("data-flash-href") || l.getAttribute("href") || "";
      return /^https?:/i.test(href);
    }).slice(0, CSS_MAX);
    await eachLimit(links, activeLimit(), async (l) => {
      const href = l.getAttribute("data-flash-href") || l.getAttribute("href") || "";
      const restoreNative = () => {
        // Tunnel failed: put the URL back for a native last-chance attempt.
        // Marked tried so later passes don't burn another 20s on it.
        try {
          if (/^https?:/i.test(href)) l.setAttribute("href", href);
        } catch {}
        l.removeAttribute("data-flash-href");
        l.setAttribute("data-flash-tried", "1");
      };
      try {
        if (!/^https?:/i.test(href)) return;
        const r = await fetchBytes(href, "style", pageUrl, CSS_FETCH_TIMEOUT_MS);
        if (!r || r.body.length > CSS_MAX_BYTES) { restoreNative(); return; }
        const raw = rewriteCssText(new TextDecoder("utf-8", { fatal: false }).decode(r.body), href);
        // Fonts inside the sheet ride the tunnel too (else CORS kills them).
        const css = await inlineFontFaces(raw, pageUrl);
        const st = doc.createElement("style");
        st.setAttribute("data-flash", "sheet");
        const media = l.getAttribute("media");
        if (media) st.setAttribute("media", media);
        st.textContent = css;
        l.replaceWith(st);
      } catch {
        restoreNative();
      }
    });
    // Over-cap leftovers keep working natively, as before defusing.
    // Everything touched here is marked tried so the background pass skips it.
    doc.querySelectorAll("link[data-flash-href]").forEach((l) => {
      try {
        const u = l.getAttribute("data-flash-href");
        if (u && /^https?:/i.test(u)) l.setAttribute("href", u);
      } catch {}
      l.removeAttribute("data-flash-href");
      l.setAttribute("data-flash-tried", "1");
    });
  }

  // Same treatment for classic AND module scripts: without it they load raw
  // (leaking on open networks, breaking on filtered ones — and module scripts
  // die on CORS from the blob frame, killing app pages like DDG's SERP).
  // Inlining is safe: document <base> is already the real origin, and bundled
  // app scripts carry no relative imports. Bounded.
  // Serializing a doc with raw `</script` inside a script element truncates
  // the element at parse time (real-world case: bundler regexes matching
  // "</script\s*>"). `<\/script>` is identical at JS runtime but inert to the
  // HTML parser, so inlined code is always escaped this way.
  function safeJs(js) {
    return String(js).replace(/<\/script/gi, "<\\/script");
  }

  async function inlineScripts(doc, pageUrl) {
    const cap = budgets().js;
    if (!cap) return;
    // Sources were stashed as data-flash-src at rewrite time (src defused so
    // the base paint can't execute anything natively). Fall back to src for
    // documents that bypassed the rewriter.
    const scripts = Array.from(doc.querySelectorAll("script[data-flash-src],script[src]")).filter((s) => {
      if (s.hasAttribute("data-flash") || s.hasAttribute("data-flash-tried")) return false;
      const src = s.getAttribute("data-flash-src") || s.getAttribute("src") || "";
      if (!/^https?:/i.test(src)) return false;
      const tp = (s.getAttribute("type") || "").toLowerCase().trim();
      return tp === "" || tp === "module" || tp === "text/javascript" || tp === "application/javascript" || tp === "application/ecmascript";
    }).slice(0, cap);
    await eachLimit(scripts, activeLimit(), async (s) => {
      const src = s.getAttribute("data-flash-src") || s.getAttribute("src") || "";
      const restoreNative = () => {
        // Tunnel failed: restore the URL for a native last-chance attempt
        // (works on open nets; fails the same way on filtered ones).
        // Marked tried so later passes don't burn another 30s on it.
        try {
          if (/^https?:/i.test(src)) s.setAttribute("src", src);
        } catch {}
        s.removeAttribute("data-flash-src");
        s.setAttribute("data-flash-tried", "1");
      };
      try {
        const r = await fetchBytes(src, "script", pageUrl, SCRIPT_FETCH_TIMEOUT_MS);
        if (!r || r.body.length > JS_MAX_BYTES) { restoreNative(); return; }
        const js = new TextDecoder("utf-8", { fatal: false }).decode(r.body);
        if (!js.trim()) { restoreNative(); return; }
        s.textContent = safeJs(js);
        s.removeAttribute("src");
        s.removeAttribute("data-flash-src");
        s.removeAttribute("integrity");
        s.removeAttribute("crossorigin");
      } catch {
        restoreNative();
      }
    });
    // Anything still stashed (over budget caps, never attempted) gets its URL
    // back for a native attempt — identical to pre-defuse behavior for those.
    // Everything touched here is marked tried so the background pass skips it.
    doc.querySelectorAll("script[data-flash-src]").forEach((s) => {
      try {
        const u = s.getAttribute("data-flash-src");
        if (u && /^https?:/i.test(u)) s.setAttribute("src", u);
      } catch {}
      s.removeAttribute("data-flash-src");
      s.setAttribute("data-flash-tried", "1");
    });
  }

  // One level of subframes, fetched + rewritten + sandboxed as srcdoc. This is
  // what kills the whole class of X-Frame-Options deaths: srcdoc documents
  // carry no frameable headers. Bounded: 5 frames, 500KB each, depth 1.
  async function inlineFrames(doc, ctx, pageUrl, onPatch) {
    const frames = Array.from(doc.querySelectorAll("iframe[src]")).filter((f) => {
      if (f.hasAttribute("srcdoc")) return false;
      const src = f.getAttribute("src") || "";
      return /^https?:/i.test(src);
    }).slice(0, FRAME_MAX);
    await eachLimit(frames, activeLimit(), async (f) => {
      try {
        const src = f.getAttribute("src");
        const r = await fetchBytes(src, "iframe", pageUrl, FRAME_FETCH_TIMEOUT_MS);
        if (!r || r.body.length > FRAME_MAX_BYTES) return;
        const ct = ((r.headers["content-type"] || "").split(";")[0] || "").trim().toLowerCase();
        if (ct && !ct.includes("html")) return;
        const text = new TextDecoder("utf-8", { fatal: false }).decode(r.body);
        const sub = new DOMParser().parseFromString(text, "text/html");
        rewriteDocument(sub, src);
        injectRuntime(sub, { baseUrl: src, tabId: ctx.tabId, settings: ctx.settings });
        await Promise.allSettled([inlineImages(sub, src), inlineStyles(sub, src), inlineScripts(sub, src)]);
        try { restoreUnfilled(sub); } catch {}
        const frameHtml = "<!DOCTYPE html>\n" + sub.documentElement.outerHTML;
        f.removeAttribute("src");
        f.setAttribute("srcdoc", frameHtml);
        f.setAttribute("sandbox", "allow-scripts allow-forms");
        // Live mode: the caller patches the running frame in place.
        if (onPatch) { try { onPatch({ url: src, frameSrcdoc: frameHtml }); } catch {} }
      } catch {}
    });
  }

  // Render HTML into a frame via blob URL (not srcdoc): the parser streams
  // instead of choking on one giant attribute string, and the previous blob
  // is revoked to bound memory. Falls back to srcdoc if blobs are unavailable.
  function setFrameHtml(frame, srcdoc) {
    try {
      const old = frame._flashBlob;
      const url = URL.createObjectURL(new Blob([srcdoc], { type: "text/html;charset=utf-8" }));
      frame.removeAttribute("srcdoc");
      frame.removeAttribute("src");
      frame.src = url;
      frame._flashBlob = url;
      frame._lastAssign = Date.now();
      try { global.FlashTabs.noteFrameAssign(frame); } catch {}
      if (old) {
        try { URL.revokeObjectURL(old); } catch {}
      }
      frame.style.display = "";
      // Whisper-quiet content transition so blob swaps don't pop.
      try {
        frame.classList.remove("fswap");
        void frame.offsetWidth;
        frame.classList.add("fswap");
      } catch {}
    } catch {
      try {
        frame.srcdoc = srcdoc;
        try { global.FlashTabs.noteFrameAssign(frame); } catch {}
        frame.style.display = "";
      } catch {}
    }
  }

  // Discover the site icon: first link[rel*=icon], else /favicon.ico.
  // Runs after rewriting, so hrefs are already absolute.
  function discoverIcon(doc, finalUrl) {
    try {
      const links = doc.querySelectorAll("link[rel]");
      for (const l of links) {
        const rel = (l.getAttribute("rel") || "").toLowerCase();
        if (!rel.includes("icon")) continue;
        const href = l.getAttribute("href") || "";
        if (/^https?:/i.test(href)) return href;
      }
    } catch {}
    try {
      return new URL("/favicon.ico", finalUrl).href;
    } catch {
      return "";
    }
  }
  // Phase 1: parse → rewrite → inject → fill critical subresources →
  // serialize. Scripts and stylesheets fill BEFORE first paint (bounded by
  // PREPAINT_BUDGET_MS): app pages boot on the first paint with everything
  // defined, so boot-error reload loops never start. Images/frames stay
  // progressive in phase 2.
  const PREPAINT_BUDGET_MS = 25000;
  async function renderBase(bytes, finalUrl, ctx) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");
    rewriteDocument(doc, finalUrl);
    injectRuntime(doc, { baseUrl: finalUrl, tabId: ctx.tabId, settings: ctx.settings });
    try {
      await Promise.race([
        Promise.allSettled([inlineScripts(doc, finalUrl), inlineStyles(doc, finalUrl), inlineStyleFonts(doc, finalUrl)]),
        new Promise((res) => setTimeout(res, PREPAINT_BUDGET_MS)),
      ]);
    } catch {}
    // Race expiry must never strand stashed nodes: anything unfilled goes
    // native (old behavior) instead of staying dead. No-op when all filled.
    try { restoreUnfilled(doc); } catch {}
    const html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
    return { srcdoc: html, title: doc.title || finalUrl, doc, iconUrl: discoverIcon(doc, finalUrl) };
  }

  // Phase 2: tunnel in images/frames. In live mode (onPatch set) the caller
  // patches the running frame in place instead of swapping the document —
  // no re-parse, no script re-execution, no media restart. Parent-side
  // application still happens so the back/forward cache stays correct.
  // Scripts/styles already filled pre-paint (tried-markers make any repeat
  // pass a no-op).
  async function enrichDoc(doc, ctx, finalUrl, onPatch) {
    await Promise.race([
      (async () => {
        await Promise.allSettled([inlineImages(doc, finalUrl, onPatch || null)]);
        await inlineFrames(doc, ctx, finalUrl, onPatch || null);
      })(),
      new Promise((res) => setTimeout(res, ENRICH_BUDGET_MS)),
    ]);
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  async function renderHtml(bytes, finalUrl, ctx) {
    ctx = ctx || {};
    const base = await renderBase(bytes, finalUrl, ctx);
    const html = await enrichDoc(base.doc, ctx, finalUrl);
    return { srcdoc: html, title: base.title };
  }

  async function loadPage(targetUrl, opts) {
    // opts: {tabId, headers, wispUrl, onProgress}
    opts = opts || {};
    const s = global.FlashStore.getSettings();
    const resp = await global.FlashTransport.fetchViaTransport(targetUrl, {
      headers: opts.headers,
      wispUrl: opts.wispUrl,
      kind: "navigate",
    });
    const ct = (resp.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const kind = global.FlashUtil.sniffKind(ct, resp.finalUrl);
    if (kind === "html" || ct.includes("html") || (!ct && resp.body.length && isHtml(resp.body))) {
      const s = global.FlashStore.getSettings();
      const base = await renderBase(resp.body, resp.finalUrl, { tabId: opts.tabId, settings: s, zoom: opts.zoom });
      // Enrichment handle: callers paint `base` now, then enrichDoc() in the
      // background. Pass onPatch to live-patch the running frame instead of
      // re-parsing; renderHtml() below does both for simple callers.
      const enricher = (onPatch) => enrichDoc(base.doc, { tabId: opts.tabId, settings: s }, resp.finalUrl, onPatch || null);
      return { kind: "page", srcdoc: base.srcdoc, title: base.title, resp, enrich: enricher, iconUrl: base.iconUrl };
    }
    return { kind, resp, title: resp.finalUrl };
  }

  function isHtml(bytes) {
    const head = new TextDecoder().decode(bytes.slice(0, 512)).toLowerCase();
    return head.includes("<html") || head.includes("<!doctype") || head.includes("<head");
  }

  global.FlashRewrite = {
    absolutize, rewriteCssText, rewriteDocument, renderHtml, renderBase, enrichDoc, loadPage, setFrameHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);

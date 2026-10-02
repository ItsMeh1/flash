/* bootstrap-init.js — serverless frame driver for amazingexample.html.
 *
 * Implements the tiny contract that page expects from its bootstrap:
 *   window.initBootstrap() -> Promise<controller>
 *   controller = { wait(), createFrame(iframeEl, opts?) }
 *   frame      = { go(url), back(), forward(), reload() }
 *
 * Frames are driven by a fully static, serverless engine: pages are fetched
 * through a WISP relay with TLS running inside WebAssembly (libcurl.js by
 * default, Epoxy selectable — the same single-file, no-service-worker
 * approach GUST uses), rewritten, and rendered into the given iframe via
 * srcdoc. Renders are cached per frame entry, so back/forward is instant.
 * No local server, no hosted origin required: open the page from
 * file:// and it works. Only https CDN fetches (WASM engines, fonts).
 *
 * Engine code is shared with the Flash app (js/*.js, loaded relative to
 * THIS file), so fixes land in both places at once.
 */
(function (global) {
  "use strict";

  var ENGINE_FILES = [
    "js/config.js",
    "js/injected-css.js",
    "js/util.js",
    "js/store.js",
    "js/cookies.js",
    "js/adblock.js",
    "js/engine.js",
    "js/sandbox.js",
    "js/render.js",
  ];

  function baseUrl() {
    try {
      if (document.currentScript && document.currentScript.src) {
        return new URL(".", document.currentScript.src).href;
      }
    } catch (e) {}
    return document.baseURI || location.href;
  }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var to = setTimeout(function () {
        if (!done) { done = true; reject(new Error("timed out: " + url)); }
      }, 60000);
      var el = document.createElement("script");
      el.src = url;
      el.async = false; // preserve engine load order
      el.onload = function () { if (!done) { done = true; clearTimeout(to); resolve(); } };
      el.onerror = function () {
        if (!done) { done = true; clearTimeout(to); reject(new Error("failed: " + url)); }
      };
      document.head.appendChild(el);
    });
  }

  var enginePromise = null;
  function ensureEngine() {
    if (!enginePromise) {
      enginePromise = (async function () {
        var base = baseUrl();
        for (const rel of ENGINE_FILES) {
          await loadScript(new URL(rel, base).href);
        }
        if (!global.FlashTransport || !global.FlashRewrite) {
          throw new Error("engine failed to initialise");
        }
      })().catch(function (e) {
        enginePromise = null;
        throw e;
      });
    }
    return enginePromise;
  }

  function settings() {
    return global.FlashStore.getSettings();
  }

  function contentKind(resp) {
    var ct = ((resp.headers && resp.headers["content-type"]) || "").split(";")[0].trim().toLowerCase();
    return global.FlashUtil.sniffKind(ct, resp.finalUrl);
  }

  function errorCard(title, msg) {
    var esc = global.FlashUtil.escapeHtml;
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" + (global.FlashInjectedCSS || "") +
      "</style></head><body class=\"fcard-page\"><div class=\"fcard\"><div class=\"fcard-alert\"><h3>" +
      esc(title) + "</h3></div><p>" + esc(msg).slice(0, 500) + "</p></div></body></html>";
  }

  var frameSeq = 0;

  function createFrame(iframeEl, opts) {
    var tabId = "shim-" + (++frameSeq) + "-" + Date.now().toString(36);
    // Frame-local history. HTML renders are cached per entry, so back/forward
    // (and repeat visits) restore instantly with zero network. Fresh loads
    // and reloads always refetch. Media blob URLs are never cached.
    var stack = []; // { url, srcdoc|null }
    var idx = -1;

    async function renderInto(entry, fresh) {
      if (entry.srcdoc && !fresh) {
        iframeEl.removeAttribute("src");
        iframeEl.srcdoc = entry.srcdoc;
        return entry.url;
      }
      var s = settings();
      var resp = await global.FlashTransport.fetchViaTransport(entry.url, {});
      var kind = contentKind(resp);
      if (kind === "html" || isHtml(resp)) {
        var out = await global.FlashRewrite.renderHtml(resp.body, resp.finalUrl, { tabId: tabId, settings: s });
        entry.srcdoc = out.srcdoc;
        if (stack.length > 50) stack.splice(0, stack.length - 50);
        global.FlashRewrite.setFrameHtml(iframeEl, out.srcdoc);
        return resp.finalUrl || entry.url;
      }
      var ct = ((resp.headers && resp.headers["content-type"]) || "").split(";")[0] || "application/octet-stream";
      iframeEl.src = URL.createObjectURL(new Blob([resp.body], { type: ct }));
      return resp.finalUrl || entry.url;
    }

    function isHtml(resp) {
      try {
        var head = new TextDecoder().decode(resp.body.slice(0, 512)).toLowerCase();
        return head.includes("<html") || head.includes("<!doctype") || head.includes("<head");
      } catch (e) { return false; }
    }

    async function go(url) {
      if (!url) return;
      stack = stack.slice(0, idx + 1);
      if (stack.length && stack[stack.length - 1].url === url) {
        idx = stack.length - 1;
      } else {
        stack.push({ url: url, srcdoc: null });
        idx = stack.length - 1;
      }
      try {
        await renderInto(stack[idx], false);
      } catch (e) {
        console.error("[bootstrap] load failed:", e);
        try {
          iframeEl.removeAttribute("src");
          iframeEl.srcdoc = errorCard("Couldn't load this page", String((e && e.message) || e));
        } catch (e2) {}
      }
    }

    return {
      go: go,
      back: function () {
        if (idx > 0) { idx -= 1; renderInto(stack[idx], false).catch(function (e) { console.error(e); }); }
      },
      forward: function () {
        if (idx < stack.length - 1) { idx += 1; renderInto(stack[idx], false).catch(function (e) { console.error(e); }); }
      },
      reload: function () {
        if (idx >= 0) { stack[idx].srcdoc = null; renderInto(stack[idx], true).catch(function (e) { console.error(e); }); }
      },
    };
  }

  // --- parent-side translator -------------------------------------------
  // The injected page runtime speaks the Flash postMessage protocol
  // ({__flash:1,...}). This page speaks its own. Translate between them so
  // clicks, forms and subresource fetches inside frames keep working.
  var translatorInstalled = false;
  function installTranslator() {
    if (translatorInstalled) return;
    translatorInstalled = true;
    window.addEventListener("message", async function (e) {
      var m = e.data;
      if (!m || m.__flash !== 1) return;
      var d = m.data || {};
      try {
        if (m.type === "navigate" || m.type === "leaving") {
          if (d.url && typeof window.navigate === "function") window.navigate(d.url);
        } else if (m.type === "popup") {
          // No new-tab hook is exposed by the page, so open in place —
          // staying inside the tunnel beats a raw new tab.
          if (d.url && typeof window.navigate === "function") window.navigate(d.url);
        } else if (m.type === "form-post") {
          await handleFormPost(e.source, d);
        } else if (m.type === "subfetch") {
          await handleSubfetch(e.source, d);
        }
        // "title" / "ready": the page observes titles itself — ignore.
      } catch (err) {
        console.error("[bootstrap] bridge failed:", err);
      }
    });
  }

  async function handleFormPost(source, d) {
    try {
      var resp = await global.FlashTransport.fetchViaTransport(d.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new TextEncoder().encode(d.body || ""),
        kind: "navigate",
        pageUrl: d.url,
      });
      var out = await global.FlashRewrite.renderHtml(resp.body, resp.finalUrl, {
        tabId: "shim-form", settings: settings(),
      });
      var frame = findFrame(source);
      if (frame) {
        frame.removeAttribute("src");
        frame.srcdoc = out.srcdoc;
      }
    } catch (err) {
      console.error("[bootstrap] form submit failed:", err);
    }
  }

  async function handleSubfetch(source, d) {
    var reply = function (payload) {
      try {
        source.postMessage(Object.assign({ __flash: 2, id: d.id }, payload), "*");
      } catch (e) {}
    };
    try {
      if (!d.url || !/^https?:\/\//i.test(d.url)) {
        reply({ ok: false, error: "non-web URL" });
        return;
      }
      if (global.FlashAdblock && global.FlashAdblock.isBlocked(d.url)) {
        try { global.FlashAdblock.noteBlocked(d.url); } catch (e2) {}
        reply({ ok: false, error: "blocked" });
        return;
      }
      var resp = await global.FlashTransport.fetchViaTransport(d.url, {
        method: (d.opts && d.opts.method) || "GET",
        headers: (d.opts && d.opts.headers) || {},
        kind: "fetch",
        body: (function () {
          var b = d.opts && d.opts.body;
          if (b == null) return undefined;
          if (d.opts.bin) { try { return new Uint8Array(b); } catch (e) { return undefined; } }
          return b;
        })(),
      });
      if (resp.body.length > 8 * 1024 * 1024) {
        reply({ ok: false, error: "payload too large" });
        return;
      }
      var bin = "";
      var CH = 0x8000;
      for (var i = 0; i < resp.body.length; i += CH) {
        bin += String.fromCharCode.apply(null, resp.body.subarray(i, i + CH));
      }
      reply({ ok: true, status: resp.status, headers: resp.headers, b64: btoa(bin) });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
    }
  }

  function findFrame(source) {
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentWindow === source) return frames[i];
      } catch (e) {}
    }
    return null;
  }

  global.initBootstrap = async function () {
    await ensureEngine();
    installTranslator();
    var api = {
      // Warms the default engine so first navigation isn't cold.
      wait: async function () {
        try {
          var s = settings();
          var relay = (s.poolEnabled && s.poolList && s.poolList[0]) || s.wispUrl;
          if (global.FlashTransport.ensureLibcurl) {
            await global.FlashTransport.ensureLibcurl(relay);
          }
        } catch (e) {
          console.warn("[bootstrap] warm-up failed (will retry on navigation):", e);
        }
      },
      createFrame: createFrame,
    };
    return api;
  };
})(typeof window !== "undefined" ? window : globalThis);

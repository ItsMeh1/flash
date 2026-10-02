/* Flash — util.js : small pure helpers (no DOM). */
(function (global) {
  "use strict";

  let _id = 0;

  function uid(prefix) {
    _id += 1;
    return (
      (prefix || "f") +
      "_" +
      Date.now().toString(36) +
      "_" +
      _id.toString(36) +
      Math.floor(Math.random() * 0xffff).toString(36)
    );
  }

  function isProbablyUrl(input) {
    if (!input) return false;
    const s = input.trim();
    if (/^https?:\/\//i.test(s)) return true;
    if (/^[a-z0-9-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return true;
    if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/\S*)?$/.test(s)) return true;
    return s.indexOf(" ") === -1 && s.indexOf(".") !== -1;
  }

  function normalizeInput(input, searchEngine) {
    const raw = (input || "").trim();
    if (!raw) return "flash://newtab";
    if (/^flash:\/\//i.test(raw)) {
      const name = raw.toLowerCase().replace(/^flash:\/\//, "").replace(/\/.*$/, "");
      const alias = { home: "newtab", help: "about", config: "settings", prefs: "settings", preferences: "settings", store: "store" };
      return "flash://" + (alias[name] || name);
    }
    if (/^about:/i.test(raw)) return "flash://newtab";
    if (/^https?:\/\//i.test(raw)) {
      try {
        return new URL(raw).href;
      } catch {
        return raw;
      }
    }
    if (isProbablyUrl(raw)) {
      try {
        return new URL("https://" + raw).href;
      } catch {
        return "https://" + raw;
      }
    }
    const engines = (global.FlashConfig || {}).SEARCH_ENGINES || {};
    // Custom engine: user URL with %s (or {q}) placeholder; falls back to Brave.
    if (searchEngine === "custom") {
      try {
        const s = global.FlashStore ? global.FlashStore.getSettings() : {};
        const tpl = (s.customEngineUrl || "").trim();
        if (tpl && /%s|\{q\}/i.test(tpl)) {
          return tpl.replace(/%s|\{q\}/gi, encodeURIComponent(raw));
        }
      } catch {}
    }
    const eng = engines[searchEngine] || engines.brave;
    return eng.url.replace("%s", encodeURIComponent(raw));
  }

  function originOf(url) {
    try {
      const u = new URL(url);
      return u.origin;
    } catch {
      return "";
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, ms) {
    let t = 0;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms || 150);
    };
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function fmtMs(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < 1000) return Math.round(n) + " ms";
    return (n / 1000).toFixed(2) + " s";
  }

  // Safe base64 for Uint8Array (chunked to avoid stack blowup)
  function b64encode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function b64decode(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function sniffKind(contentType, url) {
    const ct = (contentType || "").toLowerCase();
    const u = (url || "").toLowerCase();
    if (/\.pdf($|[?#])/.test(u) || ct.includes("application/pdf")) return "pdf";
    if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)($|[?#])/.test(u))
      return "image";
    if (ct.startsWith("video/") || /\.(mp4|webm|ogv|mov|m4v)($|[?#])/.test(u))
      return "video";
    if (ct.startsWith("audio/") || /\.(mp3|wav|ogg|oga|m4a|flac)($|[?#])/.test(u))
      return "audio";
    if (ct.includes("json") || /\.json($|[?#])/.test(u)) return "text";
    if (ct.startsWith("text/") || /javascript|css|xml/.test(ct)) return "text";
    if (/\.(txt|md|csv|log|js|mjs|cjs|ts|css|xml|svg|html|htm)($|[?#])/.test(u))
      return "text";
    return "html";
  }

  global.FlashUtil = {
    uid,
    isProbablyUrl,
    normalizeInput,
    originOf,
    hostOf,
    escapeHtml,
    debounce,
    clamp,
    fmtBytes,
    fmtMs,
    b64encode,
    b64decode,
    sniffKind,
  };
})(typeof window !== "undefined" ? window : globalThis);

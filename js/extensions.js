/* FlashNext — extensions.js : tiny userscript-style extension system.
 * Manifest format (JSON):
 *   { id?, name, version?, author?, desc?, js?, css? }
 * Page scripts run inside the sandboxed page (DOM access, no chrome access);
 * CSS is appended as well. Storage: flash:extensions (customs only);
 * built-ins ship in code and can only be toggled, never removed.
 * Install sources: paste JSON, or fetch a manifest URL through the WISP
 * tunnel (kind: fetch) so filters only see wss:// traffic.
 */
(function (global) {
  "use strict";

  const KEY = "extensions";
  const MAX_FIELD = 100 * 1024;

  const BUILTINS = [
    {
      id: "force-dark", name: "Force Dark", version: "1.0.0", author: "FlashNext",
      desc: "Dark background with light text on bright pages.",
      css: "html{background:#0d1424!important}body{background:#0d1424!important;color:#e9efff!important}a{color:#7aa2ff!important}",
      js: "",
    },
    {
      id: "focus-mode", name: "Focus Mode", version: "1.0.0", author: "FlashNext",
      desc: "Hides sidebars, comment sections and recommendation rails.",
      css: "aside,[class*=sidebar],[class*=rail],[id*=comments],[class*=comments],[class*=recommend],[id*=recommend]{display:none!important}main,article{max-width:900px!important;margin:0 auto!important}",
      js: "",
    },
    {
      id: "wide-video", name: "Wide Video", version: "1.0.0", author: "FlashNext",
      desc: "Lets HTML5 video use the full content width.",
      css: "video{max-width:100%!important;width:100%!important;height:auto!important}",
      js: "",
    },
  ];

  function customs() {
    try {
      const list = global.FlashStore.get(KEY, []);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function saveCustoms(list) {
    global.FlashStore.set(KEY, list);
  }

  function stateMap() {
    try {
      return global.FlashStore.get("extState", {});
    } catch {
      return {};
    }
  }

  // All extensions with effective enabled flag (default: off for built-ins).
  function all() {
    const st = stateMap();
    const out = BUILTINS.map((b) => ({
      ...b, builtin: true, enabled: !!st[b.id],
    }));
    for (const c of customs()) {
      out.push({ ...c, builtin: false, enabled: c.enabled !== false });
    }
    return out;
  }

  function setEnabled(id, on) {
    const custom = customs().find((c) => c.id === id);
    if (custom) {
      custom.enabled = !!on;
      saveCustoms(customs());
    } else {
      const st = stateMap();
      st[id] = !!on;
      global.FlashStore.set("extState", st);
    }
  }

  function slug(s) {
    return String(s || "ext").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ext";
  }

  function validate(m) {
    if (!m || typeof m !== "object") throw new Error("not an object");
    if (!m.name || typeof m.name !== "string") throw new Error("missing name");
    const js = (m.js != null ? String(m.js) : "").replace(/<\/script/gi, "<\\/script");
    const css = (m.css != null ? String(m.css) : "").replace(/<\/style/gi, "<\\/style");
    if (js.length > MAX_FIELD || css.length > MAX_FIELD) throw new Error("too large (100KB max per field)");
    if (!js.trim() && !css.trim()) throw new Error("empty: needs js or css");
    return {
      id: slug(m.id || m.name) + "-" + Date.now().toString(36),
      name: String(m.name).slice(0, 80),
      version: String(m.version || "1.0").slice(0, 20),
      author: String(m.author || "?").slice(0, 60),
      desc: String(m.desc || "").slice(0, 300),
      js, css, enabled: true,
    };
  }

  function add(manifest) {
    const clean = validate(manifest);
    const list = customs();
    // Same name+version replaces (re-install), otherwise append. Cap 50.
    const i = list.findIndex((c) => c.name === clean.name && c.version === clean.version);
    if (i >= 0) list[i] = { ...clean, id: list[i].id };
    else list.push(clean);
    saveCustoms(list.slice(-50));
    return clean;
  }

  function addFromJson(text) {
    let m;
    try {
      m = JSON.parse(String(text));
    } catch {
      throw new Error("invalid JSON");
    }
    return add(m);
  }

  async function addFromUrl(url) {
    const abs = /^https?:\/\//i.test(url) ? url : "https://" + url;
    const r = await global.FlashTransport.fetchViaTransport(abs, { kind: "fetch", pageUrl: "flash://store" });
    const text = new TextDecoder("utf-8", { fatal: false }).decode(r.body).slice(0, 300000);
    return addFromJson(text);
  }

  function remove(id) {
    saveCustoms(customs().filter((c) => c.id !== id));
  }

  // Concatenated extras for the page renderer (enabled only).
  function pageExtras() {
    let css = "", js = "";
    for (const e of all()) {
      if (!e.enabled) continue;
      if (e.css) css += "\n/* ext:" + e.id + " */\n" + e.css;
      if (e.js) js += "\n/* ext:" + e.id + " */\n" + e.js;
    }
    return { css, js };
  }

  global.FlashExtensions = {
    all, setEnabled, add, addFromJson, addFromUrl, remove, pageExtras, BUILTINS,
  };
})(typeof window !== "undefined" ? window : globalThis);

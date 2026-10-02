/* Flash — cookies.js : per-origin isolated cookie jar (localStorage). */
(function (global) {
  "use strict";

  function load() {
    return global.FlashStore.get("cookies", {});
  }
  function save(jar) {
    global.FlashStore.set("cookies", jar);
  }

  function domainMatch(cookieDomain, host) {
    if (!cookieDomain) return true;
    let d = cookieDomain.toLowerCase();
    if (d[0] === ".") d = d.slice(1);
    return host === d || host.endsWith("." + d);
  }

  function store(url, setCookie) {
    let host = "";
    let path = "/";
    try {
      const u = new URL(url);
      host = u.hostname.toLowerCase();
      path = u.pathname || "/";
    } catch { return; }
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    const jar = load();
    for (const line of list) {
      if (!line) continue;
      const parts = String(line).split(";");
      const [k, ...rest] = parts[0].split("=");
      const name = (k || "").trim();
      if (!name) continue;
      const value = rest.join("=").trim();
      let domain = host, cpath = "/", expires = 0;
      for (let i = 1; i < parts.length; i++) {
        const [ak, ...av] = parts[i].split("=");
        const an = (ak || "").trim().toLowerCase();
        const aval = av.join("=").trim();
        if (an === "domain") domain = aval.toLowerCase().replace(/^\./, "");
        if (an === "path") cpath = aval || "/";
        if (an === "max-age") expires = Date.now() + parseInt(aval, 10) * 1000;
        if (an === "expires") { const t = Date.parse(aval); if (!isNaN(t)) expires = t; }
      }
      if (!jar[domain]) jar[domain] = {};
      jar[domain][name] = { value, path: cpath, expires, host };
    }
    // prune expired
    const now = Date.now();
    for (const d of Object.keys(jar)) {
      for (const n of Object.keys(jar[d])) {
        if (jar[d][n].expires && jar[d][n].expires < now) delete jar[d][n];
      }
      if (!Object.keys(jar[d]).length) delete jar[d];
    }
    save(jar);
  }

  function getHeader(url) {
    let host = "", path = "/";
    try {
      const u = new URL(url);
      host = u.hostname.toLowerCase();
      path = u.pathname || "/";
    } catch { return ""; }
    const jar = load();
    const now = Date.now();
    const out = [];
    for (const d of Object.keys(jar)) {
      if (!domainMatch(d, host)) continue;
      for (const n of Object.keys(jar[d])) {
        const c = jar[d][n];
        if (c.expires && c.expires < now) continue;
        if (path.indexOf(c.path) !== 0) continue;
        out.push(n + "=" + c.value);
      }
    }
    return out.join("; ");
  }

  function clear() { save({}); }

  global.FlashCookies = { store, getHeader, clear };
})(typeof window !== "undefined" ? window : globalThis);

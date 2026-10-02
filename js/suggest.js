/* FlashNext — suggest.js : fast search suggestions for omnibox + new tab.
 * Provider chain, fetched THROUGH the WISP tunnel (never direct fetch):
 *   DuckDuckGo autocomplete -> Brave suggest -> Bing osjson.
 * Direct fetch is unusable here: from file:// the origin is `null` and all
 * three providers refuse it via CORS (console spam, zero results). The WASM
 * engines do their own TLS and ignore browser CORS entirely, so tunneled
 * suggestions just work — on file://, http(s), and hosted alike.
 * First success wins; anything failing falls through silently. Debounced,
 * keyboard-navigable (up/down/enter/esc), gated by the searchSuggest setting.
 * A 6s cap keeps the dropdown snappy; stale keystrokes are discarded.
 */
(function (global) {
  "use strict";

  const DEBOUNCE_MS = 180;
  const MIN_LEN = 2;
  const SUGGEST_TIMEOUT_MS = 6000;

  function suggestOn() {
    try {
      return global.FlashStore.getSettings().searchSuggest !== false;
    } catch {
      return true;
    }
  }

  function isUrlLike(q) {
    const s = q.trim();
    return /^https?:\/\//i.test(s) || global.FlashUtil.isProbablyUrl(s);
  }

  // One autocomplete API call over the tunnel. Throws on any failure so the
  // chain falls through to the next provider.
  async function tunnelJson(url, pick) {
    const r = await global.FlashTransport.fetchViaTransport(url, {
      kind: "fetch", pageUrl: "flash://newtab",
    });
    if (!r || r.status >= 400 || !r.body || !r.body.length) throw new Error("bad response");
    let j;
    try {
      j = JSON.parse(new TextDecoder("utf-8").decode(r.body));
    } catch {
      throw new Error("bad json");
    }
    const out = pick(j);
    if (!Array.isArray(out) || !out.length) throw new Error("empty");
    return out.slice(0, 8);
  }

  const isStr = (x) => typeof x === "string" && x.trim().length > 0;

  async function fetchSuggestions(q) {
    const enc = encodeURIComponent(q);
    // DuckDuckGo (list shape: [query, [suggestions...]]).
    try {
      const r = await tunnelJson("https://duckduckgo.com/ac/?q=" + enc + "&type=list",
        (j) => (Array.isArray(j) && Array.isArray(j[1]) ? j[1].filter(isStr) : null));
      if (r) return r;
    } catch {}
    // Brave suggest (defensive: array or {suggestions/results} shapes).
    try {
      const r = await tunnelJson("https://search.brave.com/api/suggest?q=" + enc, (j) => {
        if (Array.isArray(j)) return j.filter(isStr);
        if (j && Array.isArray(j.suggestions)) return j.suggestions.map((x) => x.text || x.value || x).filter(isStr);
        if (j && Array.isArray(j.results)) return j.results.map((x) => x.title || x.text).filter(isStr);
        return null;
      });
      if (r) return r;
    } catch {}
    // Bing osjson ([query, [suggestions...]]).
    try {
      const r = await tunnelJson("https://api.bing.com/osjson.aspx?query=" + enc,
        (j) => (Array.isArray(j) && Array.isArray(j[1]) ? j[1].filter(isStr) : null));
      if (r) return r;
    } catch {}
    return [];
  }

  function withTimeout(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error("suggest timeout")), ms));
  }

  // Attach to an input + dropdown box. onPick(text) navigates.
  function attach(input, box, onPick) {
    if (!input || !box) return;
    let items = [], active = -1, timer = 0, seq = 0;

    function hide() {
      box.hidden = true;
      box.innerHTML = "";
      items = [];
      active = -1;
    }

    function draw() {
      if (!items.length) { hide(); return; }
      const U = global.FlashUtil;
      box.innerHTML = items.map((s, i) =>
        `<button class="sug-row${i === active ? " on" : ""}" data-i="${i}">${U.escapeHtml(s)}</button>`
      ).join("");
      box.hidden = false;
      box.querySelectorAll(".sug-row").forEach((row) => {
        row.onmousedown = (e) => {
          e.preventDefault(); // keep focus so enter/esc still work
          const v = items[+row.dataset.i];
          hide();
          onPick(v);
        };
      });
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value;
      if (!suggestOn() || q.trim().length < MIN_LEN || isUrlLike(q)) { hide(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        // 6s cap: a hung provider must never hold the dropdown hostage.
        // Stale keystrokes are discarded by the seq guard below.
        const list = await Promise.race([fetchSuggestions(q.trim()), withTimeout(SUGGEST_TIMEOUT_MS)])
          .catch(() => []);
        if (my !== seq) return; // superseded
        // Dedupe + drop the exact query itself.
        const seen = new Set();
        items = list.filter((s) => {
          const k = s.toLowerCase();
          if (k === q.trim().toLowerCase() || seen.has(k)) return false;
          seen.add(k);
          return true;
        }).slice(0, 8);
        active = -1;
        draw();
      }, DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (e) => {
      if (box.hidden || !items.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = e.key === "ArrowDown"
          ? (active + 1) % items.length
          : (active - 1 + items.length) % items.length;
        input.value = items[active];
        draw();
      } else if (e.key === "Escape") {
        hide();
      }
    });

    input.addEventListener("blur", () => {
      // Let mousedown on rows win first.
      setTimeout(hide, 150);
    });
  }

  global.FlashSuggest = { attach, fetchSuggestions };
})(typeof window !== "undefined" ? window : globalThis);

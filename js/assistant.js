/* Flash — assistant.js : AI Assistant sidebar.
 * Online-first, offline-capable: when the device is online it asks a free,
 * keyless text API (no key, no account); when offline or blocked it falls
 * back to a smarter local brain (commands, arithmetic, page outline, browser
 * control). Display name is always "AI Assistant" — the name Bolt is only
 * revealed when the user explicitly asks for its name.
 */
(function (global) {
  "use strict";

  const U = () => global.FlashUtil;
  const I = () => global.FlashIcons.svg;
  const MAX_KEEP = 40;

  const JOKES = [
    "Why do programmers prefer dark mode? Because light attracts bugs.",
    "There are only 10 kinds of people: those who understand binary and those who don't.",
    "A SQL query walks into a bar and asks two tables: “Mind if I join you?”",
  ];
  let jokeIdx = 0;

  function load() { return global.FlashStore.get("chat", []); }
  function save(list) { global.FlashStore.set("chat", list.slice(-MAX_KEEP)); }

  function T(k) {
    try {
      return global.FlashI18n.t(k);
    } catch {
      return k;
    }
  }

  function init() {
    const log = document.getElementById("chatLog");
    if (!log) return;
    renderAll();
    if (!load().length) {
      botSay(T("aiHello"));
    }
    bindChips([[T("chipStatus"), "status"], [T("chipOpen"), "Open example.com"], [T("chipSettings"), "go settings"], [T("chipHelp"), "help"]]);
    document.getElementById("chatForm").onsubmit = (e) => {
      e.preventDefault();
      const inp = document.getElementById("chatInput");
      const v = inp.value.trim();
      if (!v) return;
      inp.value = "";
      userSay(v);
      respond(v);
    };
  }

  function push(role, html) {
    const list = load();
    list.push({ role, html, t: Date.now() });
    save(list);
  }

  function renderAll() {
    const log = document.getElementById("chatLog");
    log.innerHTML = "";
    for (const m of load()) log.appendChild(msgEl(m.role, m.html, false));
    log.scrollTop = log.scrollHeight;
  }

  function msgEl(role, html, animate) {
    const d = document.createElement("div");
    d.className = "chat-msg " + role;
    const ava = role === "bot"
      ? `<span class="ava">${I()("zap", 14)}</span>`
      : `<span class="ava">${I()("arrowRight", 13)}</span>`;
    d.innerHTML = ava + `<div class="bubble">${linkify(html)}</div>`;
    // Internal-page + URL buttons inside bot messages.
    d.querySelectorAll("[data-goto]").forEach((b) => {
      b.onclick = () => global.FlashApp.navigate(b.dataset.goto);
    });
    d.querySelectorAll("[data-cmd]").forEach((b) => {
      b.onclick = () => {
        userSay(b.dataset.cmd);
        respond(b.dataset.cmd);
      };
    });
    return d;
  }

  // flash://settings tokens become buttons; bare https URLs become links.
  function linkify(html) {
    return String(html)
      .replace(/flash:\/\/[a-z]+/g, (m) => ` <button class="act" data-goto="${m}">${m}</button> `)
      .replace(/cmd:([a-z0-9 ]+)/gi, (m, c) => ` <button class="act" data-cmd="${c.trim()}">${c.trim()}</button> `);
  }

  function userSay(text) {
    push("user", U().escapeHtml(text));
    document.getElementById("chatLog").appendChild(msgEl("user", U().escapeHtml(text)));
    scrollDown();
  }

  function botSay(html, chips) {
    const log = document.getElementById("chatLog");
    const ty = document.createElement("div");
    ty.className = "chat-msg bot";
    ty.innerHTML = `<span class="ava">${I()("zap", 14)}</span><div class="bubble typing"><i></i><i></i><i></i></div>`;
    log.appendChild(ty);
    scrollDown();
    const delay = Math.min(1100, 320 + String(html).length * 4);
    setTimeout(() => {
      ty.replaceWith(msgEl("bot", html));
      push("bot", html);
      scrollDown();
      if (chips) bindChips(chips);
    }, delay);
  }

  function scrollDown() {
    const log = document.getElementById("chatLog");
    log.scrollTop = log.scrollHeight;
  }

  // Chips may be plain labels (legacy English map applies) or
  // [label, command] pairs (used for translated labels).
  function bindChips(chips) {
    const box = document.getElementById("chatChips");
    box.innerHTML = chips.map((c) => `<button>${U().escapeHtml(Array.isArray(c) ? c[0] : c)}</button>`).join("");
    box.querySelectorAll("button").forEach((b, i) => {
      b.onclick = () => {
        const item = chips[i];
        const v = Array.isArray(item) ? item[0] : item;
        if (Array.isArray(item)) {
          userSay(v);
          respond(item[1]);
          return;
        }
        // Friendly chip labels map to real commands.
        const map = {
          "Status": "status",
          "Settings": "go settings",
          "Help": "help",
          "History": "go history",
          "Bookmarks": "go bookmarks",
        };
        const cmd = map[v] || v;
        userSay(v);
        respond(cmd);
      };
    });
  }

  function transportLine() {
    const st = global.FlashTransport.getStatus();
    const s = global.FlashStore.getSettings();
    const host = (() => { try { return new URL(s.wispUrl).hostname; } catch { return s.wispUrl; } })();
    return `Engine <b>${U().escapeHtml(st.engine || "none yet")}</b> · relay <b>${U().escapeHtml(host)}</b> · pool <b>${s.poolEnabled ? "on" : "off"}</b>`;
  }

  // Last thing Bolt sent you to — so "open it" / "again" work.
  function remember(url) {
    if (url && /^https?:/i.test(url)) global.FlashStore.set("boltLast", url);
  }
  function recalled() {
    const u = global.FlashStore.get("boltLast", "");
    return u && /^https?:/i.test(u) ? u : "";
  }

  function whereAmI() {
    const t = global.FlashTabs.active();
    if (!t) return "Nowhere — no tabs open.";
    if (t.view === "internal") return `On internal page <b>${U().escapeHtml(t.title)}</b>.`;
    return `On <b>${U().escapeHtml(t.title || t.url)}</b><br>${U().escapeHtml(t.url)}`;
  }

  // Ask the active page for an outline (headings + first paragraphs).
  function pageOutline() {
    return new Promise((resolve) => {
      const t = global.FlashTabs.active();
      const f = t && t.view === "web" ? document.getElementById("frame-" + t.id) : null;
      if (!f) { resolve(null); return; }
      const id = "ol" + Date.now();
      const to = setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, 5000);
      const onMsg = (e) => {
        const m = e.data;
        if (m && m.__flash === 1 && m.type === "text-result" && m.data && m.data.id === id) {
          clearTimeout(to);
          window.removeEventListener("message", onMsg);
          resolve(m.data);
        }
      };
      window.addEventListener("message", onMsg);
      try {
        f.contentWindow.postMessage({ __flash: 2, tab: t.id, type: "text-extract", id }, "*");
      } catch {
        clearTimeout(to);
        window.removeEventListener("message", onMsg);
        resolve(null);
      }
    });
  }

  function respond(raw) {
    const text = raw.trim();
    const low = text.toLowerCase();
    let m;

    if (/^(hi|hey|hello|yo|sup)\b/.test(low)) {
      return botSay("Hey! Ask me to open or search something, jump to a page, or check the tunnel. “help” lists everything.", ["Status", "Open example.com", "Help"]);
    }
    if (low.includes("help") || low.includes("what can you") || low === "commands" || low === "?") {
      return botSay(
        "Here's my whole trick list:<br>• Ask me <b>anything</b> — online AI answers when connected, offline brain when not<br>• <b>open &lt;url&gt;</b> · <b>search &lt;words&gt;</b> · <b>watch &lt;videos&gt;</b> · <b>calc 2+2</b> · <b>open it</b><br>• <b>go settings | history | bookmarks | watch | home | about</b> · <b>where am i</b><br>• <b>outline</b> — headings + opening of this page<br>• <b>tab 2</b> · <b>close others</b> · <b>new tab</b> · <b>close tab</b><br>• <b>status</b> · <b>engine auto | epoxy | libcurl</b> · <b>relay wss://…</b><br>• <b>theme &lt;name&gt;</b> · <b>bookmark</b> · <b>fav</b> · <b>tabs</b> · <b>shortcuts</b><br>• <b>reload</b> · <b>back</b> · <b>forward</b> · <b>mute</b> · <b>again</b><br>• <b>time</b> · <b>joke</b> · <b>version</b> · <b>clear chat | history | cookies</b><br>Star = bookmark (bar + manager). Pin = favorite (new-tab tile).<br>Try: flash://settings",
        ["Status", "Open example.com", "Settings"]
      );
    }
    if ((m = /^(?:open|go to|visit|browse)\s+(.+)/i.exec(text))) {
      const target = m[1].trim();
      // flash:// pages go directly; everything else is normalized (URL or search).
      const isFlash = /^flash:\/\//i.test(target);
      botSay(`On it — opening <b>${U().escapeHtml(target)}</b>.`, ["Status", "History", "Help"]);
      if (!isFlash) remember(target.startsWith("http") ? target : "https://" + target);
      setTimeout(() => global.FlashApp.navigate(isFlash ? target : target), 450);
      return;
    }
    if ((m = /^(?:search|google|look up|find)\s+(.+)/i.exec(text))) {
      const q = m[1].trim();
      const s = global.FlashStore.getSettings();
      const eng = (global.FlashConfig.SEARCH_ENGINES[s.searchEngine] || global.FlashConfig.SEARCH_ENGINES.brave).url.replace("%s", encodeURIComponent(q));
      botSay(`Searching for <b>${U().escapeHtml(q)}</b>.`, ["Status", "History", "Help"]);
      setTimeout(() => global.FlashApp.navigate(eng), 450);
      return;
    }
    if (/^go\s+customizer|^open\s+customizer|custom build|customize flash|patcher/.test(low)) {
      return botSay("Custom builds live in <b>patcher.html</b> — open that file (next to the app), pick features, download your build. It's separate so it works even on a fresh copy.");
    }
    if ((m = /^go\s+(settings|history|bookmarks?|watch|home|new\s*tab|about)/i.exec(text))) {
      const dest = { settings: "flash://settings", history: "flash://history", bookmarks: "flash://bookmarks", bookmark: "flash://bookmarks", watch: "flash://watch", home: "flash://newtab", "new tab": "flash://newtab", "newtab": "flash://newtab", about: "flash://about" }[m[1].toLowerCase()];
      botSay(`Taking you to <b>${U().escapeHtml(m[1])}</b>.`);
      setTimeout(() => global.FlashApp.navigate(dest), 400);
      return;
    }
    if (/status|transport|engine status|wisp|tunnel|connection/.test(low) && !/^engine\s/.test(low) && !/^relay\s/.test(low)) {
      return botSay("Tunnel report — " + transportLine() + ".<br>Open flash://settings to switch engine or benchmark relays.", ["Settings", "Open example.com", "Help"]);
    }
    if ((m = /^engine\s+(auto|epoxy|libcurl|curl)/i.exec(text))) {
      const v = m[1].toLowerCase() === "curl" ? "libcurl" : m[1].toLowerCase();
      global.FlashStore.saveSettings({ transport: v });
      return botSay(`Engine set to <b>${v}</b>. It applies on your next navigation.`, ["Status", "Open example.com"]);
    }
    if (/^clear(\s+(chat|conversation))?$/.test(low)) {
      save([]);
      document.getElementById("chatLog").innerHTML = "";
      return botSay("Chat cleared. Fresh slate.");
    }
    if (/^clear\s+history/.test(low)) {
      global.FlashHistory.clear();
      return botSay("Browsing history wiped.", ["History", "Help"]);
    }
    if (/^clear\s+cookies/.test(low)) {
      global.FlashCookies.clear();
      return botSay("Saved site cookies wiped. You'll be logged out everywhere.", ["Help"]);
    }
    // Tiny offline calculator. Strict whitelist — digits and operators only.
    if ((m = /^(?:calc|calculate|math)\s+(.+)/i.exec(text)) || (m = /^what is\s+([0-9][0-9+\-*/().\s%^]*)$/i.exec(text))) {
      const expr = m[1].trim();
      if (!/^[0-9+\-*/().\s%^]*$/.test(expr) || /\/\s*0(?![0-9.])/.test(expr)) {
        return botSay("I only do plain arithmetic — digits and <b>+ − * / % ^ ( )</b>.");
      }
      try {
        const val = Function('"use strict";return(' + expr.replace(/\^/g, "**") + ")")();
        if (typeof val !== "number" || !isFinite(val)) throw new Error("nope");
        return botSay(`<b>${U().escapeHtml(expr)}</b> = <b>${Math.round(val * 1e10) / 1e10}</b>`);
      } catch {
        return botSay("Couldn't evaluate that. Try something like <b>calc (12 + 8) * 3</b>.");
      }
    }
    // Browser driving.
    if (/^new\s*tab$/.test(low)) {
      global.FlashTabs.create("flash://newtab");
      return botSay("Fresh tab opened.");
    }
    if (/^close\s*tab$/.test(low)) {
      const t = global.FlashTabs.active();
      if (t) global.FlashTabs.close(t.id);
      return botSay("Tab closed.");
    }
    if (/^(tabs|list tabs)$/.test(low)) {
      const all = global.FlashTabs.all();
      const t = global.FlashTabs.active();
      return botSay(all.length
        ? "Open tabs:<br>" + all.map((x, i) => `${x.id === (t && t.id) ? "● " : "○ "}<b>${U().escapeHtml((x.title || x.url).slice(0, 42))}</b>`).join("<br>")
        : "No tabs open — which shouldn't be possible. Impressive.");
    }
    if (/^(reload|refresh)$/.test(low)) {
      global.FlashApp.reload();
      return botSay("Reloading the current tab.");
    }
    if (/^back$/.test(low)) { global.FlashApp.goBack(); return botSay("Went back."); }
    if (/^forward$/.test(low)) { global.FlashApp.goForward(); return botSay("Went forward."); }
    if (/^(mute|unmute)$/.test(low)) {
      global.FlashTabs.toggleMute();
      const t = global.FlashTabs.active();
      return botSay(t && t.muted ? "Tab muted." : "Tab unmuted.");
    }
    if (/^bookmark( this( page)?)?$/.test(low)) {
      const t = global.FlashTabs.active();
      if (t && t.url && !t.url.startsWith("flash://")) {
        global.FlashBookmarks.add(t.url, t.title);
        global.FlashTabs.updateChrome();
        return botSay(`Bookmarked <b>${U().escapeHtml(t.title || t.url)}</b>.`, ["Bookmarks"]);
      }
      return botSay("Open a web page first, then I'll pin it.");
    }
    if (/^bookmarks$/.test(low)) {
      const n = global.FlashBookmarks.all().length;
      return botSay(n ? `You have <b>${n}</b> bookmark${n === 1 ? "" : "s"}. Opening the manager…` : "No bookmarks yet — star a page in the address bar.");
    }
    if (/^history$/.test(low)) {
      if (!global.FlashStore.getSettings().historyEnabled) {
        return botSay("History is off — private by default. Turn it on in flash://settings under Privacy.", ["Settings"]);
      }
      const n = global.FlashHistory.all().length;
      if (!n) return botSay("History is empty. Go touch grass — I mean, browse.");
      setTimeout(() => global.FlashApp.navigate("flash://history"), 400);
      return botSay(`<b>${n}</b> entries. Opening history…`);
    }
    if (/^(shortcuts?|keys|hotkeys)$/.test(low)) {
      const rows = global.FlashSettings.loadShortcuts().map((s) => `<b>${U().escapeHtml(s.keys)}</b> — ${U().escapeHtml(s.label || s.action)}`).join("<br>");
      return botSay("Keyboard shortcuts:<br>" + rows + "<br>Rebind them in flash://settings");
    }
    if (/^theme\s+list$/.test(low)) {
      const names = Object.entries(global.FlashConfig.THEMES).map(([id, th]) => id === global.FlashStore.getSettings().theme ? `<b>${th.name}</b> (current)` : th.name).join(" · ");
      return botSay("Themes: " + names + "<br>Say <b>theme &lt;name&gt;</b> to switch.");
    }
    if ((m = /^theme\s+([a-z]+)/i.exec(text))) {
      const want = m[1].toLowerCase();
      const hit = Object.keys(global.FlashConfig.THEMES).find((id) => id === want || global.FlashConfig.THEMES[id].name.toLowerCase() === want);
      if (!hit) return botSay(`No theme called “${U().escapeHtml(m[1])}”. Say <b>theme list</b>.`);
      global.FlashStore.saveSettings({ theme: hit });
      global.FlashSettings.applyAppearance();
      return botSay(`Theme set to <b>${global.FlashConfig.THEMES[hit].name}</b>.`);
    }
    if ((m = /^relay\s+(wss?:\/\/\S+)/i.exec(text))) {
      global.FlashStore.saveSettings({ wispUrl: m[1] });
      return botSay(`Relay set to <b>${U().escapeHtml(m[1])}</b>. Applies on your next navigation.`, ["Status"]);
    }
    if (/^(version|build|about flash)$/.test(low)) {
      const b = global.FlashBuild || { n: 0, state: "" };
      const at = b.at ? ` · ${b.at}` : "";
      return botSay(`Flash <b>v${global.FlashConfig.VERSION}</b> · build <b>#${b.n} ${U().escapeHtml(b.state || "")}</b>${U().escapeHtml(at)} · single file, no service workers. Full tour: flash://about`);
    }
    if (/privacy|shields|protection|adblock|tracking/.test(low)) {
      const s = global.FlashStore.getSettings();
      return botSay(`Shields: adblock <b>${s.adblockEnabled ? "on" : "off"}</b> · cosmetic <b>${s.cosmeticFiltering ? "on" : "off"}</b> · WebRTC guard <b>${s.blockWebRTC ? "on" : "off"}</b> · cookies isolated per site. Tune it all in flash://settings`, ["Settings"]);
    }
    if (/reset|start over|wipe/.test(low)) {
      return botSay("Reset lives in flash://settings under Danger zone — it asks for confirmation first, because some mistakes shouldn't be one-liners.");
    }
    if (/^(fav|favorite|favourite|pin)( this)?$/.test(low)) {
      const t = global.FlashTabs.active();
      if (t && t.url && !t.url.startsWith("flash://")) {
        const had = global.FlashFavorites.has(t.url);
        global.FlashFavorites.toggle(t.url, t.title);
        return botSay(had ? "Unpinned from your new tab." : `Pinned <b>${U().escapeHtml(t.title || t.url)}</b> to your new tab.`, ["Help"]);
      }
      return botSay("Open a web page first, then I'll pin it to your new tab.");
    }
    if (/^(favorites|favourites|pins)$/.test(low)) {
      const n = global.FlashFavorites.all().length;
      return botSay(n ? `You have <b>${n}</b> favorite${n === 1 ? "" : "s"} on your new tab. Manage them from any bookmark card's pin button.` : "No favorites yet — pin pages from flash://bookmarks and they'll show on every new tab.");
    }
    if (/\btime\b/.test(low)) {
      return botSay("It's <b>" + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + "</b>.", ["Status", "Help"]);
    }
    if (/\b(date|today|day)\b/.test(low)) {
      return botSay("Today is <b>" + new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + "</b>.");
    }
    if (/joke|funny|make me laugh/.test(low)) {
      const j = JOKES[jokeIdx % JOKES.length];
      jokeIdx += 1;
      return botSay(U().escapeHtml(j), ["Help"]);
    }
    if (/what('s| is) your name|^your name$|what are you called|your nickname/.test(low)) {
      return botSay("My name is <b>Bolt</b>.", ["Help", "Status"]);
    }
    if (/who are you|about you|are you (ai|real)|ai\b/.test(low)) {
      return botSay("I'm the <b>AI Assistant</b> built into FlashNext — online AI when you're connected, on-device brain when you're not. No account, no key, chat stays in this browser.", ["Help", "Status"]);
    }
    if (/thank|thx|nice|cool|awesome|great/.test(low)) {
      return botSay("Anytime. I live in the sidebar if you need a shortcut with opinions.", ["Open example.com", "Status"]);
    }
    if (/^(where am i|current( page| tab)?|this page|what tab( am i on)?)$/.test(low)) {
      const t = global.FlashTabs.active();
      if (t && t.url && !t.url.startsWith("flash://")) remember(t.url);
      return botSay(whereAmI(), ["Status", "Help"]);
    }
    if (/^(open it|go there|take me there|that one)$/.test(low)) {
      const u = recalled();
      if (!u) return botSay("I don't have anything remembered yet — tell me a URL first.");
      botSay(`Back to <b>${U().escapeHtml(u)}</b>.`);
      setTimeout(() => global.FlashApp.navigate(u), 400);
      return;
    }
    if (/^(again|retry|reload it|try again)$/.test(low)) {
      global.FlashApp.reload();
      return botSay("Reloading.");
    }
    if (/^(outline|summary|summarize|summarise|tldr|tl;dr|what is this (page )?about|describe this page)$/.test(low)) {
      pageOutline().then((o) => {
        if (!o || ((!o.heads || !o.heads.length) && (!o.paras || !o.paras.length))) {
          botSay("Couldn't read this page — it may still be loading, or it's not a proxied article page. Try again in a few seconds.");
          return;
        }
        let html = `<b>${U().escapeHtml(o.title || "Page outline")}</b>`;
        for (const h of (o.heads || []).slice(0, 8)) html += `<br>• ${U().escapeHtml(h.text)}`;
        for (const p of (o.paras || []).slice(0, 2)) html += `<br><br>${U().escapeHtml(p)}`;
        botSay(html + "<br><br><span style=\"opacity:.65\">Outline only — I'm a script, not a reader. Full text lives on the page.</span>");
      });
      return;
    }
    if ((m = /^(?:go to |switch to |open )?tab (\d+)$/.exec(low))) {
      const all = global.FlashTabs.all();
      const t = all[+m[1] - 1];
      if (!t) return botSay(`There's no tab ${m[1]} — ${all.length} open.`);
      global.FlashTabs.setActive(t.id);
      return botSay(`Switched to <b>${U().escapeHtml(t.title || t.url)}</b>.`);
    }
    if (/^close others|close other tabs$/.test(low)) {
      const keep = global.FlashTabs.active();
      for (const t of global.FlashTabs.all()) {
        if (keep && t.id !== keep.id) global.FlashTabs.close(t.id);
      }
      return botSay("Closed everything else.");
    }
    if (/^(bye|goodbye|see you)/.test(low)) {
      return botSay("Powering down my three brain cells. Ping me with the sparkles button anytime.");
    }
    if ((m = /^(?:watch|play video|youtube)\s+(.+)/i.exec(text))) {
      const q = m[1].trim();
      if (/^(it|that|this)$/i.test(q) && recalled()) {
        setTimeout(() => global.FlashApp.navigate(recalled()), 400);
        return botSay(`Playing <b>${U().escapeHtml(recalled())}</b>.`);
      }
      try {
        global.FlashStore.set("watchQ", q);
      } catch {}
      botSay(`Searching videos for <b>${U().escapeHtml(q)}</b>.`);
      setTimeout(() => global.FlashApp.navigate("flash://watch"), 400);
      return;
    }
    if (/wallpaper|theme|backdrop/.test(low)) {
      return botSay("New tab backdrops live in flash://settings under Appearance — paste any image URL there.", ["Settings"]);
    }
    if (/^(flash|proxy|how.*work|what is)/.test(low)) {
      return botSay("Flash fetches pages through a WISP tunnel with TLS inside WASM, rewrites them, and renders them sandboxed — one HTML file, zero service workers. Full tour: flash://about", ["Status", "Help"]);
    }
    // Looks like a bare URL? Just open it — friendliest interpretation.
    if (/^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(text) || /^https?:\/\//i.test(text)) {
      botSay(`Opening <b>${U().escapeHtml(text)}</b>.`, ["Status", "History"]);
      setTimeout(() => global.FlashApp.navigate(text), 450);
      return;
    }
    // Open-ended question: free keyless online AI when allowed + connected,
    // otherwise the honest offline brain. Never blocks commands above.
    askOnline(text);
  }

  // Plain offline fallback: no mention of services, connections, or modes —
  // the assistant just answers as its offline self.
  function offlineUnknown(text) {
    return botSay(
      `“${U().escapeHtml(text.slice(0, 60))}” isn't something I can do — try “help”, “open …”, “search …”, or “status”.`,
      ["Help", "Status", "Open example.com"]
    );
  }

  // Free, keyless text API (no account). Prompt is sent as the path; page
  // context is prepended when the toggle is on. 15s cap, then offline.
  async function askOnline(text) {
    let onlineOk = true;
    try {
      const s = global.FlashStore.getSettings();
      onlineOk = s.aiOnline !== false && navigator.onLine;
      var ctxOn = s.aiContext !== false;
    } catch { var ctxOn = true; }
    if (!onlineOk) {
      return offlineUnknown(text);
    }
    const log = document.getElementById("chatLog");
    const ty = document.createElement("div");
    ty.className = "chat-msg bot";
    ty.innerHTML = `<span class="ava">${I()("zap", 14)}</span><div class="bubble typing"><i></i><i></i><i></i></div>`;
    log.appendChild(ty);
    scrollDown();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    try {
      let prompt = text.slice(0, 1000);
      if (ctxOn) {
        const o = await pageOutline();
        if (o && ((o.heads && o.heads.length) || (o.paras && o.paras.length))) {
          const ctx = "Page: " + (o.title || "") + ". " +
            (o.heads || []).slice(0, 5).map((h) => h.text).join(" | ").slice(0, 400);
          prompt = ctx + "\n\nQuestion: " + prompt;
        }
      }
      const sys = "You are the AI Assistant inside the FlashNext browser. Be concise, plain-text, no markdown tables. ";
      const r = await fetch("https://text.pollinations.ai/" + encodeURIComponent(sys + prompt), { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const ans = (await r.text()).trim().slice(0, 3000) || "(empty answer)";
      ty.replaceWith(msgEl("bot", U().escapeHtml(ans)));
      push("bot", U().escapeHtml(ans));
      scrollDown();
    } catch {
      clearTimeout(to);
      ty.remove();
      // Service failed silently (HTTP 500, blocked, offline): fall back to
      // the offline brain with no announcement.
      offlineUnknown(text);
    }
  }

  global.FlashAssistant = { init, respond };
})(window);

/* Flash — history.js + bookmarks.js */
(function (global) {
  "use strict";

  function featsOff() {
    try {
      return global.FLASH_FEATURES || {};
    } catch {
      return {};
    }
  }

  const History = {
    push(url, title) {
      if (!url || url.startsWith("flash://")) return;
      if (featsOff().history === false) return;
      if (!global.FlashStore.getSettings().historyEnabled) return;
      const list = global.FlashStore.get("history", []);
      list.unshift({ url, title: title || url, t: Date.now() });
      global.FlashStore.set("history", list.slice(0, 200));
      renderHistory();
      refreshPages();
    },
    all() { return global.FlashStore.get("history", []); },
    clear() { global.FlashStore.set("history", []); renderHistory(); refreshPages(); },
    removeAt(i) {
      const list = History.all();
      list.splice(i, 1);
      global.FlashStore.set("history", list);
      renderHistory();
      refreshPages();
    },
  };

  // Re-render open internal pages so they never go stale after mutations.
  function refreshPages() {
    try {
      if (global.FlashInternal) global.FlashInternal.refreshIfActive(["history", "newtab", "bookmarks"]);
    } catch {}
  }

  // Favorites: the newtab speed-dial. Separate from bookmarks on purpose —
  // starring pins to the bar/manager, pinning puts a tile on a new tab.
  const Favorites = {
    all() { return global.FlashStore.get("favorites", []); },
    has(url) { return Favorites.all().some((b) => b.url === url); },
    add(url, title) {
      const list = Favorites.all();
      if (list.some((b) => b.url === url)) return;
      list.push({ url, title: title || url, t: Date.now() });
      global.FlashStore.set("favorites", list.slice(0, 24));
      refreshPages();
    },
    remove(url) {
      global.FlashStore.set("favorites", Favorites.all().filter((b) => b.url !== url));
      refreshPages();
    },
    toggle(url, title) {
      if (Favorites.has(url)) Favorites.remove(url);
      else Favorites.add(url, title);
    },
    // One-time migration so existing users don't wake up to an empty newtab.
    seedIfEmpty() {
      if (global.FlashStore.get("favSeeded", false)) return;
      global.FlashStore.set("favSeeded", true);
      if (Favorites.all().length) return;
      const from = Bookmarks.all().slice(0, 7);
      if (from.length) global.FlashStore.set("favorites", from);
    },
  };

  function renderHistory() {
    const el = document.getElementById("historyList");
    if (!el) return;
    const list = History.all();
    el.innerHTML = list.length
      ? list.slice(0, 80).map((h, i) =>
          `<div class="hist-row" data-i="${i}"><span class="hist-t">${global.FlashUtil.escapeHtml(h.title || h.url)}</span><span class="hist-u">${global.FlashUtil.escapeHtml(h.url.slice(0, 80))}</span></div>`
        ).join("")
      : `<div class="empty">No history yet.</div>`;
    el.querySelectorAll(".hist-row").forEach((row) => {
      row.onclick = () => {
        const h = History.all()[+row.dataset.i];
        if (h) global.FlashApp.navigate(h.url);
      };
    });
  }

  const Bookmarks = {
    all() { return global.FlashStore.get("bookmarks", []); },
    add(url, title) {
      const list = Bookmarks.all();
      if (list.some((b) => b.url === url)) return;
      list.push({ url, title: title || url, t: Date.now() });
      global.FlashStore.set("bookmarks", list);
      renderBookmarks();
      refreshPages();
    },
    remove(url) {
      global.FlashStore.set("bookmarks", Bookmarks.all().filter((b) => b.url !== url));
      renderBookmarks();
      refreshPages();
    },
    toggle(url, title) {
      if (Bookmarks.all().some((b) => b.url === url)) Bookmarks.remove(url);
      else Bookmarks.add(url, title);
      renderBookmarks();
    },
  };

  function favicon(url) {
    // No external favicon service (would leak). Use letter fallback.
    const h = global.FlashUtil.hostOf(url);
    return (h || "?")[0].toUpperCase();
  }

  function renderBookmarks() {
    const bar = document.getElementById("bookmarkBar");
    if (!bar) return;
    if (featsOff().bookmarks === false) {
      bar.style.display = "none";
      bar.innerHTML = "";
      return;
    }
    const s = global.FlashStore.getSettings();
    const show = s.bookmarksBar || s.showBookmarksBar;
    if (!show) {
      // Actually hides: no row, no padding, no layout reservation.
      bar.style.display = "none";
      bar.innerHTML = "";
      return;
    }
    bar.style.display = "";
    const list = Bookmarks.all();
    const collapsed = !!global.FlashStore.get("bmCollapsed", false);
    bar.classList.toggle("collapsed", collapsed);
    bar.innerHTML =
      `<button class="bm bm-add" id="bmAdd" title="Bookmark this page"><i data-icon="plus" data-size="13"></i> Add Bookmark</button>` +
      (list.length
        ? list.map((b) =>
            `<button class="bm" data-url="${global.FlashUtil.escapeHtml(b.url)}" title="${global.FlashUtil.escapeHtml(b.url)}"><span class="bm-f">${favicon(b.url)}</span> ${global.FlashUtil.escapeHtml((b.title || b.url).slice(0, 24))}</button>`
          ).join("")
        : `<span class="bm-empty">No bookmarks yet — star a page to pin it here</span>`) +
      `<button class="ibtn" id="bmCollapse" title="${collapsed ? "Expand" : "Collapse"}"><i data-icon="${collapsed ? "chevDown" : "chevUp"}" data-size="15"></i></button>`;
    document.getElementById("bmAdd").onclick = () => {
      const t = global.FlashTabs.active();
      if (t && t.url && !t.url.startsWith("flash://")) Bookmarks.add(t.url, t.title);
    };
    document.getElementById("bmCollapse").onclick = () => {
      global.FlashStore.set("bmCollapsed", !global.FlashStore.get("bmCollapsed", false));
      renderBookmarks();
    };
    bar.querySelectorAll(".bm[data-url]").forEach((b) => {
      b.onclick = (e) => {
        if (e.altKey) { Bookmarks.remove(b.dataset.url); return; } // alt-click removes
        global.FlashApp.navigate(b.dataset.url);
      };
      b.oncontextmenu = (e) => { e.preventDefault(); Bookmarks.remove(b.dataset.url); };
    });
    global.FlashIcons.apply(bar);
    renderNewtabFavs();
  }

  function renderNewtabFavs() {
    const el = document.getElementById("ntFavs");
    if (!el) return;
    const list = Bookmarks.all().slice(0, 8);
    el.innerHTML = list.length
      ? list.map((b) => `<button class="fav" data-url="${global.FlashUtil.escapeHtml(b.url)}"><span class="fav-f">${favicon(b.url)}</span><span>${global.FlashUtil.escapeHtml((b.title || b.url).slice(0, 20))}</span></button>`).join("")
      : `<div class="empty">Bookmark pages to pin them here.</div>`;
    el.querySelectorAll(".fav").forEach((f) => {
      f.onclick = () => global.FlashApp.navigate(f.dataset.url);
    });
  }

  global.FlashHistory = History;
  global.FlashBookmarks = Bookmarks;
  global.FlashFavorites = Favorites;
  global.FlashChrome = { renderHistory, renderBookmarks };
})(window);

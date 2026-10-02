/* Flash — yt.js : built-in YouTube viewer.
 *
 * Approach (deliberately NOT signature-deciphering): YouTube's web player
 * obfuscates its decipher constantly, so instead we ask the player API as a
 * mobile client, which returns stream URLs that need no deciphering. Same
 * class of trick downloaders have used for years; far more stable than
 * chasing base.js. Everything rides the tunnel (libcurl default).
 *
 * Flow: extract ID -> fetch watch page (API key) -> POST youtubei player API
 * as ANDROID -> pick progressive mp4 (audio+video) -> fetch bytes ->
 * blob URL in the theater <video> (native seeking works on blobs).
 * Adaptive-only / login-walled / age-gated videos fail with an honest card.
 */
(function (global) {
  "use strict";

  const U = () => global.FlashUtil;
  const I = () => global.FlashIcons.svg;

  const ANDROID_VERSION = "19.09.37";

  function extractId(input) {
    if (!input) return "";
    const s = String(input).trim();
    let m;
    if ((m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(s))) return m[1];
    if ((m = /youtu\.be\/([A-Za-z0-9_-]{6,})/i.exec(s))) return m[1];
    if ((m = /youtube(?:-nocookie)?\.com\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/i.exec(s))) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return "";
  }

  function isYouTube(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === "youtu.be" || h.endsWith(".youtube.com") || h === "youtube.com" ||
        h.endsWith(".youtube-nocookie.com");
    } catch {
      return false;
    }
  }

  function canonical(id) {
    return "https://www.youtube.com/watch?v=" + id;
  }

  // Start-time (?t= / ?start=): "90", "1m30s", "1h2m3s".
  function parseStart(url) {
    let raw = "";
    try {
      const u = new URL(url);
      raw = u.searchParams.get("t") || u.searchParams.get("start") || "";
    } catch {
      return 0;
    }
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i.exec(raw.trim());
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
  }

  function parseApiKey(html) {
    const m = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(html);
    return m ? m[1] : "";
  }

  async function fetchText(url, body) {
    const headers = { "Content-Type": "application/json" };
    const resp = await global.FlashTransport.fetchViaTransport(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? new TextEncoder().encode(body) : undefined,
      kind: "fetch",
      pageUrl: "https://www.youtube.com/",
    });
    return new TextDecoder("utf-8", { fatal: false }).decode(resp.body);
  }

  // Same fetch, but refuses to parse non-JSON — so a dead instance's HTML
  // error page becomes "HTTP 502 (text/html): <snippet>" instead of a
  // cryptic "Unexpected token '<'".
  async function fetchJson(url, body) {
    const headers = body ? { "Content-Type": "application/json" } : {};
    const resp = await global.FlashTransport.fetchViaTransport(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? new TextEncoder().encode(body) : undefined,
      kind: "fetch",
      pageUrl: "https://www.youtube.com/",
    });
    const text = new TextDecoder("utf-8", { fatal: false }).decode(resp.body);
    const trimmed = text.trim();
    const ct = ((resp.headers["content-type"] || "").split(";")[0] || "").trim().toLowerCase();
    if (resp.status >= 400) {
      throw new Error("HTTP " + resp.status + " " + trimmed.slice(0, 120));
    }
    if (!ct.includes("json") && !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      throw new Error("HTTP " + resp.status + " non-JSON (" + (ct || "unknown type") + "): " + trimmed.slice(0, 120));
    }
    return JSON.parse(text);
  }

  function errMsg(e) {
    return String((e && e.message) || e).slice(0, 140);
  }

  // Piped pool reality (probed live): ~1 in 20 public instances answers.
  // Every instance call gets a hard timeout so one blackholed host can't
  // stall the tier — failover only works if failures are FAST.
  const PIPED_TIMEOUT_MS = 12000;
  const API_TIMEOUT_MS = 15000;

  function withTimeout(p, ms, what) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error((what || "request") + " timed out")), ms)),
    ]);
  }

  // Cached API context (the key is stable for weeks; refetch from homepage).
  async function getApiContext() {
    let saved = null;
    try {
      saved = global.FlashStore.get("ytKey", null);
    } catch (e) {}
    if (saved && saved.key && Date.now() - (saved.t || 0) < 7 * 24 * 3600 * 1000) return saved;
    const html = await withTimeout(fetchText("https://www.youtube.com/?hl=en"), API_TIMEOUT_MS, "homepage");
    const m = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(html);
    if (!m) throw new Error("no api key (homepage blocked?)");
    saved = { key: m[1], t: Date.now() };
    try {
      global.FlashStore.set("ytKey", saved);
    } catch (e) {}
    return saved;
  }

  function parseDuration(s) {
    const parts = String(s || "").trim().split(":").map((x) => parseInt(x, 10));
    if (!parts.length || parts.some(isNaN)) return 0;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return sec;
  }

  // Official search API as a WEB client — no Piped needed, verified live.
  async function youtubeiSearch(q) {
    const { key } = await getApiContext();
    const body = JSON.stringify({
      context: { client: { hl: "en", gl: "US", clientName: "WEB", clientVersion: "2.20250101.00.00" } },
      query: q,
    });
    const d = await withTimeout(fetchJson(
      "https://www.youtube.com/youtubei/v1/search?key=" + encodeURIComponent(key) + "&prettyPrint=false",
      body
    ), API_TIMEOUT_MS, "search");
    const out = [];
    const walk = (o) => {
      if (!o || out.length >= 24) return;
      if (Array.isArray(o)) {
        for (const v of o) walk(v);
        return;
      }
      if (typeof o !== "object") return;
      if (o.videoRenderer && typeof o.videoRenderer.videoId === "string") {
        const vr = o.videoRenderer;
        const runs = (x) => ((x || {}).runs || []).map((r) => r.text || "").join("");
        const thumbs = ((vr.thumbnail || {}).thumbnails) || [];
        out.push({
          id: vr.videoId,
          title: runs(vr.title) || "Untitled",
          author: runs(vr.ownerText) || runs(vr.longBylineText),
          duration: parseDuration(((vr.lengthText || {}).simpleText) || ""),
          thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
        });
        return;
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(d);
    if (!out.length) throw new Error("no results");
    return out;
  }

  async function resolve(id) {
    let firstErr = null;
    // Phase 1: official player API as ANDROID (plain stream URLs).
    try {
      return await resolveYoutubei(id);
    } catch (e) {
      firstErr = e;
    }
    // Phase 2: Piped fallback (separate video+audio, synced in the theater).
    const s = global.FlashStore.getSettings();
    if (s.pipedEnabled) {
      try {
        return await resolvePiped(id, s.pipedInstances);
      } catch (e2) {
        throw new Error(String((firstErr && firstErr.message) || firstErr || "").slice(0, 120) +
          " + piped: " + String((e2 && e2.message) || e2).slice(0, 120));
      }
    }
    throw firstErr;
  }

  async function resolveYoutubei(id) {
    // API key is cached for a week and every call is timed — no hangs.
    const { key } = await getApiContext();
    // 2) player API as ANDROID -> plain stream URLs, no deciphering.
    const payload = JSON.stringify({
      videoId: id,
      racyCheckOk: true,
      contentCheckOk: true,
      context: {
        client: {
          hl: "en", gl: "US",
          clientName: "ANDROID",
          clientVersion: ANDROID_VERSION,
          androidSdkVersion: 30,
        },
      },
    });
    const pr = await withTimeout(fetchJson(
      "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(key) + "&prettyPrint=false",
      payload
    ), API_TIMEOUT_MS, "player");
    const status = pr.playabilityStatus && pr.playabilityStatus.status;
    if (status && status !== "OK") {
      const reason = (pr.playabilityStatus.reason || status || "unplayable").toString().slice(0, 160);
      throw new Error(reason + (status === "LOGIN_REQUIRED" ? " (login-walled)" : ""));
    }
    const sd = pr.streamingData || {};
    const vd = pr.videoDetails || {};
    const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
    const all = (sd.formats || []).concat(sd.adaptiveFormats || []);
  // Progressive mp4 only (audio+video in one file). Detected via the codecs
  // list (mp4a/opus/…) or the audio track fields — adaptive video-only would
  // play silent, so it is listed nowhere. Honest error instead. 
  function isProgressive(f) {
    if (!f || typeof f.url !== "string" || !/^https?:/i.test(f.url)) return false;
    const mt = String(f.mimeType || "");
    if (!mt.startsWith("video/mp4")) return false;
    if (f.audioChannels != null) return true;
    const m = /codecs="([^"]*)"/.exec(mt);
    if (m && /(mp4a|opus|ec-3|ac-3|vorbis|alac|flac)/i.test(m[1])) return true;
    if (/audio/i.test(String(f.audioQuality || ""))) return true;
    return false;
  }
  const prog = all.filter(isProgressive).map((f) => {
      const qm = /(\d{3,4})p/.exec(String(f.qualityLabel || f.quality || ""));
      const h = parseInt((f.size || "").split("x")[1] || f.height || (qm && qm[1]) || 0, 10) || 0;
      return {
        itag: f.itag,
        label: f.qualityLabel || f.quality || (h ? h + "p" : "video"),
        height: h,
        url: f.url,
        bytes: parseInt(f.contentLength || "0", 10) || 0,
      };
    }).sort((a, b) => b.height - a.height);
    if (!prog.length) {
      const hasAny = all.some((f) => f && typeof f.url === "string");
      throw new Error(hasAny
        ? "only silent/adaptive streams here — no playable file"
        : "no streams returned (age-gate, region block, or removed video)");
    }
    return {
      id,
      title: vd.title || ("YouTube video " + id),
      author: vd.author || "",
      duration: cleanDur(parseInt(vd.lengthSeconds || "0", 10)),
      thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
      formats: prog,
      source: "youtube",
    };
  }

  // Piped fallback: public API instances return separate video-only and
  // audio-only streams. The theater plays them as a synced pair.
  async function resolvePiped(id, instances) {
    const list = (instances && instances.length ? instances : []).map((s) => String(s).trim().replace(/\/+$/, "")).filter(Boolean);
    if (!list.length) throw new Error("no piped instances configured");
    let lastErr = null;
    for (const inst of list) {
      try {
        const d = await withTimeout(
          fetchJson("https://" + inst + "/streams/" + encodeURIComponent(id)),
          PIPED_TIMEOUT_MS, inst
        );
        const videos = (d.videoStreams || []).filter((v) =>
          v && typeof v.url === "string" && /^https?:/i.test(v.url) && v.videoOnly !== false &&
          /mp4|avc1|mp4v/i.test(String(v.codec || "") + String(v.mimeType || "")));
        const audios = (d.audioStreams || []).filter((a) =>
          a && typeof a.url === "string" && /^https?:/i.test(a.url));
        if (!videos.length || !audios.length) throw new Error("empty streams");
        audios.sort((a, b) => {
          const am = /m4a|mp4a/i.test(String(a.codec || "")) ? 0 : 1;
          const bm = /m4a|mp4a/i.test(String(b.codec || "")) ? 0 : 1;
          return am - bm || ((b.bitrate || 0) - (a.bitrate || 0));
        });
        const audio = audios[0];
        const formats = videos.map((v) => {
          const qm = /(\d{3,4})p/.exec(String(v.quality || ""));
          const h = parseInt(qm && qm[1], 10) || 0;
          return {
            itag: "piped-" + (v.quality || h || "sd"),
            label: (v.quality || (h ? h + "p" : "video")) + " + audio",
            height: h,
            url: v.url,
            bytes: 0,
            audioUrl: audio.url,
          };
        }).sort((a, b) => b.height - a.height);
        if (!formats.length) throw new Error("empty streams");
        return {
          id,
          title: d.title || ("YouTube video " + id),
          author: d.uploader || "",
          duration: cleanDur(d.duration),
          thumb: d.thumbnailUrl || "",
          formats,
          source: "piped via " + inst,
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("all piped instances failed (" + String((lastErr && lastErr.message) || lastErr).slice(0, 100) + ")");
  }

  // Durations: Piped uses -1/0 for unknown/live; garbage in → 0 (hidden), never -1:-1:-1.
  function cleanDur(v) {
    const n = Math.floor(+v);
    return n > 0 ? n : 0;
  }

  function fmtDur(sec) {
    sec = cleanDur(sec);
    if (!sec) return "";
    const m = Math.floor(sec / 60), s = sec % 60;
    const h = Math.floor(m / 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m % 60)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(n < 104857600 ? 1 : 0) + " MB";
  }

  // ── Piped browse APIs (search + trending), tried across instances ──
  function pipedHosts() {
    let list = [];
    try {
      const s = global.FlashStore.getSettings();
      list = (s.pipedEnabled && s.pipedInstances && s.pipedInstances.length
        ? s.pipedInstances
        : (global.FlashConfig.DEFAULT_SETTINGS.pipedInstances || [])).slice();
    } catch {
      list = (global.FlashConfig.DEFAULT_SETTINGS.pipedInstances || []).slice();
    }
    return list.map((h) => String(h).trim().replace(/\/+$/, "")).filter(Boolean);
  }

  async function pipedGet(path) {
    const hosts = pipedHosts();
    if (!hosts.length) throw new Error("no piped instances configured (Settings → Video)");
    let lastErr = null;
    for (const h of hosts) {
      try {
        const data = await withTimeout(fetchJson("https://" + h + path), PIPED_TIMEOUT_MS, h);
        return { host: h, data };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("all piped instances failed (" + errMsg(lastErr) + ")");
  }

  function normalizeItems(d) {
    const raw = Array.isArray(d) ? d : (d && d.items) || [];
    const out = [];
    for (const it of raw) {
      if (!it) continue;
      let u = String(it.url || "");
      // Piped returns site-relative paths (/watch?v=, /shorts/).
      if (u.startsWith("/")) u = "https://www.youtube.com" + u;
      const id = extractId(u);
      if (!id) continue;
      out.push({
        id,
        title: it.title || it.name || "Untitled",
        author: it.uploaderName || it.uploader || "",
        duration: cleanDur(it.duration),
        thumb: it.thumbnail || "",
        views: it.views || 0,
      });
      if (out.length >= 24) break;
    }
    return out;
  }

  async function searchVideos(q) {
    let firstErr = null;
    try {
      return await youtubeiSearch(q);
    } catch (e) {
      firstErr = e;
    }
    try {
      const { data } = await pipedGet("/search?q=" + encodeURIComponent(q) + "&filter=videos");
      const items = normalizeItems(data);
      if (!items.length) throw new Error("no results");
      return items;
    } catch (e2) {
      throw new Error("search failed: " + errMsg(firstErr) + " / piped: " + errMsg(e2));
    }
  }

  async function trending(region) {
    const { data } = await pipedGet("/trending?region=" + encodeURIComponent(region || "US"));
    return normalizeItems(data);
  }

  /* ── theater (stage view owned by this module) ── */
  function stage() { return document.getElementById("stage"); }

  // Remove a tab's theater views, revoking media blob URLs to free memory.
  function dispose(tabId) {
    stage().querySelectorAll(`[data-yt="${tabId}"]`).forEach((n) => {
      try {
        n.querySelectorAll("video, audio").forEach((m) => {
          if (m.src && m.src.startsWith("blob:")) URL.revokeObjectURL(m.src);
          m.removeAttribute("src");
        });
      } catch {}
      n.remove();
    });
  }

  function viewFor(tabId) {
    return stage().querySelector(`[data-yt="${tabId}"]`);
  }

  function syncVisibility(tab) {
    const on = global.FlashTabs.active() === tab;
    stage().querySelectorAll(`[data-yt="${tab.id}"]`).forEach((n) => {
      n.style.display = on ? "" : "none";
    });
  }

  function syncAll() {
    for (const t of global.FlashTabs.all()) {
      if (t.view === "yt") syncVisibility(t);
    }
  }

  function open(tab, videoId) {
    dispose(tab.id);
    const frame = document.getElementById("frame-" + tab.id);
    if (frame) frame.style.display = "none";
    stage().querySelectorAll(`[data-iv="${tab.id}"]`).forEach((n) => { n.style.display = "none"; });

    tab.view = "yt";
    tab.internal = null;
    tab.url = canonical(videoId);

    const div = document.createElement("div");
    div.className = "iv";
    div.dataset.yt = tab.id;
    div.innerHTML = `
      <div class="pg yt-pg">
        <div class="yt-loading"><span class="mini-spinner" style="visibility:visible"></span>
          <span>Resolving streams…</span></div>
      </div>`;
    stage().appendChild(div);
    global.FlashIcons.apply(div);
    global.FlashTabs.setTitle(tab, "Loading video…");
    syncVisibility(tab);
    if (tab.id === global.FlashTabs.active().id) global.FlashTabs.updateChrome();
    load(tab, videoId, div, 0);
  }

  async function load(tab, videoId, div, attempt) {
    let meta;
    try {
      meta = await resolve(videoId);
    } catch (e) {
      if (!div.isConnected) return;
      div.querySelector(".pg").innerHTML = `
        <div class="pg-head"><span class="pg-ic">${I()("alert", 22)}</span><h2>Can't play this video</h2></div>
        <p class="pg-sub">${U().escapeHtml(String((e && e.message) || e).slice(0, 200))}</p>
        <div class="card"><div class="f-row">
          <button class="btn primary yt-retry">Retry</button>
        </div>
        <p class="hint">Some videos are login-walled, age-gated, region-blocked, or streamless for embedded clients. Retrying or another relay sometimes helps.</p></div>`;
      div.querySelector(".yt-retry").onclick = () => open(tab, videoId);
      return;
    }
    if (!div.isConnected) return;
    global.FlashTabs.setTitle(tab, meta.title);
    const quals = meta.formats.map((f, i) =>
      `<button class="btn small yt-q${i === 0 ? " primary" : ""}" data-i="${i}">${U().escapeHtml(f.label)}${f.bytes ? ` · ${fmtBytes(f.bytes)}` : ""}</button>`
    ).join("");
    div.querySelector(".pg").innerHTML = `
      <div class="yt-head">
        ${meta.thumb ? `<img class="yt-thumb" data-tsrc="${U().escapeHtml(meta.thumb)}" alt="">` : ""}
        <div class="yt-meta">
          <h2>${U().escapeHtml(meta.title)}</h2>
          <div class="hint">${U().escapeHtml(meta.author)}${meta.duration ? ` · ${fmtDur(meta.duration)}` : ""}${meta.source && meta.source !== "youtube" ? ` · via ${U().escapeHtml(meta.source)}` : ""}</div>
        </div>
      </div>
      <div class="yt-quals">${quals}</div>
      <div class="yt-status"><span class="mini-spinner" style="visibility:visible"></span><span>Fetching video…</span></div>
      <video class="yt-player" controls playsinline hidden></video>`;
    const thumbEl = div.querySelector(".yt-thumb");
    if (thumbEl) {
      // Thumbnails ride the tunnel too — never a raw pixel.
      global.FlashTransport.fetchViaTransport(meta.thumb, { kind: "image", pageUrl: canonical(meta.id) })
        .then((r) => {
          if (!div.isConnected) return;
          const ct = ((r.headers["content-type"] || "").split(";")[0] || "").trim().toLowerCase();
          if (!r.body || !r.body.length || r.body.length > 500000) return;
          if (ct && !ct.startsWith("image/")) return;
          thumbEl.src = URL.createObjectURL(new Blob([r.body], { type: ct || "image/jpeg" }));
        })
        .catch(() => {});
    }
    const video = div.querySelector(".yt-player");
    const status = div.querySelector(".yt-status");
    const buttons = Array.from(div.querySelectorAll(".yt-q"));
    const fail = (msg) => {
      status.innerHTML = `<span style="color:var(--err-t)">Failed: ${U().escapeHtml(msg)}</span> <button class="btn small yt-retry2">Retry</button>`;
      status.querySelector(".yt-retry2").onclick = () => load(tab, videoId, div, 0);
    };
    buttons.forEach((b) => {
      b.onclick = () => {
        buttons.forEach((x) => x.classList.remove("primary"));
        b.classList.add("primary");
        play(tab, meta, +b.dataset.i, div, video, status, fail);
      };
    });
    play(tab, meta, 0, div, video, status, fail);
  }

  // Dual-element playback for Piped-style video-only + audio pairs. The hidden
  // <audio> mirrors play/pause/seek/rate of the <video>. Torn down on switch.
  function dubFor(div) {
    let au = div.querySelector("audio.yt-dub");
    if (!au) {
      au = document.createElement("audio");
      au.className = "yt-dub";
      au.preload = "auto";
      au.style.display = "none";
      div.appendChild(au);
    }
    return au;
  }

  function dropDub(div) {
    const au = div.querySelector("audio.yt-dub");
    if (au) {
      try { au.pause(); } catch {}
      try { if (au.src && au.src.startsWith("blob:")) URL.revokeObjectURL(au.src); } catch {}
      au.removeAttribute("src");
      au.remove();
    }
  }

  async function play(tab, meta, i, div, video, status, fail) {
    const f = meta.formats[i];
    if (!f) return;
    const myUrl = tab.url;
    status.innerHTML = `<span class="mini-spinner" style="visibility:visible"></span><span>Fetching ${U().escapeHtml(f.label)}${f.bytes ? ` (${fmtBytes(f.bytes)})` : ""}…</span>`;
    try {
      URL.revokeObjectURL(video.src || "");
    } catch {}
    dropDub(div);
    const fresh = () => tab.url === myUrl && div.isConnected;
    try {
      const jobs = [
        global.FlashTransport.fetchViaTransport(f.url, { kind: "fetch", pageUrl: canonical(meta.id) }),
      ];
      if (f.audioUrl) {
        jobs.push(global.FlashTransport.fetchViaTransport(f.audioUrl, { kind: "fetch", pageUrl: canonical(meta.id) }));
      }
      const [vresp, aresp] = await Promise.all(jobs);
      if (!fresh()) return;
      const blob = new Blob([vresp.body], { type: "video/mp4" });
      video.src = URL.createObjectURL(blob);
      video.hidden = false;
      if (tab._ytStart) {
        const st = tab._ytStart;
        tab._ytStart = 0;
        video.addEventListener("loadedmetadata", () => {
          try {
            const d = video.duration || 0;
            if (d > 1) video.currentTime = Math.min(st, d - 1);
          } catch {}
        }, { once: true });
      }
      if (f.audioUrl && aresp && aresp.body && aresp.body.length) {
        const au = dubFor(div);
        try { URL.revokeObjectURL(au.src || ""); } catch {}
        au.src = URL.createObjectURL(new Blob([aresp.body], { type: "audio/mp4" }));
        au.playbackRate = video.playbackRate || 1;
        video.onplay = () => { try { au.currentTime = video.currentTime; au.play(); } catch {} };
        video.onpause = () => { try { au.pause(); } catch {} };
        video.onseeked = () => { try { au.currentTime = video.currentTime; } catch {} };
        video.onratechange = () => { try { au.playbackRate = video.playbackRate; } catch {} };
        video.onended = () => { try { au.pause(); } catch {} };
      } else {
        video.onplay = video.onpause = video.onseeked = video.onratechange = video.onended = null;
      }
      status.innerHTML = `<span class="hint">${U().escapeHtml(f.label)} · proxied, seekable${f.audioUrl ? " · synced audio" : ""}</span>`;
      try { await video.play(); } catch {}
    } catch (e) {
      if (!fresh()) return;
      fail(String((e && e.message) || e).slice(0, 160));
    }
  }

  global.FlashYT = { open, dispose, syncAll, isYouTube, extractId, canonical, parseStart, resolve, fmtDur, searchVideos, trending };
})(window);

/* Flash — adblock.js : host blocklist + cosmetic hiding rules. */
(function (global) {
  "use strict";

  // Host blocklist: requests to these never leave the tunnel. Tracker and ad
  // infrastructure only — never content sites, CDNs, or login providers.
  // The page keeps working; only the ad/tracker calls die (the cosmetic list
  // below then removes the empty shells they leave behind).
  const DEFAULT_HOSTS = [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "googletagmanager.com", "googletagservices.com", "adservice.google.com",
    "2mdn.net", "google-analytics.com", "analytics.google.com",
    "ads.yahoo.com", "advertising.com",
    "amazon-adsystem.com", "aax.amazon-adsystem.com",
    "taboola.com", "outbrain.com", "criteo.com", "moatads.com",
    "revcontent.com", "mgid.com", "mgidcdn.com", "media.net",
    "zedo.com", "pubmatic.com", "rubiconproject.com", "openx.net",
    "adsrvr.org", "adnxs.com", "mathtag.com", "bluekai.com",
    "adform.net", "adform.com", "casalemedia.com", "indexww.com",
    "bidswitch.net", "smartadserver.com", "triplelift.com",
    "sharethrough.com", "sovrn.com", "lijit.com", "spotxchange.com",
    "gumgum.com", "nativo.com", "conversantmedia.com",
    "adblade.com", "bidvertiser.com",
    "propellerads.com", "adcash.com", "exoclick.com", "adsterra.com",
    "popads.net", "popcash.net", "hilltopads.net", "clickadu.com",
    "admaven.com", "juicyads.com", "trafficjunky.net", "plugrush.com",
    "awempire.com", "yllix.com", "adsupply.com",
    "adcolony.com", "inmobi.com", "smaato.com", "smaato.net",
    "applovin.com", "unityads.unity3d.com", "chartboost.com",
    "vungle.com", "ironsource.com", "tapjoy.com", "fyber.com",
    "loopme.me", "ogury.io",
    "doubleverify.com", "iasds01.com",
    "anrdoezrs.net", "qksrv.net", "jdoqocy.com", "dpbolvw.net",
    "rakutenmarketing.com", "impactradius.com", "awin1.com",
    "tradedoubler.com", "webgains.com", "shareasale.com",
    "skimlinks.com", "viglink.com", "clickbank.net",
    "pardot.com", "eloqua.com",
    "scorecardresearch.com", "quantserve.com", "exelator.com",
    "hotjar.com", "fullstory.com", "mouseflow.com",
    "crazyegg.com", "luckyorange.com", "inspectlet.com",
    "contentsquare.net", "optimizely.com", "vwo.com",
    "newrelic.com", "nr-data.net", "segment.com", "segment.io",
    "mixpanel.com", "amplitude.com", "app-measurement.com",
    "appsflyer.com", "adjust.com", "mc.yandex.ru",
    "cloudflareinsights.com",
    "facebook.net", "connect.facebook.net", "analytics.twitter.com",
    "static.ads-twitter.com", "ads.linkedin.com", "px.ads.linkedin.com",
    "ct.pinterest.com",
    "analytics.tiktok.com",
    "bat.bing.com", "clarity.ms",
  ];

  // Cosmetic hiding rules: collapse the empty shells trackers leave behind.
  // Covers GPT slots, Taboola/Outbrain/MGID/Revcontent widgets, Amazon,
  // Fandom's rail + leaderboard slots, sticky/floating units, and labeled
  // "Advertisement" containers via :has() (all modern browsers support it).
  const COSMETIC_SELECTORS = [
    // Google Publisher Tags + AdSense
    ".ad", ".ads", ".advert", ".advertisement", ".sponsored", ".advertorial",
    "[id^='div-gpt-ad']", "[id^='google_ads']", "[id*='google_ad']",
    "[class*='google-ad']", ".gpt-ad", ".ad-slot", ".adslot", ".adsbygoogle",
    ".ad-container", ".ad-wrapper", ".ad-unit", ".ad-placeholder",
    ".ads-container", ".ads-wrapper", ".ad-placement",
    // Taboola / Outbrain / MGID / Revcontent / content-rec
    "[class*='taboola']", "[id*='taboola']", "[class*='outbrain']",
    "[id*='outbrain']", "[class*='mgid']", "[id*='mgid']",
    "[class*='revcontent']", "[id*='revcontent']", "[class*='rc-widget']",
    "[class*='trc_']", "[id*='trc_']", ".ob-widget", ".ob-widget-section",
    // Amazon + Media.net + misc networks
    "[id*='amzn-native']", "[class*='amzn-native']", ".media-net",
    "[class*='medianet']", "[class*='mads-']", "[id*='mads-']",
    // Fandom / Wikia specifics
    ".top-ads", ".bottom-ads", "#top_leaderboard", "#bottom_leaderboard",
    ".is-gap", ".gpt-label", ".ad-label", "#WikiaArticleBottomAd",
    ".WikiaTopAds", ".wikia-ad", "#rail .ad", ".right-rail-ad",
    // Sticky / floating / interstitial / takeover units
    ".sticky-ad", ".sticky-ads", ".floating-ad", ".anchor-ad",
    ".interstitial", ".interstitial-ad", ".takeover", ".prestitial",
    ".overlay-ad", ".popup-ad", ".slide-in-ad", ".video-ad-wrapper",
    ".instream-ad", "[id*='interstitial']",
    // Labeled shells: containers whose only job is one ad slot
    "div:has(> div[id^='div-gpt-ad'])", "div:has(> ins.adsbygoogle)",
    "div:has(> [class*='taboola'])", "div:has(> [class*='outbrain'])",
    "aside:has([id^='div-gpt-ad'])", "aside:has([class*='taboola'])",
    "section:has(> div[id^='div-gpt-ad'])",
    // Cookie/consent banners that double as layout wreckers
    ".cookie-banner", "#cookie-banner", "#onetrust-banner-sdk",
    ".qc-cmp2-container", "#qc-cmp2-container",
  ];

  // Feature-flag gate (FlashNext Customizer builds): adblock off at build
  // level behaves as if the whole list were empty, regardless of settings.
  function buildOff() {
    try {
      return global.FLASH_FEATURES && global.FLASH_FEATURES.adblock === false;
    } catch {
      return false;
    }
  }
  // Custom host rules (Settings → Privacy, one per line). Accepts plain
  // domains and EasyList-style `||domain^` patterns. Parsed on every check;
  // lists are small so this stays cheap.
  function customHosts() {
    let raw = "";
    try {
      raw = global.FlashStore.getSettings().customHosts || "";
    } catch {
      return [];
    }
    const out = [];
    for (let line of String(raw).split("\n")) {
      line = line.trim().toLowerCase();
      if (!line || line[0] === "!" || line[0] === "#") continue;
      line = line.replace(/^\|\|/, "").replace(/^\|/, "").replace(/[\^/*]+$/, "").replace(/^\.+/, "");
      if (line && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(line)) out.push(line);
    }
    return out;
  }

  function hostBlocked(host) {
    if (!host) return false;
    for (const h of DEFAULT_HOSTS) {
      if (host === h || host.endsWith("." + h)) return true;
    }
    for (const h of customHosts()) {
      if (host === h || host.endsWith("." + h)) return true;
    }
    return false;
  }

  // Block counters: per-page (resets on navigation) + all-time persisted.
  let pageBlocked = 0;

  function totalBlocked() {
    try {
      return global.FlashStore.get("blockedTotal", 0) || 0;
    } catch {
      return 0;
    }
  }

  function noteBlocked(url) {
    pageBlocked += 1;
    try {
      global.FlashStore.set("blockedTotal", totalBlocked() + 1);
    } catch {}
  }

  function newPage() {
    pageBlocked = 0;
  }

  function stats() {
    return { page: pageBlocked, total: totalBlocked() };
  }

  function pausedHosts() {
    try {
      const raw = global.FlashStore.getSettings().pausedSites || "";
      return String(raw).split(/[\n,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    } catch {
      return [];
    }
  }

  function isPausedFor(url) {
    try {
      const host = global.FlashUtil.hostOf(url);
      if (!host) return false;
      return pausedHosts().some((h) => host === h || host.endsWith("." + h));
    } catch {
      return false;
    }
  }

  function isBlocked(url) {
    if (buildOff()) return false;
    const s = global.FlashStore.getSettings();
    if (!s.adblockEnabled) return false;
    if (isPausedFor(url)) return false;
    const host = global.FlashUtil.hostOf(url);
    return hostBlocked(host);
  }

  function cosmeticCss() {
    if (buildOff()) return "";
    const s = global.FlashStore.getSettings();
    if (!s.adblockEnabled || !s.cosmeticFiltering) return "";
    let css = COSMETIC_SELECTORS.map((x) => x + "{display:none!important;}").join("\n");
    if (s.customCosmeticRules) css += "\n" + s.customCosmeticRules;
    return css;
  }

  global.FlashAdblock = { isBlocked, isPausedFor, pausedHosts, cosmeticCss, noteBlocked, newPage, stats, DEFAULT_HOSTS };
})(window);

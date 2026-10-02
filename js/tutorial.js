/* FlashNext — tutorial.js : richer guided tour with spotlight steps.
 * Each step points at a real chrome element (glow ring + anchored card);
 * steps whose element is missing (stripped builds) are skipped silently.
 * Esc skips. Finishing (or Skip) sets tutorialDone so it never auto-launches.
 */
(function (global) {
  "use strict";

  const STEPS = [
    { sel: "#omniWrap", key: "s1" },
    { sel: "#tabStrip", key: "s2" },
    { sel: "#protectPill", key: "s3" },
    { sel: "#btnAssistant", key: "s4" },
    { sel: "#btnCode", key: "s5" },
    { sel: "#btnApps", key: "s6" },
    { sel: null, key: "s7" },
  ];

  let idx = 0;

  function t(k) {
    try {
      return global.FlashI18n.t(k);
    } catch {
      return k;
    }
  }

  function tutOff() {
    try {
      const ff = global.FLASH_FEATURES || {};
      return ff.tutorial === false || ff.showTutorial === false || ff.tutorialInclude === false;
    } catch {
      return false;
    }
  }

  function visibleSteps() {
    return STEPS.filter((s) => !s.sel || document.querySelector(s.sel));
  }

  function init() {
    const next = document.getElementById("tutNext");
    const back = document.getElementById("tutBack");
    const skip = document.getElementById("tutSkip");
    if (next) next.onclick = () => {
      const steps = visibleSteps();
      if (idx >= steps.length - 1) finish();
      else { idx += 1; draw(); }
    };
    if (back) back.onclick = () => {
      if (idx > 0) { idx -= 1; draw(); }
    };
    if (skip) skip.onclick = () => finish();
    window.addEventListener("keydown", (e) => {
      const ov = document.getElementById("tutorialOverlay");
      if (e.key === "Escape" && ov && !ov.hidden) finish();
    });
  }

  function start() {
    if (tutOff()) return;
    const steps = visibleSteps();
    if (!steps.length) return;
    idx = 0;
    const ov = document.getElementById("tutorialOverlay");
    if (!ov) return;
    ov.hidden = false;
    draw();
  }

  function finish() {
    const ov = document.getElementById("tutorialOverlay");
    if (ov) ov.hidden = true;
    const glow = document.getElementById("tutGlow");
    if (glow) glow.style.display = "none";
    try {
      global.FlashStore.saveSettings({ tutorialDone: true });
    } catch {}
  }

  function draw() {
    const steps = visibleSteps();
    const step = steps[Math.min(idx, steps.length - 1)];
    const ov = document.getElementById("tutorialOverlay");
    const card = document.getElementById("tutCard");
    const glow = document.getElementById("tutGlow");
    if (!ov || !card) return;

    const title = document.getElementById("tutTitle");
    const body = document.getElementById("tutStep");
    const dots = document.getElementById("tutDots");
    const back = document.getElementById("tutBack");
    const next = document.getElementById("tutNext");
    const skip = document.getElementById("tutSkip");
    if (title) title.textContent = t("tutWelcome");
    if (body) body.textContent = (idx + 1) + ". " + t(step.key);
    if (dots) {
      dots.innerHTML = steps.map((_, i) =>
        `<i class="${i === idx ? "on" : ""}"></i>`).join("");
    }
    if (back) {
      back.textContent = t("backB");
      back.style.visibility = idx === 0 ? "hidden" : "";
    }
    if (next) next.textContent = idx >= steps.length - 1 ? t("finish") : t("next");
    if (skip) skip.textContent = t("skip");

    // Spotlight + anchored card.
    const el = step.sel ? document.querySelector(step.sel) : null;
    if (el && glow) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      glow.style.display = "block";
      glow.style.left = Math.max(4, r.left - pad) + "px";
      glow.style.top = Math.max(4, r.top - pad) + "px";
      glow.style.width = (r.width + pad * 2) + "px";
      glow.style.height = (r.height + pad * 2) + "px";
      // Card below the target when room, else above, else centered.
      card.style.position = "fixed";
      card.style.margin = "0";
      card.style.maxWidth = "340px";
      const below = r.bottom + 12;
      const estH = 220;
      if (below + estH < innerHeight) {
        card.style.top = below + "px";
        card.style.bottom = "auto";
      } else if (r.top - estH - 12 > 0) {
        card.style.bottom = (innerHeight - r.top + 12) + "px";
        card.style.top = "auto";
      } else {
        card.style.top = "50%";
        card.style.bottom = "auto";
        card.style.transform = "translate(-50%,-50%)";
        card.style.left = "50%";
      }
      if (card.style.transform !== "translate(-50%,-50%)") {
        card.style.transform = "none";
        const cx = Math.min(Math.max(r.left, 12), innerWidth - 364);
        card.style.left = cx + "px";
      }
    } else {
      if (glow) glow.style.display = "none";
      card.style.position = "";
      card.style.transform = "";
      card.style.left = "";
      card.style.top = "";
      card.style.bottom = "";
      card.style.maxWidth = "420px";
    }
    try {
      global.FlashIcons.apply(card);
    } catch {}
  }

  global.FlashTutorial = { init, start, finish };
})(typeof window !== "undefined" ? window : globalThis);

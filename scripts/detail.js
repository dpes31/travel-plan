(() => {
  const tripId = document.body.dataset.tripId || "unknown";
  const key = `travelArchive:detail:${tripId}:v1`;
  const header = document.querySelector(".trip-appbar");
  const dayNavigation = document.querySelector(".sticky, .nav");
  const dayLinks = [...(dayNavigation?.querySelectorAll('a[href^="#"]') || [])];
  const dayTargets = dayLinks.map(link => ({
    link,
    target: document.querySelector(link.getAttribute("href"))
  })).filter(item => item.target);
  let timer;
  let navTimer;
  let isRestoring = true;
  let activeDayHref = "";

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  function currentAnchor() {
    const points = [...document.querySelectorAll("[data-restore-anchor]")];
    const offset = (header?.offsetHeight || 0) + 24;
    let current = points[0]?.id || "";
    for (const point of points) {
      if (point.getBoundingClientRect().top <= offset) current = point.id;
      else break;
    }
    return current;
  }

  function savePosition() {
    if (isRestoring) return;
    localStorage.setItem(key, JSON.stringify({
      y: Math.max(0, window.scrollY),
      anchor: currentAnchor(),
      updatedAt: Date.now()
    }));
  }

  function revealActiveDay(link) {
    if (!dayNavigation || !link) return;
    const left = link.offsetLeft - (dayNavigation.clientWidth - link.offsetWidth) / 2;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    dayNavigation.scrollTo({ left: Math.max(0, left), behavior: reducedMotion ? "auto" : "smooth" });
  }

  function setActiveDay(link, reveal = true) {
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (href === activeDayHref) return;
    activeDayHref = href;
    for (const candidate of dayLinks) {
      if (candidate === link) candidate.setAttribute("aria-current", "true");
      else candidate.removeAttribute("aria-current");
    }
    if (reveal) revealActiveDay(link);
  }

  function updateActiveDay(reveal = true) {
    if (!dayTargets.length) return;
    const fixedHeight = (header?.offsetHeight || 0) + (dayNavigation?.offsetHeight || 0);
    const marker = window.scrollY + fixedHeight + 30;
    let current = dayTargets[0];
    for (const item of dayTargets) {
      const top = item.target.getBoundingClientRect().top + window.scrollY;
      if (top <= marker) current = item;
      else break;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 8) {
      current = dayTargets[dayTargets.length - 1];
    }
    setActiveDay(current.link, reveal);
  }

  function restorePosition() {
    isRestoring = true;
    if (location.hash) {
      const target = document.querySelector(location.hash);
      if (target) {
        requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
        setTimeout(() => {
          history.replaceState(null, "", `${location.pathname}${location.search}`);
          isRestoring = false;
          savePosition();
          updateActiveDay();
        }, 260);
        return;
      }
    }
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved) { isRestoring = false; updateActiveDay(false); return; }
      const restore = () => {
        window.scrollTo({ top: Number(saved.y || 0), behavior: "auto" });
        updateActiveDay(false);
      };
      requestAnimationFrame(restore);
      setTimeout(restore, 80);
      setTimeout(() => { restore(); isRestoring = false; updateActiveDay(); }, 240);
    } catch (_) { isRestoring = false; updateActiveDay(false); }
  }

  document.addEventListener("click", event => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    if (dayLinks.includes(link)) setActiveDay(link);
    savePosition();
  }, true);
  window.addEventListener("scroll", () => {
    if (isRestoring) return;
    clearTimeout(navTimer);
    navTimer = setTimeout(updateActiveDay, 40);
    clearTimeout(timer);
    timer = setTimeout(savePosition, 90);
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePosition();
    else if (!isRestoring) restorePosition();
  });
  window.addEventListener("pagehide", savePosition);
  window.addEventListener("pageshow", event => { if (event.persisted) restorePosition(); });
  updateActiveDay(false);
  window.addEventListener("load", restorePosition, { once: true });
})();

(() => {
  const tripId = document.body.dataset.tripId || "unknown";
  const key = `travelArchive:detail:${tripId}:v1`;
  const header = document.querySelector(".trip-appbar");
  let timer;
  let isRestoring = true;

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
        }, 260);
        return;
      }
    }
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved) { isRestoring = false; return; }
      const restore = () => window.scrollTo({ top: Number(saved.y || 0), behavior: "auto" });
      requestAnimationFrame(restore);
      setTimeout(restore, 80);
      setTimeout(() => { restore(); isRestoring = false; }, 240);
    } catch (_) { isRestoring = false; }
  }

  document.addEventListener("click", event => {
    const link = event.target.closest("a[href]");
    if (!link) return;
    savePosition();
  }, true);
  window.addEventListener("scroll", () => {
    if (isRestoring) return;
    clearTimeout(timer);
    timer = setTimeout(savePosition, 90);
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePosition();
    else if (!isRestoring) restorePosition();
  });
  window.addEventListener("pagehide", savePosition);
  window.addEventListener("pageshow", event => { if (event.persisted) restorePosition(); });
  window.addEventListener("load", restorePosition, { once: true });
})();

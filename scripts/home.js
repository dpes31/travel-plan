const HOME_STATE_KEY = "travelArchive:home:v1";

const state = {
  trips: [],
  query: "",
  region: "전체",
  city: "전체"
};

const searchInput = document.querySelector("#trip-search");
const clearButton = document.querySelector("#search-clear");
const regionFilters = document.querySelector("#region-filters");
const cityFilters = document.querySelector("#city-filters");
const cityBlock = document.querySelector("#city-block");
const tripList = document.querySelector("#trip-list");
const tripCount = document.querySelector("#trip-count");
const emptyState = document.querySelector("#empty-state");
const searchContext = document.querySelector("#search-context");

function normalize(value) {
  return String(value || "").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function unique(values) {
  return [...new Set(values)];
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_STATE_KEY) || "{}");
    state.query = saved.query || "";
    state.region = saved.region || "전체";
    state.city = saved.city || "전체";
    searchInput.value = state.query;
  } catch (_) {}
}

function saveState() {
  localStorage.setItem(HOME_STATE_KEY, JSON.stringify({
    query: state.query,
    region: state.region,
    city: state.city,
    scrollY: window.scrollY
  }));
}

function restoreScroll() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_STATE_KEY) || "{}");
    const y = Number(saved.scrollY || 0);
    requestAnimationFrame(() => window.scrollTo(0, y));
  } catch (_) {}
}

function chip(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `filter-chip${active ? " active" : ""}`;
  button.textContent = label;
  button.setAttribute("aria-pressed", String(active));
  button.addEventListener("click", onClick);
  return button;
}

function renderFilters() {
  const regions = ["전체", ...unique(state.trips.map(trip => trip.region))];
  regionFilters.replaceChildren(...regions.map(region => chip(region, state.region === region, () => {
    state.region = region;
    state.city = "전체";
    render();
  })));

  const cities = unique(state.trips
    .filter(trip => state.region === "전체" || trip.region === state.region)
    .flatMap(trip => trip.cities || [trip.city]));
  cityBlock.hidden = state.region === "전체";
  cityFilters.replaceChildren(...["전체", ...cities].map(city => chip(city, state.city === city, () => {
    state.city = city;
    render();
  })));
}

function findMatch(trip, query) {
  if (!query) return null;
  const entries = Object.entries(trip.matches || {});
  const exact = entries.find(([term]) => normalize(term).includes(query) || query.includes(normalize(term)));
  return exact ? { label: exact[0], anchor: exact[1] } : null;
}

function filteredTrips() {
  const q = normalize(state.query);
  return state.trips.map(trip => {
    const haystack = normalize([
      trip.title, trip.dateLabel, trip.region, trip.city, trip.summary,
      ...(trip.keywords || [])
    ].join(" "));
    return { ...trip, match: findMatch(trip, q) };
  }).filter(trip => {
    const regionOk = state.region === "전체" || trip.region === state.region;
    const cityOk = state.city === "전체" || (trip.cities || [trip.city]).includes(state.city);
    const queryOk = !q || normalize([
      trip.title, trip.dateLabel, trip.region, trip.city, trip.summary,
      ...(trip.keywords || [])
    ].join(" ")).includes(q);
    return regionOk && cityOk && queryOk;
  }).sort((a, b) => b.dateStart.localeCompare(a.dateStart));
}

function ribbon(trip) {
  const link = document.createElement("a");
  const target = trip.match?.anchor ? `#${trip.match.anchor}` : "";
  link.className = "trip-ribbon";
  link.href = `${trip.href}${target}`;
  link.dataset.tripId = trip.id;
  link.innerHTML = `
    <span class="ribbon-accent" aria-hidden="true"></span>
    <span class="ribbon-copy">
      <span class="ribbon-meta"><span>${trip.dateLabel}</span><i></i><span>${trip.region} ${(trip.cities || [trip.city]).join("·")}</span></span>
      <h3>${trip.title}</h3>
      <p>${trip.summary}</p>
      ${trip.match ? `<span class="match-badge">‘${trip.match.label}’ 일정으로 바로 이동</span>` : ""}
    </span>
    <span class="ribbon-arrow" aria-hidden="true">›</span>`;
  link.addEventListener("click", saveState);
  return link;
}

function render() {
  renderFilters();
  const trips = filteredTrips();
  tripList.replaceChildren(...trips.map(ribbon));
  tripCount.textContent = `${trips.length}개`;
  emptyState.hidden = trips.length > 0;
  searchContext.hidden = !state.query;
  searchContext.textContent = state.query ? `‘${state.query}’ 검색 결과` : "";
  clearButton.classList.toggle("visible", Boolean(state.query));
  saveState();
}

searchInput.addEventListener("input", event => {
  state.query = event.target.value.trim();
  render();
});
clearButton.addEventListener("click", () => {
  state.query = "";
  searchInput.value = "";
  searchInput.focus();
  render();
});
window.addEventListener("scroll", () => {
  clearTimeout(window.__homeScrollTimer);
  window.__homeScrollTimer = setTimeout(saveState, 100);
}, { passive: true });
window.addEventListener("pagehide", saveState);

async function start() {
  loadState();
  const response = await fetch("/data/trips.json", { cache: "no-store" });
  if (!response.ok) throw new Error("여행계획서 목록을 불러오지 못했습니다.");
  state.trips = await response.json();
  render();
  restoreScroll();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

start().catch(error => {
  tripList.innerHTML = `<div class="empty-state"><strong>${error.message}</strong><p>새로고침 후 다시 확인해 주세요.</p></div>`;
});

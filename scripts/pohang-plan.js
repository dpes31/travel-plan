export const catalog = {};
const originals = new Map();
const routes = new Map();
const routeNames = {
  mori: "모리국수 점심", guryongpo: "문화관·역사거리", gwamegi: "과메기 수령", chohouse: "초하우스",
  stayday1: "과메기 저녁", cheongha: "청하공진시장", igari: "이가리 닻 전망대", aquabelle: "아쿠아벨 점심",
  fireworks: "국제불꽃쇼", jangsa: "장사 전승기념관", nabisan: "생대구 지리", return: "영덕 출발"
};
for (const card of document.querySelectorAll(".day-section article.stop[id]")) {
  const day = Number(card.closest(".day-section").id.slice(3));
  catalog[card.id] = { day, title: card.querySelector("h3").textContent, time: card.querySelector(".time").textContent, note: "", url: "" };
  originals.set(card.id, card.cloneNode(true));
  const route = [...card.closest(".day-section").querySelectorAll(".route-stop")]
    .find(node => node.querySelector(".route-name")?.textContent === routeNames[card.id]);
  if (route) routes.set(card.id, { node: route, label: routeNames[card.id], time: route.querySelector(".route-time").textContent });
}

export function available(items) {
  return Object.entries({ ...catalog, ...items }).filter(([, stop]) => stop);
}

export function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function mapLink(title, url) {
  const a = el("a", url ? "장소 링크" : "네이버지도", "btn primary");
  a.href = url || "https://map.naver.com/p/search/" + encodeURIComponent(title);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function updateCard(card, change, original) {
  if (original) card.replaceChildren(...[...originals.get(card.id).childNodes].map(n => n.cloneNode(true)));
  if (!change) { card.hidden = true; return; }
  card.hidden = false;
  if (!original) {
    const head = el("div", null, "stop-head");
    head.append(el("span", "", "time"));
    card.append(head, el("h3"), el("ul", "", "facts"), el("div", "", "buttons"));
  }
  card.querySelector("h3").textContent = change.title;
  card.querySelector(".time").textContent = change.time;
  const facts = card.querySelector(".facts"), buttons = card.querySelector(".buttons");
  if (!original || change.title !== original.title) {
    // Venue-specific menus and links only belong to the original venue.
    for (const node of card.children) {
      if (!node.matches(".stop-head,h3,.facts,.buttons")) node.hidden = true;
    }
    card.querySelector(".kind")?.remove();
    facts?.replaceChildren();
    if (buttons) buttons.replaceChildren(mapLink(change.title, change.url));
    else { const links = el("div", null, "buttons"); links.append(mapLink(change.title, change.url)); card.append(links); }
  } else if (change.url) {
    let links = buttons;
    if (!links) { links = el("div", null, "buttons"); card.append(links); }
    links.prepend(mapLink(change.title, change.url));
  }
  if (change.note) {
    let list = facts;
    if (!list) { list = el("ul", null, "facts"); card.querySelector("h3").after(list); }
    for (const line of change.note.split("\n").filter(Boolean)) list.append(el("li", line));
  }
}

function insertAfterAnchor(card, afterId, parent, selector) {
  let anchor = afterId && parent.querySelector(selector);
  if (!anchor) { parent.append(card); return; }
  while (anchor.nextElementSibling?.dataset.after === afterId) anchor = anchor.nextElementSibling;
  anchor.after(card);
  card.dataset.after = afterId;
}

export function renderPlan(items) {
  document.querySelectorAll("[data-room-extra]").forEach(n => n.remove());
  for (const [id, original] of Object.entries(catalog)) {
    const current = Object.hasOwn(items, id) ? items[id] : original;
    const card = document.getElementById(id);
    if (Object.hasOwn(items, id) || card.dataset.roomEdited) {
      updateCard(card, current, original);
      if (Object.hasOwn(items, id)) card.dataset.roomEdited = "1";
      else delete card.dataset.roomEdited;
    }
    const route = routes.get(id);
    if (route) {
      route.node.dataset.roomStop = id;
      route.node.toggleAttribute("data-room-hidden", !current);
      const connector = route.node.previousElementSibling;
      if (connector?.matches(".route-connector")) connector.toggleAttribute("data-room-hidden", !current);
      route.node.querySelector(".route-name").textContent = current && current.title !== original.title ? current.title : route.label;
      route.node.querySelector(".route-time").textContent = current && current.time !== original.time ? current.time : route.time;
      route.node.querySelector(".route-icon")?.setAttribute("aria-label", route.node.querySelector(".route-name").textContent);
    }
    for (const summary of document.querySelectorAll('[data-stop-summary="' + id + '"]')) {
      summary.textContent = current ? "·" + current.title : "";
    }
  }
  for (const [id, item] of Object.entries(items)) {
    if (!item || Object.hasOwn(catalog, id)) continue;
    const section = document.getElementById("day" + item.day);
    const card = el("article", null, "stop");
    card.dataset.roomExtra = ""; card.id = id;
    updateCard(card, item);
    insertAfterAnchor(card, item.afterId, section.querySelector(".day-body"), "#" + CSS.escape(item.afterId ?? ""));
    const node = el("div", null, "room-route-extra");
    node.dataset.roomExtra = "";
    node.append(el("span", item.time, "route-time"), el("span", item.title, "route-name"));
    const group = routes.get(item.afterId)?.node.closest(".route-flow");
    if (group) {
      let anchor = group;
      while (anchor.nextElementSibling?.dataset.after === item.afterId) anchor = anchor.nextElementSibling;
      node.dataset.after = item.afterId;
      anchor.after(node);
    } else section.querySelector(".route-timeline").append(node);
  }
}

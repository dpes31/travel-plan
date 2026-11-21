import { available, catalog, el, renderPlan } from "./pohang-plan.js";

const dialog = el("dialog");
dialog.id = "collab";
dialog.setAttribute("aria-labelledby", "room-title");
dialog.innerHTML = `
<header class="room-head"><button type="button" id="room-close" aria-label="닫기" autofocus>×</button>
<h2 id="room-title">포항 공동 채팅</h2><button id="history-open" type="button">이력</button></header>
<div id="room-feed" class="room-feed" role="log" aria-label="대화 기록" aria-live="polite"></div>
<p id="room-pending" class="room-note"></p>
<form id="room-compose" class="composer">
<div class="compose-row"><button type="button" id="edit-open" aria-label="일정 변경안 작성">＋</button>
<textarea rows="1" id="room-input" maxlength="2000" placeholder="메시지 입력" aria-label="메시지" required></textarea>
<button type="submit" class="send">보내기</button></div></form>
<section id="room-edit" class="room-sheet" hidden><h3>일정 변경안</h3>
<form id="draft-form">
<label>변경 유형<select id="draft-op"><option value="edit">수정</option><option value="add">추가</option><option value="remove">삭제</option></select></label>
<label>날짜<select id="draft-day"><option value="1">1일차 · 11/20</option><option value="2">2일차 · 11/21</option><option value="3">3일차 · 11/22</option></select></label>
<label id="target-label"><span>일정</span><select id="draft-target" required></select></label>
<label id="anchor-label" hidden>추가할 위치<select id="draft-anchor"></select></label>
<div id="draft-fields"><label>장소 또는 일정명<input id="draft-title" maxlength="100" required></label>
<label>시간<input id="draft-time" maxlength="80"></label>
<label>메모<textarea id="draft-note" maxlength="1200"></textarea></label>
<label>장소 링크<input id="draft-url" type="url" placeholder="https://" maxlength="1200"></label></div>
<div class="choices"><button class="confirm" type="submit">변경안 보내기</button><button type="button" data-back>대화로</button></div>
</form></section>
<section id="room-history" class="room-sheet" hidden><h3>변경 이력</h3><div id="history-list"></div><button type="button" data-back>대화로</button></section>
<p id="room-error" class="form-error" role="alert"></p>
`;
document.body.append(dialog);
const $ = id => document.getElementById(id);
const feed = $("room-feed"), input = $("room-input");
let cursor = 0, current, screen = "chat", loading, writing = false, draftBase, pendingMessage;
let timer, seenProposalState = "", historyVersion = 0;
const proposals = new Map(), knownMessages = new Map();

async function call(action, data) {
  const res = await fetch("/api/pohang-collab/?action=" + action, {
    method: data === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "채팅방에 연결할 수 없습니다.");
  return json;
}

function show(page) {
  screen = page;
  feed.hidden = $("room-compose").hidden = page !== "chat";
  $("room-pending").hidden = page !== "chat";
  $("room-edit").hidden = page !== "edit";
  $("room-history").hidden = page !== "history";
  $("history-open").hidden = page !== "chat";
  if (page === "chat") requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

function addTextLinks(node, body) {
  let end = 0;
  for (const match of body.matchAll(/https?:\/\/[^\s<>]+/g)) {
    node.append(document.createTextNode(body.slice(end, match.index)));
    const a = el("a", match[0]); a.href = match[0]; a.rel = "noopener noreferrer"; a.target = "_blank";
    node.append(a); end = match.index + match[0].length;
  }
  node.append(document.createTextNode(body.slice(end)));
}

function actionButton(text, action, data, primary = false) {
  const b = el("button", text, primary ? "confirm" : ""); b.type = "button";
  b.addEventListener("click", () => save(b, action, data));
  return b;
}

function proposalCard(p) {
  const a = el("div", null, "proposal"), place = p.after ?? p.before;
  const stale = p.status === "제안" && p.base !== current.version;
  const label = { edit: "수정", add: "추가", remove: "삭제" }[p.op];
  a.append(el("h3", place.day + "일차 · 일정 " + label));
  if (p.before && (!p.after || p.before.title !== p.after.title)) {
    const line = el("p"); line.append(el("del", p.before.title)); a.append(line);
  }
  if (p.after) a.append(el("p", p.after.title));
  for (const [key, name] of [["time","시간"],["note","메모"],["url","장소 링크"]]) {
    const before = p.before?.[key] ?? "", after = p.after?.[key] ?? "";
    if (before === after || !p.after) continue;
    const line = el("p", name + " · ");
    if (before) line.append(el("del", before), document.createTextNode(" → "));
    addTextLinks(line, after || "삭제"); a.append(line);
  }
  if (p.reason) a.append(el("p", p.reason));
  if (p.status === "제안") {
    const buttons = el("div", null, "choices");
    if (!stale) buttons.append(actionButton("일정에 반영", "approve", { id: p.id }, true));
    else a.append(el("p", "다른 변경이 먼저 반영됐습니다.", "room-note"));
    buttons.append(actionButton("거절", "reject", { id: p.id })); a.append(buttons);
  } else a.append(el("p", p.status === "승인" ? "계획서에 반영됨" : "거절됨", "room-note"));
  return a;
}

function addRow(m) {
  const row = el("article", null, "chat-row " + (m.mine ? "mine" : m.role));
  const byline = el("div", m.mine ? "나" : m.name, "byline");
  if (m.at) {
    const date = new Date(m.at), t = el("time", date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
    t.dateTime = date.toISOString(); byline.append(t);
  }
  row.append(byline);
  if (m.kind === "proposal" && proposals.has(m.proposalId)) {
    row.dataset.proposal = String(m.proposalId); row.append(proposalCard(proposals.get(m.proposalId)));
  } else {
    const bubble = el("p", null, "bubble"); addTextLinks(bubble, m.body ?? ""); row.append(bubble);
  }
  feed.append(row);
}

function render(state) {
  const scrollToLast = !cursor || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  if (!current || current.version !== state.version) renderPlan(state.items);
  current = state;
  for (const p of state.proposals) proposals.set(p.id, p);
  const signature = JSON.stringify([state.version, state.proposals.map(p => [p.id, p.status])]);
  if (signature !== seenProposalState) {
    for (const row of feed.querySelectorAll("[data-proposal]")) {
      row.lastElementChild.replaceWith(proposalCard(proposals.get(Number(row.dataset.proposal))));
    }
    seenProposalState = signature;
  }
  for (const m of state.messages) {
    if (knownMessages.has(m.id)) continue;
    knownMessages.set(m.id, m); addRow(m); cursor = m.id;
  }
  const msgs = [...knownMessages.values()];
  const answered = new Set(msgs.filter(m => m.role === "ai" && m.replyTo).map(m => m.replyTo));
  for (const p of state.proposals) if (p.source) answered.add(p.source);
  const waiting = msgs.some(m => !m.kind && m.role !== "ai" && !answered.has(m.id));
  $("room-pending").textContent = waiting ? "AI 답변 대기" : "";
  if (state.version !== historyVersion) {
    historyVersion = state.version;
    const list = $("history-list"); list.replaceChildren();
    for (const r of state.revisions) {
      const row = el("div", null, "history-row");
      row.append(el("p", "버전 " + r.version + " · " + r.action), el("p", r.label));
      if (r.version !== state.version) row.append(actionButton("이 일정으로 복원", "restore", { version: r.version, base: state.version }));
      list.append(row);
    }
  }
  if (scrollToLast && state.messages.length) feed.scrollTop = feed.scrollHeight;
}

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    let more;
    do {
      const state = await call("state&since=" + cursor);
      render(state); more = state.more;
    } while (more);
    if ($("room-error").dataset.connection) {
      $("room-error").textContent = ""; delete $("room-error").dataset.connection;
    }
    return true;
  })().catch(() => {
    if (!writing && !$("room-error").textContent) {
      $("room-error").dataset.connection = "1"; $("room-error").textContent = "연결을 다시 시도하고 있습니다.";
    }
    return false;
  }).finally(() => { loading = null; });
  return loading;
}

async function save(button, action, data, done = () => {}) {
  if (writing) return;
  writing = true; button.disabled = true; $("room-error").textContent = "";
  delete $("room-error").dataset.connection;
  try {
    if (!current && !await refresh()) throw new Error("채팅방을 연결한 뒤 다시 보내 주세요.");
    await call(action, data);
    done();
    if (loading) await loading;
    await refresh();
    if (dialog.open && screen === "chat") feed.scrollTop = feed.scrollHeight;
  } catch (err) { $("room-error").textContent = err.message; await refresh(); }
  finally { writing = false; button.disabled = false; }
}

$("room-compose").addEventListener("submit", e => {
  e.preventDefault();
  const body = input.value.trim();
  if (!body) return;
  if (pendingMessage?.body !== body) pendingMessage = { body, request_id: crypto.randomUUID() };
  save(e.submitter, "messages", pendingMessage, () => {
    if (input.value.trim() === body) { input.value = ""; input.style.height = ""; }
    pendingMessage = null;
  });
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight + 2, 120) + "px"; });
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && matchMedia("(pointer:fine)").matches) {
    e.preventDefault(); $("room-compose").requestSubmit($("room-compose").querySelector(".send"));
  }
});
const op = $("draft-op"), day = $("draft-day"), target = $("draft-target"), anchor = $("draft-anchor");
let draftRequest;
function fillFields() {
  const stop = op.value === "add" ? {} : (current.items[target.value] ?? catalog[target.value] ?? {});
  for (const field of ["title", "time", "note", "url"]) $("draft-" + field).value = stop[field] ?? "";
}
function setOptions() {
  const choices = available(current.items).filter(([, s]) => s.day === Number(day.value));
  target.replaceChildren(...choices.map(([id, s]) => new Option(s.title, id)));
  anchor.replaceChildren(new Option("하루 일정 맨 끝", ""), ...choices.filter(([id]) => Object.hasOwn(catalog, id)).map(([id, s]) => new Option(s.title + " 다음", id)));
  const adding = op.value === "add", removing = op.value === "remove";
  $("anchor-label").hidden = !adding; $("target-label").hidden = adding; target.disabled = adding;
  $("draft-fields").hidden = removing; $("draft-title").disabled = removing; fillFields();
}
$("edit-open").onclick = async () => {
  if (!current && !await refresh()) return;
  draftBase = current.version; draftRequest = null;
  op.value = "edit"; setOptions(); show("edit");
};
op.onchange = day.onchange = setOptions; target.onchange = fillFields;
$("draft-form").onsubmit = e => {
  e.preventDefault();
  const after = { day: Number(day.value) };
  for (const field of ["title","time","note","url"]) after[field] = $("draft-" + field).value.trim();
  if (op.value === "add" && anchor.value) after.afterId = anchor.value;
  const data = { op: op.value, base: draftBase, target: target.value, after };
  const signature = JSON.stringify(data);
  if (draftRequest?.signature !== signature) draftRequest = { signature, key: crypto.randomUUID() };
  save(e.submitter, "proposals", { ...data, request_id: draftRequest.key }, () => show("chat"));
};
$("history-open").onclick = () => show("history");
dialog.querySelectorAll("[data-back]").forEach(b => { b.onclick = () => show("chat"); });
$("room-close").onclick = () => dialog.close();
$("collab-open").onclick = () => { dialog.showModal(); show("chat"); refresh(); schedule(); };
dialog.addEventListener("close", () => { schedule(); $("collab-open").focus({ preventScroll: true }); });
function schedule() {
  clearInterval(timer);
  if (!document.hidden) timer = setInterval(refresh, dialog.open ? 3000 : 20000);
}
document.addEventListener("visibilitychange", () => { schedule(); if (!document.hidden) refresh(); });
window.addEventListener("pagehide", () => clearInterval(timer));
window.addEventListener("pageshow", () => { schedule(); refresh(); });
refresh(); schedule();

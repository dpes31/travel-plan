import { stops } from "./pohang-stops.js";

export class Rejected extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function field(data, name, limit, optional = false) {
  const value = data[name] ?? "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.trim().length > limit) {
    throw new Rejected(400, "입력 내용을 확인해 주세요.");
  }
  return value.trim();
}

function baseStop(id) {
  return Object.hasOwn(stops, id) ? { ...stops[id], note: "", url: "" } : null;
}

function stopAt(items, id) {
  return Object.hasOwn(items, id) ? items[id] : baseStop(id);
}

function legacyItems(title) {
  const original = baseStop("aquabelle");
  return title && title !== original.title ? { aquabelle: { ...original, title } } : {};
}

export function migrate(previous = {}) {
  const plan = previous.itinerary ?? { version: 1, title: stops.aquabelle.title };
  const messages = (previous.messages ?? []).map(m => ({
    ...m, sender: m.role, name: m.role === "ai" ? "포항 기획 AI" : (m.role === "owner" ? "동행 1" : "동행 2"),
    replyTo: m.role === "ai" && /^room-reply-\d+$/.test(m.request_id) ? Number(m.request_id.slice(11)) : null
  }));
  const revisions = (previous.revisions ?? [{ version: 1, title: stops.aquabelle.title, action: "처음 일정" }])
    .map(r => ({ version: r.version, action: r.action, label: r.title, actor: r.actor, items: legacyItems(r.title) }));
  const proposals = (previous.proposals ?? []).map(p => ({
    ...p, target: "aquabelle", op: "edit", before: { ...baseStop("aquabelle"), title: p.before },
    after: { ...baseStop("aquabelle"), title: p.after }
  }));
  for (const p of [...proposals].reverse()) {
    messages.push({ id: (messages.at(-1)?.id ?? 0) + 1, kind: "proposal", proposalId: p.id,
      sender: p.source ? "ai" : "owner", name: p.source ? "포항 기획 AI" : "동행 1" });
  }
  return { version: plan.version, items: legacyItems(plan.title), members: { owner: "동행 1", partner: "동행 2" },
    messages, proposals, revisions };
}

const actorName = (room, sender) => sender === "ai" ? "포항 기획 AI" :
  (room.members[sender] ??= "동행 " + (Object.keys(room.members).length + 1));

export function view(room, sender, since) {
  const rows = room.messages.filter(m => m.id > since);
  const messages = rows.slice(0, 100).map(({ sender: author, request_id, ...m }) => ({
    ...m, role: author === "ai" ? "ai" : "traveler", mine: author === sender
  }));
  return {
    version: room.version, items: room.items, messages, more: rows.length > messages.length,
    proposals: room.proposals.map(({ sender: author, request_id, ...p }) => p), revisions: room.revisions.map(({ items, ...r }) => r),
    ...(sender === "ai" ? { stops, context: [
      "포항·영덕 가족여행 11/20–22. 구룡포 모리국수·이선옥 과메기, 영덕 초하우스, 화진 슬로우오션.",
      "2일차 청하공진시장·이가리·아쿠아벨 점심·죽도시장 홍게·20시 영일대 불꽃쇼. 3일차 영덕.",
      "확정된 일정은 사람이 승인한 변경안으로 수정. 실제 결정 기록이 없는 이유는 단정하지 않음."
    ] } : {})
  };
}

function addMessage(room, sender, fields) {
  const id = (room.messages.at(-1)?.id ?? 0) + 1;
  room.messages.push({ id, sender, name: actorName(room, sender), at: Date.now(), ...fields });
  return id;
}

function participantMessage(room, id) {
  if (!Number.isSafeInteger(id) || !room.messages.some(m => m.id === id && m.sender !== "ai" && !m.kind)) {
    throw new Rejected(400, "답장할 메시지를 찾을 수 없습니다.");
  }
  return id;
}

function makeStop(input, previous, room) {
  const title = field(input, "title", 100);
  const time = field(input, "time", 80, true);
  const note = field(input, "note", 1200, true);
  const url = field(input, "url", 1200, true);
  if (url && !URL.canParse(url)) throw new Rejected(400, "장소 링크를 확인해 주세요.");
  if (url && new URL(url).protocol !== "https:") throw new Rejected(400, "https 장소 링크를 입력해 주세요.");
  const day = previous?.day ?? input.day;
  if (![1, 2, 3].includes(day)) throw new Rejected(400, "여행 날짜를 선택해 주세요.");
  const afterId = previous ? previous.afterId : input.afterId;
  if (!previous && afterId && (!Object.hasOwn(stops, afterId) || !stopAt(room.items, afterId) || stops[afterId].day !== day)) {
    throw new Rejected(409, "배치할 위치를 다시 선택해 주세요.");
  }
  return { day, title, time, note, url, ...(afterId ? { afterId } : {}) };
}

function proposal(room, sender, input) {
  const key = field(input, "request_id", 100);
  const prior = room.proposals.find(p => p.sender === sender && p.request_id === key);
  const source = sender === "ai" ? participantMessage(room, input.source) : null;
  const op = input.op;
  const id = (room.proposals[0]?.id ?? 0) + 1;
  const target = op === "add" ? (prior?.target ?? "extra-" + id) : field(input, "target", 60);
  const before = prior ? prior.before : stopAt(room.items, target);
  if (!["edit", "add", "remove"].includes(op) || (op !== "add" && !before)) {
    throw new Rejected(400, "변경할 일정을 선택해 주세요.");
  }
  const after = op === "remove" ? null : makeStop(input.after ?? {}, before, room);
  const reason = field(input, "reason", 500, true);
  if (prior) {
    if (prior.base !== input.base || prior.op !== op || prior.target !== target ||
        JSON.stringify(prior.after) !== JSON.stringify(after) || prior.reason !== reason || prior.source !== source) {
      throw new Rejected(409, "요청 번호가 이미 사용됐습니다.");
    }
    return { id: prior.id, duplicate: true };
  }
  if (room.version !== input.base) throw new Rejected(409, "다른 동행이 일정을 바꿨습니다. 최신 일정을 확인해 주세요.");
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Rejected(400, "바뀐 내용이 없습니다.");
  room.proposals.unshift({ id, op, target, before, after, source, reason, sender, request_id: key, base: room.version, status: "제안" });
  addMessage(room, sender, { kind: "proposal", proposalId: id });
  return { id };
}

function revise(room, sender, items, label, action) {
  room.items = items;
  room.version += 1;
  room.revisions.unshift({ version: room.version, actor: actorName(room, sender), label, action, items });
  return { version: room.version };
}

export function apply(room, sender, action, data) {
  if (action === "messages") {
    const key = field(data, "request_id", 100);
    const body = field(data, "body", 2000);
    const implied = sender === "ai" && /^room-reply-\d+$/.test(key) ? Number(key.slice(11)) : null;
    const replyTo = sender === "ai" && (data.replyTo ?? implied) != null
      ? participantMessage(room, data.replyTo ?? implied) : null;
    const old = room.messages.find(m => m.sender === sender && m.request_id === key);
    if (old) {
      if (body !== old.body || replyTo !== (old.replyTo ?? null)) throw new Rejected(409, "요청 번호가 이미 사용됐습니다.");
      return { id: old.id, duplicate: true };
    }
    return { id: addMessage(room, sender, { body, request_id: key, replyTo }) };
  }
  if (action === "proposals") return proposal(room, sender, data);
  if (sender === "ai") throw new Rejected(403, "일정 반영은 동행이 결정합니다.");
  if (action === "restore") {
    const revision = room.revisions.find(r => r.version === data.version);
    if (!revision || data.base !== room.version || data.version === room.version) {
      throw new Rejected(409, "복원할 버전을 다시 선택해 주세요.");
    }
    const result = revise(room, sender, { ...revision.items }, "버전 " + data.version, "복원");
    addMessage(room, sender, { kind: "event", body: "버전 " + data.version + " 일정으로 복원" });
    return result;
  }
  const p = room.proposals.find(p => p.id === data.id);
  if (!p || p.status !== "제안") throw new Rejected(409, "이미 처리된 변경안입니다.");
  if (action === "reject") { p.status = "거절"; return { id: p.id }; }
  if (action !== "approve" || p.base !== room.version) throw new Rejected(409, "최신 일정에서 다시 제안해 주세요.");
  p.status = "승인";
  return revise(room, sender, { ...room.items, [p.target]: p.after }, (p.after ?? p.before).title,
    { edit: "수정", add: "추가", remove: "삭제" }[p.op]);
}

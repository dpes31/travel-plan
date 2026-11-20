import { createHash, timingSafeEqual } from "node:crypto";

const baseline = "아쿠아벨식당";
const actions = new Set(["join", "state", "messages", "proposals", "approve", "reject", "restore"]);
const actors = { owner: "관리자", partner: "참가자 B", ai: "포항 기획 AI" };
const context = [
  "2일차 11:45 점심. 청하공진시장과 이가리닻전망대 방문 후 식사.",
  "아쿠아벨식당 일정은 방석항 미역 어우동과 감태김밥. 계획서 기록상 11시 개점.",
  "16:30 죽도시장 홍게와 20:00 영일대 국제불꽃쇼 유지.",
  "후보 선정 근거와 영업 정보는 확인된 기록 범위에서만 답변."
];
const cookieName = "__Host-pohang-preview";

class Rejected extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function string(input, key, max) {
  const value = typeof input[key] === "string" ? input[key].trim() : "";
  if (!value || value.length > max) throw new Rejected(400, "입력 내용을 확인해 주세요.");
  return value;
}

function positive(input, key) {
  if (!Number.isSafeInteger(input[key]) || input[key] < 1) {
    throw new Rejected(400, "버전 또는 요청 번호를 확인해 주세요.");
  }
  return input[key];
}

function json(value, status = 200, cookie) {
  const headers = {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(value), { status, headers });
}

function initialState() {
  return {
    itinerary: { title: baseline, version: 1 },
    messages: [],
    proposals: [],
    revisions: [{ version: 1, title: baseline, action: "초기 일정", actor: "시스템" }]
  };
}

function identify(credential, hashes, allowed) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(credential)) return undefined;
  const hash = createHash("sha256").update(credential).digest();
  return allowed.find(role => /^[0-9a-f]{64}$/.test(hashes[role] ?? "") &&
    timingSafeEqual(hash, Buffer.from(hashes[role], "hex")));
}

async function payload(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    throw new Rejected(415, "JSON 요청이 필요합니다.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 16000) throw new Rejected(413, "요청 크기가 초과됐습니다.");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Rejected(400, "요청 형식을 확인해 주세요.");
  }
}

function visibleState(state, role, since) {
  return {
    role, name: actors[role], itinerary: state.itinerary,
    messages: state.messages.filter(message => message.id > since).slice(0, 100)
      .map(({ request_id, ...message }) => message),
    proposals: state.proposals,
    revisions: state.revisions,
    ...(role === "ai" ? { context } : {})
  };
}

function appendRevision(state, title, action, source) {
  const version = state.itinerary.version + 1;
  state.itinerary = { title, version };
  state.revisions.unshift({ version, title, action, actor: actors.owner, source });
  return { version };
}

function apply(state, role, action, input) {
  const { messages, proposals, itinerary } = state;
  if (action === "messages") {
    const request_id = string(input, "request_id", 100);
    const body = string(input, "body", 2000);
    const old = messages.find(message => message.role === role && message.request_id === request_id);
    if (old) {
      if (old.body !== body) throw new Rejected(409, "요청 번호가 이미 사용됐습니다.");
      return { result: { id: old.id }, duplicate: true };
    }
    const id = (messages.at(-1)?.id ?? 0) + 1;
    messages.push({ id, role, name: actors[role], body, request_id });
    return { result: { id } };
  }
  if (action === "proposals") {
    const base = positive(input, "base");
    const after = string(input, "after", 80);
    const reason = string(input, "reason", 1000);
    const source = role === "ai" ? positive(input, "source") : null;
    if (source !== null) {
      if (!messages.some(message => message.id === source && message.role !== "ai")) {
        throw new Rejected(400, "참가자의 요청 메시지를 지정해 주세요.");
      }
      const old = proposals.find(proposal => proposal.source === source);
      if (old) {
        if (old.base !== base || old.after !== after || old.reason !== reason) {
          throw new Rejected(409, "이 요청의 변경안이 이미 등록됐습니다.");
        }
        return { result: { id: old.id }, duplicate: true };
      }
    }
    if (base !== itinerary.version || after === itinerary.title) {
      throw new Rejected(409, "최신 일정을 기준으로 변경안을 제안해 주세요.");
    }
    const id = (proposals[0]?.id ?? 0) + 1;
    proposals.unshift({ id, base, before: itinerary.title, after, reason, status: "제안", source });
    return { result: { id } };
  }
  if (role !== "owner") throw new Rejected(403, "관리자만 승인·거절·복원할 수 있습니다.");
  if (action === "restore") {
    const target = state.revisions.find(revision => revision.version === positive(input, "version"));
    if (!target) throw new Rejected(404, "복원할 버전을 찾을 수 없습니다.");
    if (positive(input, "base") !== itinerary.version || target.title === itinerary.title) {
      throw new Rejected(409, "일정이 바뀌었습니다. 최신 일정을 확인해 주세요.");
    }
    return { result: appendRevision(state, target.title, "복원", target.version) };
  }
  const id = positive(input, "id");
  const proposal = proposals.find(entry => entry.id === id);
  if (!proposal) throw new Rejected(404, "변경안을 찾을 수 없습니다.");
  if (proposal.status !== "제안" || (action === "approve" && proposal.base !== itinerary.version)) {
    throw new Rejected(409, "변경안이 이미 처리됐거나 일정이 바뀌었습니다.");
  }
  proposal.status = action === "approve" ? "승인" : "거절";
  return { result: action === "approve"
    ? appendRevision(state, proposal.after, "승인 적용", id)
    : { id } };
}

export function handlerFor({ read, compareAndSet }, hashes, origin) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action");
      if (!actions.has(action)) throw new Rejected(404, "주소를 찾을 수 없습니다.");
      if (request.method !== (action === "state" ? "GET" : "POST")) {
        throw new Rejected(405, "지원하지 않는 요청입니다.");
      }
      const bearer = request.headers.get("authorization");
      if (request.method === "POST" && !bearer && request.headers.get("origin") !== origin) {
        throw new Rejected(403, "요청 출처를 확인해 주세요.");
      }
      if (action === "join") {
        if (bearer) throw new Rejected(403, "참가자 코드로 입장해 주세요.");
        const input = await payload(request);
        const code = string(input, "code", 128);
        const role = identify(code, hashes, ["owner", "partner"]);
        if (!role) throw new Rejected(403, "이 여행의 참가자 코드가 아닙니다.");
        return json({ name: actors[role] }, 200,
          `${cookieName}=${code}; Path=/; Secure; HttpOnly; SameSite=Strict`);
      }
      const cookie = request.headers.get("cookie")?.split(";").map(value => value.trim())
        .find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
      const role = bearer
        ? identify(bearer.startsWith("Bearer ") ? bearer.slice(7) : "", hashes, ["ai"])
        : identify(cookie ?? "", hashes, ["owner", "partner"]);
      if (!role) throw new Rejected(401, "참가자 등록이 필요합니다.");
      if (action === "state") {
        const since = Number(url.searchParams.get("since") ?? "0");
        if (!Number.isSafeInteger(since) || since < 0) throw new Rejected(400, "메시지 번호가 올바르지 않습니다.");
        const { value } = await read();
        return json(visibleState(value ?? initialState(), role, since));
      }
      const input = await payload(request);
      for (let attempt = 0; attempt < 5; attempt++) {
        const { value, etag } = await read();
        const next = value ?? initialState();
        const { result, duplicate } = apply(next, role, action, input);
        if (duplicate) return json(result);
        if (await compareAndSet(etag, next)) return json(result);
      }
      throw new Rejected(409, "저장 중 다른 변경이 있었습니다. 다시 시도해 주세요.");
    } catch (error) {
      if (error instanceof Rejected) return json({ error: error.message }, error.status);
      console.error("pohang-collab", { name: error?.name });
      return json({ error: "공유 저장소에 연결하지 못했습니다." }, 503);
    }
  };
}

const pathname = "collab-preview/pohang-yeongdeok-2026-11-v1.json";

export default {
  async fetch(request) {
    const env = process.env;
    const hashes = {
      owner: env.POHANG_PREVIEW_OWNER_SHA256,
      partner: env.POHANG_PREVIEW_PARTNER_SHA256,
      ai: env.POHANG_PREVIEW_AI_SHA256
    };
    if (env.VERCEL_ENV !== "preview" || !env.VERCEL_URL || !env.BLOB_READ_WRITE_TOKEN ||
      !Object.values(hashes).every(hash => /^[0-9a-f]{64}$/.test(hash ?? "")) ||
      new Set(Object.values(hashes)).size !== 3) {
      return json({ error: "테스트 채팅이 준비되지 않았습니다." }, 503);
    }
    const { get, put, BlobNotFoundError, BlobPreconditionFailedError } = await import("@vercel/blob");
    const store = {
      async read() {
        let blob;
        try {
          blob = await get(pathname, { access: "private", useCache: false });
        } catch (error) {
          if (!(error instanceof BlobNotFoundError)) throw error;
        }
        if (!blob) return { value: null, etag: null };
        if (blob.statusCode !== 200 || !blob.stream || !blob.blob.etag) throw new Error("Invalid Blob response");
        return { value: await new Response(blob.stream).json(), etag: blob.blob.etag };
      },
      async compareAndSet(etag, value) {
        try {
          await put(pathname, JSON.stringify(value), {
            access: "private", contentType: "application/json",
            ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false })
          });
          return true;
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError || error?.name === "BlobAlreadyExistsError" ||
              [409, 412].includes(error?.status ?? error?.statusCode)) return false;
          throw error;
        }
      }
    };
    const origin = "https://" + env.VERCEL_URL;
    return handlerFor(store, hashes, origin)(request);
  }
};

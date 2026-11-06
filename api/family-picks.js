import { get, head, put, BlobPreconditionFailedError } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";

const PATH = "family-picks/anyang-market-2026-11.json";
const ALLOWED = new Set([
  "chunhajudong","seoul","jangnae","hongdukkae","pia","omuk","monyeo",
  "nongbune","samdeokbbq","gamjatang","yuseongwon","stag","elmanque",
  "samdeokpark","artpark","museum"
]);
const BASE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Authorization",
  "Referrer-Policy": "no-referrer"
};
const emptyState = () => ({ version: 0, selected: [], applied: [], updatedAt: null });
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: BASE_HEADERS });
}
function authorized(request) {
  const header = request.headers.get("authorization") || "";
  const token = /^Bearer ([A-Za-z0-9_-]{43,64})$/.exec(header)?.[1];
  const expected = process.env.FAMILY_SHARE_TOKEN;
  if (!token || !expected || !/^[A-Za-z0-9_-]{43,64}$/.test(expected)) return false;
  const left = createHash("sha256").update(token).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
function isConflict(error) {
  return error instanceof BlobPreconditionFailedError ||
    ["BlobAlreadyExistsError","BlobConflictError","BlobPreconditionFailedError"].includes(error?.name) ||
    [409,412].includes(error?.status ?? error?.statusCode);
}
function validateState(state) {
  return state && Number.isSafeInteger(state.version) && state.version >= 0 &&
    Array.isArray(state.selected) && state.selected.length <= ALLOWED.size &&
    state.selected.every((id, index) => ALLOWED.has(id) && state.selected.indexOf(id) === index) &&
    Array.isArray(state.applied) && state.applied.length <= 256 &&
    state.applied.every(id => typeof id === "string") &&
    (state.updatedAt === null || typeof state.updatedAt === "string");
}
async function readState() {
  let metadata;
  try {
    metadata = await head(PATH);
  } catch (error) {
    if (error?.name === "BlobNotFoundError" || error?.status === 404) {
      return { value: emptyState(), etag: null };
    }
    throw error;
  }
  // The ETag query changes with every write, bypassing Blob CDN stale reads.
  const freshUrl = metadata.url + "?revision=" + encodeURIComponent(metadata.etag);
  const result = await get(freshUrl, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream || result.blob.etag !== metadata.etag) {
    const error = new Error("Stale Blob read");
    error.retryable = true;
    throw error;
  }
  const value = JSON.parse(await new Response(result.stream).text());
  if (!validateState(value)) throw new Error("Invalid stored selection document");
  return { value, etag: metadata.etag };
}
function parseChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { action, operationId } = input;
  if (typeof operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) return null;
  if (action === "select" || action === "deselect") {
    if (!ALLOWED.has(input.id)) return null;
    return { action, operationId, id: input.id };
  }
  if (action === "import") {
    if (!Array.isArray(input.ids) || input.ids.length > ALLOWED.size ||
        !input.ids.every(id => ALLOWED.has(id)) ||
        new Set(input.ids).size !== input.ids.length) return null;
    return { action, operationId, ids: input.ids };
  }
  return null;
}
function applyChange(previous, op) {
  const selected = previous.selected.slice();
  if (op.action === "select") {
    const i = selected.indexOf(op.id);
    if (i >= 0) selected.splice(i, 1);
    selected.unshift(op.id);
  } else if (op.action === "deselect") {
    const i = selected.indexOf(op.id);
    if (i >= 0) selected.splice(i, 1);
  } else {
    for (const id of op.ids) if (!selected.includes(id)) selected.push(id);
  }
  return {
    version: previous.version + 1,
    selected,
    applied: [...previous.applied, op.operationId].slice(-256),
    updatedAt: new Date().toISOString()
  };
}
export default async function handler(request) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "지원하지 않는 요청입니다." }, 405);
  }
  if (!authorized(request)) return json({ error: "가족 공유 권한을 확인할 수 없습니다." }, 401);
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: "공유 저장소 연결이 준비되지 않았습니다." }, 503);
  }
  try {
    if (request.method === "GET") {
      for (let n = 0; n < 4; n++) {
        try {
          const current = await readState();
          return json({ selected: current.value.selected, version: current.value.version, updatedAt: current.value.updatedAt });
        } catch (error) {
          if (!error.retryable || n === 3) throw error;
        }
      }
    }
    const length = Number(request.headers.get("content-length") || "0");
    if (length > 2048) return json({ error: "요청 크기가 초과됐습니다." }, 413);
    const text = await request.text();
    if (text.length > 2048) return json({ error: "요청 크기가 초과됐습니다." }, 413);
    let raw;
    try { raw = JSON.parse(text); } catch (_) { return json({ error: "요청 형식이 올바르지 않습니다." }, 400); }
    const op = parseChange(raw);
    if (!op) return json({ error: "요청한 장소 또는 작업이 올바르지 않습니다." }, 400);
    for (let attempt = 0; attempt < 10; attempt++) {
      let current;
      try { current = await readState(); }
      catch (error) {
        if (error.retryable && attempt < 9) continue;
        throw error;
      }
      if (current.value.applied.includes(op.operationId)) {
        return json({ selected: current.value.selected, version: current.value.version, updatedAt: current.value.updatedAt, duplicate: true });
      }
      const next = applyChange(current.value, op);
      try {
        await put(PATH, JSON.stringify(next), {
          access: "private",
          contentType: "application/json",
          cacheControlMaxAge: 60,
          ...(current.etag ? { allowOverwrite: true, ifMatch: current.etag } : { allowOverwrite: false })
        });
        return json({ selected: next.selected, version: next.version, updatedAt: next.updatedAt });
      } catch (error) {
        if (isConflict(error) && attempt < 9) continue;
        if (isConflict(error)) return json({ error: "동시 수정 충돌. 잠시 후 재시도해 주세요." }, 409);
        throw error;
      }
    }
    return json({ error: "저장 충돌. 다시 시도해 주세요." }, 409);
  } catch (error) {
    console.error("family-picks", { name: error?.name, status: error?.status ?? error?.statusCode, message: String(error?.message || "").slice(0, 160) });
    return json({ error: "공유 목록을 불러오거나 저장하지 못했습니다." }, 503);
  }
}

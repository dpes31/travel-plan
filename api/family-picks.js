import { get, head, put, BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";

const PATH = "family-picks/anyang-market-2026-11.json";
const ALLOWED = new Set([
  "chunhajudong","seoul","jangnae","hongdukkae","pia","omuk","monyeo",
  "nongbune","samdeokbbq","gamjatang","yuseongwon","stag","elmanque",
  "samdeokpark","artpark","museum"
]);
const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
function isMissing(error) {
  return error instanceof BlobNotFoundError ||
    error?.name === "BlobNotFoundError" ||
    error?.status === 404 || error?.statusCode === 404 ||
    /requested blob does not exist/i.test(String(error?.message || ""));
}
function isConflict(error) {
  return error instanceof BlobPreconditionFailedError ||
    ["BlobAlreadyExistsError","BlobConflictError","BlobPreconditionFailedError"].includes(error?.name) ||
    [409, 412].includes(error?.status ?? error?.statusCode);
}
function emptyState() {
  return { version: 0, selected: [], applied: [], updatedAt: null };
}
function validState(state) {
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
    if (isMissing(error)) return { value: emptyState(), etag: null };
    throw error;
  }
  const content = await get(PATH, {
    access: "private",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!content || content.statusCode !== 200 || !content.stream ||
      content.blob.etag !== metadata.etag) {
    const error = new Error("Stale or missing Blob read");
    error.retryable = true;
    throw error;
  }
  const value = JSON.parse(await new Response(content.stream).text());
  if (!validState(value)) throw new Error("Invalid stored selection document");
  return { value, etag: metadata.etag };
}
function parseChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { action, operationId } = input;
  if (typeof operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) return null;
  if (action === "select" || action === "deselect") {
    if (!ALLOWED.has(input.id)) return null;
    return { action, operationId, id: input.id };
  }
  if (action === "import") {
    if (!Array.isArray(input.ids) || input.ids.length > ALLOWED.size ||
        !input.ids.every(id => ALLOWED.has(id)) || new Set(input.ids).size !== input.ids.length) return null;
    return { action, operationId, ids: input.ids };
  }
  return null;
}
function applyChange(previous, op) {
  const selected = previous.selected.slice();
  if (op.action === "select") {
    const index = selected.indexOf(op.id);
    if (index >= 0) selected.splice(index, 1);
    selected.unshift(op.id);
  } else if (op.action === "deselect") {
    const index = selected.indexOf(op.id);
    if (index >= 0) selected.splice(index, 1);
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
async function handler(request) {
  if (!["GET", "POST"].includes(request.method)) return json({ error: "지원하지 않는 요청입니다." }, 405);
  if (!process.env.BLOB_READ_WRITE_TOKEN) return json({ error: "공유 저장소 연결이 준비되지 않았습니다." }, 503);
  try {
    if (request.method === "GET") {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const { value } = await readState();
          return json({ selected: value.selected, version: value.version, updatedAt: value.updatedAt });
        } catch (error) {
          if (!error.retryable || attempt === 3) throw error;
        }
      }
    }
    const size = Number(request.headers.get("content-length") || "0");
    if (size > 2048) return json({ error: "요청 크기가 초과됐습니다." }, 413);
    const rawText = await request.text();
    if (rawText.length > 2048) return json({ error: "요청 크기가 초과됐습니다." }, 413);
    let input;
    try { input = JSON.parse(rawText); }
    catch (_) { return json({ error: "요청 형식이 올바르지 않습니다." }, 400); }
    const operation = parseChange(input);
    if (!operation) return json({ error: "요청한 장소 또는 작업이 올바르지 않습니다." }, 400);
    for (let attempt = 0; attempt < 10; attempt++) {
      let previous;
      try { previous = await readState(); }
      catch (error) {
        if (error.retryable && attempt < 9) continue;
        throw error;
      }
      if (previous.value.applied.includes(operation.operationId)) {
        const state = previous.value;
        return json({ selected: state.selected, version: state.version, updatedAt: state.updatedAt, duplicate: true });
      }
      const next = applyChange(previous.value, operation);
      try {
        await put(PATH, JSON.stringify(next), {
          access: "private", contentType: "application/json",
          cacheControlMaxAge: 60,
          ...(previous.etag ? { allowOverwrite: true, ifMatch: previous.etag } : { allowOverwrite: false })
        });
        return json({ selected: next.selected, version: next.version, updatedAt: next.updatedAt });
      } catch (error) {
        if (isConflict(error) && attempt < 9) continue;
        if (isConflict(error)) return json({ error: "동시 수정 충돌. 다시 시도해 주세요." }, 409);
        throw error;
      }
    }
    return json({ error: "저장 충돌. 다시 시도해 주세요." }, 409);
  } catch (error) {
    console.error("family-picks", {
      name: error?.name, status: error?.status ?? error?.statusCode,
      message: String(error?.message || "").slice(0, 160)
    });
    return json({ error: "공유 목록을 불러오거나 저장하지 못했습니다." }, 503);
  }
}
export default { fetch(request) { return handler(request); } };

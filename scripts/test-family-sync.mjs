import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile("api/family-picks.js", "utf8");
const script = raw
  .replace(/^import .*;\s*$/gm, "")
  .replace(/^export default \{ fetch\(request\) \{ return handler\(request\); \} \};\s*$/m, "");
class BlobNotFoundError extends Error {}
class BlobPreconditionFailedError extends Error {}

let stored = null;
let serial = 0;
let calls = [];
let raceOnce = false;
function record(selected, version, applied = []) {
  serial++;
  stored = {
    value: JSON.stringify({ version, selected, applied, updatedAt: new Date().toISOString() }),
    etag: '"e' + serial + '"'
  };
}
async function get(_path, opts) {
  calls.push({ method: "get", opts });
  assert.equal(opts.access, "private");
  assert.equal(opts.useCache, false, "모든 읽기는 CDN 캐시를 우회해야 합니다.");
  if (!stored) return null;
  return {
    statusCode: 200,
    stream: new TextEncoder().encode(stored.value),
    blob: { etag: stored.etag }
  };
}
async function put(_path, data, opts) {
  calls.push({ method: "put", opts });
  if (raceOnce) {
    raceOnce = false;
    const prior = JSON.parse(stored.value);
    const extra = "stag";
    record([extra, ...prior.selected.filter(id => id !== extra)], prior.version + 1, prior.applied);
    throw new BlobPreconditionFailedError("Concurrent overwrite");
  }
  if (stored && (!opts.allowOverwrite || opts.ifMatch !== stored.etag)) {
    throw new BlobPreconditionFailedError("ETag mismatch");
  }
  if (!stored && opts.allowOverwrite !== false) {
    throw new BlobPreconditionFailedError("Expected new blob");
  }
  serial++;
  stored = { value: String(data), etag: '"e' + serial + '"' };
}
const handler = new Function("get", "put", "BlobNotFoundError",
  "BlobPreconditionFailedError", "process", "Response",
  script + "\nreturn handler;"
)(get, put, BlobNotFoundError, BlobPreconditionFailedError,
  { env: { BLOB_READ_WRITE_TOKEN: "mocked-private-server-token" } }, Response);

const uid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
async function request(method, body) {
  const req = {
    method,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
  const result = await handler(req);
  return { status: result.status, body: await result.json() };
}
let checks = 0;
function verify(value, message) { assert.ok(value, message); checks++; }

let r = await request("GET");
verify(r.status === 200 && r.body.selected.length === 0, "새 저장소는 빈 목록으로 시작");
verify(calls.length === 1 && calls[0].method === "get", "GET은 조회 한 번만 실행");

r = await request("POST", { action: "select", id: "seoul", operationId: uid(1) });
verify(r.status === 200 && r.body.selected[0] === "seoul", "신규 선택 저장");
verify(calls.at(-1).opts.allowOverwrite === false, "최초 저장의 생성 충돌 방지");

r = await request("GET");
verify(r.status === 200 && r.body.selected[0] === "seoul" && r.body.version === 1,
  "선택 직후 최신 버전을 읽음");
verify(calls.at(-1).method === "get", "GET은 메타데이터 중복 요청 없이 읽음");

raceOnce = true;
r = await request("POST", { action: "select", id: "monyeo", operationId: uid(2) });
verify(r.status === 200 && r.body.selected.includes("stag") &&
  r.body.selected.includes("monyeo") && r.body.selected.includes("seoul"),
  "동시 변경은 충돌 이후 재조회하여 보존");

r = await request("POST", { action: "select", id: "monyeo", operationId: uid(2) });
verify(r.status === 200 && r.body.duplicate === true, "중복 전송은 한 번만 반영");

r = await request("POST", { action: "deselect", id: "monyeo", operationId: uid(3) });
verify(r.status === 200 && !r.body.selected.includes("monyeo"), "선택 해제 정상");

r = await request("POST", { action: "import", ids: ["chunhajudong"], operationId: uid(4) });
verify(r.status === 200 && r.body.selected.includes("chunhajudong"), "기존 선택 병합");

r = await request("POST", { action: "select", id: "invalid-id", operationId: uid(5) });
verify(r.status === 400, "임의의 장소 ID 차단");

r = await request("GET");
verify(r.status === 200 && r.body.selected.includes("stag") &&
  r.body.selected.includes("chunhajudong"), "연속 쓰기 뒤 최신 공통 목록 조회");
verify(calls.filter(c => c.method === "get").every(c => c.opts.useCache === false),
  "모든 내부 재시도에 캐시 우회 적용");
verify(!calls.some(c => c.method === "head"), "이전 head/get 이중 읽기 제거");
console.log("family sync regression passed · " + checks + " checks · private origin read + CAS");

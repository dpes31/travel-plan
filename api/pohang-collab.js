import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { apply, migrate, Rejected, view } from "../lib/pohang-room.js";

const cookieName = "__Host-pohang-member";
const actions = new Set(["state", "messages", "proposals", "approve", "reject", "restore"]);
const oldPath = "collab-preview/pohang-yeongdeok-2026-11-v1.json";
const roomPath = "collab-preview/pohang-yeongdeok-2026-11-v2.json";

function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function guestKey(id, secret) {
  return createHmac("sha256", secret).update("pohang-preview/member/v2/" + id).digest("hex");
}

function session(request, config) {
  if (request.headers.has("authorization")) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("authorization"));
    if (!match || !equal(createHash("sha256").update(match[1]).digest("hex"), config.aiHash)) {
      throw new Rejected(401, "AI 연결 인증에 실패했습니다.");
    }
    return { sender: "ai" };
  }
  const cookies = Object.fromEntries((request.headers.get("cookie") ?? "").split(";")
    .map(s => s.trim().split("=")).filter(pair => pair.length === 2));
  const [id = "", signature = ""] = (cookies[cookieName] ?? "").split(".");
  if (/^[a-f\d-]{36}$/.test(id) && equal(signature, guestKey(id, config.secret))) return { sender: id };
  // Preserve attribution on browsers that had joined the first preview.
  const legacy = cookies["__Host-pohang-preview"];
  if (legacy && /^[A-Za-z0-9_-]{32,128}$/.test(legacy)) {
    const digest = createHash("sha256").update(legacy).digest("hex");
    for (const [role, hash] of Object.entries(config.legacy ?? {})) {
      if (hash && equal(digest, hash)) return { sender: role };
    }
  }
  if (request.method !== "GET") throw new Rejected(401, "채팅 연결을 새로고침해 주세요.");
  const sender = randomUUID();
  return { sender, cookie: cookieName + "=" + sender + "." + guestKey(sender, config.secret) +
    "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000" };
}

function json(data, status = 200, cookie) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Vary: "Authorization, Cookie" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}

export function handlerFor(store, config) {
  return async request => {
    try {
      const url = new URL(request.url);
      const action = url.searchParams.get("action");
      if (!actions.has(action)) throw new Rejected(404, "요청을 찾을 수 없습니다.");
      if (request.method !== (action === "state" ? "GET" : "POST")) throw new Rejected(405, "지원하지 않는 요청입니다.");
      const { sender, cookie } = session(request, config);
      if (action === "state") {
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!Number.isSafeInteger(since) || since < 0) throw new Rejected(400, "메시지 번호를 확인해 주세요.");
        const { value } = await store.read();
        return json(view(value, sender, since), 200, cookie);
      }
      if (sender !== "ai" && !config.origins.includes(request.headers.get("origin"))) {
        throw new Rejected(403, "계획서 안에서 다시 시도해 주세요.");
      }
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Rejected(415, "JSON 요청이 필요합니다.");
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 16000) throw new Rejected(413, "요청이 너무 깁니다.");
      let data;
      try { data = JSON.parse(raw); } catch { throw new Rejected(400, "요청 형식을 확인해 주세요."); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Rejected(400, "요청 형식을 확인해 주세요.");
      for (let attempt = 0; attempt < 5; attempt++) {
        const { value, etag } = await store.read();
        const result = apply(value, sender, action, data);
        if (result.duplicate || await store.save(etag, value)) return json(result);
      }
      throw new Rejected(409, "동시에 변경됐습니다. 다시 시도해 주세요.");
    } catch (err) {
      if (err instanceof Rejected) return json({ error: err.message }, err.status);
      console.error("pohang-collab", err?.name);
      return json({ error: "대화 저장소에 연결할 수 없습니다." }, 503);
    }
  };
}

export default {
  async fetch(request) {
    const env = process.env;
    if (env.VERCEL_ENV !== "preview" || !env.VERCEL_URL || !env.BLOB_READ_WRITE_TOKEN ||
        !/^[a-f\d]{64}$/.test(env.POHANG_PREVIEW_AI_SHA256 ?? "")) {
      return json({ error: "포항 채팅 연결을 준비하고 있습니다." }, 503);
    }
    const { get, put, BlobNotFoundError, BlobPreconditionFailedError } = await import("@vercel/blob");
    async function readBlob(path) {
      let blob;
      try { blob = await get(path, { access: "private", useCache: false }); }
      catch (err) { if (!(err instanceof BlobNotFoundError)) throw err; }
      if (!blob) return null;
      if (blob.statusCode !== 200 || !blob.stream || !blob.blob.etag) throw new Error("Invalid Blob response");
      return { value: await new Response(blob.stream).json(), etag: blob.blob.etag };
    }
    async function save(etag, value) {
      try {
        await put(roomPath, JSON.stringify(value), { access: "private", contentType: "application/json",
          ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }) });
        return true;
      } catch (err) {
        if (err instanceof BlobPreconditionFailedError || err?.name === "BlobAlreadyExistsError" ||
            [409, 412].includes(err?.status ?? err?.statusCode)) return false;
        throw err;
      }
    }
    async function read() {
      const current = await readBlob(roomPath);
      if (current) return current;
      // Only one simultaneous request can initialize the new schema. Older deployments keep their original format.
      const previous = await readBlob(oldPath);
      await save(null, migrate(previous?.value));
      const initialized = await readBlob(roomPath);
      if (!initialized) throw new Error("Room initialization failed");
      return initialized;
    }
    return handlerFor({ read, save }, {
      aiHash: env.POHANG_PREVIEW_AI_SHA256, secret: env.BLOB_READ_WRITE_TOKEN,
      legacy: { owner: env.POHANG_PREVIEW_OWNER_SHA256, partner: env.POHANG_PREVIEW_PARTNER_SHA256 },
      origins: [env.VERCEL_URL, env.VERCEL_BRANCH_URL].filter(Boolean).map(host => "https://" + host)
    })(request);
  }
};

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { handlerFor } from "../api/pohang-collab.js";
import { migrate } from "../lib/pohang-room.js";
import { stops } from "../lib/pohang-stops.js";

const origin = "https://travel.example", secret = randomBytes(32).toString("hex");
const ai = randomBytes(32).toString("hex");
let data = migrate({
  itinerary: { version: 1, title: stops.aquabelle.title },
  messages: [{ id: 1, role: "owner", body: "이전 요청", request_id: "a" },
    { id: 2, role: "ai", body: "이전 답장", request_id: "room-reply-1" }]
}), version = 1;
const handle = handlerFor({
  async read() { return { value: structuredClone(data), etag: version }; },
  async save(tag, value) {
    if (tag !== version) return false;
    version++; data = structuredClone(value); return true;
  }
}, { origins: [origin], secret, aiHash: createHash("sha256").update(ai).digest("hex") });
async function send(action, headers = {}, body, status = 200) {
  const response = await handle(new Request(origin + "/api/pohang-collab/?action=" + action, {
    method: body ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body)
  }));
  const json = await response.json();
  assert.equal(response.status, status, JSON.stringify(json));
  return { json, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
const first = await send("state"), second = await send("state");
assert.notEqual(first.cookie, second.cookie);
assert.equal(first.json.messages[1].replyTo, 1);
assert.deepEqual(first.json.messages, second.json.messages);
const a = { Cookie: first.cookie }, b = { Cookie: second.cookie }, agent = { Authorization: "Bearer " + ai };
await send("state", { Authorization: "Bearer wrong" }, undefined, 401);
await send("messages", { ...a, Origin: "https://other.example" }, { body: "x", request_id: "y" }, 403);
const m = { body: "가상 카페 변경", request_id: "r1" };
await Promise.all([send("messages", a, m), send("messages", a, m), send("messages", b, { ...m, body: "동행 답장" })]);
const state = (await send("state", a)).json;
assert.equal(state.messages.length, 4);
assert.equal(state.messages.filter(row => row.mine).length, 1);
assert.equal((await send("state", b)).json.messages.filter(row => row.mine).length, 1);
const mid = state.messages.find(row => row.mine).id;
const msg = { body: "가상 카페 변경안입니다.", replyTo: mid, request_id: "room-reply-" + mid };
await send("messages", agent, msg); await send("messages", agent, msg);
const change = { base: 1, op: "edit", target: "chohouse", after: { title: "가상 카페", time: "15:00", note: "검증" },
  request_id: "p1", source: mid };
const pid = (await send("proposals", agent, change)).json.id;
await send("proposals", agent, change);
await send("approve", agent, { id: pid }, 403);
assert.equal((await send("state", b)).json.items.chohouse, undefined);
await send("approve", b, { id: pid });
assert.equal((await send("state", a)).json.items.chohouse.title, "가상 카페");
await send("proposals", a, { ...change, request_id: "stale" }, 409);
const add = { op: "add", base: 2, request_id: "a1", after: { day: 2, title: "새 일정", afterId: "igari", time: "12:00" } };
const p2 = (await send("proposals", a, add)).json.id;
await send("approve", b, { id: p2 });
const p3 = (await send("proposals", b, { op: "remove", base: 3, request_id: "d1", target: "extra-" + p2 })).json.id;
await send("approve", a, { id: p3 });
await send("restore", b, { version: 1, base: 4 });
assert.deepEqual((await send("state", a)).json.items, {});
assert.equal((await send("state&since=2", b)).json.messages.some(row => row.id < 3), false);
const html = await readFile(new URL("../trips/pohang-yeongdeok-2026-11/index.html", import.meta.url), "utf8");
for (const [id, item] of Object.entries(stops)) {
  const article = html.match(new RegExp('<article[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</article>'))?.[1];
  assert.ok(article?.includes("<h3>" + item.title + "</h3>") && article.includes(item.time), id);
}
console.log("Pohang room: code-free entry, independent browsers, legacy chat, AI reply, proposal, approval, add, remove, restore, concurrency, and itinerary bindings passed");

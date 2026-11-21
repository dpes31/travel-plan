import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { apply } from "./pohang-room.js";

const leaseMs = 150000;
export function pending(room, now = Date.now()) {
  const answered = new Set(room.messages.filter(m => m.sender === "ai").map(m => m.replyTo));
  for (const p of room.proposals) answered.add(p.source);
  return room.messages.find(m => !m.kind && m.sender !== "ai" && !answered.has(m.id) &&
    (m.processing?.until ?? 0) <= now && (m.processing?.tries ?? 0) < 3);
}

async function update(store, change) {
  for (let i = 0; i < 6; i++) {
    const { value, etag } = await store.read(true);
    const result = change(value);
    if (!result || await store.save(etag, value)) return result;
    await delay(45 * (i + 1));
  }
  throw new Error("room busy");
}

export async function respond(store, generate) {
  const ticket = randomUUID();
  const job = await update(store, value => {
    // One generation per room at a time, including during concurrent refreshes.
    if (value.messages.some(m => m.processing?.ticket && m.processing.until > Date.now())) return;
    const m = pending(value);
    if (!m) return;
    m.processing = { ticket, detected: Date.now(), until: Date.now() + leaseMs, tries: (m.processing?.tries ?? 0) + 1 };
    return { value, m };
  });
  if (!job) return;
  const started = Date.now();
  try {
    const body = await generate(job.value, job.m);
    await update(store, value => {
      const m = value.messages.find(m => m.id === job.m.id);
      if (m?.processing?.ticket !== ticket) return;
      if (value.version !== job.value.version) { delete m.processing; return true; }
      if (!value.messages.some(r => r.sender === "ai" && r.replyTo === m.id) && !value.proposals.some(p => p.source === m.id)) {
        const { id } = apply(value, "ai", "messages", { body, replyTo: m.id, request_id: "room-reply-" + m.id });
        const reply = value.messages.find(r => r.id === id);
        reply.name = "포항 일정 AI · Qwen";
        reply.trace = { detected: m.processing.detected, started };
      }
      delete m.processing;
      return true;
    });
  } catch (err) {
    console.error("pohang responder", err?.name, String(err?.message ?? "").slice(0,170));
    await update(store, value => {
      const m = value.messages.find(m => m.id === job.m.id);
      if (m?.processing?.ticket !== ticket) return;
      m.processing = { tries: m.processing.tries, until: Date.now() + 12000 };
      return true;
    });
  }
}

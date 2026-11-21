import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { stops } from "./pohang-stops.js";
import notes from "./pohang-planning-notes.json" with { type: "json" };

const weights = "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_K_M.gguf";
const digest = "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a";
const bytes = 396705472;
let modelPromise;

async function load() {
  const target = join(tmpdir(), digest + ".gguf");
  if ((await stat(target).catch(() => null))?.size !== bytes) {
    const part = target + "." + randomUUID();
    try {
      const result = await fetch(weights, { signal: AbortSignal.timeout(80000) });
      if (!result.ok || !result.body) throw new Error("weights download failed");
      const hash = createHash("sha256");
      let size = 0;
      const verify = new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > bytes) return done(new Error("invalid weights length"));
        hash.update(chunk); done(null, chunk);
      } });
      await pipeline(result.body, verify, createWriteStream(part, { flags: "wx", mode: 0o600 }));
      if (size !== bytes || hash.digest("hex") !== digest) throw new Error("invalid weights");
      await rename(part, target);
    } finally { await rm(part, { force: true }); }
  }
  const llama = await getLlama({ gpu: false, build: "never", skipDownload: true, maxThreads: 2 });
  return llama.loadModel({ modelPath: target });
}

export async function generate(room, question) {
  modelPromise ??= load().catch(e => { modelPromise = undefined; throw e; });
  const model = await modelPromise;
  const ctx = await model.createContext({ contextSize: 4096, threads: 2 });
  try {
    const plan = Object.entries({ ...stops, ...room.items }).filter(([,v]) => v);
    const schedule = plan.map(([id,v]) => {
      const archive = v.title === stops[id]?.title ? notes[id] ?? [] : [];
      return [v.day + "일차", v.time, v.title, archive[0], v.note].filter(Boolean).join(" ");
    });
    const details = plan.filter(([,v]) => v.title.split(/[ ·]+/u).some(w => w.length > 1 && question.body.includes(w)))
      .map(([id,v]) => v.title === stops[id]?.title ? [v.title, ...(notes[id] ?? [])].join(" ") : v.note);
    const previous = room.messages.filter(m => m.id < question.id && m.body).slice(-4).map(m => m.body.slice(0,220));
    const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt:
      "한국어 여행 플래너입니다. 질문에 추천부터 답하고, 현재 일정의 정확한 장소와 시각으로 이유를 설명하세요. 비교 질문에는 두 날짜 각각의 이점이나 제약을 설명하세요. 자료에 없는 거리·소요시간·선정 이유를 만들어내지 마세요. 일정을 직접 바꿀 수 없습니다. 변경 요청에는 변경 전후를 설명하고 사람의 승인이 필요하다고 안내하세요. 이전 대화의 장소나 시간을 현재 일정보다 우선하지 마세요." });
    const input = JSON.stringify({ 날짜: ["금요일","토요일","일요일"], 일정: schedule, 상세: details,
      기획기록: ["전승기념관과 나비산은 영덕에, 죽도시장과 영일대는 포항에 있다. 토요일에 영덕을 방문하면 저녁 전에 포항으로 돌아와야 한다.",
        "소노벨 경주는 후보에서 제외했다. 제외 이유는 기록되지 않았다. 실시간 교통·영업·날씨는 확인되지 않았다."],
      승인기록:room.revisions.slice(0,4).map(r=>[r.version,r.action,r.label]), 최근대화:previous, 질문:question.body });
    const answer = (await session.prompt(input + "\n한국어로 짧게 답하세요. /no_think", { temperature: 0, maxTokens: 380 }))
      .replace(/<think>[\s\S]*?<\/think>/gu,"").trim();
    if (!answer || answer.includes("<think>") || !/[가-힣]/u.test(answer)) throw new Error("no usable reply");
    return answer.slice(0,1900);
  } finally { await ctx.dispose(); }
}

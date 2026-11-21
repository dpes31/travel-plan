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
    const names = ["", "금요일", "토요일", "일요일"];
    const records = new Map(plan);
    const candidates = plan.map(([id, item]) => {
      const aliases = [item.title, ...item.title.split(/[ ·]+/u).filter(w => w.length >= 3)];
      const hits = aliases.filter(w => question.body.includes(w));
      return { id, index: Math.min(...hits.map(w => question.body.indexOf(w))), length: Math.max(0,...hits.map(w => w.length)) };
    }).filter(r => Number.isFinite(r.index)).sort((a,b) => a.index - b.index || b.length - a.length);
    const schema = {
      type: "object",
      properties: {
        place: { enum: [...records.keys(), "unknown"] },
        task: { enum: ["compare_days", "place_info", "change_request", "other"] },
        target: { enum: ["금요일", "토요일", "일요일", "미지정"] }
      }
    };
    const history = room.messages.filter(m => m.id < question.id && m.body).slice(-3).map(m => m.body.slice(0,140));
    const catalog = plan.map(([id, v]) => [id, v.title, names[v.day], v.time]);
    const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt:
      "Read a Korean travel question. Select the MAIN place the user asks about, the task, and the proposed new day. 첫째 날=금요일, 둘째 날=토요일, 셋째 날=일요일. Asking whether to move a stop is compare_days; change_request requires an explicit request to actually change the plan. Use unknown if the place is absent. Return JSON only." });
    const grammar = await model.llama.createGrammarForJsonSchema(schema);
    const selection = await session.prompt(JSON.stringify({ catalog, history, question: question.body }) + " /no_think",
      { grammar, maxTokens: 180, temperature: 0 });
    const prediction = JSON.parse(selection);
    const place = candidates[0]?.id ?? prediction.place;
    const task = prediction.task;
    const days = [["금요일","금욜","첫째 날","첫날","1일차"],["토요일","토욜","둘째 날","둘째날","둘쨋날","2일차"],["일요일","일욜","셋째 날","셋째날","3일차"]];
    const mentions = days.flatMap((words,idx) => words.filter(w => question.body.includes(w)).map(w => ({ idx, pos: question.body.indexOf(w) })));
    mentions.sort((a,b) => a.pos - b.pos);
    const target = mentions.length ? names[mentions[0].idx + 1] : prediction.target;
    const v = records.get(place);
    const archive = id => records.get(id)?.title === stops[id]?.title ? notes[id] ?? [] : [];
    const primary = ([id]) => !archive(id)[0]?.includes("대안");
    const describe = ([, item]) => item.time + " " + item.title;
    const dayPlan = day => plan.filter(entry => entry[1].day === day && primary(entry));
    if (v && task === "compare_days" && names.indexOf(target) > 0 && target !== names[v.day]) {
      const current = dayPlan(v.day);
      const next = current[current.findIndex(([key]) => key === place) + 1];
      const proposed = dayPlan(names.indexOf(target));
      const fixed = proposed.filter(([id]) => ["홍게 저녁", "고정 공연"].includes(archive(id)[0]));
      const constraints = fixed.length ? fixed : proposed.slice(-2);
      const protectedTimes = constraints.map(e => describe(e) + (archive(e[0])[0] === "고정 공연" ? " (" + archive(e[0])[1] + ")" : "")).join(", ");
      const local = region(place, v);
      const other = constraints.map(([id, item]) => region(id, item)).find(r => r && r !== local);
      const travel = local && other ? local + "에서 " + other + "으로 다시 이동해야 해서 " : "";
      return names[v.day] + " " + v.time + " " + v.title + " 일정을 유지하는 편을 추천합니다. " +
        (next ? "이어서 " + describe(next) + " 일정이 잡혀 있습니다. " : "") +
        (protectedTimes ? target + "에는 " + protectedTimes + " 일정이 있습니다. " + travel +
          "그 전에 관람과 이동·주차를 마칠 여유가 있는지 확인해야 합니다." : target + " 이동 시간은 기록에 없어 여유를 단정하기 어렵습니다.");
    }
    const system = "한국 가족여행 안내자입니다. 참고자료에 있는 정보만 사용해 질문에 직접 답하세요. 시각과 요일은 그대로 쓰세요. 답은 한국어 존댓말 두세 문장. 일정 변경을 약속하지 마세요. 모르는 사실은 미확인으로 답하세요.";
    const details = v ? [names[v.day], v.time, v.title, ...archive(place), v.note] : [];
    session.dispose({ disposeSequence: true });
    const writer = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: system });
    const input = JSON.stringify({ 기준일정: catalog.map(x => x.slice(1)), 질문관련기록: details,
      기획기록: ["영덕 전승기념관과 나비산은 같은 지역, 죽도시장과 영일대는 포항.", "소노벨 경주는 제외. 사유 미기록. 실시간 교통·날씨는 미확인."],
      최근승인: room.revisions.slice(0,3).map(r => [r.action,r.label]), 질문: question.body });
    const answer = (await writer.prompt(input + " /no_think", { temperature: 0, maxTokens: 230 })).replace(/<think>[\s\S]*?<\/think>/gu,"").trim();
    if (!answer || answer.includes("<think>") || !/[가-힣]/u.test(answer)) throw new Error("no usable reply");
    const facts = v ? "\n\n현재 일정 · " + names[v.day] + " " + v.time + " " + v.title : "";
    return (answer + facts).slice(0,1900);
  } finally { await ctx.dispose(); }
}

function region(id, stop) {
  if (stop.title !== stops[id]?.title) return null;
  if (["jangsa", "nabisan", "chohouse"].includes(id)) return "영덕";
  if (["hongge", "fireworks", "igari", "aquabelle", "cheongha", "mori", "guryongpo", "gwamegi", "museum", "stayday1"].includes(id)) return "포항";
  return null;
}

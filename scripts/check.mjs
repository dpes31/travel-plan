import { readFile, access } from "node:fs/promises";

const files = ["index.html", "trips/yeosu-2026-08/index.html", "trips/tongyeong-geoje-2026-07/index.html", "data/trips.json", "manifest.webmanifest", "vercel.json"];
await Promise.all(files.map(file => access(file)));
const trips = JSON.parse(await readFile("data/trips.json", "utf8"));
if (!Array.isArray(trips) || trips.length < 1) throw new Error("여행 데이터가 비어 있습니다.");
const home = await readFile("index.html", "utf8");
const detail = await readFile("trips/yeosu-2026-08/index.html", "utf8");
const tongyeongDetail = await readFile("trips/tongyeong-geoje-2026-07/index.html", "utf8");
if (!home.includes('id="trip-list"')) throw new Error("홈 목록 컨테이너 누락");
for (const id of ["day1", "day2", "day3", "day1-luge", "day2-yacht", "day2-gyeongwon", "day3-gyeongdo"]) {
  if (!detail.includes(`id="${id}"`)) throw new Error(`상세 앵커 누락: ${id}`);
}
for (const id of ["day1", "day2", "day3", "day4", "tg-day2-samchingi", "tg-day2-yacht", "tg-day3-oedo", "tg-day4-garden"]) {
  if (!tongyeongDetail.includes(`id="${id}"`)) throw new Error(`통영·거제 상세 앵커 누락: ${id}`);
}
console.log("travel-plan structural checks passed");

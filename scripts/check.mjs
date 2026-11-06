import { readFile, access } from "node:fs/promises";

const files = ["index.html", "trips/yeosu-2026-08/index.html", "trips/tongyeong-geoje-2026-07/index.html", "trips/anyang-market-2026-11/index.html", "data/trips.json", "manifest.webmanifest", "vercel.json"];
await Promise.all(files.map(file => access(file)));
const trips = JSON.parse(await readFile("data/trips.json", "utf8"));
if (!Array.isArray(trips) || trips.length < 1) throw new Error("여행 데이터가 비어 있습니다.");
const home = await readFile("index.html", "utf8");
const detail = await readFile("trips/yeosu-2026-08/index.html", "utf8");
const tongyeongDetail = await readFile("trips/tongyeong-geoje-2026-07/index.html", "utf8");
const detailScript = await readFile("scripts/detail.js", "utf8");
const anyangDetail = await readFile("trips/anyang-market-2026-11/index.html", "utf8");
const serviceWorker = await readFile("service-worker.js", "utf8");
const appname = "https://github.com/dpes31/travel-plan";
if (!home.includes('id="trip-list"')) throw new Error("홈 목록 컨테이너 누락");
for (const id of ["day1", "day2", "day3", "day1-luge", "day1-busker", "stay-rnb", "stay-goldbeach", "day2-yacht", "day2-hamel", "day2-gyeongwon", "day3-gyeongdo"]) {
  if (!detail.includes(`id="${id}"`)) throw new Error(`상세 앵커 누락: ${id}`);
}
for (const id of ["day1", "day2", "day3", "day4", "tg-day2-samchingi", "tg-day2-yacht", "tg-day3-oedo", "tg-day4-garden"]) {
  if (!tongyeongDetail.includes(`id="${id}"`)) throw new Error(`통영·거제 상세 앵커 누락: ${id}`);
}
if (!detail.includes('a[aria-current="true"]')) throw new Error("여수 DAY 활성 스타일 누락");
if (!tongyeongDetail.includes('a[aria-current="true"]')) throw new Error("통영·거제 DAY 활성 스타일 누락");
if (!detailScript.includes("updateActiveDay")) throw new Error("DAY 스크롤 연동 로직 누락");
for (const [name, html] of [["여수", detail], ["통영·거제", tongyeongDetail]]) {
  if (!html.includes('.btn[href^="nmap://"]{background:#03c75a')) throw new Error(`${name} 네이버지도 버튼 초록색 스타일 누락`);
}
if (/모아모아|newjplusps\.kr\/Y\/userGuide|domestic-accommodations\/84867/.test(detail)) throw new Error("교체 전 모아모아 숙소 정보가 남아 있습니다.");
if ((detail.match(/%EC%95%8C%EC%95%A4%EB%B9%84%EB%B9%84%EC%A6%88%EB%8B%88%EC%8A%A4%ED%98%B8%ED%85%94%20%EC%97%AC%EC%88%98%20%EB%AC%B8%EC%88%98%EB%A1%9C%2058/g) || []).length !== 2) throw new Error("알앤비비즈니스호텔 지도 링크가 두 위치에 동기화되지 않았습니다.");
if (detail.includes('id="day2-busker"')) throw new Error("버스커의 이전 DAY 2 앵커가 남아 있습니다.");

let nmapLinkCount = 0;
let exactPlaceLinkCount = 0;
for (const [name, html] of [["여수", detail], ["통영·거제", tongyeongDetail]]) {
  const anchors = [...html.matchAll(/<a\b([^>]*)href="([^"]+)"([^>]*)>([^<]*)<\/a>/g)];
  for (const match of anchors) {
    const attributes = `${match[1]} ${match[3]}`;
    const href = match[2];
    const label = match[4].trim();
    const isMapButton = /(지도|주차장|도착지)/.test(label);
    if (isMapButton && !href.startsWith("nmap://")) throw new Error(`${name} 지도 버튼이 네이버지도 앱 직결 링크가 아님: ${label} ${href}`);
    if (!href.startsWith("nmap://")) continue;
    nmapLinkCount += 1;
    const url = new URL(href.replaceAll("&amp;", "&"));
    if (!['search', 'place'].includes(url.hostname)) throw new Error(`${name} 지원하지 않는 nmap 액션: ${href}`);
    if (url.hostname === "search" && !url.searchParams.get("query")?.trim()) throw new Error(`${name} nmap 검색어 누락: ${href}`);
    if (url.hostname === "place") {
      exactPlaceLinkCount += 1;
      for (const param of ["lat", "lng", "name"]) {
        if (!url.searchParams.get(param)?.trim()) throw new Error(`${name} nmap 장소 파라미터 누락(${param}): ${href}`);
      }
      if (!/data-map-source="user-share"/.test(attributes)) throw new Error(`${name} nmap 장소 출처 누락: ${label}`);
      if (!/data-map-place-id="\d+"/.test(attributes)) throw new Error(`${name} 네이버 장소 ID 누락: ${label}`);
    }
    if (url.searchParams.get("appname") !== appname) throw new Error(`${name} nmap appname 오류: ${href}`);
    if (/target\s*=\s*"_blank"/.test(attributes)) throw new Error(`${name} nmap 링크에 target=_blank 사용: ${label}`);
  }
  if (/(?:m\.)?map\.naver\.com/.test(html)) throw new Error(`${name} 웹 지도 검색 링크가 남아 있습니다.`);
}
if (nmapLinkCount < 1) throw new Error("nmap 지도 링크가 없습니다.");
if (exactPlaceLinkCount < 1) throw new Error("nmap exact place 링크가 없습니다.");

const anyang = trips.find(trip => trip.id === "anyang-market-2026-11");
if (!anyang || anyang.href !== "/trips/anyang-market-2026-11/") throw new Error("안양 목록 연결 누락");
if (!serviceWorker.includes("/trips/anyang-market-2026-11/")) throw new Error("안양 PWA 캐시 누락");
if (!anyangDetail.includes("const PLACES =") || !anyangDetail.includes("picked.unshift(place.id)") || !anyangDetail.includes("localStorage.setItem(STORAGE_KEY")) throw new Error("안양 선택·정렬·저장 로직 누락");
const anyangCount = (anyangDetail.match(/"category":"(?:market|nearby|see)"/g) || []).length;
if (anyangCount !== 16) throw new Error("안양 목록 수 오류: " + anyangCount);
const anyangIds = ["chunhajudong","seoul","jangnae","hongdukkae","pia","omuk","monyeo","nongbune","samdeokbbq","gamjatang","yuseongwon","stag","elmanque","samdeokpark","artpark","museum"];
for (const id of anyangIds) {
  if (!anyangDetail.includes('"id":"' + id + '"')) throw new Error("안양 장소 누락: " + id);
}
if (!anyangDetail.includes('data-category="market"') || !anyangDetail.includes('data-category="nearby"') || !anyangDetail.includes('data-category="see"') || !anyangDetail.includes("filters.scrollIntoView")) throw new Error("안양 상단 바로가기 및 자동 스크롤 누락");
if (anyangDetail.includes('id="search"') || anyangDetail.includes('시장 먹거리 6') || anyangDetail.includes('"id":"firststreet"')) throw new Error("삭제할 검색/카운트/관광 후보 잔존");
if (anyangDetail.includes('class="notice"') || anyangDetail.includes("선택은 방문 확정이 아닙니다.") || anyangDetail.includes("가장 최근에 선택한 장소가 맨 위에 표시됩니다.") || anyangDetail.includes("아직 선택한 장소가 없습니다.")) throw new Error("안양 중복 안내 문구 잔존");
if (anyangDetail.includes('document.querySelector("#picked").hidden=chosen.length===0')) throw new Error("선택 영역을 잘못 숨기는 코드가 남아 있습니다.");
if (!anyangDetail.includes('class="picked"') || !anyangDetail.includes('class="picked-empty"') && !anyangDetail.includes('make("div","picked-empty"')) || !anyangDetail.includes('아래 후보에서 ‘이곳 선택’을 눌러보세요.')) throw new Error("빈 선택 박스 복원 누락");
if (!anyangDetail.includes('href="nmap://search?') || !anyangDetail.includes("function nmapUrl(place)")) throw new Error("안양 네이버지도 앱 딥링크 누락");
if (/(?:m\.)?map\.naver\.com/.test(anyangDetail)) throw new Error("안양 지도에 웹 링크가 포함되어 있습니다.");

console.log(`travel-plan structural checks passed · ${nmapLinkCount} nmap deep links · ${exactPlaceLinkCount} exact place links`);

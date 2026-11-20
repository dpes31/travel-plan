(() => {
  const api = "/api/pohang-collab/?action=";
  const dialog = document.createElement("dialog");
  dialog.id = "collab";
  dialog.setAttribute("aria-labelledby", "collab-title");
  dialog.innerHTML = `
    <header><h2 id="collab-title">포항 공동 채팅</h2><button id="collab-close">닫기</button></header>
    <p id="collab-status" role="status"></p>
    <form id="join-form" hidden>
      <label for="join-code">참가자 코드</label><input id="join-code" type="password" required autocomplete="off">
      <button class="primary">입장</button>
    </form>
    <section id="collab-room" hidden>
      <p id="collab-user"></p>
      <p>기획 AI는 ChatGPT에서 요청을 확인한 뒤 답변을 남깁니다.</p>
      <div id="collab-messages" aria-label="대화 기록"></div>
      <form id="message-form">
        <label for="message">메시지</label><textarea id="message" maxlength="2000" required></textarea>
        <button class="primary">보내기</button>
      </form>
      <details><summary>직접 변경 제안</summary>
        <form id="proposal-form">
          <label for="next-title">변경할 식당 이름</label><input id="next-title" maxlength="80" required>
          <label for="reason">변경 이유</label><textarea id="reason" maxlength="1000" required></textarea>
          <button>제안 등록</button>
        </form>
      </details>
      <h3>변경안</h3><div id="collab-proposals"></div>
      <h3>변경 이력</h3><div id="collab-revisions"></div>
    </section>`;
  document.body.append(dialog);
  const byId = id => document.getElementById(id);
  const lunch = byId("aquabelle");
  const title = lunch.querySelector("h3");
  const baseline = title.textContent;
  const versionLabel = document.createElement("small");
  lunch.append(versionLabel);
  const lunchFacts = [...lunch.querySelectorAll(".facts,.buttons")];
  const routeLabels = [...document.querySelectorAll("#day2 .route-name")]
    .filter(node => node.textContent === "아쿠아벨 점심");
  const originalLabels = routeLabels.map(node => node.textContent);
  let current, role, timer, activeRefresh, cursor = 0;
  let pendingMessage, writePending = false, needsJoin = false, cardsSignature = '';
  const status = msg => { byId("collab-status").textContent = msg; };

  async function call(url, body) {
    const res = await fetch(url, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
    return json;
  }

  function paragraph(container, value) {
    const node = document.createElement("p");
    node.textContent = value;
    container.append(node);
  }
  function card(container, lines) {
    const node = document.createElement("article");
    for (const line of lines) paragraph(node, line);
    container.append(node);
    return node;
  }
  function actionButton(container, label, action, data) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => write(button, api + action, data, "저장했습니다."));
    container.append(button);
  }

  function render(state) {
    current = state.itinerary;
    role = state.role;
    title.textContent = current.title;
    lunchFacts.forEach(node => { node.hidden = current.title !== baseline; });
    routeLabels.forEach((node, i) => {
      node.textContent = current.title === baseline ? originalLabels[i] : current.title + " 점심";
      node.parentElement.querySelector(".route-icon")?.setAttribute("aria-label", node.textContent);
    });
    versionLabel.textContent = `테스트 일정 v${current.version}`;
    byId("collab-user").textContent = `${state.name} · 일정 v${current.version}`;
    for (const msg of state.messages) {
      card(byId("collab-messages"), [msg.name, msg.body]);
      cursor = msg.id;
    }
    const signature = JSON.stringify([role, current.version, state.proposals, state.revisions]);
    if (signature === cardsSignature) return;
    cardsSignature = signature;
    const proposals = byId("collab-proposals");
    proposals.replaceChildren();
    for (const entry of state.proposals) {
      const stale = entry.status === "제안" && entry.base !== current.version;
      const node = card(proposals, [
        `${stale ? "이전 버전 제안" : entry.status} · v${entry.base}`,
        `${entry.before} → ${entry.after}`, entry.reason
      ]);
      if (role === "owner" && entry.status === "제안") {
        if (!stale) actionButton(node, "승인 및 적용", "approve", { id: entry.id });
        actionButton(node, "거절", "reject", { id: entry.id });
      }
    }
    const history = byId("collab-revisions");
    history.replaceChildren();
    for (const revision of state.revisions) {
      const node = card(history, [`v${revision.version} · ${revision.action} · ${revision.actor}`, revision.title]);
      if (role === "owner" && revision.title !== current.title) {
        actionButton(node, "이 버전으로 복원", "restore", { version: revision.version, base: current.version });
      }
    }
  }

  function refresh() {
    if (activeRefresh) return activeRefresh;
    activeRefresh = (async () => {
      try {
        const state = await call(api + "state&since=" + cursor);
        needsJoin = false;
        byId("join-form").hidden = true;
        byId("collab-room").hidden = false;
        render(state);
      } catch (error) {
        if (error.status === 401) {
          needsJoin = true;
          byId("join-form").hidden = false;
          byId("collab-room").hidden = true;
        } else status("연결 지연 · 마지막으로 확인한 일정 표시 중");
      } finally { activeRefresh = null; }
    })();
    return activeRefresh;
  }

  async function write(button, url, data, success, clear = () => {}) {
    if (writePending) return;
    writePending = button.disabled = true;
    try {
      await call(url, data);
      clear();
      if (activeRefresh) await activeRefresh;
      status(success);
      await refresh();
    } catch (error) { status(error.message || "요청에 실패했습니다."); }
    finally { writePending = button.disabled = false; }
  }

  byId("join-form").addEventListener("submit", event => {
    event.preventDefault();
    write(event.submitter, api + "join", { code: byId("join-code").value }, "", () => {
      byId("join-code").value = "";
    });
  });
  byId("message-form").addEventListener("submit", event => {
    event.preventDefault();
    const field = byId("message");
    if (pendingMessage?.body !== field.value) pendingMessage = { body: field.value, request_id: crypto.randomUUID() };
    write(event.submitter, api + "messages", pendingMessage, "보냈습니다.", () => {
      if (field.value === pendingMessage.body) field.value = "";
      pendingMessage = null;
    });
  });
  byId("proposal-form").addEventListener("submit", event => {
    event.preventDefault();
    write(event.submitter, api + "proposals", {
      after: byId("next-title").value, reason: byId("reason").value, base: current.version
    }, "변경안을 등록했습니다.", () => event.target.reset());
  });
  byId("collab-open").addEventListener("click", () => { dialog.showModal(); refresh(); });
  byId("collab-close").addEventListener("click", () => dialog.close());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  timer = setInterval(() => { if (!document.hidden && !needsJoin) refresh(); }, 5000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  window.addEventListener("pageshow", event => {
    if (event.persisted) timer = setInterval(() => { if (!document.hidden && !needsJoin) refresh(); }, 5000);
  });
  refresh();
})();

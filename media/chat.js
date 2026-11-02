const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const send = $("send");
const stop = $("stop");
const modelBtn = $("modelBtn");
const modelName = $("modelName");
const dot = $("dot");
const ctx = $("ctx");
const gen = $("gen");
const effort = $("effort");
const effortRange = $("effortRange");
const effortName = $("effortName");
const switches = document.querySelectorAll("[data-flag]");
const cfg = $("cfg");
const hostInput = $("host");
const portInput = $("port");
const tokenInput = $("token");
const httpsInput = $("https");
const clearToken = $("clearToken");
const cfgHint = $("cfgHint");
const langSelect = $("lang");
const applyLang = $("applyLang");
let langSetting = "auto";

let busy = false;
let connected = false;
let currentAssistant = null;
let currentReason = null;
let lastStatus = null;
let planCard = null; // jedna karta planu na rozmowę; każda zmiana planu przenosi ją na dół
let ctxUsed = 0; // tokeny ostatniego zapytania rozmowy (prompt + odpowiedź)
let ctxMax = 0; // kontekst załadowanego modelu; 0 = serwer go nie podaje
let effortLevels = { options: [], default: "" }; // poziomy myślenia wybranego modelu z LM Studio
// Ostatni stan wskaźnika generowania od hosta (wait, out, tool, done) i początek bieżącej fazy.
let genState = { phase: "" };
let genTimer = null;
let S = {}; // teksty UI w wybranym języku; przychodzą od hosta ("l10n")

function tr(key, ...args) {
  return String(S[key] ?? key).replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? ""));
}

function applyL10n() {
  document.querySelectorAll("[data-i18n]").forEach((e) => (e.textContent = tr(e.dataset.i18n)));
  document.querySelectorAll("[data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]").forEach((e) => {
    for (const a of [...e.attributes]) {
      if (a.name.startsWith("data-i18n-")) e.setAttribute(a.name.slice(10), tr(a.value));
    }
  });
}

function emptyHint() {
  const examples = [tr("ex1"), tr("ex2"), tr("ex3")];
  log.innerHTML = `<div class="empty">
    <h2>SyntaxCoder</h2>
    <p>${esc(tr("emptySub"))}</p>
    <div class="examples">${examples.map((e) => `<button class="ghost" data-example="${esc(e)}">${esc(e)}</button>`).join("")}</div>
  </div>`;
}

function el(html) {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const TABLE_SEP = /^[\s|:-]+$/;

// Wiersze tabeli markdown; druga linia z samych kresek oddziela nagłówek.
function table(rows) {
  const head = rows.length > 1 && TABLE_SEP.test(rows[1]);
  const row = (r, tag) =>
    `<tr>${r.trim().replace(/^\||\|$/g, "").split("|").map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join("")}</tr>`;
  const body = rows.slice(head ? 2 : 0).filter((r) => !TABLE_SEP.test(r));
  return `<div class="table"><table>${head ? `<thead>${row(rows[0], "th")}</thead>` : ""}<tbody>${body
    .map((r) => row(r, "td"))
    .join("")}</tbody></table></div>`;
}

function blocks(text) {
  const out = [];
  let list = null;
  let rows = [];
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
    if (rows.length) out.push(table(rows));
    rows = [];
  };
  for (const line of text.split("\n")) {
    let m;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
      rows.push(line);
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      close();
      const h = m[1].length + 2;
      out.push(`<h${h}>${inline(m[2])}</h${h}>`);
    } else if ((m = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/))) {
      const kind = m[1] ? "ul" : "ol";
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(m[2])}</li>`);
    } else if (line.trim()) {
      close();
      out.push(`<p>${inline(line)}</p>`);
    } else {
      close();
    }
  }
  close();
  return out.join("");
}

function md(text) {
  const parts = String(text).split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf("\n");
      const lang = nl >= 0 ? parts[i].slice(0, nl).trim() : "";
      const code = nl >= 0 ? parts[i].slice(nl + 1) : parts[i];
      html += `<div class="code">${lang ? `<span class="lang">${esc(lang)}</span>` : ""}<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre><button class="copy ghost">${esc(tr("copy"))}</button></div>`;
    } else {
      html += blocks(parts[i]);
    }
  }
  return html;
}

// Argumenty czytelnie: każdy klucz osobno, wieloliniowe teksty bez \n.
function pretty(args) {
  try {
    return Object.entries(JSON.parse(args || "{}"))
      .map(([k, v]) => (typeof v === "string" ? (v.includes("\n") ? `${k}:\n${v}` : `${k}: ${v}`) : `${k}: ${JSON.stringify(v)}`))
      .join("\n");
  } catch {
    return args || "";
  }
}

// Krótki opis wywołania: ścieżka, komenda albo wzorzec.
function summary(args) {
  try {
    const a = JSON.parse(args || "{}");
    return a.from ? `${a.from} → ${a.to}` : String(a.path || a.command || a.pattern || "");
  } catch {
    return "";
  }
}

function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
}

function append(node) {
  const stick = nearBottom();
  log.querySelector(".empty")?.remove();
  log.appendChild(node);
  if (stick) log.scrollTop = log.scrollHeight;
  return node;
}

// Serwer może powtórzyć id wywołania; stara karta oddaje id nowej.
function freeId(id) {
  $(id)?.removeAttribute("id");
}

// Render raz na klatkę zamiast przy każdym tokenie.
function queueRender(node) {
  if (node.dataset.queued) return;
  node.dataset.queued = "1";
  requestAnimationFrame(() => {
    delete node.dataset.queued;
    scrollIfNear(() => (node.innerHTML = md(node.dataset.raw)));
  });
}

function scrollIfNear(fn) {
  const stick = nearBottom();
  fn();
  if (stick) log.scrollTop = log.scrollHeight;
}

function endReasoning() {
  if (!currentReason) return;
  const box = currentReason.closest("details");
  box.classList.remove("live");
  box.querySelector(".label-text").textContent = tr("thoughts");
  currentReason = null;
}

function ensureAssistant(who) {
  if (!currentAssistant) {
    currentAssistant = append(
      el(who === "reviewer" ? `<div class="msg assistant reviewer"></div>` : `<div class="msg assistant"></div>`)
    );
    currentAssistant.dataset.raw = "";
  }
  return currentAssistant;
}

const KIND = { write: "kindWrite", terminal: "kindTerminal" };
const PLAN_MARK = { pending: "○", in_progress: "▸", done: "✓" };

function renderPlan(steps) {
  const done = steps.filter((s) => s.status === "done").length;
  return el(`<div class="plan">
    <div class="head"><span class="kind">${esc(tr("plan"))}</span><span class="count">${done}/${steps.length}</span></div>
    <ol>${steps
      .map((s) => `<li class="${esc(s.status)}"><span class="mark">${PLAN_MARK[s.status] ?? "○"}</span><span class="text">${inline(s.step)}</span></li>`)
      .join("")}</ol>
  </div>`);
}

const kTok = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`);

// Licznik kontekstu przy modelu; powyżej 3/4 kontekstu ostrzega kolorem.
function renderCtx() {
  ctx.hidden = !ctxUsed;
  if (!ctxUsed) return;
  ctx.textContent = ctxMax ? `${kTok(ctxUsed)} / ${kTok(ctxMax)}` : kTok(ctxUsed);
  ctx.title = tr("ctxTitle", ctxUsed.toLocaleString(), ctxMax ? ctxMax.toLocaleString() : "?");
  ctx.classList.toggle("high", ctxMax > 0 && ctxUsed > ctxMax * 0.75);
}

const secs = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

// Wskaźnik generowania. Liczby (tokeny, tempo, czasy) liczy host. wait = LM Studio jeszcze nic nie wysłało;
// tool = model pisze argumenty narzędzia, które LM Studio odda w całości: tu tokeny szacujemy z tempa modelu.
function onGen(m) {
  const same = m.phase === genState.phase && m.tool === genState.tool;
  genState = { ...m, since: same ? genState.since : Date.now() };
  stopGen();
  if (m.phase === "wait" || m.phase === "tool") genTimer = setInterval(drawGen, 250);
  drawGen();
}

function stopGen() {
  clearInterval(genTimer);
  genTimer = null;
}

function drawGen() {
  const s = genState;
  gen.hidden = !s.phase;
  if (!s.phase) return;
  gen.classList.toggle("live", s.phase !== "done");
  const n = (s.tokens ?? 0).toLocaleString();
  const r = s.rate ? s.rate.toFixed(s.rate < 10 ? 1 : 0) : "";
  const t = secs(Date.now() - s.since);
  if (s.phase === "wait") {
    gen.textContent = tr("genWait");
    gen.title = tr("genWaitTitle", t);
  } else if (s.phase === "tool") {
    const est = s.rate ? Math.round((s.rate * (Date.now() - s.since)) / 1000).toLocaleString() : "";
    gen.textContent = est ? tr("genTool", s.tool, est) : tr("genToolNoRate", s.tool);
    gen.title = tr(est ? "genToolTitle" : "genToolNoRateTitle", s.tool, r, t);
  } else if (s.phase === "out") {
    gen.textContent = r ? tr("genOut", n, r) : tr("genTok", n);
    gen.title = tr("genLiveTitle");
  } else {
    gen.textContent = r ? tr("genOut", n, r) : tr("genTok", n);
    gen.title =
      tr("genTitle", n, secs(s.ms), s.firstMs == null ? "—" : secs(s.firstMs)) + (r ? " " + tr("genRateTitle", r) : "");
  }
}

const levelName = (l) => (S["lvl_" + l] ? tr("lvl_" + l) : l);

// Suwak myślenia: pozycje to poziomy wybranego modelu; zapisany poziom spoza listy = domyślny modelu.
// Model bez poziomów (albo serwer bez API LM Studio) = brak suwaka.
function renderEffort(m) {
  const r = m.connected ? m.reasoning : null;
  effort.hidden = !r;
  if (!r) return;
  effortLevels = r;
  effortRange.max = String(r.options.length - 1);
  const level = r.options.includes(m.reasoningLevel) ? m.reasoningLevel : r.default;
  effortRange.value = String(Math.max(0, r.options.indexOf(level)));
  showEffort();
}

function showEffort() {
  const level = effortLevels.options[Number(effortRange.value)];
  effortName.textContent = levelName(level);
  effort.title = tr("effortTitle", levelName(level), levelName(effortLevels.default));
}

function renderStatus(m) {
  connected = m.connected;
  renderEffort(m);
  dot.className = "dot " + (connected ? "on" : "off");
  delete modelName.dataset.i18n;
  // Serwer odpowiada, ale bez wybranego modelu: pokaż model i pozwól wybrać inny.
  modelName.textContent = connected || m.reachable ? short(m.model) : tr("offline");
  modelBtn.title = connected ? tr("modelTitle", m.model, m.baseUrl) : m.error || tr("disconnected", m.baseUrl);
  cfgHint.textContent = connected ? tr("connected", m.baseUrl) : m.error || tr("disconnected", m.baseUrl || "LM Studio");
  // Token nigdy nie wraca do webview; widać tylko, czy jest zapisany.
  tokenInput.placeholder = tr(m.hasToken ? "tokenSet" : "tokenPlaceholder");
  clearToken.hidden = !m.hasToken;
  cfgHint.className = "hint " + (connected ? "ok" : "bad");
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  switch (m.type) {
    case "l10n":
      S = m.strings;
      document.documentElement.lang = m.lang;
      langSetting = m.setting;
      langSelect.value = m.setting;
      applyLang.disabled = true;
      applyL10n();
      if (!log.children.length || log.querySelector(".empty")) emptyHint();
      if (lastStatus) renderStatus(lastStatus);
      renderCtx();
      break;
    case "cleared":
      currentAssistant = null;
      currentReason = null;
      planCard = null;
      ctxUsed = 0;
      renderCtx();
      stopGen();
      genState = { phase: "" };
      drawGen();
      emptyHint();
      break;
    case "gen":
      onGen(m);
      break;
    case "usage":
      ctxUsed = m.prompt + m.completion;
      renderCtx();
      break;
    case "user":
      currentAssistant = null;
      currentReason = null;
      planCard?.querySelector(".actions")?.remove();
      append(el(`<div class="msg user">${esc(m.text)}</div>`));
      log.scrollTop = log.scrollHeight;
      break;
    case "assistantDelta":
      endReasoning();
      ensureAssistant(m.who);
      currentAssistant.dataset.raw += m.text;
      queueRender(currentAssistant);
      break;
    case "reasoningDelta":
      if (!currentReason) {
        const node = append(
          el(`<details class="thinking live"><summary><span class="dot"></span><span class="label-text">${esc(tr("thinking"))}</span></summary><div class="inner"><div class="body"></div></div></details>`)
        );
        currentReason = node.querySelector(".body");
      }
      scrollIfNear(() => (currentReason.textContent += m.text));
      break;
    case "assistantDone":
      endReasoning();
      currentAssistant = null;
      break;
    case "toolPending": {
      endReasoning();
      currentAssistant = null;
      freeId(`p-${cssId(m.id)}`);
      const card = append(
        el(`<div class="pending" id="p-${cssId(m.id)}">
          <div class="head"><span class="kind">${esc(KIND[m.kind] ? tr(KIND[m.kind]) : m.kind)}</span><span class="tname">${esc(m.name)}</span><span class="targ">${esc(summary(m.args))}</span></div>
          <pre>${esc(pretty(m.args))}</pre>
          <div class="actions">
            <button data-act="approve">${esc(tr("allow"))}</button>
            <button class="ghost" data-act="deny">${esc(tr("deny"))}</button>
          </div>
        </div>`)
      );
      card.querySelectorAll("[data-act]").forEach((b) => {
        b.onclick = () => {
          vscode.postMessage({ type: b.dataset.act, id: m.id });
          card.querySelector(".actions").replaceWith(
            el(`<div class="hint">${esc(tr(b.dataset.act === "approve" ? "allowed" : "denied"))}</div>`)
          );
        };
      });
      card.querySelector('[data-act="approve"]').focus();
      break;
    }
    case "toolStart":
      endReasoning();
      currentAssistant = null;
      $(`p-${cssId(m.id)}`)?.remove();
      freeId(`t-${cssId(m.id)}`);
      append(
        el(`<details class="tool running" id="t-${cssId(m.id)}">
          <summary><span class="dot"></span><span class="tname">${esc(m.name)}</span><span class="targ">${esc(summary(m.args))}</span></summary>
          <div class="inner">
            <div class="label">${esc(tr("args"))}</div><pre>${esc(pretty(m.args))}</pre>
            <div class="label">${esc(tr("result"))}</div><pre class="out">…</pre>
          </div>
        </details>`)
      );
      break;
    case "toolResult": {
      const node = $(`t-${cssId(m.id)}`);
      if (node) {
        node.classList.remove("running");
        node.classList.add(m.ok ? "ok" : "fail");
        node.querySelector(".out").textContent = m.preview || "(ok)";
      }
      break;
    }
    case "plan":
      endReasoning();
      currentAssistant = null;
      planCard?.remove();
      planCard = append(renderPlan(m.steps));
      break;
    case "planReady": {
      if (!planCard) break;
      const actions = el(`<div class="actions"><button>${esc(tr("planRun"))}</button><span class="hint">${esc(tr("planHint"))}</span></div>`);
      actions.querySelector("button").onclick = () => {
        actions.remove();
        vscode.postMessage({ type: "executePlan" });
      };
      planCard.appendChild(actions);
      // Pod podsumowanie modelu: decyzja na samym dole rozmowy.
      append(planCard);
      break;
    }
    case "error":
      endReasoning();
      currentAssistant = null;
      append(el(`<div class="msg error">${esc(m.message)}</div>`));
      break;
    case "notice":
      endReasoning();
      currentAssistant = null;
      append(el(`<div class="notice">${esc(m.text)}</div>`));
      break;
    case "busy":
      busy = m.value;
      document.body.classList.toggle("busy", busy);
      log.setAttribute("aria-busy", String(busy));
      stop.hidden = !busy;
      send.hidden = busy;
      // Błąd albo Stop w trakcie zapytania: bez dokładnych danych z serwera wskaźnik znika.
      if (!busy && genState.phase && genState.phase !== "done") {
        stopGen();
        genState = { phase: "" };
        drawGen();
      }
      break;
    case "status":
      lastStatus = m;
      renderStatus(m);
      ctxMax = m.ctxMax || 0;
      renderCtx();
      if (m.host && document.activeElement !== hostInput) hostInput.value = m.host;
      if (m.port && document.activeElement !== portInput) portInput.value = m.port;
      httpsInput.checked = Boolean(m.https);
      setFlags(m);
      break;
    case "flags":
      setFlags(m);
      break;
    case "reviewStart":
      endReasoning();
      currentAssistant = null;
      append(el(`<div class="review-mark">${esc(m.round > 1 ? tr("reviewingRound", m.round) : tr("reviewing"))}</div>`));
      break;
    case "reviewEnd": {
      endReasoning();
      currentAssistant = null;
      const text = {
        ok: tr("verdictOk"),
        unknown: tr("verdictUnknown"),
        fail: m.fixing ? tr("verdictFixing", m.round, m.maxRounds) : tr("verdictLeft", m.maxRounds),
      }[m.verdict];
      append(el(`<div class="verdict ${esc(m.verdict)}"><span class="dot"></span>${esc(text)}</div>`));
      break;
    }
    case "checking":
      dot.className = "dot wait";
      cfgHint.textContent = tr("checking");
      cfgHint.className = "hint";
      break;
    case "toggleCfg":
      toggleCfg();
      break;
    case "prefill":
      input.value = m.text;
      autosize();
      input.focus();
      break;
  }
});

function short(s) {
  const p = String(s || "model").split("/");
  return p[p.length - 1];
}

function setFlags(f) {
  switches.forEach((b) => b.setAttribute("aria-checked", String(Boolean(f[b.dataset.flag]))));
}

function toggleCfg(show = cfg.hidden) {
  cfg.hidden = !show;
  if (show) hostInput.focus();
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  autosize();
  vscode.postMessage({ type: "chat", text });
}

function saveCfg() {
  cfgHint.textContent = tr("checking");
  cfgHint.className = "hint";
  vscode.postMessage({
    type: "saveConnection",
    host: hostInput.value,
    port: Number(portInput.value) || 1234,
    https: httpsInput.checked,
    token: tokenInput.value,
  });
  tokenInput.value = "";
}

send.onclick = submit;
stop.onclick = () => vscode.postMessage({ type: "stop" });
modelBtn.onclick = () =>
  connected || lastStatus?.reachable ? vscode.postMessage({ type: "pickModel" }) : toggleCfg(true);
// Typowe porty: LM Studio 1234, reverse proxy z HTTPS 443.
httpsInput.onchange = () => {
  if (httpsInput.checked && portInput.value === "1234") portInput.value = "443";
  if (!httpsInput.checked && portInput.value === "443") portInput.value = "1234";
};
// Stan zmienia dopiero host (Auto wymaga potwierdzenia), potem odsyła "flags".
switches.forEach((b) => {
  b.onclick = () =>
    vscode.postMessage({ type: "setFlag", key: b.dataset.flag, value: b.getAttribute("aria-checked") !== "true" });
});
$("cfgClose").onclick = () => toggleCfg(false);
$("saveCfg").onclick = saveCfg;
langSelect.onchange = () => (applyLang.disabled = langSelect.value === langSetting);
applyLang.onclick = () => vscode.postMessage({ type: "setLanguage", value: langSelect.value });
// Nazwa poziomu zmienia się przy przesuwaniu, zapis dopiero po puszczeniu suwaka.
effortRange.oninput = showEffort;
effortRange.onchange = () =>
  vscode.postMessage({ type: "setReasoning", value: effortLevels.options[Number(effortRange.value)] });
clearToken.onclick = () => vscode.postMessage({ type: "clearToken" });
[hostInput, portInput, tokenInput].forEach((i) =>
  i.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCfg();
    if (e.key === "Escape") toggleCfg(false);
  })
);
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

log.addEventListener("click", (e) => {
  const t = e.target;
  if (t.dataset?.example) {
    input.value = t.dataset.example;
    autosize();
    input.focus();
  } else if (t.classList?.contains("copy")) {
    const code = t.parentElement.querySelector("code").textContent;
    navigator.clipboard.writeText(code).then(() => {
      t.textContent = tr("copied");
      setTimeout(() => (t.textContent = tr("copy")), 1200);
    });
  }
});

vscode.postMessage({ type: "ready" });

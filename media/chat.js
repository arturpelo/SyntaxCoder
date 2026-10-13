const vscode = acquireVsCodeApi();
const log = document.getElementById("log");
const input = document.getElementById("input");
const send = document.getElementById("send");
const stop = document.getElementById("stop");
const statusEl = document.getElementById("status");
const modelBtn = document.getElementById("modelBtn");
const cfgBtn = document.getElementById("cfgBtn");
const cfg = document.getElementById("cfg");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const saveCfg = document.getElementById("saveCfg");
const cfgHint = document.getElementById("cfgHint");

let busy = false;
let currentAssistant = null;
let currentReason = null;

function emptyHint() {
  log.innerHTML = `<div class="empty">Połącz SyntaxCoder z LM Studio (Developer → Local Server).<br/>
  Kliknij <strong>Połączenie</strong> i wpisz adres oraz port LM Studio.<br/><br/>
  Przykłady: „przejrzyj projekt”, „dodaj README”, „uruchom testy”.</div>`;
}
emptyHint();

function el(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild;
}

function md(text) {
  const parts = String(text).split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf("\n");
      const code = nl >= 0 ? parts[i].slice(nl + 1) : parts[i];
      html += `<pre><code>${esc(code)}</code></pre>`;
    } else {
      html += esc(parts[i])
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/^### (.+)$/gm, "<h3>$1</h3>")
        .replace(/^## (.+)$/gm, "<h2>$1</h2>")
        .replace(/^# (.+)$/gm, "<h1>$1</h1>")
        .replace(/\n/g, "<br/>");
    }
  }
  return html;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clearEmpty() {
  const e = log.querySelector(".empty");
  if (e) e.remove();
}

function addUser(text) {
  clearEmpty();
  log.appendChild(el(`<div class="msg user">${esc(text)}</div>`));
  log.scrollTop = log.scrollHeight;
}

function ensureAssistant() {
  if (!currentAssistant) {
    const node = el(`<div class="msg assistant"><span class="who">SyntaxCoder</span><div class="body"></div></div>`);
    log.appendChild(node);
    currentAssistant = node.querySelector(".body");
  }
  return currentAssistant;
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  switch (m.type) {
    case "cleared":
      currentAssistant = null;
      emptyHint();
      break;
    case "user":
      currentAssistant = null;
      currentReason = null;
      addUser(m.text);
      break;
    case "assistantDelta":
      ensureAssistant();
      currentAssistant.dataset.raw = (currentAssistant.dataset.raw || "") + m.text;
      currentAssistant.innerHTML = md(currentAssistant.dataset.raw);
      log.scrollTop = log.scrollHeight;
      break;
    case "reasoningDelta":
      if (!currentReason) {
        const node = el(`<div class="msg tool"><span class="who">rozumowanie</span><div class="body"></div></div>`);
        log.appendChild(node);
        currentReason = node.querySelector(".body");
      }
      currentReason.textContent += m.text;
      log.scrollTop = log.scrollHeight;
      break;
    case "assistantDone":
      currentAssistant = null;
      currentReason = null;
      break;
    case "toolPending": {
      currentAssistant = null;
      const card = el(`<div class="msg pending" data-id="${esc(m.id)}">
        <span class="who">wymaga zgody · ${esc(m.kind)}</span>
        <div><strong>${esc(m.name)}</strong></div>
        <pre>${esc(pretty(m.args))}</pre>
        <div class="actions">
          <button data-act="ok">Zezwól</button>
          <button class="ghost" data-act="no">Odrzuć</button>
        </div>
      </div>`);
      card.querySelector('[data-act="ok"]').onclick = () => {
        vscode.postMessage({ type: "approve", id: m.id });
        card.querySelector(".actions").remove();
      };
      card.querySelector('[data-act="no"]').onclick = () => {
        vscode.postMessage({ type: "deny", id: m.id });
        card.querySelector(".actions").remove();
      };
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
      break;
    }
    case "toolStart":
      currentAssistant = null;
      log.appendChild(
        el(`<div class="msg tool" id="t-${cssId(m.id)}">
          <span class="who">${esc(m.name)}</span>
          <pre>${esc(pretty(m.args))}</pre>
          <div class="out muted">…</div>
        </div>`)
      );
      log.scrollTop = log.scrollHeight;
      break;
    case "toolResult": {
      const node = document.getElementById(`t-${cssId(m.id)}`);
      if (node) {
        const out = node.querySelector(".out");
        out.textContent = m.preview || "(ok)";
      }
      break;
    }
    case "error":
      currentAssistant = null;
      log.appendChild(el(`<div class="msg error">${esc(m.message)}</div>`));
      log.scrollTop = log.scrollHeight;
      break;
    case "busy":
      busy = m.value;
      stop.hidden = !busy;
      send.disabled = busy;
      break;
    case "status":
      statusEl.textContent = m.connected ? (m.model || "ok") : "offline";
      statusEl.className = "pill " + (m.connected ? "on" : "off");
      statusEl.title = m.baseUrl || "";
      modelBtn.textContent = m.model ? short(m.model) : "model";
      if (m.host) hostInput.value = m.host;
      if (m.port) portInput.value = m.port;
      cfgHint.textContent = m.connected
        ? `Połączono: ${m.baseUrl}`
        : `Brak połączenia z ${m.baseUrl || "LM Studio"}`;
      break;
    case "prefill":
      input.value = m.text;
      input.focus();
      break;
  }
});

function pretty(args) {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args || "";
  }
}
function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}
function short(s) {
  const p = s.split("/");
  return p[p.length - 1].slice(0, 28);
}

function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  vscode.postMessage({ type: "chat", text });
}

send.onclick = submit;
stop.onclick = () => vscode.postMessage({ type: "stop" });
modelBtn.onclick = () => vscode.postMessage({ type: "pickModel" });
cfgBtn.onclick = () => {
  cfg.hidden = !cfg.hidden;
};
saveCfg.onclick = () => {
  vscode.postMessage({
    type: "saveConnection",
    host: hostInput.value,
    port: Number(portInput.value) || 1234,
  });
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

vscode.postMessage({ type: "ready" });

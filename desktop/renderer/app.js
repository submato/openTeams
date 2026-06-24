(() => {
const api = window.api;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmtMs = (ms) => { if (!ms || ms < 0) return "0秒"; const s = Math.round(ms / 1000); if (s < 60) return s + "秒"; return `${Math.floor(s / 60)}分${s % 60}秒`; };
const reasoningCN = (r) => ({ low: "低", medium: "中", high: "高" }[r] || "中");
const STATUS_CN = { pending_confirm: "待确认", pending: "待执行", running: "执行中", interrupted: "已中断", done: "执行完", failed: "失败" };
const BOARD_COLS = ["pending_confirm", "pending", "running", "interrupted", "done", "failed"];
const PHASE_CN = { plan: "规划中", tasks: "执行任务", review: "审查中" };
const REASON_CN = { app_quit: "退出应用", app_crash: "应用异常退出" };

// Lightweight transient toast (no dependency; auto-dismisses).
function toast(msg, kind = "info", ms = 5000) {
  let host = document.querySelector("#toasts");
  if (!host) {
    host = el("div", "toasts"); host.id = "toasts";
    // Announce toasts to assistive tech (errors/successes are otherwise silent).
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const t = el("div", "toast " + kind, esc(msg));
  // Errors deserve an assertive announcement so they aren't missed.
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const dismiss = () => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); };
  // Let the user clear a toast immediately instead of waiting out the timer —
  // useful when several stack up, or to dismiss a sticky (ms<=0) error toast.
  // addEventListener (not onclick) so callers can still attach their own action.
  t.addEventListener("click", dismiss);
  // ms <= 0 means "sticky": keep it until something dismisses it (used for
  // critical errors that need a deliberate user action rather than a timeout).
  if (ms > 0) setTimeout(dismiss, ms);
  return t;
}

// Copy a fenced code block's raw text. textContent decodes the HTML-escaped
// source back to the original code (entities → characters).
async function onCodeCopyClick(e) {
  const btn = e.target.closest ? e.target.closest(".md-copy") : null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const code = btn.parentElement && btn.parentElement.querySelector("pre code");
  const text = code ? code.textContent : "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = "已复制 ✓";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("done"); }, 1400);
  } catch { toast("复制失败", "error"); }
}

function rel(ts) {
  if (!ts) return "";
  const d = Date.now() - ts, m = Math.floor(d / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const dd = Math.floor(h / 24);
  if (dd < 30) return dd + " 天前";
  return new Date(ts).toLocaleDateString();
}
function fmtRel(ms) {
  if (ms <= 0) return "马上";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + " 秒后";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " 分后";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时 " + (m % 60) + " 分后";
  return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时后";
}

// ---- Markdown → HTML (escape-first, XSS-safe). Supports tables. ----
function mdToHtml(src) {
  const Z = "\uE000";
  let text = esc(src || "");
  const blocks = [];
  text = text.replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const body = code.replace(/\n$/, "");
    // Wrap fenced blocks so a one-click "复制" affordance can grab the raw code.
    blocks.push(`<div class="md-codewrap"><button class="md-copy" type="button" title="复制代码">复制</button><pre class="md-code"><code>${body}</code></pre></div>`);
    return Z + (blocks.length - 1) + Z;
  });
  // Autolink bare http(s) URLs, but never touch URLs already inside an <a> or
  // <code> span: split on those (capturing-group keeps them at odd indices) and
  // only linkify the plain-text segments. Trailing punctuation is peeled so
  // "(see http://x)" / "http://x." link cleanly.
  const linkifyBare = (s) => s
    .split(/(<a\b[^>]*>.*?<\/a>|<code>.*?<\/code>)/g)
    .map((seg, i) => (i % 2 ? seg : seg.replace(/https?:\/\/[^\s<]+/g, (m) => {
      let url = m, tail = "";
      const tm = url.match(/[.,;:!?)\]'"]+$/);
      if (tm) { tail = tm[0]; url = url.slice(0, -tail.length); }
      return `<a href="${url}" target="_blank">${url}</a>` + tail;
    })))
    .join("");
  const inline = (s) => linkifyBare(s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // GitHub-style strikethrough: ~~text~~ → <del>. LLM reports use it to mark
    // dropped/superseded items; otherwise it renders as literal tildes.
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>'));
  const lines = text.split("\n");
  const codeRe = new RegExp("^" + Z + "\\d+" + Z + "$");
  let html = "", list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], t = line.trim();
    if (codeRe.test(t)) { closeList(); html += t; continue; }
    // Thematic break: a line of 3+ dashes/asterisks/underscores → <hr/>. LLMs use
    // "---" as a section divider constantly; otherwise it renders as literal text.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); html += "<hr/>"; continue; }
    // table: header row + separator row
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(t);
      i++; // skip separator
      const rows = [];
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1].trim())) { i++; rows.push(cells(lines[i])); }
      const th = header.map((h) => `<th>${inline(h)}</th>`).join("");
      const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      html += `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lv = Math.min(3, h[1].length); html += `<h${lv}>${inline(h[2])}</h${lv}>`; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      // GitHub-style task list: "- [ ] todo" / "- [x] done" → a real (disabled)
      // checkbox instead of literal "[ ]" text. LLM plans/reports emit these a lot.
      const task = ul[1].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) html += `<li class="md-task"><input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}/><span>${inline(task[2])}</span></li>`;
      else html += `<li>${inline(ul[1])}</li>`;
      continue;
    }
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      // Preserve the first item's number so a list that resumes after some text
      // (e.g. "3. ...") doesn't silently restart at 1.
      if (list !== "ol") { closeList(); const start = parseInt(ol[1], 10); html += start > 1 ? `<ol start="${start}">` : "<ol>"; list = "ol"; }
      html += `<li>${inline(ol[2])}</li>`; continue;
    }
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) { closeList(); html += `<blockquote>${inline(bq[1])}</blockquote>`; continue; }
    if (t === "") { closeList(); continue; }
    closeList(); html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html.replace(new RegExp(Z + "(\\d+)" + Z, "g"), (_, n) => blocks[+n]);
}

// ---- state ----
let META = { tools: [], models: [], home: "" };
let SETTINGS = { cautious: false };
let SCHEDULE = { enabled: false, mode: "interval", everyHours: 6, dailyAt: "09:00", source: "ideas", prompt: "", lastRunAt: 0, nextRunAt: 0, log: [] };
let IDEAS = [];
let WS = [];
let chatHistory = [];
let chatLive = null;
let chatInflight = null;        // { statusLabel, status, stream, startedAt } — survives tab switches
let chatTick = null;            // 1s interval keeping the elapsed-time readout live
// Restore the last-used mode so a reload/relaunch keeps the user's choice
// (mirrors the persisted draft + panel prefs); fall back to "auto" if unset
// or somehow invalid.
let chatMode = (() => {
  let m = "auto";
  try { m = localStorage.getItem("chatMode") || "auto"; } catch {}
  return ["auto", "chat", "task"].includes(m) ? m : "auto";
})();          // "auto" = 自动判断 | "chat" = 只聊天 | "task" = 派活拟计划
let activeSessionId = null;
let editing = null;
let detailIdeaId = null;
let detailDocDirty = false;
let detailIdea = null;
let cardChatLive = null;
let cardChatInflight = false;

const isView = (v) => { const e = document.querySelector('.view[data-view="' + v + '"]'); return e && e.classList.contains("active"); };
// Views worth restoring after a reload/relaunch. "editor" is excluded: it only
// makes sense with a live `editing` selection that doesn't survive a reload.
const RESTORABLE_VIEWS = ["chat", "board", "schedule", "agents", "skills", "runs", "objectives", "usage", "settings"];

// ---------------------------------------------------------------- init
async function init() {
  // Load environment + persisted state best-effort. A single corrupt data file
  // or a flaky IPC call must NOT abort init and leave a blank, unusable screen:
  // fall back to the in-memory defaults and let the UI bind/render anyway (each
  // view re-fetches its own data on open, so this degrades gracefully).
  try {
    const env = await api.envStatus();
    $("#envDot").classList.toggle("ok", env.hasKey);
    $("#envText").textContent = env.hasKey ? "Key 已加载" : "缺少 Key";
    $("#setKey").textContent = env.hasKey ? "已加载 ✓" : "缺失（在 Application Support/ai-team/.env 设置）";
    META = await api.getMeta();
    SETTINGS = await api.getSettings();
    $("#setNoConfirm").checked = !SETTINGS.cautious;
    $("#setWsBase").value = SETTINGS.workspaceBase || "~";
    SCHEDULE = await api.getSchedule();
  } catch (e) {
    console.error("初始化加载失败，使用默认值继续", e);
    toast("部分设置加载失败，已用默认值继续。", "warn", 7000);
  }

  bindNav(); bindChat(); bindBoard(); bindSchedule(); bindAgents(); bindEditor(); bindSettings(); bindDetail(); bindSkills(); bindObjectives();
  // Single delegated handler so every markdown-rendered code block (chat, docs,
  // reports, artifacts) gets a working copy button without re-binding per render.
  document.addEventListener("click", onCodeCopyClick);
  api.onCeoEvent(handleCeoEvent);
  api.onCardEvent(handleCardEvent);
  api.onCrewEvent(handleCrewEvent);
  api.onSchedEvent(handleSchedEvent);
  setInterval(tickAutoStatus, 1000);
  reflectSchedDot();

  try {
    await refreshIdeas();
    const interrupted = IDEAS.filter((i) => i.status === "interrupted").length;
    if (interrupted > 0) toast(`有 ${interrupted} 个任务上次被中断，可在看板「已中断」里继续或重跑。`, "warn", 8000);
  } catch (e) { console.error("看板数据加载失败", e); }
  // Reopen the last view (mirrors the persisted chat mode / draft / panel prefs)
  // so a reload or self-heal relaunch doesn't yank the user back to chat.
  let startView = "chat";
  try { const v = localStorage.getItem("activeView"); if (RESTORABLE_VIEWS.includes(v)) startView = v; } catch {}
  show(startView);
}

function bindNav() {
  $$(".nav-item").forEach((n) => (n.onclick = () => show(n.dataset.view)));
}
function show(view) {
  // Remember the last real view so a reload/relaunch can reopen it. The transient
  // "editor" view is skipped — it has no meaning without a live selection.
  if (RESTORABLE_VIEWS.includes(view)) { try { localStorage.setItem("activeView", view); } catch {} }
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  if (view === "chat") { safeRender(renderChat, "对话"); focusComposer(); }
  if (view === "board") safeRender(renderBoard, "看板");
  if (view === "schedule") safeRender(renderSchedule, "定时");
  if (view === "agents") safeRender(renderAgents, "员工");
  if (view === "skills") safeRender(renderSkills, "技能");
  if (view === "runs") safeRender(renderRuns, "运行记录");
  if (view === "objectives") safeRender(renderObjectives, "目标循环");
  if (view === "usage") safeRender(renderUsage, "用量");
}
// Run a (possibly async) view renderer without letting a single failed IPC/render
// blank the view or surface as an unhandled rejection: log it and tell the user
// the view failed to load (each view re-fetches on next open, so this recovers).
function safeRender(fn, label) {
  Promise.resolve().then(fn).catch((e) => {
    console.error(`${label}视图渲染失败`, e);
    toast(`${label}加载失败，请稍后重试。`, "error", 6000);
  });
}

async function refreshIdeas() {
  IDEAS = await api.ideasList();
  WS = await api.listWorkspaces();
  updateBoardBadge();
  if (isView("board")) renderBoardColumns();
}
function updateBoardBadge() {
  const n = IDEAS.filter((i) => ["pending_confirm", "pending", "running", "interrupted"].includes(i.status)).length;
  const b = $("#boardBadge"); b.textContent = n; b.classList.toggle("on", n > 0);
}

// ---------------------------------------------------------------- chat
function bindChat() {
  setSendingUI(false);
  const ta = $("#chatInput");
  ta.addEventListener("keydown", (e) => {
    // Ignore Enter while an IME is composing (e.g. selecting a Chinese candidate).
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); chatSend(); }
  });
  // Persist the unsent draft so a reload/crash/navigation never loses what was typed.
  ta.addEventListener("input", () => { autoGrow(); saveChatDraft(); });
  restoreChatDraft();
  $("#newSession").onclick = async () => { await api.ceoSessionCreate(); await renderChat(); focusComposer(); };
  $("#chatPanelToggle").onclick = () => {
    const c = localStorage.getItem("chatPanelCollapsed") === "1";
    localStorage.setItem("chatPanelCollapsed", c ? "0" : "1");
    applyChatPrefs();
  };
  $("#chatSideToggle").onclick = () => {
    const r = localStorage.getItem("chatPanelSide") === "right";
    localStorage.setItem("chatPanelSide", r ? "left" : "right");
    applyChatPrefs();
  };
  applyChatPrefs();
  const log = $("#chatLog");
  if (log) log.addEventListener("scroll", updateChatJump);
  $("#chatJump").onclick = () => { const l = $("#chatLog"); l.scrollTop = l.scrollHeight; updateChatJump(); };
  $$("#modeSeg .seg").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  setMode(chatMode);
}
// Show the "jump to latest" affordance only while scrolled up away from the bottom.
function updateChatJump() {
  const btn = $("#chatJump");
  if (btn) btn.classList.toggle("show", !chatNearBottom());
}
function setMode(mode) {
  chatMode = mode;
  try { localStorage.setItem("chatMode", mode); } catch {}
  $$("#modeSeg .seg").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  if (mode === "task") {
    $("#modeHint").textContent = "锁定派活：这条一定拟成执行文档 → 看板「待执行」";
    $("#chatInput").placeholder = "描述要做的事，例如「做一个把 git 提交整理成周报的小工具」";
  } else if (mode === "chat") {
    $("#modeHint").textContent = "锁定聊天：只给建议、绝不建计划";
    $("#chatInput").placeholder = "跟 Elon 聊点什么、问问建议… Enter 发送 · Shift+Enter 换行";
  } else {
    $("#modeHint").textContent = "自动判断：该聊就聊，该派活就派活（拿不准会先聊）";
    $("#chatInput").placeholder = "说点什么 —— 问建议或交代任务都行，我自己判断";
  }
}
function applyChatPrefs() {
  const layout = document.querySelector(".chat-layout");
  if (!layout) return;
  layout.classList.toggle("collapsed", localStorage.getItem("chatPanelCollapsed") === "1");
  layout.classList.toggle("side-right", localStorage.getItem("chatPanelSide") === "right");
}
function autoGrow() { const t = $("#chatInput"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; }
// Put the cursor in the composer when entering the chat or starting a new
// session, so the user can type right away instead of having to click in first.
// Never steal focus while the detail modal is open (it has its own editor).
function focusComposer() {
  const detail = $("#detail");
  if (detail && !detail.classList.contains("hidden")) return;
  const ta = $("#chatInput");
  if (!ta) return;
  requestAnimationFrame(() => {
    try { ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n); } catch {}
  });
}
function saveChatDraft() { try { localStorage.setItem("chatDraft", $("#chatInput").value || ""); } catch {} }
function clearChatDraft() { try { localStorage.removeItem("chatDraft"); } catch {} }
function restoreChatDraft() {
  let d = "";
  try { d = localStorage.getItem("chatDraft") || ""; } catch {}
  if (!d) return;
  const ta = $("#chatInput");
  if (ta && !ta.value) { ta.value = d; autoGrow(); }
}
function groupSessions(sessions) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  const g = { today: [], yesterday: [], week: [], month: [], older: [] };
  for (const s of sessions) {
    const t = s.updatedAt || 0;
    if (t >= startOfToday) g.today.push(s);
    else if (t >= startOfToday - day) g.yesterday.push(s);
    else if (t >= startOfToday - 7 * day) g.week.push(s);
    else if (t >= startOfToday - 30 * day) g.month.push(s);
    else g.older.push(s);
  }
  return g;
}
function sessionItem(x, activeId) {
  const it = el("div", "session-item" + (x.id === activeId ? " active" : ""));
  it.innerHTML =
    `<svg class="si-ico" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>` +
    `<span class="si-title">${esc(x.title || "新对话")}</span>` +
    `<span class="si-count">${x.count || ""}</span>` +
    `<button class="si-del" title="删除对话">✕</button>`;
  it.onclick = () => switchSession(x.id);
  it.querySelector(".si-del").onclick = async (e) => {
    e.stopPropagation();
    if (!confirm("删除这个对话？")) return;
    await api.ceoSessionDelete(x.id);
    await renderChat();
  };
  return it;
}
async function switchSession(id) {
  if (id === activeSessionId) return;
  // Use a toast, not #chatStatus: that line is refreshed every second by the
  // live ticker and would swallow this hint within ~1s, so the user would never
  // learn why their click was ignored.
  if (chatInflight) { toast("等 Elon 回完这条再切换对话", "warn"); return; }
  await api.ceoSessionSet(id);
  await renderChat();
}
async function renderSessions() {
  const s = await api.ceoSessions();
  activeSessionId = s.activeId;
  const list = $("#sessionList"); list.innerHTML = "";
  const g = groupSessions(s.sessions);
  const order = [["today", "今天"], ["yesterday", "昨天"], ["week", "过去 7 天"], ["month", "过去 30 天"], ["older", "更早"]];
  for (const [key, label] of order) {
    if (!g[key].length) continue;
    list.appendChild(el("div", "session-group", label));
    for (const x of g[key]) list.appendChild(sessionItem(x, s.activeId));
  }
}
async function renderChat() {
  await renderSessions();
  if (chatInflight) return;
  chatHistory = await api.ceoHistory();
  const log = $("#chatLog"); log.innerHTML = "";
  if (!chatHistory.length) { chatWelcome(); return; }
  for (const m of chatHistory) addMsg(m.role, m.text);
  maybeOfferRetry();
}
function maybeOfferRetry() {
  const last = chatHistory[chatHistory.length - 1];
  if (!last) return;
  // Offer a one-click resend either when the last message is an unanswered user
  // message, or when the turn ended in an error — the error text promises the
  // message is preserved and "可重发", so surface an actual control to do so.
  const isErr = last.role === "system" && /^出错/.test(last.text || "");
  if (last.role !== "user" && !isErr) return;
  const lastUser = chatHistory.slice().reverse().find((m) => m.role === "user");
  if (!lastUser || !(lastUser.text || "").trim()) return;
  const row = el("div", "msg system");
  const label = isErr ? "上一条没发成功。" : "上条消息没有收到回复。";
  row.innerHTML = esc(label) + '<button class="btn ghost sm" style="margin-left:8px">重发</button>';
  row.querySelector("button").onclick = () => { $("#chatInput").value = lastUser.text; chatSend(); };
  $("#chatLog").appendChild(row);
}
function chatWelcome() {
  addMsg("system", "我是 Elon（CEO）。抛个目标，我会拟一份执行文档放到看板「待执行」，你点执行（或直接说「干吧」）我就带团队落地。");
}
function addMsg(role, text) {
  const log = $("#chatLog");
  const m = el("div", "msg " + role);
  if (role.indexOf("assistant") !== -1) m.innerHTML = mdToHtml(text); else m.textContent = text;
  log.appendChild(m); log.scrollTop = log.scrollHeight;
  return m;
}
// True when a chat log is scrolled to (or near) the bottom. Used so live
// streaming only auto-scrolls when the user is already following along — if they
// scrolled up to re-read something, incoming tokens won't yank them back down.
// Defaults to the main chat log; pass another element to reuse for card chat.
function chatNearBottom(log) {
  log = log || $("#chatLog");
  if (!log) return true;
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}
function docBubble(bubble, idea) {
  const status = idea.status || "pending";
  bubble.className = "msg assistant doc";
  bubble.innerHTML =
    `<div class="doc-head"><span class="doc-ico">📋</span><span>执行文档</span><span class="cstat ${status}" style="margin-left:auto">${STATUS_CN[status] || status}</span></div>` +
    `<div class="doc-body md">${mdToHtml(idea.doc || idea.text)}</div>` +
    `<div class="doc-foot"></div>`;
  const foot = bubble.querySelector(".doc-foot");
  if (status === "pending_confirm") {
    const go = el("button", "btn primary sm", "✓ 确认并排期");
    go.onclick = async () => {
      go.disabled = true;
      await api.ideaConfirm(idea.id);
      idea.status = "pending";
      const chip = bubble.querySelector(".cstat");
      if (chip) { chip.className = "cstat pending"; chip.textContent = "待执行"; }
      go.remove();
      await refreshIdeas();
    };
    foot.appendChild(go);
  } else if (status === "pending") {
    const go = el("button", "btn primary sm", "▶ 立即执行");
    go.onclick = () => { go.disabled = true; execIdea(idea.id); };
    foot.appendChild(go);
  }
  const v = el("button", "btn ghost sm", "在看板查看");
  v.onclick = () => show("board");
  foot.appendChild(v);
}
function setSendingUI(on) {
  const btn = $("#chatSend");
  if (on) { btn.textContent = "■ 停止"; btn.classList.remove("primary"); btn.classList.add("danger"); btn.onclick = cancelChat; }
  else { btn.textContent = "发送"; btn.classList.remove("danger"); btn.classList.add("primary"); btn.onclick = chatSend; }
}
// Render the status line as "<base>… <N>s". `base` is the current phase
// (thinking / planning / investigating / delegating), elapsed time is derived
// from startedAt so a live ticker can refresh it without any incoming event.
function renderChatStatus() {
  if (!chatInflight) return;
  const node = $("#chatStatus");
  if (!node) return;
  const sec = Math.floor((Date.now() - chatInflight.startedAt) / 1000);
  const base = chatInflight.status || chatInflight.statusLabel || "思考中";
  node.textContent = `${base}… ${sec}s`;
}
// Keep the seconds counter advancing even while the model is silent (e.g. mid
// tool call) so a working run never looks frozen/hung.
function startChatTick() { stopChatTick(); chatTick = setInterval(renderChatStatus, 1000); }
function stopChatTick() { if (chatTick) { clearInterval(chatTick); chatTick = null; } }
async function cancelChat() {
  if (chatInflight) chatInflight.status = "停止中";
  $("#chatStatus").textContent = "停止中…";
  await api.ceoCancel();   // backend cancels the run; ceoSend then resolves with partial
}
async function chatSend() {
  const msg = $("#chatInput").value.trim();
  if (!msg || chatInflight) return;
  $("#chatInput").value = ""; autoGrow(); clearChatDraft();
  const sendHistory = chatHistory.slice();
  addMsg("user", msg);
  chatHistory.push({ role: "user", text: msg });
  await api.ceoSaveHistory(chatHistory);

  const statusLabel = chatMode === "task" ? "拟计划中" : "思考中";
  const thinking = chatMode === "task" ? "Elon 正在拟执行文档…" : "Elon 正在思考…";
  const bubble = addMsg("assistant typing", thinking);
  bubble._stream = "";
  chatLive = bubble;
  chatInflight = { statusLabel, status: statusLabel, stream: "", startedAt: Date.now() };
  setSendingUI(true);
  startChatTick();
  renderChatStatus();
  let res;
  try {
    res = await api.ceoSend(sendHistory, msg, chatMode);
  } catch (err) {
    res = { ok: false, error: err.message || String(err) };
  } finally {
    stopChatTick();
    chatInflight = null;
    chatLive = null;
    setSendingUI(false);
    $("#chatStatus").textContent = "";
  }
  if (!res || !res.ok) {
    // Preserve any half-written reply that already streamed — don't lose it.
    const partial = (res && res.text && res.text.trim())
      ? res.text.trim()
      : (bubble && bubble._stream && bubble._stream.trim() ? bubble._stream.trim() : "");
    if (partial) chatHistory.push({ role: "assistant", text: partial });
    const errText = "出错：" + ((res && res.error) || "未知错误") + (partial ? "（上面是中断前已写出的部分，可重发续写）" : "（你的消息已保留，可重发）");
    chatHistory.push({ role: "system", text: errText });
    await api.ceoSaveHistory(chatHistory);
    await renderChat();
    return;
  }

  let recorded;
  if (res.mode === "capture" || res.mode === "delegate") {
    docBubble(bubble, res.idea);
    recorded = res.idea.doc || res.idea.text;
    addMsg("system", res.mode === "delegate"
      ? (res.cancelled ? "团队任务已取消" : `「${res.wsName || "项目"}」团队完成${res.verdict ? ` · 结论 ${res.verdict}` : ""}`)
      : "已拟好计划，放进看板「待确认」。确认后才会进入「待执行」交给团队。").appendChild(boardLink());
    await refreshIdeas();
  } else {
    bubble.classList.remove("typing");
    const finalText = (res.text && res.text.trim())
      ? res.text
      : (bubble._stream && bubble._stream.trim() ? bubble._stream : "（已停止）");
    bubble.innerHTML = mdToHtml(finalText);
    recorded = finalText;
  }
  chatHistory.push({ role: "assistant", text: recorded });
  if (chatHistory.length > 60) chatHistory = chatHistory.slice(-60);
  await api.ceoSaveHistory(chatHistory);
  await renderSessions();
}
function boardLink() { const s = el("span", "mini-link", "▶ 看板"); s.onclick = () => show("board"); return s; }

function handleCeoEvent(ev) {
  if (chatLive) {
    // Capture intent BEFORE mutating the bubble: only follow the stream if the
    // user is already at the bottom, so reading scrolled-up text isn't disrupted.
    const stick = chatNearBottom();
    if (ev.kind === "planning") chatLive.textContent = "Elon 正在拟执行文档…";
    else if (ev.kind === "doc" && ev.idea) docBubble(chatLive, ev.idea);
    else if (ev.kind === "delegate") { if (chatInflight) chatInflight.status = "团队执行中"; }
    else if (ev.kind === "tool") {
      if (chatInflight) chatInflight.status = "调查中";
      if (!chatLive._stream) chatLive.textContent = "🔍 " + (ev.name || "查看资料") + (ev.status ? " · " + ev.status : "");
    } else if (ev.kind === "text" && ev.text) {
      if (chatInflight) chatInflight.status = chatInflight.statusLabel;
      chatLive.classList.remove("typing");
      chatLive._stream = ev.text;
      if (chatInflight) chatInflight.stream = ev.text;
      chatLive.textContent = ev.text;
    }
    renderChatStatus();
    if (stick) $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
    updateChatJump();
  }
  if (ev.kind === "status" || ev.kind === "doc" || ev.kind === "delegate") refreshIdeas();
}

// ---------------------------------------------------------------- board / kanban
function bindBoard() {
  $("#boardRefresh").onclick = refreshIdeas;
  // Drop targets: only the pre-run / running lanes (done & failed are outcomes).
  for (const st of ["pending_confirm", "pending", "running"]) {
    const body = $("#col-" + st);
    if (!body) continue;
    body.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; body.classList.add("drag-over"); });
    body.addEventListener("dragleave", (e) => { if (e.target === body) body.classList.remove("drag-over"); });
    body.addEventListener("drop", (e) => {
      e.preventDefault(); body.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (id) dropIdea(id, st);
    });
  }
}
async function dropIdea(id, toStatus) {
  const it = IDEAS.find((x) => x.id === id);
  if (!it || it.status === toStatus || it.status === "running") return;
  if (toStatus === "running") { await execIdea(id); return; }            // drag → 执行中 = 立即派团队
  await api.ideaSetStatus(id, toStatus);                                  // 待确认 / 待执行 之间移动（含失败/完成→重排）
  await refreshIdeas();
}
async function renderBoard() {
  IDEAS = await api.ideasList();
  WS = await api.listWorkspaces();
  renderBoardColumns();
  updateBoardBadge();
}
function emptyHint(st) {
  return {
    pending_confirm: "没有待确认的计划。\n去「与 CEO 对话」交代个任务。",
    pending: "没有已确认待执行的卡片。\n在「待确认」里点 ✓ 确认。",
    running: "暂无执行中的任务。",
    interrupted: "没有被中断的任务 👍",
    done: "还没有完成的卡片。",
    failed: "没有失败的卡片 👍",
  }[st] || "空";
}
function renderBoardColumns() {
  for (const st of BOARD_COLS) {
    const col = $("#col-" + st); col.innerHTML = "";
    const items = IDEAS.filter((i) => i.status === st);
    $("#cnt-" + st).textContent = items.length;
    if (!items.length) { col.appendChild(el("div", "kcol-empty", esc(emptyHint(st)).replace(/\n/g, "<br/>"))); continue; }
    for (const it of items) col.appendChild(ideaCard(it));
  }
}
function ideaCard(it) {
  const card = el("div", "kcard " + it.status); card.dataset.id = it.id;
  const ws = WS.find((w) => w.id === it.projectId);
  const proj = ws ? `<span class="tag">${ws.emoji || "📁"} ${esc(ws.name)}</span>` : "";
  const verdict = it.verdict ? `<span class="badge ${it.verdict}">${it.verdict}</span>` : "";
  const time = `<span class="tag">${rel(it.createdAt)}</span>`;
  let live = "", err = "", acts = "";
  if (it.status === "running") {
    live = `<div class="kcard-live"><span class="spinner"></span><span class="kcard-live-txt">${esc(progressLabel(it))}</span></div>`;
    acts = `<button class="kbtn danger" data-act="stop">停止</button>`;
  } else if (it.status === "interrupted") {
    const p = it.progress, prog = p && p.total ? `已完成 ${p.done}/${p.total} 个任务` : "尚未产出";
    const why = REASON_CN[it.reason] || "已中断";
    err = `<div class="kcard-warn">⚠ ${esc(why)} · ${esc(prog)}</div>`;
    acts = `<button class="kbtn primary" data-act="resume">▶ 继续</button><button class="kbtn" data-act="rerun">↻ 重跑</button><button class="kbtn" data-act="artifacts">产物</button><button class="kbtn" data-act="report">📋 进度</button><button class="kbtn ghost" data-act="discard">放回待执行</button>`;
  } else if (it.status === "pending_confirm") {
    acts = `<button class="kbtn primary" data-act="confirm">✓ 确认</button><button class="kbtn" data-act="doc">📋 文档</button><button class="kbtn ghost" data-act="del">✕</button>`;
  } else if (it.status === "pending") {
    acts = `<button class="kbtn primary" data-act="exec">▶ 执行</button><button class="kbtn" data-act="doc">📋 文档</button><button class="kbtn ghost" data-act="del">✕</button>`;
  } else if (it.status === "done") {
    acts = `<button class="kbtn primary" data-act="artifacts">产物</button><button class="kbtn" data-act="report">📋 报告</button><button class="kbtn" data-act="doc">文档</button><button class="kbtn ghost" data-act="del">✕</button>`;
  } else if (it.status === "failed") {
    err = it.error ? `<div class="kcard-err">${esc(it.error)}</div>` : "";
    acts = `${it.runId ? `<button class="kbtn primary" data-act="resume">▶ 从失败处继续</button>` : `<button class="kbtn primary" data-act="retry">↻ 重试</button>`}<button class="kbtn" data-act="rerun">↻ 重跑</button><button class="kbtn" data-act="timeline">过程</button><button class="kbtn" data-act="artifacts">产物</button><button class="kbtn" data-act="doc">📋 文档</button><button class="kbtn ghost" data-act="del">✕</button>`;
  }
  card.innerHTML = `<div class="kcard-title">${esc(it.text)}</div><div class="kcard-meta">${proj}${verdict}${time}</div>${live}${err}<div class="kcard-acts">${acts}</div>`;
  if (it.status !== "running" && it.status !== "interrupted") {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  }
  card.querySelector(".kcard-title").onclick = () => openDetail(it, "doc");
  card.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const a = btn.dataset.act;
      if (a === "confirm") { btn.disabled = true; confirmIdea(it.id); }
      else if (a === "exec" || a === "retry") { btn.disabled = true; execIdea(it.id); }
      else if (a === "doc") openDetail(it, "doc");
      else if (a === "report") openDetail(it, "report");
      else if (a === "timeline") openDetail(it, "timeline");
      else if (a === "artifacts") openDetail(it, "artifacts");
      else if (a === "del") delIdea(it.id);
      else if (a === "stop") stopIdea(it);
      else if (a === "resume") { btn.disabled = true; resumeIdea(it); }
      else if (a === "rerun") { btn.disabled = true; rerunIdea(it); }
      else if (a === "discard") discardIdea(it.id);
    };
  });
  return card;
}
async function confirmIdea(id) {
  if (detailIdeaId === id && detailDocDirty) await saveDetailDoc();
  await api.ideaConfirm(id);
  await refreshIdeas();
}
async function execIdea(id) {
  if (detailIdeaId === id && detailDocDirty) await saveDetailDoc();
  await api.ideaExecute(id);
  await refreshIdeas();
}
async function stopIdea(it) {
  const cancelled = it.projectId ? await api.cancelCrew(it.projectId) : false;
  // No live run (e.g. orphaned after an app restart) → unstick the card.
  if (!cancelled) await api.ideaSetStatus(it.id, "pending");
  await refreshIdeas();
}
async function delIdea(id) {
  // Deleting a card is irreversible and (for done/failed cards) also throws away
  // its run report and extracted artifacts — yet it was the one destructive
  // delete with no guard, unlike sessions/agents/objectives. Confirm first, and
  // make the prompt aware of what's actually at stake.
  const it = IDEAS.find((x) => x.id === id);
  const title = (it && (it.text || "").trim()) || "这张卡片";
  const losesRun = it && (it.status === "done" || it.status === "failed");
  const msg = `删除卡片「${title.slice(0, 50)}」？`
    + (losesRun ? "\n它的运行报告和产物也会一并删除，无法恢复。" : "");
  if (!confirm(msg)) return;
  await api.ideaRemove(id);
  await refreshIdeas();
}
function progressLabel(it) {
  const p = it.progress;
  if (it.phase === "review") return "审查中…";
  if (p && p.total) return `${p.current ? p.current + "：" : ""}任务 ${p.done}/${p.total}`;
  return PHASE_CN[it.phase] || "执行中…";
}
// Phase C: warn before running on top of uncommitted changes in the workspace.
async function confirmIfDirty(id, verb) {
  try {
    const g = await api.ideaGitStatus(id);
    if (g && g.repo && g.dirty > 0) {
      return confirm(`工作区有 ${g.dirty} 个未提交的改动。\n${verb}可能覆盖这些改动，建议先提交或备份。\n\n仍要${verb}？`);
    }
  } catch {}
  return true;
}
async function resumeIdea(it) {
  if (!(await confirmIfDirty(it.id, "继续执行"))) { await refreshIdeas(); return; }
  const r = await api.ideaResume(it.id);
  if (r && !r.ok && r.error) toast(r.error, "error");
  await refreshIdeas();
}
async function rerunIdea(it) {
  if (!confirm("重跑会丢弃已完成的中间产出，从头开始。确定？")) return;
  if (!(await confirmIfDirty(it.id, "重跑"))) { await refreshIdeas(); return; }
  const r = await api.ideaRerun(it.id);
  if (r && !r.ok && r.error) toast(r.error, "error");
  await refreshIdeas();
}
async function discardIdea(id) {
  await api.ideaDiscard(id);
  await refreshIdeas();
}

function handleCrewEvent(ev) {
  if (ev && ev.objectiveId) { objHandleEvent(ev); return; }
  const txt = document.querySelector(".kcard.running .kcard-live-txt");
  if (txt) {
    if (ev.type === "plan-start") txt.textContent = "指挥官规划中…";
    else if (ev.type === "plan-done") txt.textContent = "已拆解 " + (ev.tasks ? ev.tasks.length : 0) + " 个任务";
    else if (ev.type === "task-start") txt.textContent = (ev.agent || "") + "：" + ((ev.task && ev.task.title) || "");
    else if (ev.type === "task-stream") { if (ev.kind === "tool") txt.textContent = "调用 " + (ev.name || ""); else if (ev.kind === "text") txt.textContent = (ev.text || "").slice(0, 70); }
    else if (ev.type === "review-start") txt.textContent = "审查中…";
    else if (ev.type === "task-done") txt.textContent = "完成一个任务";
  }
  if (ev.type === "done" || ev.type === "cancelled" || ev.type === "error") refreshIdeas();
}

// ---------------------------------------------------------------- detail modal
function bindDetail() {
  $("#dtClose").onclick = () => closeDetail();
  $("#detail").onclick = (e) => { if (e.target.id === "detail") closeDetail(); };
  $$(".mtab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  $("#dtDocSave").onclick = () => saveDetailDoc();
  $("#dtDocEditor").addEventListener("input", () => { detailDocDirty = true; updateDocSaveHint(); });
  $("#dtCopyId").onclick = async () => {
    if (!detailIdeaId) return;
    try { await navigator.clipboard.writeText(detailIdeaId); } catch {}
    const b = $("#dtCopyId"); const t = b.textContent; b.textContent = "已复制 ✓";
    setTimeout(() => { b.textContent = t; }, 1200);
  };
  $("#dtChatSend").onclick = () => cardChatSend();
  $("#dtChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); cardChatSend(); }
  });
  document.addEventListener("keydown", (e) => {
    if ($("#detail").classList.contains("hidden")) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveDetailDoc(); }
    // Escape closes the modal (standard dialog behavior); closeDetail() still
    // guards unsaved doc edits with a confirm, so nothing is silently lost.
    else if (e.key === "Escape") { e.preventDefault(); closeDetail(); }
  });
}
function updateDocSaveHint() {
  $("#dtDocSave").disabled = !detailDocDirty;
  $("#dtDocHint").textContent = detailDocDirty ? "有未保存的修改 · ⌘S 保存" : "已保存";
}
async function closeDetail() {
  if (detailDocDirty && !confirm("执行文档有未保存的修改，确定关闭？")) return;
  $("#detail").classList.add("hidden");
  detailIdeaId = null;
  detailIdea = null;
  detailDocDirty = false;
}

// ---- Per-card CEO chat (in the detail modal) ----
function stripCardMarkers(t) {
  return String(t || "").replace(/\[\[CARD_(TITLE|DOC|STATUS)\]\][\s\S]*?\[\[\/CARD_\1\]\]/g, "").trim();
}
function appendCardMsg(role, text) {
  const log = $("#dtChatLog");
  const b = el("div", "cc-msg " + role);
  b.innerHTML = role.includes("assistant") ? mdToHtml(text || "") : esc(text || "");
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
  return b;
}
function renderCardChat(it) {
  const log = $("#dtChatLog");
  log.innerHTML = "";
  const chat = (it && it.chat) || [];
  if (!chat.length) {
    log.innerHTML = `<div class="cc-empty">和 CEO 聊这张卡。它能读你的现有成果，并直接改这张卡的标题 / 执行文档 / 状态。</div>`;
  } else {
    chat.forEach((m) => appendCardMsg(m.role === "user" ? "user" : "assistant", m.text));
  }
  $("#dtChatStatus").textContent = "";
}
function handleCardEvent(ev) {
  if (!cardChatLive || !ev || ev.ideaId !== cardChatLive.id) return;
  const b = cardChatLive.bubble;
  if (ev.kind === "tool") {
    $("#dtChatStatus").textContent = "调查中…" + (ev.name ? "（" + ev.name + "）" : "");
  } else if (ev.kind === "text" && ev.text) {
    // Capture intent BEFORE mutating the bubble: only follow the stream if the
    // user is already at the bottom, so reading scrolled-up text isn't disrupted
    // (mirrors the main chat's scroll-aware streaming).
    const log = $("#dtChatLog");
    const stick = chatNearBottom(log);
    b.classList.remove("typing");
    b._stream = ev.text;
    b.innerHTML = mdToHtml(stripCardMarkers(ev.text));
    if (stick && log) log.scrollTop = log.scrollHeight;
  }
}
async function cardChatSend() {
  const input = $("#dtChatInput");
  const msg = input.value.trim();
  if (!msg || !detailIdeaId || cardChatInflight) return;
  const id = detailIdeaId;
  input.value = "";
  if ($("#dtChatLog .cc-empty")) $("#dtChatLog").innerHTML = "";
  appendCardMsg("user", msg);
  const history = (detailIdea && detailIdea.chat) ? detailIdea.chat.slice() : [];
  const bubble = appendCardMsg("assistant typing", "CEO 正在看这张卡…");
  bubble._stream = "";
  cardChatLive = { id, bubble };
  cardChatInflight = true;
  $("#dtChatSend").disabled = true;
  $("#dtChatStatus").textContent = "思考中…";
  let res;
  try { res = await api.cardChat(id, history, msg); }
  catch (err) { res = { ok: false, error: err.message || String(err) }; }
  finally {
    cardChatInflight = false;
    cardChatLive = null;
    $("#dtChatSend").disabled = false;
    $("#dtChatStatus").textContent = "";
  }
  bubble.classList.remove("typing");
  if (!res || !res.ok) {
    const partial = (res && res.text && res.text.trim()) ? res.text.trim() : stripCardMarkers(bubble._stream || "");
    bubble.innerHTML = mdToHtml(partial || "（没有内容）");
    // Unlike the main chat, card chat isn't persisted on failure, so the typed
    // message would be lost. Restore it to the (empty) composer so the user can
    // resend without retyping — never drop written content.
    if (!input.value.trim()) { input.value = msg; }
    appendCardMsg("system", "出错：" + ((res && res.error) || "未知错误") + "（你的消息已放回输入框，可重发）");
    return;
  }
  bubble.innerHTML = mdToHtml(res.text || "（无回复）");
  if (res.idea) detailIdea = res.idea;
  const applied = res.applied || {};
  const parts = [];
  if (applied.text) parts.push("标题");
  if (applied.doc) parts.push("执行文档");
  if (applied.status) parts.push("状态");
  if (parts.length) {
    appendCardMsg("system", "✅ 已更新这张卡的" + parts.join("、"));
    if (res.idea) {
      $("#dtTitle").textContent = res.idea.text || "";
      if (!detailDocDirty) { $("#dtDocEditor").value = res.idea.doc || ""; updateDocSaveHint(); }
    }
    await refreshIdeas();
  }
}
function switchTab(tab) {
  $$(".mtab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#dtDocPane").classList.toggle("hidden", tab !== "doc");
  $("#dtDocFoot").classList.toggle("hidden", tab !== "doc");
  $("#dtChat").classList.toggle("hidden", tab !== "chat");
  $("#dtReport").classList.toggle("hidden", tab !== "report");
  $("#dtTimeline").classList.toggle("hidden", tab !== "timeline");
  $("#dtArtifacts").classList.toggle("hidden", tab !== "artifacts");
  if (tab === "chat") setTimeout(() => $("#dtChatInput").focus(), 0);
}
async function saveDetailDoc() {
  if (!detailIdeaId || !detailDocDirty) return;
  const doc = $("#dtDocEditor").value;
  await api.ideaUpdate(detailIdeaId, { doc });
  detailDocDirty = false;
  updateDocSaveHint();
  await refreshIdeas();
}
async function openDetail(it, tab) {
  detailIdeaId = it.id;
  detailIdea = it;
  detailDocDirty = false;
  $("#dtTitle").textContent = it.text;
  $("#dtDocEditor").value = it.doc || "";
  updateDocSaveHint();
  renderCardChat(it);
  let report = "（还没有运行报告）";
  const rep = await api.ideaReport(it.id);
  if (rep && rep.run) {
    const head = rep.kind === "checkpoint" ? `> ⚠ 这是被中断运行的**进度快照**，团队尚未跑完。\n\n` : "";
    report = head + buildReportMd(rep.run);
  }
  $("#dtReport").innerHTML = mdToHtml(report);
  renderTimeline(rep && rep.run);
  await renderArtifacts(it.id);
  switchTab(tab || "doc");
  $("#detail").classList.remove("hidden");
  if (!tab || tab === "doc") $("#dtDocEditor").focus();
}
function buildReportMd(run) {
  let md = "";
  if (run.errors && run.errors.length) {
    md += `## 失败诊断\n`;
    for (const e of run.errors) {
      const who = e.agent ? `**${e.agent}** · ` : "";
      const where = e.title || e.stage || "运行";
      md += `- ${who}${where}：${String(e.error || "未知错误").replace(/^ERROR:\s*/i, "")}\n`;
    }
    md += `\n`;
  }
  md += `## 计划\n`;
  for (const t of run.tasks || []) md += `- **${t.agentName || t.agent}**（${t.role}）：${t.title}\n`;
  md += `\n## 交付物\n`;
  for (const r of run.results || []) md += `\n### ${r.agent} — ${r.title}（${fmtMs(r.meta && r.meta.durationMs)}）\n\n${r.output}\n`;
  if (run.review) md += `\n## 审查\n\n${run.review}\n`;
  return md;
}
function renderTimeline(run) {
  const box = $("#dtTimeline");
  if (!run) { box.innerHTML = `<div class="timeline-empty">还没有运行过程。</div>`; return; }
  const events = run.events || [];
  const errors = run.errors || [];
  const summary = [
    { k: "状态", v: statusText(run.status || (errors.length ? "failed" : "succeeded")) },
    { k: "任务", v: `${(run.results || []).filter((r) => r.ok).length}/${(run.tasks || []).length || 0}` },
    { k: "耗时", v: run.finishedAt && run.startedAt ? fmtMs(run.finishedAt - run.startedAt) : "进行中" },
    { k: "错误", v: String(errors.length) },
  ].map((x) => `<div class="tl-stat"><strong>${esc(x.v)}</strong><span>${esc(x.k)}</span></div>`).join("");
  const errHtml = errors.length ? `
    <section class="tl-errors">
      <h3>失败诊断</h3>
      ${errors.map((e) => `<div class="tl-error"><strong>${esc((e.agent ? e.agent + " · " : "") + (e.title || e.stage || "运行"))}</strong><p>${esc(String(e.error || "未知错误").replace(/^ERROR:\s*/i, ""))}</p></div>`).join("")}
    </section>` : "";
  const lines = events.length ? events.map((ev) => `
    <div class="tl-line ${evError(ev) ? "bad" : ""}">
      <div class="tl-dot"></div>
      <div class="tl-body">
        <div class="tl-title">${esc(eventTitle(ev))}</div>
        <div class="tl-meta">${esc(new Date(ev.at || Date.now()).toLocaleTimeString())}${ev.agent ? " · " + esc(ev.agent) : ""}${ev.model ? " · " + esc(ev.model) : ""}</div>
        ${ev.skills && ev.skills.length ? `<div class="tl-skills">${ev.skills.map((s) => `<span>${esc(s.name || s.id || String(s))}</span>`).join("")}</div>` : ""}
        ${eventDetail(ev) ? `<div class="tl-detail">${esc(eventDetail(ev))}</div>` : ""}
      </div>
    </div>`).join("") : `<div class="timeline-empty">这次运行还没有事件时间线（旧运行可能没有记录）。</div>`;
  box.innerHTML = `<div class="tl-stats">${summary}</div>${errHtml}<section class="tl-list">${lines}</section>`;
}
function statusText(s) {
  return { running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已取消", interrupted: "已中断" }[s] || s || "未知";
}
function evError(ev) { return ev.type === "error" || ev.entry?.ok === false || /failed|error|已取消/i.test(ev.error || ev.review || ""); }
function eventTitle(ev) {
  if (ev.type === "plan-start") return "指挥官开始规划";
  if (ev.type === "plan-done") return `计划完成：${ev.count || 0} 个任务`;
  if (ev.type === "task-start") return `开始任务：${ev.task?.title || ""}`;
  if (ev.type === "task-done") return `${ev.entry?.ok === false ? "任务失败" : "任务完成"}：${ev.entry?.title || ""}`;
  if (ev.type === "review-start") return "开始审查";
  if (ev.type === "review-done") return evError(ev) ? "审查失败" : "审查完成";
  if (ev.type === "cancelled") return "运行已取消";
  if (ev.type === "error") return "运行错误";
  return ev.type || "事件";
}
function eventDetail(ev) {
  if (ev.error) return ev.error;
  if (ev.entry?.error) return ev.entry.error;
  if (ev.entry?.durationMs) return `耗时 ${fmtMs(ev.entry.durationMs)}`;
  if (ev.review && evError(ev)) return ev.review;
  return "";
}
async function renderArtifacts(ideaId) {
  const box = $("#dtArtifacts");
  const res = await api.ideaArtifacts(ideaId);
  const items = (res && res.artifacts) || [];
  if (!items.length) {
    box.innerHTML = `<div class="artifact-empty">还没有可展示的运行产物。<br/>完成运行后，这里会显示提取文件和 <code>deliverables/</code> 里的交付物。</div>`;
    return;
  }
  const visibleGroups = [
    ["final", "最终产物", "可以直接看/交付/使用的结果"],
    ["valuable", "有价值的中间产物", "对判断和复盘有帮助"],
  ];
  const hidden = items.filter((a) => a.category === "hidden" || a.hidden);
  const card = (a, i) => `
    <article class="artifact-card ${i === 0 ? "open" : ""}" data-idx="${i}">
      <button class="artifact-head">
        <span class="artifact-icon">${artifactIcon(a.kind)}</span>
        <span class="artifact-main"><strong>${esc(a.name)}</strong><em>${esc(a.path)}</em></span>
        <span class="artifact-chip ${a.category || ""}">${esc(a.categoryLabel || "")}</span>
        <span class="artifact-meta">${esc(a.source)} · ${fmtSize(a.size)}</span>
      </button>
      <div class="artifact-preview">
        ${artifactPreview(a)}
        <div class="artifact-actions">
          ${a.previewable ? `<button class="kbtn" data-copy="${i}">复制内容</button>` : ""}
          ${a.source === "工作区产物" && res.workspace ? `<button class="kbtn" data-reveal="${i}">在 Finder 打开</button>` : ""}
        </div>
      </div>
    </article>
  `;
  const sections = visibleGroups.map(([cat, title, desc]) => {
    const group = items.filter((a) => a.category === cat && !a.hidden);
    if (!group.length) return "";
    return `<section class="artifact-section"><div class="artifact-section-head"><h3>${title}</h3><span>${desc} · ${group.length}</span></div><div class="artifact-grid">${group.map((a) => card(a, items.indexOf(a))).join("")}</div></section>`;
  }).join("");
  const hiddenSection = hidden.length ? `<details class="artifact-hidden"><summary>不用看的中间产物 · ${hidden.length}</summary><div class="artifact-grid">${hidden.map((a) => card(a, items.indexOf(a))).join("")}</div></details>` : "";
  box.innerHTML = `${sections || `<div class="artifact-empty">没有最终产物；可展开中间产物检查。</div>`}${hiddenSection}`;
  box.querySelectorAll(".artifact-head").forEach((h) => {
    h.onclick = () => h.closest(".artifact-card").classList.toggle("open");
  });
  box.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const a = items[Number(b.dataset.copy)];
      try { await navigator.clipboard.writeText(a.content || ""); toast("已复制产物内容", "info"); } catch { toast("复制失败", "error"); }
    };
  });
  box.querySelectorAll("[data-reveal]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const a = items[Number(b.dataset.reveal)];
      if (res.workspace) await api.revealPath(res.workspace.id, a.path);
    };
  });
}
function artifactPreview(a) {
  if (!a.previewable) return `<div class="muted artifact-pad">文件较大或不可预览。</div>`;
  const content = a.content || "";
  if (a.kind === "md") return `<div class="artifact-md md">${mdToHtml(content)}</div>`;
  if (a.kind === "csv") return csvPreview(content);
  if (["txt"].includes(a.kind)) return `<div class="artifact-text">${esc(content)}</div>`;
  return `<pre class="artifact-code"><code>${esc(content)}</code></pre>`;
}
// Split one CSV line into fields, honoring double-quoted fields so a comma
// inside quotes (e.g. "Smith, John") stays in one cell instead of splitting the
// row. Handles "" as an escaped quote. (Embedded newlines aren't handled — same
// as before — but quoted commas are by far the common real-world case.)
function splitCsvLine(line) {
  const out = [];
  let field = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}
function csvPreview(src) {
  const CAP = 30;
  const lines = (src || "").trim().split(/\r?\n/);
  const rows = lines.slice(0, CAP).map((line) => splitCsvLine(line).map((c) => c.trim()));
  if (!rows.length) return `<div class="muted artifact-pad">空 CSV</div>`;
  const head = rows[0], body = rows.slice(1);
  // The preview is capped; say so rather than silently dropping rows.
  const more = lines.length > CAP ? `<div class="muted artifact-pad">仅显示前 ${CAP} 行，共 ${lines.length} 行。</div>` : "";
  return `<div class="artifact-table-wrap"><table class="artifact-table"><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${more}`;
}
function artifactIcon(kind) {
  if (kind === "md") return "MD";
  if (kind === "csv") return "CSV";
  if (["js", "ts", "py", "sh"].includes(kind)) return kind.toUpperCase();
  if (["json", "yml", "yaml"].includes(kind)) return "{}";
  return "FILE";
}
function fmtSize(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// ---------------------------------------------------------------- schedule
function bindSchedule() {
  $("#autoEnabled").onchange = saveAuto;
  $("#autoMode").onchange = () => { syncAutoModeRows(); saveAuto(); };
  $("#autoEveryHours").onchange = saveAuto;
  $("#autoDailyAt").onchange = saveAuto;
  $("#autoSource").onchange = () => { syncAutoSourceRows(); saveAuto(); };
  $("#autoPrompt").onchange = saveAuto;
  $("#autoCard").onchange = saveAuto;
  $("#autoRunNow").onclick = async () => {
    const btn = $("#autoRunNow"); btn.disabled = true; btn.textContent = "派活中…";
    const r = await api.runScheduleNow();
    btn.disabled = false; btn.textContent = "▶ 立即跑一次";
    // Use the app's toast instead of a blocking alert() (consistent with every
    // other error path here, and doesn't freeze the UI thread).
    if (r && !r.ok && r.error) toast(r.error, "error", 7000);
    else if (r && r.ok) toast("已派活，去看板查看进度。", "info");
    SCHEDULE = await api.getSchedule(); renderSchedule(); refreshIdeas();
  };
}
function syncAutoModeRows() {
  const daily = $("#autoMode").value === "daily";
  $("#autoIntervalWrap").classList.toggle("hidden", daily);
  $("#autoDailyWrap").classList.toggle("hidden", !daily);
}
function syncAutoSourceRows() {
  const src = $("#autoSource").value;
  $("#autoPromptRow").classList.toggle("hidden", src !== "prompt");
  $("#autoCardRow").classList.toggle("hidden", src !== "card");
  if (src === "card") populateAutoCard();
}
function populateAutoCard() {
  const sel = $("#autoCard");
  const prev = SCHEDULE.cardId || sel.value || "";
  const cards = (IDEAS || []).filter((i) => i.status !== "pending_confirm");
  if (!cards.length) {
    sel.innerHTML = `<option value="">看板里还没有可执行的卡片</option>`;
    return;
  }
  sel.innerHTML = cards.map((i) => {
    const label = `[${STATUS_CN[i.status] || i.status}] ${(i.text || "").slice(0, 40)}`;
    return `<option value="${i.id}" ${i.id === prev ? "selected" : ""}>${esc(label)}</option>`;
  }).join("");
}
async function saveAuto() {
  SCHEDULE = await api.setSchedule({
    enabled: $("#autoEnabled").checked,
    mode: $("#autoMode").value,
    everyHours: Math.max(1, parseInt($("#autoEveryHours").value, 10) || 6),
    dailyAt: $("#autoDailyAt").value || "09:00",
    source: $("#autoSource").value,
    prompt: $("#autoPrompt").value.trim(),
    cardId: $("#autoCard").value || "",
  });
  reflectSchedDot(); renderAutoStatus();
}
async function renderSchedule() {
  SCHEDULE = await api.getSchedule();
  IDEAS = await api.ideasList();   // keep the card picker in sync with the board
  $("#autoEnabled").checked = !!SCHEDULE.enabled;
  $("#autoMode").value = SCHEDULE.mode || "interval";
  $("#autoEveryHours").value = SCHEDULE.everyHours || 6;
  $("#autoDailyAt").value = SCHEDULE.dailyAt || "09:00";
  $("#autoSource").value = SCHEDULE.source || "ideas";
  $("#autoPrompt").value = SCHEDULE.prompt || "";
  syncAutoModeRows(); syncAutoSourceRows();
  if (SCHEDULE.source === "card") $("#autoCard").value = SCHEDULE.cardId || "";
  renderAutoStatus(); renderAutoLog(); reflectSchedDot();
}
function renderAutoStatus() {
  const box = $("#autoStatus"); if (!box) return;
  if (!SCHEDULE.enabled) { box.innerHTML = '<span class="hint">已停用</span>'; return; }
  const last = SCHEDULE.lastRunAt ? "上次 " + new Date(SCHEDULE.lastRunAt).toLocaleString() : "还没跑过";
  const next = SCHEDULE.nextRunAt ? "下次 " + new Date(SCHEDULE.nextRunAt).toLocaleTimeString() + "（" + fmtRel(SCHEDULE.nextRunAt - Date.now()) + "）" : "计算中…";
  box.innerHTML = '<span style="color:var(--done)">启用中</span> · ' + next + '　<span class="hint">' + last + "</span>";
}
function tickAutoStatus() {
  if (isView("schedule") && SCHEDULE.enabled) renderAutoStatus();
  // NOTE: the chat status line is owned solely by renderChatStatus() (driven by
  // chatTick while a turn is in flight). It must NOT be written here too — doing
  // so used to clobber the richer live phase (调查中 / 团队执行中 / 停止中) back
  // to the generic statusLabel about once a second, causing flicker.
}
function renderAutoLog() {
  const wrap = $("#autoLog"); if (!wrap) return;
  const log = (SCHEDULE.log || []).slice().reverse();
  wrap.innerHTML = "";
  if (!log.length) { wrap.innerHTML = '<div class="hint" style="padding:10px 2px">还没有自动运行记录。</div>'; return; }
  for (const e of log) {
    const row = el("div", "auto-log-row");
    const when = new Date(e.at).toLocaleString();
    let body = "";
    if (e.type === "done") body = `<span class="badge ${e.verdict || ""}">${e.verdict || "DONE"}</span> ${esc((e.brief || "").slice(0, 60))} <span class="hint">${e.wsName ? "→ " + esc(e.wsName) : ""}${e.manual ? " · 手动" : ""}</span>`;
    else if (e.type === "skip") body = `<span class="alog-tag skip">跳过</span> <span class="hint">${esc(e.msg || "")}</span>`;
    else if (e.type === "error") body = `<span class="alog-tag err">错误</span> <span class="hint">${esc(e.msg || "")}</span>`;
    else body = esc(e.msg || e.type);
    row.innerHTML = `<div class="alog-when">${when}</div><div class="alog-body">${body}</div>`;
    wrap.appendChild(row);
  }
}
function reflectSchedDot() { const d = $("#schedDot"); if (d) d.classList.toggle("on", !!SCHEDULE.enabled); }
function handleSchedEvent(ev) {
  if (ev.schedule) SCHEDULE = ev.schedule;
  reflectSchedDot();
  if (isView("schedule")) { renderAutoStatus(); renderAutoLog(); }
  if (ev.type === "fired" || ev.type === "done" || ev.type === "error") refreshIdeas();
}

// ---------------------------------------------------------------- agents
function bindAgents() { $("#newAgentBtn").onclick = () => openEditor(null); }
async function renderAgents() {
  const agents = await api.listAgents();
  const grid = $("#agentGrid"); grid.innerHTML = "";
  for (const a of agents) {
    const tile = el("div", "agent-tile");
    tile.innerHTML = `
      <div class="at-name">${esc(a.name)}</div>
      <div class="at-role">${esc(a.role)}</div>
      <div class="at-goal">${esc(a.goal)}</div>
      <div class="at-foot">
        <span class="tag model">${esc(a.model)}</span>
        <span class="tag">推理 ${reasoningCN(a.reasoning)}</span>
        ${a.memory ? '<span class="tag">记忆</span>' : ""}
        <span class="tag ${a.access === "owner" ? "owner" : ""}">${a.access === "owner" ? "所有者" : "成员"}</span>
      </div>`;
    tile.onclick = () => openEditor(a);
    grid.appendChild(tile);
  }
}
function bindEditor() {
  $("#editorCancel").onclick = () => show("agents");
  $("#editorSave").onclick = saveAgent;
  $("#editorDelete").onclick = deleteAgent;
}
function fillModels(sel, current) { sel.innerHTML = META.models.map((m) => `<option ${m === current ? "selected" : ""}>${m}</option>`).join(""); }
function renderToolChips(active) {
  const wrap = $("#f-tools"); wrap.innerHTML = "";
  for (const t of META.tools) {
    const c = el("span", "chip" + (active.includes(t) ? " on" : ""), t);
    c.onclick = () => c.classList.toggle("on"); c.dataset.tool = t;
    wrap.appendChild(c);
  }
}
function openEditor(agent) {
  editing = agent;
  $("#editorTitle").textContent = agent ? `编辑：${agent.name}` : "新建员工";
  $("#editorSave").textContent = agent ? "保存" : "创建员工";
  $("#editorDelete").classList.toggle("hidden", !agent);
  $("#f-name").value = agent?.name || ""; $("#f-role").value = agent?.role || "";
  $("#f-goal").value = agent?.goal || ""; $("#f-backstory").value = agent?.backstory || "";
  $("#f-persona").value = agent?.persona || "";
  fillModels($("#f-model"), agent?.model || "claude-sonnet-4-6");
  $("#f-reasoning").value = agent?.reasoning || "medium";
  $("#f-memory").checked = !!agent?.memory;
  $("#f-mcp").value = (agent?.mcp || []).join(",");
  $("#f-access").value = agent?.access || "member";
  renderToolChips(agent?.tools || []);
  show("editor");
}
function collectEditor() {
  const tools = [...document.querySelectorAll("#f-tools .chip.on")].map((c) => c.dataset.tool);
  const mcp = $("#f-mcp").value.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    id: editing?.id,
    name: $("#f-name").value.trim() || $("#f-role").value.trim() || "New Agent",
    role: $("#f-role").value.trim(), goal: $("#f-goal").value.trim(),
    backstory: $("#f-backstory").value.trim(), persona: $("#f-persona").value.trim(),
    model: $("#f-model").value, reasoning: $("#f-reasoning").value,
    memory: $("#f-memory").checked, tools, mcp, access: $("#f-access").value,
  };
}
async function saveAgent() {
  const data = collectEditor();
  try {
    const saved = editing ? await api.saveAgent({ ...editing, ...data }) : await api.createAgent(data);
    editing = saved;
    toast("员工设置已保存", "info");
  } catch (err) {
    toast(`保存失败：${err.message || err}`, "error", 7000);
    return;
  }
  show("agents");
}
async function deleteAgent() {
  if (!editing || !confirm(`删除员工「${editing.name}」？`)) return;
  await api.deleteAgent(editing.id);
  show("agents");
}

// ---------------------------------------------------------------- skills
let SKILLS = [];
let skillQuery = "";
let skillCat = "all";
function bindSkills() {
  $("#skillsSync").onclick = async () => {
    const btn = $("#skillsSync"); btn.disabled = true; const t = btn.textContent; btn.textContent = "同步中…";
    const r = await api.skillsSync();
    btn.disabled = false; btn.textContent = t;
    toast(`已同步 ${r && r.count != null ? r.count : 0} 个技能`, "info");
    await renderSkills();
  };
  $("#skillsSearch").addEventListener("input", (e) => { skillQuery = e.target.value.trim().toLowerCase(); renderSkillGrid(); });
  $("#skillBack").onclick = () => showSkillBrowse();
}
function showSkillBrowse() {
  $("#skillsDetail").classList.add("hidden");
  $("#skillsBrowse").classList.remove("hidden");
}
async function renderSkills() {
  const { skills, syncedAt } = await api.skillsList();
  SKILLS = skills || [];
  $("#skillsSynced").textContent = syncedAt ? `上次同步 ${rel(syncedAt)} · 共 ${SKILLS.length} 个` : `共 ${SKILLS.length} 个`;
  // category chips from distinct sources
  const cats = [...new Set(SKILLS.map((s) => s.source || "其它"))].sort();
  const wrap = $("#skillsCats"); wrap.innerHTML = "";
  const mk = (id, label, n) => {
    const c = el("button", "skill-cat" + (skillCat === id ? " on" : ""), `${esc(label)} <span class="skill-cat-n">${n}</span>`);
    c.onclick = () => { skillCat = id; renderSkills(); };
    return c;
  };
  wrap.appendChild(mk("all", "全部", SKILLS.length));
  for (const c of cats) wrap.appendChild(mk(c, c, SKILLS.filter((s) => (s.source || "其它") === c).length));
  showSkillBrowse();
  renderSkillGrid();
}
function renderSkillGrid() {
  const grid = $("#skillsGrid"); grid.innerHTML = "";
  let items = SKILLS;
  if (skillCat !== "all") items = items.filter((s) => (s.source || "其它") === skillCat);
  if (skillQuery) items = items.filter((s) => (s.name + " " + (s.description || "")).toLowerCase().includes(skillQuery));
  if (!items.length) {
    if (!SKILLS.length) {
      // No skills at all (never synced or none available) — guide to sync, not "no match".
      const empty = el("div", "muted skill-empty", "还没有技能。点击右上角的「同步技能」从工作区拉取。");
      const act = el("button", "btn ghost sm", "立即同步");
      act.onclick = () => $("#skillsSync").click();
      empty.appendChild(act);
      grid.appendChild(empty);
    } else {
      // Have skills but the current filter/search excludes them all — offer to clear.
      const empty = el("div", "muted skill-empty", "没有匹配的技能。");
      const act = el("button", "btn ghost sm", "清除筛选");
      act.onclick = () => {
        skillQuery = ""; skillCat = "all";
        const box = $("#skillsSearch"); if (box) box.value = "";
        renderSkills();
      };
      empty.appendChild(act);
      grid.appendChild(empty);
    }
    return;
  }
  for (const s of items) {
    const card = el("div", "skill-card");
    card.innerHTML =
      `<div class="skill-card-head"><span class="skill-card-name">${esc(s.name)}</span><span class="skill-badge">${esc(s.source || "其它")}</span></div>` +
      `<div class="skill-card-desc">${esc(s.description || "（无描述）")}</div>`;
    card.onclick = () => openSkill(s.id);
    grid.appendChild(card);
  }
}
async function openSkill(id) {
  const meta = SKILLS.find((s) => s.id === id);
  $("#skillsBrowse").classList.add("hidden");
  $("#skillsDetail").classList.remove("hidden");
  $("#skillBadge").textContent = meta ? (meta.source || "") : "";
  $("#skillView").innerHTML = '<div class="muted">加载中…</div>';
  const sk = await api.skillsGet(id);
  if (!sk) { $("#skillView").innerHTML = "（读取失败）"; return; }
  const body = sk.content.replace(/^---\n[\s\S]*?\n---\n?/, "");   // strip frontmatter
  let files = "";
  if (sk.files && sk.files.length) {
    files = `\n\n---\n\n**附带文件（${sk.files.length}）**\n\n` + sk.files.map((f) => `- \`${f}\``).join("\n");
  }
  $("#skillView").innerHTML = mdToHtml(`# ${sk.name}\n\n${body}${files}`);
  $("#skillView").scrollTop = 0;
}

// ---------------------------------------------------------------- runs
async function renderRuns() {
  const all = await api.listAllMissions();
  const list = $("#missionsList"); list.innerHTML = "";
  $("#missionReport").innerHTML = "选择左侧一次运行查看完整产出。";
  if (!all.length) { list.innerHTML = '<div class="muted">还没有运行记录。</div>'; return; }
  for (const t of all) {
    const item = el("div", "run-item");
    const badge = t.verdict ? `<span class="badge ${t.verdict}">${t.verdict}</span>` : "";
    item.innerHTML = `<div class="ri-idea">${esc(t.idea || t.stamp)}</div><div class="ri-meta"><span>${t.emoji || ""} ${esc(t.wsName || "")}</span>${badge}<span>${t.agents} 任务</span><span>${new Date(t.finishedAt).toLocaleString()}</span></div>`;
    item.onclick = () => openMission(t.wsId, t.stamp, item);
    list.appendChild(item);
  }
}
async function openMission(wsId, stamp, item) {
  $$(".run-item").forEach((n) => n.classList.remove("active"));
  if (item) item.classList.add("active");
  const run = await api.getMission(wsId, stamp);
  if (!run) return;
  $("#missionReport").innerHTML = mdToHtml(`# ${run.idea}\n\n` + buildReportMd(run));
}

// ---------------------------------------------------------------- usage
async function renderUsage() {
  const s = await api.getUsage();
  $("#usageCards").innerHTML = `
    <div class="cost-card"><div class="cc-num">${s.workspaceCount}</div><div class="cc-label">项目</div></div>
    <div class="cost-card"><div class="cc-num">${s.runCount}</div><div class="cc-label">运行次数</div></div>
    <div class="cost-card"><div class="cc-num">${s.agentCalls}</div><div class="cc-label">Agent 调用</div></div>
    <div class="cost-card"><div class="cc-num">${fmtMs(s.totalMs)}</div><div class="cc-label">累计耗时</div></div>`;
}

// ---------------------------------------------------------------- settings
function bindSettings() {
  $("#setNoConfirm").onchange = async () => { SETTINGS = await api.setSettings({ cautious: !$("#setNoConfirm").checked }); };
  $("#setWsBaseSave").onclick = async () => {
    const v = $("#setWsBase").value.trim() || "~";
    SETTINGS = await api.setSettings({ workspaceBase: v });
    $("#setWsBase").value = SETTINGS.workspaceBase;
    const btn = $("#setWsBaseSave"); const t = btn.textContent; btn.textContent = "已保存 ✓";
    setTimeout(() => { btn.textContent = t; }, 1400);
  };
  $("#editCrewLink").onclick = () => show("agents");
}

// ---------------------------------------------------------------- objective loop (目标循环)
let OBJECTIVES = [];
let objDetailId = null;
let objRunning = false;
let objProgress = [];

const OBJ_STATUS = { active: ["进行中", "ready"], done: ["已达成", "done"], gaveup: ["已放弃", "bad"], paused: ["已暂停", "muted"] };

function bindObjectives() {
  $("#objNew").onclick = showObjForm;
}

async function renderObjectives() {
  OBJECTIVES = await api.objList();
  renderObjList();
  $("#objDot").classList.toggle("on", objRunning);
  if (objDetailId && OBJECTIVES.some((o) => o.id === objDetailId)) openObjective(objDetailId);
}

function objChip(s) { const [l, c] = OBJ_STATUS[s] || [s, "muted"]; return `<span class="se-chip ${c}">${esc(l)}</span>`; }

function renderObjList() {
  const host = $("#objList");
  if (!OBJECTIVES.length) { host.innerHTML = `<div class="se-list-empty">还没有目标。点右上「+ 新目标」开始。</div>`; return; }
  host.innerHTML = "";
  OBJECTIVES.forEach((o) => {
    const item = el("div", "se-item" + (o.id === objDetailId ? " active" : ""));
    const kindCN = o.kind === "self-edit" ? "自改" : "干活";
    item.innerHTML = `<div class="se-item-goal">${esc((o.title || o.northStar || "").slice(0, 80))}</div>
      <div class="se-item-meta">${objChip(o.status)}<span class="obj-kind">${kindCN}</span><span class="se-item-time">${rel(o.createdAt)}</span></div>`;
    item.onclick = () => { objDetailId = o.id; renderObjList(); openObjective(o.id); };
    host.appendChild(item);
  });
}

async function showObjForm() {
  const ws = await api.listWorkspaces();
  const wsOpts = ws.map((w) => `<option value="${w.id}">${esc((w.emoji || "") + " " + w.name)}</option>`).join("");
  $("#objDetail").innerHTML = `
    <div class="obj-form">
      <h2>新目标</h2>
      <label class="fl">北极星（你最终想要什么）</label>
      <textarea id="ofNorth" class="se-goal" placeholder="例如：通过小红书内容带来真实的付费咨询订单；或：让这个 App 的看板更好用。"></textarea>
      <label class="fl">怎么干</label>
      <select id="ofKind"><option value="crew">在一个工作区里干活</option><option value="self-edit">修改 App 自己的源码</option></select>
      <div id="ofWsRow"><label class="fl">工作区</label><select id="ofWs">${wsOpts || '<option value="">（没有工作区，先去看板/项目建一个）</option>'}</select></div>
      <label class="fl">每轮怎么验证</label>
      <select id="ofVerify"><option value="human">我来人工打分（推荐：真实信号）</option><option value="auto">让审查员自动判定（SHIP=通过）</option></select>
      <label class="fl">最多循环几轮</label>
      <input id="ofMax" type="number" min="1" max="50" value="10" />
      <div class="se-compose-actions">
        <button id="ofCreate" class="btn primary">创建并开始</button>
        <button id="ofCancel" class="btn ghost">取消</button>
      </div>
    </div>`;
  const syncKind = () => {
    const k = $("#ofKind").value;
    $("#ofWsRow").classList.toggle("hidden", k !== "crew");
    $("#ofVerify").disabled = k === "self-edit";
    if (k === "self-edit") $("#ofVerify").value = "auto";
  };
  $("#ofKind").onchange = syncKind; syncKind();
  $("#ofCancel").onclick = () => { objDetailId = null; renderObjectives(); $("#objDetail").innerHTML = `<div class="se-empty">选择左边一个目标，或新建一个。</div>`; };
  $("#ofCreate").onclick = createObjectiveUI;
}

async function createObjectiveUI() {
  const northStar = $("#ofNorth").value.trim();
  if (!northStar) { toast("先写下北极星目标", "warn"); return; }
  const kind = $("#ofKind").value;
  const workspaceId = kind === "crew" ? $("#ofWs").value : "";
  if (kind === "crew" && !workspaceId) { toast("请选择一个工作区", "warn"); return; }
  const o = await api.objCreate({
    northStar, title: northStar.slice(0, 50), kind, workspaceId,
    autoVerify: $("#ofVerify").value === "auto",
    maxIterations: Number($("#ofMax").value) || 10,
  });
  objDetailId = o.id;
  await renderObjectives();
  openObjective(o.id);
  objStepUI(o.id);   // kick off the first iteration immediately
}

function pushObjProgress(line) {
  objProgress.push(line);
  const host = $("#objProgress");
  if (!host) return;
  host.innerHTML = objProgress.slice(-14).map((p) => `<div class="se-prog-line">${esc(p)}</div>`).join("");
  host.scrollTop = host.scrollHeight;
}

function objHandleEvent(ev) {
  if (ev.type === "loop-propose-start") pushObjProgress("规划下一步…");
  else if (ev.type === "loop-propose-done") pushObjProgress("下一步：" + (ev.task || ""));
  else if (ev.type === "loop-execute-start") pushObjProgress("执行中…");
  else if (ev.type === "task-start") pushObjProgress("· " + (ev.agent || "") + "：" + ((ev.task && ev.task.title) || ""));
  else if (ev.type === "task-stream") { if (ev.kind === "tool") pushObjProgress("· 调用 " + (ev.name || "")); }
  else if (ev.type === "loop-execute-done") pushObjProgress("执行完成");
  else if (ev.type === "loop-verify-start") pushObjProgress("验证中…");
  else if (ev.type === "loop-verify-pending") pushObjProgress("⏸ 等你人工打分");
  else if (ev.type === "loop-verify-done") pushObjProgress("验证：" + (ev.ok ? "✓ 通过" : "✗ 未过"));
  else if (ev.type === "loop-reflect-done") pushObjProgress("复盘：" + (ev.note || ""));
  else if (ev.type === "loop-done") pushObjProgress("✓ 北极星达成");
  else if (ev.type === "error") pushObjProgress("✗ " + (ev.error || "出错"));
}

async function openObjective(id) {
  const { objective, journal } = await api.objGet(id);
  if (!objective) { $("#objDetail").innerHTML = `<div class="se-empty">目标不存在。</div>`; return; }
  renderObjDetail(objective, journal || []);
}

function verifyVerdict(v) {
  if (!v) return "";
  if (v.pending) return `<span class="se-gate-badge bad">⏸ 待人工打分</span>`;
  const cls = v.ok ? "ok" : "bad";
  const sc = (v.score != null) ? ` · 分 ${v.score}` : "";
  return `<span class="se-gate-badge ${cls}">${v.ok ? "✓ 通过" : "✗ 未过"}${sc}</span>`;
}

function renderObjDetail(o, journal) {
  const pending = journal.find((e) => e.verify && e.verify.pending);
  const completed = journal.filter((e) => !(e.verify && e.verify.pending)).length;
  const canRun = o.status === "active" && !objRunning && !pending;
  let html = `<div class="se-detail-head">
    <div class="se-detail-goal">${esc(o.northStar)}</div>
    <div class="se-detail-sub">${objChip(o.status)}<span class="sub">${o.kind === "self-edit" ? "自改源码" : "干活"} · 第 ${completed}/${o.maxIterations} 轮 · ${o.autoVerify ? "自动验证" : "人工打分"}</span></div>
  </div>`;

  html += `<div class="se-actions">`;
  if (canRun) html += `<button class="btn primary" id="objStep">▶ 跑一轮</button><button class="btn ghost" id="objLoop">⏩ 连跑到停</button>`;
  if (objRunning) html += `<button class="btn ghost" id="objCancel">■ 取消</button>`;
  if (o.status === "active" && !objRunning) html += `<button class="btn ghost" id="objGiveUp">放弃目标</button>`;
  html += `<button class="btn ghost danger" id="objDelete">删除</button></div>`;

  html += `<div id="objProgress" class="se-progress"></div>`;

  if (pending) {
    html += `<div class="obj-score panel">
      <div class="obj-score-head">⏸ 这一轮做完了，需要你给真实信号</div>
      <div class="obj-score-task">${esc(pending.task)}</div>
      <div class="obj-score-row">
        <label><input type="radio" name="objOk" value="1" checked> 有效（更接近北极星）</label>
        <label><input type="radio" name="objOk" value="0"> 无效</label>
      </div>
      <label class="fl">打分 0–1（这步贡献多大）</label>
      <input id="objScoreVal" type="number" min="0" max="1" step="0.1" value="0.6" />
      <label class="fl">真实情况 / 证据（卖了几单、来了几个咨询、数据怎样…）</label>
      <textarea id="objScoreNotes" class="se-goal" placeholder="给团队下一轮参考的真实结果。"></textarea>
      <div class="se-compose-actions"><button class="btn primary" id="objScoreSubmit">提交评分，继续循环</button></div>
    </div>`;
  }

  // journal timeline
  html += `<div class="se-files-head">历程（${journal.length} 轮）</div>`;
  if (!journal.length) html += `<div class="se-empty">还没开始。点「跑一轮」让团队拆出第一步。</div>`;
  else html += `<div class="obj-journal">` + journal.slice().reverse().map((e) => `
    <div class="obj-entry">
      <div class="obj-entry-top"><span class="obj-entry-n">#${e.n}</span><span class="obj-entry-task">${esc(e.task)}</span>${verifyVerdict(e.verify)}</div>
      ${e.exec && e.exec.summary ? `<div class="obj-entry-exec">${esc(e.exec.summary)}</div>` : ""}
      ${e.verify && e.verify.notes ? `<div class="obj-entry-notes">验证：${esc(e.verify.notes)}</div>` : ""}
      ${e.reflection ? `<div class="obj-entry-reflect">复盘：${esc(e.reflection)}</div>` : ""}
    </div>`).join("") + `</div>`;

  $("#objDetail").innerHTML = html;
  if (objProgress.length) pushObjProgress("");  // re-render progress buffer

  const sb = $("#objStep"); if (sb) sb.onclick = () => objStepUI(o.id);
  const lb = $("#objLoop"); if (lb) lb.onclick = () => objLoopUI(o.id);
  const cb = $("#objCancel"); if (cb) cb.onclick = async () => { await api.objCancel(); toast("正在取消…", "info"); };
  const gb = $("#objGiveUp"); if (gb) gb.onclick = async () => { if (confirm("放弃这个目标？")) { await api.objUpdate(o.id, { status: "gaveup" }); renderObjectives(); } };
  const db = $("#objDelete"); if (db) db.onclick = async () => { if (confirm("删除这个目标及其全部历程？")) { await api.objDelete(o.id); objDetailId = null; await renderObjectives(); $("#objDetail").innerHTML = `<div class="se-empty">已删除。</div>`; } };
  const ss = $("#objScoreSubmit"); if (ss) ss.onclick = () => objScoreUI(o.id);
}

async function objStepUI(id) {
  if (objRunning) { toast("已有一轮在跑", "warn"); return; }
  objRunning = true; objProgress = [];
  $("#objDot").classList.add("on");
  await openObjective(id);
  pushObjProgress("开始这一轮…");
  let res;
  try { res = await api.objStep(id); }
  finally { objRunning = false; $("#objDot").classList.remove("on"); }
  if (!res || !res.ok) { toast("这一轮失败：" + ((res && res.error) || "未知"), "error", 8000); pushObjProgress("✗ " + ((res && res.error) || "失败")); await openObjective(id); return; }
  const k = res.result && res.result.kind;
  await renderObjectives();
  if (k === "objective-done") toast("北极星达成 ✓", "info", 7000);
  else if (k === "gave-up") toast("团队判断此路不通，已放弃", "warn", 7000);
  else if (k === "await-human") toast("这一轮做完了，去给个真实评分让它继续", "info", 7000);
  else if (k === "max-reached") toast("已到最大轮数", "info");
}

async function objLoopUI(id) {
  if (objRunning) { toast("已有循环在跑", "warn"); return; }
  objRunning = true; objProgress = [];
  $("#objDot").classList.add("on");
  await openObjective(id);
  pushObjProgress("连续循环中（遇到需要你打分会停下）…");
  let res;
  try { res = await api.objLoop(id, 5); }
  finally { objRunning = false; $("#objDot").classList.remove("on"); }
  if (!res || !res.ok) { toast("循环出错：" + ((res && res.error) || "未知"), "error", 8000); }
  await renderObjectives();
}

async function objScoreUI(id) {
  const okEl = document.querySelector('input[name="objOk"]:checked');
  const ok = okEl ? okEl.value === "1" : true;
  const score = Number($("#objScoreVal").value);
  const notes = $("#objScoreNotes").value.trim();
  const res = await api.objScore(id, { ok, score, notes });
  if (!res || !res.ok) { toast("提交失败：" + ((res && res.error) || "未知"), "error"); return; }
  toast("已记录，继续下一轮", "info");
  await openObjective(id);
  objStepUI(id);   // auto-continue
}

// Final safety net: if init still throws unexpectedly, surface it instead of
// failing silently to a blank window, and offer a one-click reload to recover.
init().catch((e) => {
  console.error("init 失败", e);
  try {
    const t = toast("界面初始化出错，点这里重新加载", "error", 0);
    if (t) { t.style.cursor = "pointer"; t.onclick = () => location.reload(); }
  } catch {}
});
})();

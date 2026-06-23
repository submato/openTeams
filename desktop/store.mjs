// Workspace-centric store. The top-level dimension is the WORKSPACE (a channel
// bound to a working directory), AI-managed. Agents live in a shared repository.
// Layout under <root> (= ai-team/):
//   agents/<id>.json            shared Agents Repository (the "employees")
//   crew.json                   default crew { managerId, reviewerId, workerIds[] }
//   workspaces.json             [{ id, name, kind, cwd, emoji, mode, crewId?,
//                                  ceoSdkAgentId?, createdBy, summary, lastActiveAt, archived }]
//   workspaces/<wsId>/chat.json          CEO conversation (UI mirror)
//   workspaces/<wsId>/missions/<stamp>/  run history (report.md + run.json + files/)
//   settings.json               { cautious }  (cautious=false ⇒ 免确认模式)
//   .sdk-store/                 SqliteLocalAgentStore root (persistent CEO sessions)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SEED_AGENTS, AVAILABLE_TOOLS, AVAILABLE_MODELS } from "../src/agents.mjs";
import { kickoff } from "../src/crew.mjs";
import { chatTurn, ceoChatTurn, ceoExecDoc } from "../src/chat.mjs";
import { decideCeoAction, classifyWorkspace } from "../src/router.mjs";

// Persistent SDK agent store (resumeable CEO sessions). Built lazily; if the
// SDK shape changes we fall back to the SDK's own default store (undefined).
let _sdkStore = null;
let _sdkStoreTried = false;
async function sdkStore() {
  if (_sdkStoreTried) return _sdkStore;
  _sdkStoreTried = true;
  try {
    const mod = await import("@cursor/sdk");
    if (mod.JsonlLocalAgentStore) _sdkStore = new mod.JsonlLocalAgentStore(sdkStoreRoot());
  } catch { _sdkStore = null; }
  return _sdkStore;
}

// Active crew runs, for cancellation. wsId -> { current: Run|null, cancelled, reason }
// reason "user" = pressed stop (card → 待执行); "quit" = app shutting down (→ 已中断).
const controllers = new Map();
export function cancelRun(wsId, reason = "user") {
  const c = controllers.get(wsId);
  if (!c) return false;
  c.cancelled = true;
  c.cancelReason = reason;
  try { c.current?.cancel?.(); } catch {}
  return true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let ROOT = path.resolve(__dirname, "..");
const HOME = process.env.HOME || process.env.USERPROFILE || "";

export function setRoot(dir) { ROOT = dir; ensure(); }
export function getRoot() { return ROOT; }
export function sdkStoreRoot() { return ensureDir(path.join(ROOT, ".sdk-store")); }

const agentsDir = () => path.join(ROOT, "agents");
const crewPath = () => path.join(ROOT, "crew.json");
const workspacesPath = () => path.join(ROOT, "workspaces.json");
const settingsPath = () => path.join(ROOT, "settings.json");
const wsDir = (id) => path.join(ROOT, "workspaces", id);
const missionsDir = (wsId) => path.join(wsDir(wsId), "missions");
const runsDir = (wsId) => path.join(wsDir(wsId), "runs");
const runPath = (wsId, runId) => path.join(runsDir(wsId), `${runId}.json`);
const chatPath = (wsId) => path.join(wsDir(wsId), "chat.json");

// ---- Run checkpoints (Phase A) -------------------------------------------
// A "run" is one execution of an idea. We persist its progress incrementally so
// an unexpected quit/crash never throws away finished agent work: each plan and
// each completed task is flushed to disk. On restart the run can be resumed from
// its last checkpoint or rerun from scratch.
function newRunId() { return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function readRun(wsId, runId) { return runId ? readJson(runPath(wsId, runId), null) : null; }

function makeRunRecorder(wsId, runId, base = {}) {
  let rec = {
    runId, wsId,
    ideaId: base.ideaId || null,
    idea: base.idea || "",
    brief: base.brief || "",
    status: "running",          // running | succeeded | failed | cancelled | interrupted
    phase: base.plan?.length ? "tasks" : "plan",
    reason: "",
    plan: base.plan || [],
    results: base.results || [],
    events: base.events || [],
    errors: base.errors || [],
    review: base.review || null,
    verdict: base.verdict || "",
    stamp: base.stamp || null,
    error: "",
    startedAt: base.startedAt || Date.now(),
    updatedAt: Date.now(),
    finishedAt: 0,
  };
  const flush = () => { rec.updatedAt = Date.now(); writeJson(runPath(wsId, runId), rec); };
  flush();
  const verdictOf = (review) => (review || "").match(/VERDICT:?\s*(SHIP|FIX|KILL)/i)?.[1]?.toUpperCase() || "";
  const eventSummary = (ev) => {
    const out = { type: ev.type, at: ev.at || Date.now() };
    if (ev.agent) out.agent = ev.agent;
    if (ev.model) out.model = ev.model;
    if (ev.stage) out.stage = ev.stage;
    if (ev.error) out.error = ev.error;
    if (ev.skills) out.skills = ev.skills;
    if (ev.task) out.task = { id: ev.task.id, title: ev.task.title };
    if (ev.entry) out.entry = {
      id: ev.entry.id, agent: ev.entry.agent, title: ev.entry.title, ok: !!ev.entry.ok,
      error: ev.entry.ok ? "" : String(ev.entry.output || "").slice(0, 500),
      durationMs: ev.entry.meta?.durationMs || 0,
    };
    if (ev.tasks) out.count = ev.tasks.length;
    if (ev.review) out.review = String(ev.review).slice(0, 500);
    if (ev.kind) out.kind = ev.kind;
    return out;
  };
  const noteError = (err) => {
    if (!err) return;
    const key = `${err.stage || ""}|${err.agent || ""}|${err.title || ""}|${err.error || ""}`;
    if (!rec.errors.some((e) => `${e.stage || ""}|${e.agent || ""}|${e.title || ""}|${e.error || ""}` === key)) rec.errors.push(err);
  };
  return {
    runId,
    get: () => rec,
    onEvent: (ev) => {
      rec.events.push(eventSummary(ev));
      if (rec.events.length > 500) rec.events = rec.events.slice(-500);
      if (ev.type === "plan-done") { rec.plan = ev.tasks || rec.plan; rec.phase = "tasks"; flush(); }
      else if (ev.type === "task-done" && ev.entry && ev.entry.ok) {
        // Only checkpoint SUCCESSFUL tasks — a cancelled/failed task must be
        // re-run on resume, not replayed from a half-baked output.
        const i = rec.results.findIndex((r) => r.id === ev.entry.id);
        if (i >= 0) rec.results[i] = ev.entry; else rec.results.push(ev.entry);
        flush();
      } else if (ev.type === "task-done" && ev.entry && !ev.entry.ok) {
        noteError({ stage: "task", agent: ev.entry.agent, title: ev.entry.title, error: ev.entry.output || "任务失败" });
        flush();
      } else if (ev.type === "review-start") { rec.phase = "review"; flush(); }
      else if (ev.type === "review-done") {
        rec.review = ev.review; rec.verdict = verdictOf(ev.review) || rec.verdict;
        if (/Reviewer failed|run status:\s*error|已取消/i.test(ev.review || "")) noteError({ stage: "review", error: ev.review });
        flush();
      } else if (ev.type === "error") { noteError({ stage: ev.stage || "run", error: ev.error || "运行失败" }); flush(); }
    },
    finish: (status, patch = {}) => { rec = { ...rec, status, finishedAt: Date.now(), ...patch }; flush(); return rec; },
  };
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJson(p, o) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function uid(name) {
  const base = (name || "ws").toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "ws";
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

// Expand "~" and resolve to an absolute path.
function expand(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}
// Join `sub` under `root`, refusing to escape the subtree. Returns null on escape.
function safeJoin(root, sub) {
  const abs = path.resolve(root, sub || "");
  const rel = path.relative(root, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}
// Pretty form for display: collapse $HOME back to "~".
function tildify(p) { return HOME && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p; }

// ---- Seeds ----
const SEED_WORKSPACES = [
  { id: "pamu", name: "pamu", kind: "repo", cwd: "~/pamu", emoji: "🟢",
    summary: "POM 产品线 + 多服务（pom-backend / pom-search / echo / luming…）" },
  { id: "hyg", name: "hyg", kind: "repo", cwd: "~/hyg", emoji: "🔵",
    summary: "微服务后端：gate / llm_route / main_service / memory_service / model_route" },
  { id: "freeform", name: "天马行空", kind: "scratch", cwd: "projects/freeform", emoji: "🟣",
    summary: "从零的新点子与小工具" },
];
function wsDefaults(w) {
  return {
    mode: "agent",          // 免确认模式：默认可改
    crewId: null,           // null ⇒ 用默认 crew.json
    ceoSdkAgentId: null,    // 持久化 SDK 会话 id（Phase 2 写入）
    createdBy: "seed",
    color: "", archived: false, lastActiveAt: Date.now(),
    ...w,
  };
}

// ---- ensure scaffolding ----
function ensure() {
  ensureDir(agentsDir());
  if (fs.readdirSync(agentsDir()).filter((f) => f.endsWith(".json")).length === 0) {
    for (const a of SEED_AGENTS) writeJson(path.join(agentsDir(), `${a.id}.json`), a);
  }
  if (!fs.existsSync(crewPath())) {
    writeJson(crewPath(), {
      managerId: "ceo", reviewerId: "reviewer",
      workerIds: SEED_AGENTS.filter((a) => !a.suggestManager && !a.suggestReviewer).map((a) => a.id),
    });
  }
  if (!fs.existsSync(workspacesPath())) {
    const seeded = SEED_WORKSPACES.map(wsDefaults);
    writeJson(workspacesPath(), seeded);
    for (const w of seeded) {
      ensureDir(wsDir(w.id));
      if (w.kind === "scratch") ensureDir(expand(w.cwd));
    }
  }
  if (!fs.existsSync(settingsPath())) writeJson(settingsPath(), { cautious: false });
}

export function meta() {
  return { tools: AVAILABLE_TOOLS, models: AVAILABLE_MODELS, home: HOME };
}

// ---- Settings ----
const DEFAULT_WORKSPACE_BASE = "~";          // what the CEO can read/access (full home by default)
const PROJECTS_BASE = "~/ai-team-projects";  // where freshly-built projects are created (kept tidy)
export function getSettings() {
  ensure();
  return { cautious: false, workspaceBase: DEFAULT_WORKSPACE_BASE, ...readJson(settingsPath(), {}) };
}
export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  writeJson(settingsPath(), s);
  return s;
}

// ---- Agents Repository CRUD (unchanged) ----
export function listAgents() {
  ensure();
  return fs.readdirSync(agentsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(agentsDir(), f), null))
    .filter(Boolean);
}
export function getAgent(id) { return readJson(path.join(agentsDir(), `${id}.json`), null); }
export function createAgent(partial) {
  ensure();
  const id = partial.id && !fs.existsSync(path.join(agentsDir(), `${partial.id}.json`)) ? partial.id : uid(partial.name || partial.role);
  const agent = {
    id, name: partial.name || "New Agent", role: partial.role || "", model: partial.model || "claude-sonnet-4-6",
    goal: partial.goal || "", backstory: partial.backstory || "", persona: partial.persona || "",
    reasoning: partial.reasoning || "medium", memory: !!partial.memory,
    tools: partial.tools || [], mcp: partial.mcp || [], access: partial.access || "member",
    updatedAt: Date.now(),
  };
  writeJson(path.join(agentsDir(), `${id}.json`), agent);
  return agent;
}
export function saveAgent(agent) {
  ensure();
  if (!agent || !agent.id) throw new Error("员工缺少 id，无法保存");
  const next = { ...agent, updatedAt: Date.now() };
  const p = path.join(agentsDir(), `${next.id}.json`);
  writeJson(p, next);
  const saved = readJson(p, null);
  if (!saved || saved.id !== next.id) throw new Error("员工保存失败：写入后无法读回");
  return saved;
}
export function deleteAgent(id) {
  const p = path.join(agentsDir(), `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const crew = getCrew();
  crew.workerIds = (crew.workerIds || []).filter((x) => x !== id);
  if (crew.managerId === id) crew.managerId = null;
  if (crew.reviewerId === id) crew.reviewerId = null;
  saveCrew(crew);
  return true;
}

// ---- Crew assembly (default + per-workspace override) ----
export function getCrew() { ensure(); return readJson(crewPath(), { managerId: null, reviewerId: null, workerIds: [] }); }
export function saveCrew(crew) { writeJson(crewPath(), crew); return crew; }

// ---- Workspaces ----
function readWorkspaces() { ensure(); return readJson(workspacesPath(), []); }
export function listWorkspaces() {
  return readWorkspaces().filter((w) => !w.archived)
    .map((w) => ({ ...w, cwdDisplay: tildify(expand(w.cwd)), running: 0 }));
}
export function getWorkspace(id) {
  const w = readWorkspaces().find((x) => x.id === id);
  return w ? { ...w, cwdDisplay: tildify(expand(w.cwd)), cwdAbs: expand(w.cwd) } : null;
}
export function createWorkspace(partial) {
  const all = readWorkspaces();
  let id = partial.id || uid(partial.name);
  while (all.some((w) => w.id === id)) id = uid(partial.name);
  const kind = partial.kind || "scratch";
  // scratch workspaces get their own folder under a tidy projects base
  const cwd = partial.cwd || (kind === "scratch" ? path.join(PROJECTS_BASE, id) : "");
  const ws = wsDefaults({
    id, name: partial.name || id, kind, cwd, emoji: partial.emoji || "🟣",
    summary: partial.summary || "", createdBy: partial.createdBy || "ai",
  });
  all.push(ws);
  writeJson(workspacesPath(), all);
  ensureDir(wsDir(id));
  if (kind === "scratch") ensureDir(expand(cwd));
  return getWorkspace(id);
}
export function saveWorkspace(patch) {
  const all = readWorkspaces();
  const i = all.findIndex((w) => w.id === patch.id);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  writeJson(workspacesPath(), all);
  return getWorkspace(patch.id);
}
export function touchWorkspace(id) {
  const all = readWorkspaces();
  const i = all.findIndex((w) => w.id === id);
  if (i !== -1) { all[i].lastActiveAt = Date.now(); writeJson(workspacesPath(), all); }
}
export function deleteWorkspace(id) {
  const all = readWorkspaces().map((w) => (w.id === id ? { ...w, archived: true } : w));
  writeJson(workspacesPath(), all);
  return true;
}

// ---- File tree (path-safe within ws.cwd) ----
const TREE_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "target",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", ".DS_Store", ".cache",
]);
export function fsTree(wsId, sub = "") {
  const ws = getWorkspace(wsId);
  if (!ws) return { error: "no workspace" };
  const root = ws.cwdAbs;
  const abs = safeJoin(root, sub);
  if (abs === null) return { error: "out of bounds" };
  if (!fs.existsSync(abs)) return { root: ws.cwdDisplay, path: sub, entries: [] };
  let dirents = [];
  try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return { error: e.message }; }
  const entries = dirents
    .filter((d) => !TREE_IGNORE.has(d.name))
    .map((d) => {
      const isDir = d.isDirectory();
      const rel = sub ? `${sub}/${d.name}` : d.name;
      let size = 0, mtime = 0;
      if (!isDir) { try { const st = fs.statSync(path.join(abs, d.name)); size = st.size; mtime = st.mtimeMs; } catch {} }
      return { name: d.name, dir: isDir, path: rel, size, mtime };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { root: ws.cwdDisplay, path: sub, entries };
}
export function fsRead(wsId, rel) {
  const ws = getWorkspace(wsId);
  if (!ws) return { error: "no workspace" };
  const abs = safeJoin(ws.cwdAbs, rel);
  if (abs === null) return { error: "out of bounds" };
  if (!fs.existsSync(abs)) return { error: "not found" };
  const st = fs.statSync(abs);
  if (st.isDirectory()) return { error: "is a directory" };
  if (st.size > 600_000) return { error: "文件过大，无法预览", size: st.size };
  let content = "";
  try { content = fs.readFileSync(abs, "utf8"); } catch (e) { return { error: e.message }; }
  return { path: rel, content, size: st.size };
}

// ---- Per-agent memory (workspace-scoped SDK agent ids for memory=true agents) ----
const agentMemPath = (wsId) => path.join(wsDir(wsId), "agent-mem.json");
function makeMemStore(wsId) {
  return {
    get: (agentId) => readJson(agentMemPath(wsId), {})[agentId] || null,
    set: (agentId, sdkId) => { const m = readJson(agentMemPath(wsId), {}); m[agentId] = sdkId; writeJson(agentMemPath(wsId), m); },
  };
}

// ---- CEO chat history (UI mirror) ----
export function getChat(wsId) { return readJson(chatPath(wsId), []); }
export function saveChat(wsId, history) { writeJson(chatPath(wsId), (history || []).slice(-200)); return true; }

// ---- CEO conversations (multiple sessions) ----
const ceoChatPath = () => path.join(ROOT, "ceo-chat.json");          // legacy (migrated once)
const ceoSessionsPath = () => path.join(ROOT, "ceo-sessions.json");
const ideasPath = () => path.join(ROOT, "ideas.json");

function sessTitle(history) {
  const u = (history || []).find((m) => m.role === "user");
  return u && u.text ? u.text.trim().slice(0, 22) : "新对话";
}
function readSessions() {
  ensure();
  let s = readJson(ceoSessionsPath(), null);
  if (!s || !Array.isArray(s.sessions) || !s.sessions.length) {
    const old = readJson(ceoChatPath(), []);   // migrate the old single conversation
    const id = uid("sess");
    s = { activeId: id, sessions: [{
      id, title: sessTitle(old), createdAt: Date.now(), updatedAt: Date.now(),
      history: Array.isArray(old) ? old : [], sdkAgentId: getSettings().ceoAgentId || null,
    }] };
    writeJson(ceoSessionsPath(), s);
  }
  if (!s.sessions.some((x) => x.id === s.activeId)) s.activeId = s.sessions[0].id;
  return s;
}
function writeSessions(s) { writeJson(ceoSessionsPath(), s); }
function activeSession() { const s = readSessions(); return s.sessions.find((x) => x.id === s.activeId) || s.sessions[0]; }
function patchActiveSession(patch) {
  const s = readSessions();
  const x = s.sessions.find((y) => y.id === s.activeId);
  if (x) { Object.assign(x, patch, { updatedAt: Date.now() }); writeSessions(s); }
  return x;
}

export function listCeoSessions() {
  const s = readSessions();
  return {
    activeId: s.activeId,
    sessions: s.sessions
      .map((x) => ({ id: x.id, title: x.title || "新对话", updatedAt: x.updatedAt || 0, count: (x.history || []).length }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
}
export function setActiveSession(id) { const s = readSessions(); if (s.sessions.some((x) => x.id === id)) { s.activeId = id; writeSessions(s); } return listCeoSessions(); }
export function createCeoSession() {
  const s = readSessions();
  const id = uid("sess");
  s.sessions.unshift({ id, title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), history: [], sdkAgentId: null });
  s.activeId = id; writeSessions(s);
  return { id };
}
export function deleteCeoSession(id) {
  const s = readSessions();
  s.sessions = s.sessions.filter((x) => x.id !== id);
  if (!s.sessions.length) { const nid = uid("sess"); s.sessions = [{ id: nid, title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), history: [], sdkAgentId: null }]; s.activeId = nid; }
  else if (s.activeId === id) s.activeId = s.sessions[0].id;
  writeSessions(s);
  return listCeoSessions();
}

// getCeoChat / saveCeoChat operate on the ACTIVE session (keeps the renderer API stable).
export function getCeoChat() { return activeSession().history || []; }
export function saveCeoChat(history) {
  const h = (history || []).slice(-200);
  const cur = activeSession();
  patchActiveSession({ history: h, title: (cur.title && cur.title !== "新对话") ? cur.title : sessTitle(h) });
  return true;
}

// ---- Idea board (CEO 拟定的执行文档 → 看板卡片) ----
// status: "pending_confirm"(待确认) | "pending"(待执行) | "running"(执行中)
//       | "interrupted"(已中断) | "done"(执行完) | "failed"(失败)
function normalizeIdea(it) {
  if (!it) return it;
  let status = it.status;
  if (status === "open" || !status) status = "pending_confirm";   // migrate old "open"
  return { doc: "", verdict: "", error: "", projectId: null, stamp: null, runId: null, phase: "", progress: null, reason: "", ...it, status };
}
export function getIdeas() { ensure(); return readJson(ideasPath(), []).map(normalizeIdea); }
function writeIdeas(a) { writeJson(ideasPath(), a); }
export function addIdea(text, doc = "", status = "pending_confirm") {
  const a = getIdeas();
  const idea = {
    id: uid("idea"), text: (text || "").trim(), doc: doc || "",
    status, verdict: "", error: "",
    createdAt: Date.now(), projectId: null, stamp: null,
  };
  a.unshift(idea); writeIdeas(a); return idea;
}
// Human confirms a drafted plan: 待确认 → 待执行 (queued for the team).
export function confirmIdea(ideaId) { return updateIdea(ideaId, { status: "pending" }); }
// Manual move (drag-and-drop) to a pre-run lane. Running/done/failed aren't set
// this way — running goes through executeIdea, done/failed are outcomes.
export function ideaSetStatus(ideaId, status) {
  if (!["pending_confirm", "pending"].includes(status)) return null;
  return updateIdea(ideaId, { status, error: "", verdict: "" });
}
// Any card still "running" lost its in-memory run — on a graceful quit we mark it
// before exiting; a crash leaves it for the next launch to catch. Either way we
// move it to "interrupted" (NOT back to 待执行) so the finished agent work kept in
// the checkpoint can be resumed or rerun, and we record why it stopped.
export function markInterruptedRuns(reason = "app_crash") {
  const a = getIdeas();
  let changed = false;
  for (const it of a) {
    if (it.status !== "running") continue;
    it.status = "interrupted";
    it.error = "";
    it.reason = reason;
    it.progress = it.progress || null;
    changed = true;
    if (it.projectId && it.runId) {
      const rec = readRun(it.projectId, it.runId);
      if (rec && rec.status === "running") {
        rec.status = "interrupted"; rec.reason = reason; rec.updatedAt = Date.now();
        writeJson(runPath(it.projectId, it.runId), rec);
      }
    }
  }
  if (changed) writeIdeas(a);
  return changed;
}
// Back-compat alias (older callers).
export function resetOrphanRuns() { return markInterruptedRuns("app_crash"); }
export function updateIdea(id, patch) { const a = getIdeas(); const i = a.findIndex((x) => x.id === id); if (i >= 0) { a[i] = { ...a[i], ...patch }; writeIdeas(a); return a[i]; } return null; }
export function removeIdea(id) { writeIdeas(getIdeas().filter((x) => x.id !== id)); return true; }

// ---- Scheduler (7×24 自动跑) ----
// While the app is open, the team can wake up on a schedule, pull the oldest
// open idea (or a fixed standing brief), route it to a project, and run itself.
const SCHEDULE_DEFAULTS = {
  enabled: false,
  mode: "interval",     // "interval" = 每隔 N 小时 | "daily" = 每天定点
  everyHours: 6,
  dailyAt: "09:00",
  source: "ideas",      // "ideas" = 取点子清单 | "prompt" = 固定任务
  prompt: "",
  lastRunAt: 0,
  nextRunAt: 0,
  log: [],
};
export function getSchedule() {
  const s = getSettings();
  return { ...SCHEDULE_DEFAULTS, ...(s.schedule || {}) };
}
export function saveSchedule(patch) {
  const next = { ...getSchedule(), ...patch };
  if (Array.isArray(next.log)) next.log = next.log.slice(-30);
  saveSettings({ schedule: next });
  return next;
}
// Next fire time (ms epoch) given the schedule and a reference "now".
export function computeNextRun(sched, fromMs = Date.now()) {
  const s = sched || getSchedule();
  if (s.mode === "daily") {
    const [hh, mm] = String(s.dailyAt || "09:00").split(":").map((n) => parseInt(n, 10) || 0);
    const d = new Date(fromMs);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const hours = Math.max(0.05, Number(s.everyHours) || 6);
  return fromMs + Math.round(hours * 3600 * 1000);
}
function appendScheduleLog(entry) {
  const e = { at: Date.now(), ...entry };
  const log = [...(getSchedule().log || []), e].slice(-30);
  saveSchedule({ log });
  return e;
}

/**
 * Run ONE scheduled dispatch. Picks work (oldest open idea, or the fixed brief),
 * routes it to a project, and runs the crew there. Always advances nextRunAt.
 * @returns {Promise<{ok, skipped?, reason?, wsId?, wsName?, stamp?, verdict?}>}
 */
export async function runScheduleOnce(apiKey, onCrewEvent, onStream, manual = false) {
  const sched = getSchedule();
  const bump = () => saveSchedule({ lastRunAt: Date.now(), nextRunAt: computeNextRun(getSchedule(), Date.now()) });
  let ideaId = null;

  if (sched.source === "prompt") {
    const brief = (sched.prompt || "").trim();
    if (!brief) {
      const e = appendScheduleLog({ type: "skip", msg: "没有配置固定任务" });
      bump();
      return { ok: true, skipped: true, reason: e.msg };
    }
    const idea = await planIdea(brief, apiKey, onStream);
    confirmIdea(idea.id);   // autonomous task: skip human confirm, queue it directly
    ideaId = idea.id;
  } else {
    // Only run cards the human already confirmed (待执行).
    const pending = getIdeas().filter((i) => i.status === "pending");
    const pick = pending[pending.length - 1];   // oldest confirmed (addIdea unshifts newest first)
    if (!pick) {
      appendScheduleLog({ type: "skip", msg: "看板没有「待执行」卡片，无活可派" });
      bump();
      return { ok: true, skipped: true, reason: "没有待执行卡片" };
    }
    ideaId = pick.id;
  }

  const idea = getIdeas().find((x) => x.id === ideaId);
  const res = await executeIdea(ideaId, apiKey, onCrewEvent, onStream);
  if (res.ok) {
    appendScheduleLog({ type: "done", brief: idea && idea.text, wsId: res.wsId, wsName: res.wsName, stamp: res.stamp, verdict: res.verdict, manual });
  } else {
    appendScheduleLog({ type: "error", msg: res.error, brief: idea && idea.text });
  }
  bump();
  return res;
}

function ceoAgentDef() { const crew = getCrew(); return (crew.managerId && getAgent(crew.managerId)) || getAgent("ceo") || listAgents()[0]; }
// The default crew used by the global CEO conversation.
function globalCrew() {
  const crew = getCrew();
  const manager = (crew.managerId && getAgent(crew.managerId)) || getAgent("ceo");
  const reviewer = crew.reviewerId ? getAgent(crew.reviewerId) : null;
  const workers = (crew.workerIds || []).map(getAgent).filter(Boolean);
  return { manager, reviewer, workers };
}

// Route a goal to the project it belongs to (existing or a freshly-created one).
async function routeToProject(text, apiKey) {
  const r = await classifyWorkspace(text, listWorkspaces(), apiKey).catch(() => null);
  if (r && r.match) return r.match;
  if (r && r.new) return createWorkspace({ name: r.new.name, kind: r.new.kind, summary: r.new.summary, createdBy: "ai" }).id;
  const all = listWorkspaces();
  return all[0] ? all[0].id : createWorkspace({ name: "新项目", kind: "scratch", createdBy: "ai" }).id;
}

// CEO drafts an execution document for a goal and files it as a 待执行 card.
export async function planIdea(goal, apiKey, onStream, history = null) {
  const { manager, workers } = globalCrew();
  const ceo = manager || ceoAgentDef();
  if (onStream) onStream({ kind: "planning", brief: goal });
  const skillPick = buildSkillContextForTurn({
    agent: ceo,
    task: { title: "拟定执行文档", description: goal, expectedOutput: "一份可执行的任务文档" },
    idea: goal,
    context: (history || getCeoChat()).map((m) => m.text || "").join("\n"),
  });
  const doc = await ceoExecDoc(ceo, goal, workers, apiKey, {
    onRun: (run) => { ceoRun = run; },
    history: history || getCeoChat(),
    skillContext: skillPick.context,
  }).catch(() => "");
  ceoRun = null;
  const idea = addIdea(goal, doc);
  if (onStream) onStream({ kind: "doc", idea });
  return idea;
}

// Where the CEO "thinks" / what it can read. Defaults to the user's whole home
// (~) so it can read any project without being configured. Narrow it in Settings
// (e.g. ~/xhsclaw) if you'd rather scope it down.
function ceoCwd() {
  const s = getSettings();
  const dir = expand(s.workspaceBase || DEFAULT_WORKSPACE_BASE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

// The in-flight CEO run (chat reply or plan drafting), for the stop button.
let ceoRun = null;
export function cancelCeoChat() { try { ceoRun?.cancel?.(); } catch {} return true; }

// A plain chat reply from the CEO. Stateless + recent history in the prompt, so
// the conversation is never lost to a flaky resume.
async function ceoDirectReply(ceo, message, apiKey, onStream, history) {
  const skillPick = buildSkillContextForTurn({
    agent: ceo,
    task: { title: "CEO 对话", description: message, expectedOutput: "高质量建议" },
    idea: message,
    context: (history || getCeoChat()).map((m) => m.text || "").join("\n"),
  });
  const res = await ceoChatTurn(ceo, message, ceoCwd(), {
    apiKey, mode: "plan", store: await sdkStore(), onStream,
    history: history || getCeoChat(), onRun: (run) => { ceoRun = run; }, skillContext: skillPick.context,
  });
  ceoRun = null;
  return { ...res, mode: "direct" };
}

/**
 * The CEO conversation. `intent` is set explicitly by the UI:
 *   "chat" → always a normal chat reply / advice, NEVER builds a plan.
 *   "task" → draft an execution doc and file it on the board as 待执行.
 *   "auto" → (fallback) infer from the message.
 */
export async function chatWithCeo(history, message, apiKey, onStream, onCrewEvent, intent = "auto") {
  const ceo = ceoAgentDef();
  if (!ceo) throw new Error("没有可用的 CEO（在员工库配置一个）。");

  if (intent === "chat") return ceoDirectReply(ceo, message, apiKey, onStream, history);
  if (intent === "task") {
    const idea = await planIdea(message, apiKey, onStream, history);
    return { ok: true, mode: "capture", idea };
  }

  // auto: a task-like message (capture OR delegate) just gets a drafted plan in
  // 待确认 — nothing runs until the human confirms it. Everything else is chat.
  const decision = await decideCeoAction(message, history, apiKey).catch(() => ({ action: "direct" }));
  if (decision.action === "capture" || decision.action === "delegate") {
    const idea = await planIdea(decision.brief || message, apiKey, onStream, history);
    return { ok: true, mode: "capture", idea };
  }
  return ceoDirectReply(ceo, message, apiKey, onStream, history);
}

// Execute a board card: dispatch the team, moving the card pending → running →
// done / failed and recording the verdict / error.
export async function executeIdea(ideaId, apiKey, onCrewEvent, onStream, opts = {}) {
  const idea = getIdeas().find((x) => x.id === ideaId);
  if (!idea) throw new Error("卡片不存在");
  let wsId = idea.projectId && getWorkspace(idea.projectId) ? idea.projectId : null;
  let ws = wsId ? getWorkspace(wsId) : null;

  // Resume picks up the last checkpoint; rerun/fresh start from zero.
  const resume = opts.resume ? loadResumePayload(idea) : null;
  updateIdea(ideaId, { status: "running", error: "", phase: resume ? (idea.phase || "tasks") : "plan", progress: resume?.progress || null });
  if (onStream) onStream({ kind: "status", ideaId, status: "running" });
  try {
    // Reuse the workspace a prior run already routed to (so resume stays in place).
    wsId = wsId || await routeToProject(idea.text, apiKey);
    ws = getWorkspace(wsId);
    updateIdea(ideaId, { projectId: wsId });   // set early so a running card can be cancelled
    if (onStream) onStream({ kind: "delegate", ideaId, brief: idea.text, wsId, wsName: ws && ws.name });
    const brief = idea.doc ? `${idea.text}\n\n# 参考执行文档（由 CEO 拟定，请据此推进）\n${idea.doc}` : idea.text;
    const { stamp, run, runId } = await runCrew(
      wsId, brief,
      (evt) => onCrewEvent && onCrewEvent({ wsId, ideaId, ...evt }),
      apiKey,
      {
        ideaId, idea: idea.text, resume,
        onProgress: (patch) => updateIdea(ideaId, patch),
      },
    );
    const verdict = (run.review || "").match(/VERDICT:?\s*(SHIP|FIX|KILL)/i)?.[1]?.toUpperCase() || "";
    if (run.cancelled && run.cancelReason === "quit") {
      // App was shutting down — keep it resumable as 已中断 (don't reset to 待执行).
      updateIdea(ideaId, { status: "interrupted", projectId: wsId, runId, reason: "app_quit", error: "" });
      if (onStream) onStream({ kind: "status", ideaId, status: "interrupted" });
      return { ok: true, wsId, wsName: ws && ws.name, interrupted: true };
    }
    const status = run.cancelled ? "pending" : (verdict === "KILL" ? "failed" : "done");
    const hasErrors = (run.errors || []).length > 0 || (run.results || []).some((r) => !r.ok) || /Reviewer failed|run status:\s*error/i.test(run.review || "");
    const finalStatus = hasErrors ? "failed" : status;
    updateIdea(ideaId, { status: finalStatus, projectId: wsId, stamp, runId, verdict, error: hasErrors ? summarizeRunError(run) : "", phase: "", progress: null });
    if (onStream) onStream({ kind: "status", ideaId, status: finalStatus, verdict, error: hasErrors ? summarizeRunError(run) : "" });
    return { ok: !hasErrors, wsId, wsName: ws && ws.name, stamp, verdict, cancelled: !!run.cancelled, error: hasErrors ? summarizeRunError(run) : "" };
  } catch (err) {
    const runErr = err.run ? (summarizeRunError(err.run) || err.message) : err.message;
    updateIdea(ideaId, { status: "failed", projectId: wsId || idea.projectId, stamp: err.stamp || idea.stamp || null, runId: err.runId || idea.runId || null, error: runErr, phase: "", progress: null });
    if (onStream) onStream({ kind: "status", ideaId, status: "failed", error: err.message });
    return { ok: false, error: err.message };
  }
}

function summarizeRunError(run) {
  const first = (run.errors || [])[0];
  if (first) {
    const who = first.agent ? `${first.agent} · ` : "";
    const where = first.title || first.stage || "运行";
    return `${who}${where}失败：${String(first.error || "未知错误").replace(/^ERROR:\s*/i, "").slice(0, 160)}`;
  }
  const failed = (run.results || []).find((r) => !r.ok);
  if (failed) return `${failed.agent} · ${failed.title}失败：${String(failed.output || "").replace(/^ERROR:\s*/i, "").slice(0, 160)}`;
  if (/Reviewer failed/i.test(run.review || "")) return String(run.review).slice(0, 160);
  return "";
}

// Build a resume payload from an idea's last checkpoint (plan + finished tasks).
function loadResumePayload(idea) {
  if (!idea || !idea.projectId || !idea.runId) return null;
  const rec = readRun(idea.projectId, idea.runId);
  if (!rec) return null;
  return {
    runId: idea.runId,
    tasks: rec.plan || [],
    results: rec.results || [],
    review: rec.review || null,
    verdict: rec.verdict || "",
    startedAt: rec.startedAt,
    progress: { total: (rec.plan || []).length, done: (rec.results || []).length },
  };
}

// Continue an interrupted run from its last checkpoint.
export async function resumeIdea(ideaId, apiKey, onCrewEvent, onStream) {
  return executeIdea(ideaId, apiKey, onCrewEvent, onStream, { resume: true });
}
// Throw away the checkpoint and run the idea from scratch.
export async function rerunIdea(ideaId, apiKey, onCrewEvent, onStream) {
  updateIdea(ideaId, { runId: null, stamp: null, verdict: "", error: "", phase: "", progress: null });
  return executeIdea(ideaId, apiKey, onCrewEvent, onStream, {});
}
// Drop an interrupted run back to 待执行 without doing anything else.
export function discardRun(ideaId) {
  return updateIdea(ideaId, { status: "pending", phase: "", progress: null, error: "" });
}

// A report for the detail modal: the finished mission if there is one, otherwise
// whatever the checkpoint captured (so interrupted runs still show partial work).
export function ideaReport(ideaId) {
  const idea = getIdeas().find((x) => x.id === ideaId);
  if (!idea) return null;
  if (idea.stamp && idea.projectId) {
    const run = getMission(idea.projectId, idea.stamp);
    if (run) return { kind: "final", run };
  }
  if (idea.projectId && idea.runId) {
    const rec = readRun(idea.projectId, idea.runId);
    if (rec) return { kind: "checkpoint", run: { ...rec, tasks: rec.plan } };
  }
  return null;
}

function artifactKind(name) {
  const ext = path.extname(name || "").slice(1).toLowerCase();
  if (["md", "txt", "csv", "json", "html", "css", "js", "ts", "py", "sh", "yml", "yaml"].includes(ext)) return ext || "file";
  return ext || "file";
}
function resultCodeArtifacts(results = [], source = "检查点产物") {
  const out = [];
  const used = new Set();
  for (const r of results || []) {
    const text = r.output || "";
    const re = /```([\w.+-]*)\n([\s\S]*?)```/g;
    let m, idx = 0;
    while ((m = re.exec(text))) {
      const lang = (m[1] || "").toLowerCase();
      const code = m[2] || "";
      const before = text.slice(Math.max(0, m.index - 200), m.index);
      const nameHit = before.match(/([\w\-./]+\.(?:html|js|ts|py|css|json|sh|md|sql|ya?ml|go))/i);
      let name = nameHit ? path.basename(nameHit[1]) : `snippet-${r.id}-${++idx}.${EXT[lang] || "txt"}`;
      while (used.has(name)) name = name.replace(/(\.\w+)$/, `-${++idx}$1`);
      used.add(name);
      out.push({
        id: `${source}:${r.id}:${idx}`,
        source,
        name,
        path: `${r.agent || "agent"}/${name}`,
        kind: artifactKind(name),
        size: Buffer.byteLength(code, "utf8"),
        mtime: Date.now(),
        previewable: true,
        content: code,
      });
    }
  }
  return out;
}
function listTextFiles(root, source, prefix = "") {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const walk = (dir, relBase = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".DS_Store" || e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, rel); continue; }
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      const kind = artifactKind(e.name);
      const previewable = ["md", "txt", "csv", "json", "html", "css", "js", "ts", "py", "sh", "yml", "yaml"].includes(kind) && st.size <= 800_000;
      out.push({
        id: `${source}:${rel}`,
        source,
        name: e.name,
        path: prefix ? `${prefix}/${rel}` : rel,
        kind,
        size: st.size,
        mtime: st.mtimeMs,
        previewable,
        content: previewable ? fs.readFileSync(abs, "utf8") : "",
      });
    }
  };
  walk(root);
  return out;
}
function fileArtifact(abs, source, displayPath) {
  if (!abs || !fs.existsSync(abs)) return null;
  let st = null;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const name = path.basename(abs);
  const kind = artifactKind(name);
  const previewable = ["md", "txt", "csv", "json", "html", "css", "js", "ts", "py", "sh", "yml", "yaml"].includes(kind) && st.size <= 800_000;
  return {
    id: `${source}:${displayPath || name}`,
    source,
    name,
    path: displayPath || name,
    kind,
    size: st.size,
    mtime: st.mtimeMs,
    previewable,
    content: previewable ? fs.readFileSync(abs, "utf8") : "",
  };
}
function classifyArtifact(a) {
  const p = `${a.path || ""} ${a.name || ""}`.toLowerCase();
  const src = a.source || "";
  if (src === "工作区产物") return { category: "final", categoryLabel: "最终产物", hidden: false, priority: 100 };
  if (/(final|release|deliverable|blueprint|runbook|launch|package|成片|发布|交付|方案|脚本|剪辑|分镜|audit|params)/i.test(p)) {
    return { category: "final", categoryLabel: "最终产物", hidden: false, priority: 90 };
  }
  if (/(report\.md|summary|review|analysis|check|diagnostic|material|quality|csv|md$|json$)/i.test(p)) {
    return { category: "valuable", categoryLabel: "有价值的中间产物", hidden: false, priority: 50 };
  }
  if (/^(snippet|tmp|temp|scratch|debug|log|trace)|(\.log$|\.tmp$|\.bak$)/i.test(p) || src === "运行提取" || src === "检查点产物" || src === "运行记录") {
    return { category: "hidden", categoryLabel: "不用看的中间产物", hidden: true, priority: 10 };
  }
  return { category: "valuable", categoryLabel: "有价值的中间产物", hidden: false, priority: 40 };
}
// Artifacts tab for the idea detail modal: extracted run snippets + workspace
// deliverables. Keeps everything read-only and small enough for the renderer.
export function ideaArtifacts(ideaId) {
  const idea = getIdeas().find((x) => x.id === ideaId);
  if (!idea) return { artifacts: [], workspace: null };
  const artifacts = [];
  const seen = new Set();
  const addMany = (items) => {
    for (const a of items || []) {
      const key = `${a.source}:${a.path}:${a.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(a);
    }
  };
  if (idea.projectId && idea.stamp) {
    const mdir = missionDir(idea.projectId, idea.stamp);
    addMany([
      fileArtifact(path.join(mdir, "report.md"), "运行记录", "report.md"),
      fileArtifact(path.join(mdir, "run.json"), "运行记录", "run.json"),
    ].filter(Boolean));
    addMany(listTextFiles(path.join(mdir, "files"), "运行提取"));
  }
  if (idea.projectId && idea.runId) {
    const rec = readRun(idea.projectId, idea.runId);
    if (rec) addMany(resultCodeArtifacts(rec.results || [], idea.stamp ? "检查点产物" : "中断产物"));
  }
  const ws = idea.projectId ? getWorkspace(idea.projectId) : null;
  if (ws && ws.cwdAbs) {
    const deliverables = safeJoin(ws.cwdAbs, "deliverables");
    if (deliverables) addMany(listTextFiles(deliverables, "工作区产物", "deliverables"));
  }
  for (const a of artifacts) Object.assign(a, classifyArtifact(a));
  artifacts.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.mtime || 0) - (a.mtime || 0));
  return { artifacts, workspace: ws ? { id: ws.id, name: ws.name, cwdDisplay: ws.cwdDisplay } : null };
}

// Working-directory cleanliness check (Phase C): warn before resuming on top of
// uncommitted changes. Returns { repo, dirty, files } — repo=false when not a git
// repo (or git is unavailable), in which case the UI just skips the warning.
export function workspaceGitStatus(wsId) {
  const ws = getWorkspace(wsId);
  if (!ws || !ws.cwdAbs || !fs.existsSync(ws.cwdAbs)) return { repo: false };
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ws.cwdAbs, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return { repo: false }; }
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: ws.cwdAbs, encoding: "utf8" });
    const files = out.split("\n").map((s) => s.trim()).filter(Boolean);
    return { repo: true, dirty: files.length, files: files.slice(0, 20) };
  } catch { return { repo: true, dirty: 0, files: [] }; }
}
export function ideaGitStatus(ideaId) {
  const idea = getIdeas().find((x) => x.id === ideaId);
  if (!idea || !idea.projectId) return { repo: false };
  return workspaceGitStatus(idea.projectId);
}

// True while at least one crew run is in flight (used for graceful shutdown).
export function hasActiveRuns() { return controllers.size > 0; }
export function activeRunWorkspaces() { return [...controllers.keys()]; }
export function cancelAllRuns(reason = "quit") { for (const id of [...controllers.keys()]) cancelRun(id, reason); return true; }

// ---- Missions (run history, per workspace) ----
function verdict(r) { const m = (r || "").match(/VERDICT:?\s*(SHIP|FIX|KILL)/i); return m ? m[1].toUpperCase() : ""; }

const EXT = { html: "html", js: "js", javascript: "js", ts: "ts", typescript: "ts", py: "py", python: "py", css: "css", json: "json", bash: "sh", sh: "sh", md: "md", sql: "sql", yaml: "yml", yml: "yml", go: "go" };

function extractFiles(dir, results) {
  const filesDir = path.join(dir, "files");
  let count = 0;
  const used = new Set();
  for (const r of results) {
    const text = r.output || "";
    const re = /```([\w.+-]*)\n([\s\S]*?)```/g;
    let m, idx = 0;
    while ((m = re.exec(text))) {
      const lang = (m[1] || "").toLowerCase();
      const code = m[2];
      const before = text.slice(Math.max(0, m.index - 200), m.index);
      const nameHit = before.match(/([\w\-./]+\.(?:html|js|ts|py|css|json|sh|md|sql|ya?ml|go))/i);
      let name = nameHit ? path.basename(nameHit[1]) : `snippet-${r.id}-${++idx}.${EXT[lang] || "txt"}`;
      while (used.has(name)) name = name.replace(/(\.\w+)$/, `-${++idx}$1`);
      used.add(name);
      ensureDir(filesDir);
      fs.writeFileSync(path.join(filesDir, name), code);
      count++;
    }
  }
  return count;
}

function writeMission(wsId, run) {
  const stamp = new Date(run.finishedAt || Date.now()).toISOString().replace(/[:.]/g, "-");
  const dir = ensureDir(path.join(missionsDir(wsId), stamp));
  let md = `# ${run.idea}\n\nManager: ${run.manager?.name}\n\n## Plan\n`;
  for (const t of run.tasks) md += `- **${t.agentName || t.agent}** (${t.role}) — ${t.title}\n`;
  if (run.errors?.length) {
    md += `\n## Failure diagnostics\n`;
    for (const e of run.errors) {
      const who = e.agent ? `${e.agent} — ` : "";
      md += `- ${who}${e.title || e.stage || "run"}: ${String(e.error || "unknown").replace(/^ERROR:\s*/i, "")}\n`;
    }
  }
  md += `\n## Deliverables\n`;
  for (const r of run.results) md += `\n### #${r.id} ${r.agent} — ${r.title}\n\n${r.output}\n`;
  if (run.review) md += `\n## Review\n\n${run.review}\n`;
  fs.writeFileSync(path.join(dir, "report.md"), md);
  run.fileCount = extractFiles(dir, run.results);
  writeJson(path.join(dir, "run.json"), run);
  return stamp;
}

export function listMissions(wsId) {
  const dir = missionsDir(wsId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const run = readJson(path.join(dir, d.name, "run.json"), null);
      return { wsId, stamp: d.name, idea: run?.idea || "", verdict: verdict(run?.review), finishedAt: run?.finishedAt || 0, agents: (run?.tasks || []).length };
    })
    .sort((a, b) => b.finishedAt - a.finishedAt);
}
export function listAllMissions() {
  const out = [];
  for (const w of listWorkspaces()) for (const m of listMissions(w.id)) out.push({ ...m, wsName: w.name, emoji: w.emoji });
  return out.sort((a, b) => b.finishedAt - a.finishedAt);
}
export function getMission(wsId, stamp) { return readJson(path.join(missionsDir(wsId), stamp, "run.json"), null); }
export function missionDir(wsId, stamp) { return path.join(missionsDir(wsId), stamp); }
// One-time/ongoing compatibility pass for older mission folders: extract code
// blocks into files/ and persist fileCount so the artifacts tab has something
// useful even for runs created before the artifacts UI existed.
export function backfillMissionArtifacts() {
  let changed = 0;
  for (const w of listWorkspaces()) {
    const mdir = missionsDir(w.id);
    if (!fs.existsSync(mdir)) continue;
    for (const d of fs.readdirSync(mdir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(mdir, d.name);
      const runFile = path.join(dir, "run.json");
      const run = readJson(runFile, null);
      if (!run) continue;
      const filesDir = path.join(dir, "files");
      const existing = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).filter((x) => x !== ".DS_Store").length : 0;
      if (existing === 0 && (run.results || []).length) {
        run.fileCount = extractFiles(dir, run.results || []);
        writeJson(runFile, run);
        changed++;
      } else if (run.fileCount == null) {
        run.fileCount = existing;
        writeJson(runFile, run);
        changed++;
      }
    }
  }
  return changed;
}

export function usage() {
  const all = listAllMissions();
  let agentCalls = 0, totalMs = 0;
  for (const t of all) {
    const full = getMission(t.wsId, t.stamp);
    if (!full) continue;
    agentCalls += (full.results?.length || 0) + 1 + (full.review ? 1 : 0);
    totalMs += (full.finishedAt || 0) - (full.startedAt || 0);
  }
  return { runCount: all.length, agentCalls, totalMs, workspaceCount: listWorkspaces().length };
}

// ---- Skills (synced from Cursor) ----------------------------------------
// We mirror the user's Cursor skill folders into <root>/skills so the app "owns"
// a copy the team can browse (and later draw on). Each skill is a folder with a
// SKILL.md (YAML frontmatter: name + description) plus optional asset files.
const skillsDir = () => ensureDir(path.join(ROOT, "skills"));
const skillsMetaPath = () => path.join(skillsDir(), ".synced.json");
// Skill roots we pull from, in priority order (first occurrence of a name wins).
function skillSources() {
  return [
    { dir: path.join(HOME, ".cursor", "skills-cursor"), label: "Cursor 内置" },
    { dir: path.join(HOME, ".cursor", "skills"), label: "Cursor" },
    { dir: path.join(HOME, ".claude", "skills"), label: "Claude" },
    { dir: path.join(HOME, ".agents", "skills"), label: "Agents" },
    { dir: path.join(HOME, "xhsclaw", ".agents", "skills"), label: "Workspace Agents" },
    { dir: path.join(HOME, "xhsclaw", ".cursor", "skills"), label: "Workspace Cursor" },
  ].filter((s) => s.dir && fs.existsSync(s.dir));
}
const SKILL_COPY_SKIP = new Set(["node_modules", ".venv", "venv", ".git", "__pycache__", ".DS_Store"]);
function skillIdFromRel(rel, fallback) {
  return (rel || fallback || "skill")
    .toLowerCase()
    .replace(/\/skill\.md$/i, "")
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "skill";
}
function discoverSkillDirs(root, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      out.push(dir);
      // Keep walking: some skill packs contain nested skills.
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || SKILL_COPY_SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
function copyTree(src, dest) {
  ensureDir(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKILL_COPY_SKIP.has(e.name)) continue;
    const from = path.join(src, e.name), to = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}
// Copy every skill folder (one that contains a SKILL.md) from each known root
// into our skills dir, de-duplicating by folder name. Returns counts + source map.
export function syncCursorSkills() {
  const dest = skillsDir();
  const sources = skillSources();
  const seen = new Map();            // id -> source label
  let count = 0;
  for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dest, e.name, "SKILL.md"))) {
      fs.rmSync(path.join(dest, e.name), { recursive: true, force: true });
    }
  }
  for (const { dir, label } of sources) {
    for (const from of discoverSkillDirs(dir)) {
      const rel = path.relative(dir, from);
      const base = path.basename(from);
      let id = skillIdFromRel(rel, base);
      if (seen.has(id)) id = skillIdFromRel(`${label}-${rel}`, base);
      if (seen.has(id)) id = `${id}-${count + 1}`;
      copyTree(from, path.join(dest, id));
      seen.set(id, label);
      count++;
    }
  }
  const meta = { at: Date.now(), count, sources: sources.map((s) => s.label), sourceMap: Object.fromEntries(seen) };
  writeJson(skillsMetaPath(), meta);
  return meta;
}
// Pull name + description out of the SKILL.md YAML frontmatter (handles folded
// `>-` / `>` / `|` block scalars that span several indented lines).
function parseSkillMeta(md) {
  let name = "", description = "";
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { name, description };
  const fm = m[1];
  const nameM = fm.match(/^name:\s*(.+)$/m);
  if (nameM) name = nameM[1].trim().replace(/^["']|["']$/g, "");
  const descM = fm.match(/^description:\s*(.*)$/m);
  if (descM) {
    let d = descM[1].trim();
    if (["", ">-", ">", "|", "|-", ">+", "|+"].includes(d)) {
      const after = fm.slice(fm.indexOf(descM[0]) + descM[0].length).split("\n");
      const lines = [];
      for (const ln of after) {
        if (/^\s+\S/.test(ln)) lines.push(ln.trim());
        else if (ln.trim() === "") continue;
        else break;
      }
      d = lines.join(" ");
    } else {
      d = d.replace(/^["']|["']$/g, "");
    }
    description = d;
  }
  return { name, description };
}
export function listSkills() {
  const dir = skillsDir();
  const meta = readJson(skillsMetaPath(), null);
  const sourceMap = meta?.sourceMap || {};
  const skills = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const skillMd = path.join(dir, d.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const { name, description } = parseSkillMeta(fs.readFileSync(skillMd, "utf8"));
    skills.push({ id: d.name, name: name || d.name, description, source: sourceMap[d.name] || "其它" });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, syncedAt: meta?.at || 0 };
}
export function getSkill(id) {
  if (!id) return null;
  const base = path.join(skillsDir(), id);
  const skillMd = path.join(base, "SKILL.md");
  if (!fs.existsSync(skillMd)) return null;
  const content = fs.readFileSync(skillMd, "utf8");
  const { name, description } = parseSkillMeta(content);
  const files = [];
  const walk = (rel) => {
    const abs = path.join(base, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (files.length >= 200) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (r !== "SKILL.md") files.push(r);
    }
  };
  try { walk(""); } catch {}
  return { id, name: name || id, description, content, files };
}

function stripSkillFrontmatter(content = "") {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}
function queryTokens(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}|[\u4e00-\u9fa5]{2,}/g) || [])
    .filter((t) => !["the", "and", "for", "with", "this", "that", "一个", "这个", "我们", "任务", "输出", "执行"].includes(t))
    .slice(0, 80);
}
function heuristicSkillBoost(query, skill) {
  const q = query.toLowerCase();
  const s = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
  let score = 0;
  const hit = (needles, skills, v = 12) => {
    if (needles.some((n) => q.includes(n)) && skills.some((n) => s.includes(n))) score += v;
  };
  hit(["ui", "frontend", "react", "tailwind", "css", "页面", "组件", "界面", "设计", "视觉"], ["ui", "frontend", "react", "tailwind", "css", "design"]);
  hit(["视频", "分镜", "剪映", "小云雀", "pippit", "tts", "配音", "字幕", "hyperframes"], ["video", "hyperframes", "media", "voice", "remotion"]);
  hit(["seo", "搜索", "排名", "内容", "文章", "关键词"], ["seo", "keyword", "content", "serp", "schema"]);
  hit(["性能", "慢", "优化", "卡顿"], ["performance", "profiling"]);
  hit(["安全", "漏洞", "secret", "token", "key"], ["security", "review"]);
  hit(["技能", "skill", "cursor", "agent", "sdk"], ["skill", "cursor", "agent", "sdk"]);
  return score;
}
function scoreSkill(skill, content, query, tokens) {
  const hay = `${skill.id} ${skill.name} ${skill.description} ${content.slice(0, 5000)}`.toLowerCase();
  let score = heuristicSkillBoost(query, skill);
  for (const t of tokens) {
    if (!t || t.length < 2) continue;
    if (hay.includes(t)) score += t.length > 8 ? 4 : 2;
    if (`${skill.id} ${skill.name}`.toLowerCase().includes(t)) score += 8;
    if ((skill.description || "").toLowerCase().includes(t)) score += 4;
  }
  return score;
}
// All agents can use all synced skills without manual config. We auto-select the
// most relevant few per turn so prompts stay useful instead of dumping 80 docs.
function buildSkillContextForTurn({ agent, task, idea, context }) {
  try {
    if ((listSkills().skills || []).length === 0) syncCursorSkills();
  } catch {}
  const skills = listSkills().skills || [];
  if (!skills.length) return "";
  const query = [
    idea,
    agent?.name, agent?.role, agent?.goal,
    task?.title, task?.description, task?.expectedOutput,
    String(context || "").slice(-2500),
  ].filter(Boolean).join("\n");
  const tokens = queryTokens(query);
  const ranked = [];
  for (const sk of skills) {
    const full = getSkill(sk.id);
    if (!full?.content) continue;
    const body = stripSkillFrontmatter(full.content);
    const score = scoreSkill(sk, body, query, tokens);
    if (score > 0) ranked.push({ ...sk, body, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, 5);
  if (!selected.length) return { context: "", selected: [] };
  const contextText = [
    "The full skill library is enabled for every agent automatically. The following skills were auto-selected as most relevant for this turn. Follow them when applicable; if none apply, proceed normally.",
    ...selected.map((s) => `\n## Skill: ${s.name} (${s.source || "skills"})\n${s.description ? `Description: ${s.description}\n` : ""}${s.body.slice(0, 3200)}`),
  ].join("\n");
  return {
    context: contextText,
    selected: selected.map((s) => ({ id: s.id, name: s.name, source: s.source || "" })),
  };
}

// ---- CEO chat (workspace-scoped, stateful + streaming + auto-delegate) ----
// The CEO first decides: answer directly, or spin up the whole team. On
// "delegate" the crew runs and streams via onCrewEvent; on "direct" the CEO
// streams its reply via onStream.
export async function chatWithWorkspaceCeo(wsId, history, message, apiKey, onStream, onCrewEvent) {
  const ws = getWorkspace(wsId);
  if (!ws) throw new Error("Workspace not found: " + wsId);
  const crew = resolveCrew(ws);
  const ceo = crew.manager || getAgent("ceo");
  if (!ceo) throw new Error("No CEO/manager agent configured.");
  touchWorkspace(wsId);

  // 1. Decide.
  const decision = await decideCeoAction(message, history, apiKey, ws).catch(() => ({ action: "direct" }));

  // 2. Delegate → run the team.
  if (decision.action === "delegate") {
    const brief = decision.brief || message;
    if (onStream) onStream({ kind: "delegate", brief, reason: decision.reason || "" });
    const { stamp, run } = await runCrew(wsId, brief, onCrewEvent, apiKey);
    const verdict = (run.review || "").match(/VERDICT:?\s*(SHIP|FIX|KILL)/i)?.[1]?.toUpperCase() || "";
    return { ok: true, mode: "delegate", brief, stamp, verdict, cancelled: !!run.cancelled };
  }

  // 3. Direct → stateful CEO reply.
  const res = await ceoChatTurn(ceo, message, ws.cwdAbs, {
    apiKey, mode: effectiveMode(ws), store: await sdkStore(),
    sdkAgentId: ws.ceoSdkAgentId || null, onStream,
  });
  if (res.sdkAgentId && res.sdkAgentId !== ws.ceoSdkAgentId) saveWorkspace({ id: wsId, ceoSdkAgentId: res.sdkAgentId });
  return { ...res, mode: "direct" };
}
// Legacy 1:1 chat with any agent (kept for the Agents page).
export async function chatWithAgent(agentId, history, message, apiKey) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error("Agent not found: " + agentId);
  return chatTurn(agent, history, message, ROOT, { apiKey });
}

function resolveCrew(ws) {
  const crew = getCrew();
  const manager = crew.managerId ? getAgent(crew.managerId) : null;
  const reviewer = crew.reviewerId ? getAgent(crew.reviewerId) : null;
  const workers = (crew.workerIds || []).map(getAgent).filter(Boolean);
  return { manager, reviewer, workers };
}
// In cautious mode, force read-only ("plan") regardless of the workspace toggle.
function effectiveMode(ws) {
  const { cautious } = getSettings();
  if (cautious) return "plan";
  return ws.mode === "plan" ? "plan" : "agent";
}

// ---- Run the assembled crew inside a workspace ----
// opts: { ideaId, idea (display text), resume (checkpoint payload), onProgress(patch) }
export async function runCrew(wsId, idea, onEvent, apiKey, opts = {}) {
  const ws = getWorkspace(wsId);
  if (!ws) throw new Error("Workspace not found: " + wsId);
  const { manager, reviewer, workers } = resolveCrew(ws);
  if (!manager) throw new Error("没有可用的指挥官（在员工库/编队里配置）。");
  if (!workers.length) throw new Error("没有可用的执行者（在编队里勾选）。");
  touchWorkspace(wsId);

  const resume = opts.resume || null;
  const runId = (resume && resume.runId) || newRunId();
  const recorder = makeRunRecorder(wsId, runId, {
    ideaId: opts.ideaId || null, idea: opts.idea || idea, brief: idea,
    plan: resume?.tasks || [], results: resume?.results || [],
    review: resume?.review || null, verdict: resume?.verdict || "",
    startedAt: resume?.startedAt,
  });
  const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  progress({ runId, phase: recorder.get().phase });

  const ctrl = { current: null, cancelled: false, runId };
  controllers.set(wsId, ctrl);

  // Forward every crew event to the checkpoint recorder and the live UI, and
  // surface a coarse progress patch onto the idea card.
  const onEventWrapped = (ev) => {
    recorder.onEvent(ev);
    const rec = recorder.get();
    const total = (rec.plan || []).length, done = (rec.results || []).length;
    if (ev.type === "plan-done") progress({ phase: "tasks", progress: { total, done } });
    else if (ev.type === "task-start") progress({ phase: "tasks", progress: { total, done, current: ev.agent || "" } });
    else if (ev.type === "task-done") progress({ phase: "tasks", progress: { total, done } });
    else if (ev.type === "review-start") progress({ phase: "review" });
    if (onEvent) onEvent(ev);
  };

  try {
    const run = await kickoff(idea, {
      manager, workers, reviewer,
      cwd: ws.cwdAbs, mode: effectiveMode(ws), apiKey, onEvent: onEventWrapped,
      store: await sdkStore(),
      memStore: makeMemStore(wsId),
      onRun: (r) => { ctrl.current = r; },
      isCancelled: () => ctrl.cancelled,
      resume,
      skillProvider: ({ agent, task, idea: ideaText, context }) => buildSkillContextForTurn({
        agent, task, idea: ideaText || opts.idea || idea, context,
      }),
    });
    run.workspaceId = wsId;
    run.cancelled = ctrl.cancelled;
    run.cancelReason = ctrl.cancelReason || "user";
    run.runId = runId;
    run.events = recorder.get().events || [];
    run.errors = recorder.get().errors || [];
    const failed = (run.results || []).some((r) => !r.ok) || /Reviewer failed|run status:\s*error/i.test(run.review || "");
    const finalStatus = ctrl.cancelled ? (ctrl.cancelReason === "quit" ? "interrupted" : "cancelled") : (failed ? "failed" : "succeeded");
    run.status = finalStatus;
    const stamp = writeMission(wsId, run);
    const vd = (run.review || "").match(/VERDICT:?\s*(SHIP|FIX|KILL)/i)?.[1]?.toUpperCase() || "";
    recorder.finish(finalStatus, { stamp, verdict: vd, review: run.review || null, reason: ctrl.cancelReason === "quit" ? "app_quit" : "" });
    return { run, stamp, runId };
  } catch (err) {
    const rec = recorder.get();
    const errors = [...(rec.errors || []), { stage: rec.phase || "run", error: err.message }];
    const failedRun = {
      idea: opts.idea || idea,
      manager: manager ? { id: manager.id, name: manager.name } : null,
      reviewer: reviewer ? { id: reviewer.id, name: reviewer.name } : null,
      tasks: rec.plan || [],
      results: rec.results || [],
      review: rec.review || "",
      startedAt: rec.startedAt || Date.now(),
      finishedAt: Date.now(),
      runId,
      workspaceId: wsId,
      status: "failed",
      errors,
      events: rec.events || [],
      cancelled: ctrl.cancelled,
      cancelReason: ctrl.cancelReason || "",
    };
    const stamp = writeMission(wsId, failedRun);
    recorder.finish("failed", { stamp, error: err.message, errors });
    err.run = failedRun;
    err.stamp = stamp;
    err.runId = runId;
    throw err;
  } finally {
    controllers.delete(wsId);
  }
}

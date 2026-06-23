// Electron main process. Workspace-centric command center.
// Bridges the renderer UI to the Node crew engine (which uses @cursor/sdk).

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { createWatchdog } = require("./selfheal.cjs");

const DEV_ROOT = path.resolve(__dirname, "..");
const USER_DATA_DIR = "ai-team";
const SMOKE_TEST = process.argv.includes("--smoke-test");
let store = null;
let router = null;
let win = null;
let watchdog = null;
let bootHealthy = false;
const watchers = new Map();   // wsId -> fs.FSWatcher

if (process.env.AI_TEAM_DISABLE_GPU === "1") app.disableHardwareAcceleration();

// Packaged builds use productName "AI Team" → ~/Library/Application Support/ai-team.
// Pin the path so migrations/docs stay consistent across rebuilds.
if (app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), USER_DATA_DIR));
}

function dataRoot() {
  return app.isPackaged ? path.join(app.getPath("userData"), "data") : DEV_ROOT;
}

/** One-time merge from the wrong migration target (ai-team-desktop). */
function migrateLegacyUserData() {
  if (!app.isPackaged) return;
  const userData = app.getPath("userData");
  const legacyRoots = [
    path.join(app.getPath("appData"), "ai-team-desktop"),
    path.join(app.getPath("appData"), "AI Team"),
  ];
  const dataDir = path.join(userData, "data");
  ensureDir(dataDir);

  for (const legacy of legacyRoots) {
    if (legacy === userData || !fs.existsSync(legacy)) continue;
    const legacyEnv = path.join(legacy, ".env");
    const targetEnv = path.join(userData, ".env");
    if (fs.existsSync(legacyEnv) && !fs.existsSync(targetEnv)) {
      fs.copyFileSync(legacyEnv, targetEnv);
    }
    const legacyData = path.join(legacy, "data");
    if (!fs.existsSync(legacyData)) continue;
    copyTreeMissing(legacyData, dataDir);
  }
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function copyTreeIfNewer(src, dest) {
  for (const name of fs.readdirSync(src)) {
    if (name === ".DS_Store") continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      copyTreeIfNewer(from, to);
      continue;
    }
    const destSt = fs.existsSync(to) ? fs.statSync(to) : null;
    if (!destSt || st.mtimeMs > destSt.mtimeMs || st.size > destSt.size) {
      fs.copyFileSync(from, to);
    }
  }
}

function copyTreeMissing(src, dest) {
  for (const name of fs.readdirSync(src)) {
    if (name === ".DS_Store") continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      copyTreeMissing(from, to);
      continue;
    }
    if (!fs.existsSync(to)) fs.copyFileSync(from, to);
  }
}

function loadEnv() {
  const envPath = app.isPackaged
    ? path.join(app.getPath("userData"), ".env")
    : path.join(DEV_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function loadStore() {
  if (!store) store = await import(pathToFileURL(path.join(__dirname, "store.mjs")).href);
  return store;
}
async function loadRouter() {
  const engineRoot = app.isPackaged ? path.join(__dirname, "..") : DEV_ROOT;
  if (!router) router = await import(pathToFileURL(path.join(engineRoot, "src", "router.mjs")).href);
  return router;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1040, minHeight: 640,
    title: "AI Team", backgroundColor: "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Renderer painted + main-process startup survived ⇒ this boot is healthy.
  // Tell the watchdog so it records this commit as last-known-good.
  win.webContents.once("did-finish-load", markBootHealthy);

  // Agent output is rendered as markdown with target="_blank" links. Never let
  // such (untrusted) links open a chromeless in-app window or navigate the app
  // shell away — route http(s) to the user's real browser and deny the rest.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url).catch(() => {}); }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url === win.webContents.getURL()) return;  // allow in-place reloads only
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });
}

function markBootHealthy() {
  if (bootHealthy) return;
  bootHealthy = true;
  try { watchdog && watchdog.markHealthy(); } catch {}
}

// Watch a workspace dir and notify the renderer when files change (debounced).
async function watchWorkspace(wsId) {
  if (watchers.has(wsId)) return;
  const s = await loadStore();
  const ws = s.getWorkspace(wsId);
  if (!ws || !fs.existsSync(ws.cwdAbs)) return;
  let timer = null;
  try {
    const w = fs.watch(ws.cwdAbs, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => send("fs:changed", { wsId }), 250);
    });
    watchers.set(wsId, w);
  } catch { /* recursive watch unsupported on some FS; ignore */ }
}

function registerIpc() {
  ipcMain.handle("env:status", () => ({ hasKey: !!process.env.CURSOR_API_KEY }));
  ipcMain.handle("meta:get", async () => (await loadStore()).meta());
  ipcMain.handle("settings:get", async () => (await loadStore()).getSettings());
  ipcMain.handle("settings:set", async (_e, patch) => (await loadStore()).saveSettings(patch));

  // Agents Repository
  ipcMain.handle("agents:list", async () => (await loadStore()).listAgents());
  ipcMain.handle("agents:get", async (_e, id) => (await loadStore()).getAgent(id));
  ipcMain.handle("agents:create", async (_e, p) => (await loadStore()).createAgent(p));
  ipcMain.handle("agents:save", async (_e, a) => (await loadStore()).saveAgent(a));
  ipcMain.handle("agents:delete", async (_e, id) => (await loadStore()).deleteAgent(id));

  // Crew
  ipcMain.handle("crew:get", async () => (await loadStore()).getCrew());
  ipcMain.handle("crew:save", async (_e, c) => (await loadStore()).saveCrew(c));

  // Native folder picker (for "open a folder as workspace")
  ipcMain.handle("dialog:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"], title: "选择工作目录",
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // Workspaces
  ipcMain.handle("ws:list", async () => (await loadStore()).listWorkspaces());
  ipcMain.handle("ws:get", async (_e, id) => (await loadStore()).getWorkspace(id));
  ipcMain.handle("ws:create", async (_e, p) => (await loadStore()).createWorkspace(p));
  ipcMain.handle("ws:save", async (_e, p) => (await loadStore()).saveWorkspace(p));
  ipcMain.handle("ws:delete", async (_e, id) => (await loadStore()).deleteWorkspace(id));

  // File tree + read (path-safe inside the workspace cwd)
  ipcMain.handle("fs:tree", async (_e, wsId, sub) => (await loadStore()).fsTree(wsId, sub || ""));
  ipcMain.handle("fs:read", async (_e, wsId, rel) => (await loadStore()).fsRead(wsId, rel));
  ipcMain.handle("fs:watch", async (_e, wsId) => { await watchWorkspace(wsId); return true; });
  ipcMain.handle("fs:revealPath", async (_e, wsId, rel) => {
    const s = await loadStore();
    const ws = s.getWorkspace(wsId);
    if (ws) shell.showItemInFolder(path.join(ws.cwdAbs, rel || ""));
    return true;
  });

  // Missions (run history)
  ipcMain.handle("missions:list", async (_e, wsId) => (await loadStore()).listMissions(wsId));
  ipcMain.handle("missions:listAll", async () => (await loadStore()).listAllMissions());
  ipcMain.handle("missions:get", async (_e, wsId, stamp) => (await loadStore()).getMission(wsId, stamp));
  ipcMain.handle("missions:reveal", async (_e, wsId, stamp) => {
    const s = await loadStore();
    shell.openPath(s.missionDir(wsId, stamp));
    return true;
  });
  ipcMain.handle("usage:get", async () => (await loadStore()).usage());

  // Chat history
  ipcMain.handle("chat:history", async (_e, wsId) => (await loadStore()).getChat(wsId));
  ipcMain.handle("chat:save", async (_e, wsId, history) => (await loadStore()).saveChat(wsId, history));

  // Route a free-form message to a workspace (or propose a new one)
  ipcMain.handle("route:classify", async (_e, message) => {
    const s = await loadStore();
    const r = await loadRouter();
    const workspaces = s.listWorkspaces();
    try { return await r.classifyWorkspace(message, workspaces, process.env.CURSOR_API_KEY); }
    catch (err) { return { error: err.message }; }
  });

  // The CEO conversation (streams via ceo:event; team runs via crew:event)
  ipcMain.handle("ceo:history", async () => (await loadStore()).getCeoChat());
  ipcMain.handle("ceo:saveHistory", async (_e, history) => (await loadStore()).saveCeoChat(history));
  ipcMain.handle("ceo:send", async (_e, history, message, intent) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY（在 ai-team/.env 设置）" };
    const s = await loadStore();
    const onStream = (evt) => send("ceo:event", evt);
    const onCrewEvent = (evt) => send("crew:event", evt);
    try {
      return await s.chatWithCeo(history, message, process.env.CURSOR_API_KEY, onStream, onCrewEvent, intent || "auto");
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle("ceo:cancel", async () => { const s = await loadStore(); return typeof s.cancelCeoChat === "function" ? s.cancelCeoChat() : false; });

  // CEO sessions (multiple conversations)
  ipcMain.handle("ceo:sessions", async () => (await loadStore()).listCeoSessions());
  ipcMain.handle("ceo:sessionCreate", async () => (await loadStore()).createCeoSession());
  ipcMain.handle("ceo:sessionSet", async (_e, id) => (await loadStore()).setActiveSession(id));
  ipcMain.handle("ceo:sessionDelete", async (_e, id) => (await loadStore()).deleteCeoSession(id));

  // Idea backlog
  ipcMain.handle("ideas:list", async () => (await loadStore()).getIdeas());
  ipcMain.handle("ideas:add", async (_e, text) => (await loadStore()).addIdea(text));
  ipcMain.handle("ideas:remove", async (_e, id) => (await loadStore()).removeIdea(id));
  ipcMain.handle("ideas:confirm", async (_e, id) => (await loadStore()).confirmIdea(id));
  ipcMain.handle("ideas:update", async (_e, id, patch) => (await loadStore()).updateIdea(id, patch));
  ipcMain.handle("ideas:setStatus", async (_e, id, status) => (await loadStore()).ideaSetStatus(id, status));
  ipcMain.handle("ideas:execute", async (_e, id) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY" };
    const s = await loadStore();
    const onStream = (evt) => send("ceo:event", evt);
    const onCrewEvent = (evt) => send("crew:event", evt);
    try { return await s.executeIdea(id, process.env.CURSOR_API_KEY, onCrewEvent, onStream); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  // Interrupted-run recovery (Phase A)
  ipcMain.handle("ideas:resume", async (_e, id) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY" };
    const s = await loadStore();
    const onStream = (evt) => send("ceo:event", evt);
    const onCrewEvent = (evt) => send("crew:event", evt);
    try { return await s.resumeIdea(id, process.env.CURSOR_API_KEY, onCrewEvent, onStream); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("ideas:rerun", async (_e, id) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY" };
    const s = await loadStore();
    const onStream = (evt) => send("ceo:event", evt);
    const onCrewEvent = (evt) => send("crew:event", evt);
    try { return await s.rerunIdea(id, process.env.CURSOR_API_KEY, onCrewEvent, onStream); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("ideas:discard", async (_e, id) => (await loadStore()).discardRun(id));
  ipcMain.handle("ideas:report", async (_e, id) => (await loadStore()).ideaReport(id));
  ipcMain.handle("ideas:artifacts", async (_e, id) => (await loadStore()).ideaArtifacts(id));
  ipcMain.handle("ideas:gitStatus", async (_e, id) => (await loadStore()).ideaGitStatus(id));

  // Skills (synced from Cursor)
  ipcMain.handle("skills:list", async () => (await loadStore()).listSkills());
  ipcMain.handle("skills:get", async (_e, id) => (await loadStore()).getSkill(id));
  ipcMain.handle("skills:sync", async () => (await loadStore()).syncCursorSkills());

  // Self-edit (Slice 2): the crew edits the app's own source on an isolated
  // worktree; the gate validates it; the human applies the diff. Live events
  // on crew:event so it reuses the existing run timeline UI.
  ipcMain.handle("selfedit:list", async () => (await loadStore()).listSelfEdits());
  ipcMain.handle("selfedit:get", async (_e, id) => (await loadStore()).getSelfEdit(id));
  ipcMain.handle("selfedit:dirty", async () => (await loadStore()).selfEditGitDirty());
  ipcMain.handle("selfedit:start", async (_e, goal) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY（在 ai-team/.env 设置）" };
    const s = await loadStore();
    try { return { ok: true, candidate: await s.startSelfEdit(goal, process.env.CURSOR_API_KEY, (evt) => send("crew:event", evt)) }; }
    catch (err) { send("crew:event", { type: "error", error: err.message }); return { ok: false, error: err.message }; }
  });
  ipcMain.handle("selfedit:cancel", async () => (await loadStore()).cancelSelfEdit());
  ipcMain.handle("selfedit:apply", async (_e, id) => {
    const s = await loadStore();
    try { return s.applySelfEdit(id); } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("selfedit:discard", async (_e, id) => (await loadStore()).discardSelfEdit(id));

  // Objective loop (the reusable closed-loop engine). Live events on crew:event.
  ipcMain.handle("obj:list", async () => (await loadStore()).listObjectives());
  ipcMain.handle("obj:get", async (_e, id) => {
    const s = await loadStore();
    return { objective: s.getObjective(id), journal: s.getObjectiveJournal(id) };
  });
  ipcMain.handle("obj:create", async (_e, p) => (await loadStore()).createObjective(p));
  ipcMain.handle("obj:update", async (_e, id, patch) => (await loadStore()).updateObjective(id, patch));
  ipcMain.handle("obj:delete", async (_e, id) => (await loadStore()).deleteObjective(id));
  ipcMain.handle("obj:step", async (_e, id) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY（在 ai-team/.env 设置）" };
    const s = await loadStore();
    try { return { ok: true, result: await s.runObjectiveStep(id, process.env.CURSOR_API_KEY, (evt) => send("crew:event", evt)) }; }
    catch (err) { send("crew:event", { type: "error", error: err.message }); return { ok: false, error: err.message }; }
  });
  ipcMain.handle("obj:loop", async (_e, id, maxSteps) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY（在 ai-team/.env 设置）" };
    const s = await loadStore();
    try { return { ok: true, result: await s.runObjectiveLoop(id, process.env.CURSOR_API_KEY, (evt) => send("crew:event", evt), maxSteps || 5) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("obj:score", async (_e, id, score) => {
    const s = await loadStore();
    try { return { ok: true, entry: s.scoreObjectiveStep(id, score) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle("obj:cancel", async () => (await loadStore()).cancelObjective());

  // Legacy 1:1 chat (Agents page)
  ipcMain.handle("chat:send", async (_e, agentId, history, message) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "Missing CURSOR_API_KEY" };
    const s = await loadStore();
    try { return await s.chatWithAgent(agentId, history, message, process.env.CURSOR_API_KEY); }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Run the crew inside a workspace (live events on crew:event)
  ipcMain.handle("crew:run", async (_e, wsId, idea) => {
    if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY（在 ai-team/.env 设置）" };
    const s = await loadStore();
    try {
      const { stamp } = await s.runCrew(wsId, idea, (event) => send("crew:event", { wsId, ...event }), process.env.CURSOR_API_KEY);
      return { ok: true, stamp };
    } catch (err) {
      send("crew:event", { wsId, type: "error", error: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("crew:cancel", async (_e, wsId) => {
    const s = await loadStore();
    if (typeof s.cancelRun === "function") return s.cancelRun(wsId);
    return false;
  });

  // Scheduler (7×24 自动跑)
  ipcMain.handle("schedule:get", async () => (await loadStore()).getSchedule());
  ipcMain.handle("schedule:set", async (_e, patch) => {
    const s = await loadStore();
    let next = s.saveSchedule(patch || {});
    // Recompute the next fire time whenever it's enabled (and reset it when off).
    next = next.enabled
      ? s.saveSchedule({ nextRunAt: s.computeNextRun(next, Date.now()) })
      : s.saveSchedule({ nextRunAt: 0 });
    send("sched:event", { type: "updated", schedule: next });
    return next;
  });
  ipcMain.handle("schedule:runNow", async () => fireSchedule(true));
}

// ---- Scheduler loop (only fires while the app is open) ----
let schedulerTimer = null;
let schedulerBusy = false;

async function fireSchedule(manual = false) {
  if (schedulerBusy) return { ok: false, error: "已经在跑了，稍等" };
  if (!process.env.CURSOR_API_KEY) return { ok: false, error: "缺少 CURSOR_API_KEY（在 ai-team/.env 设置）" };
  const s = await loadStore();
  schedulerBusy = true;
  send("sched:event", { type: "fired", manual, at: Date.now() });
  const onStream = (evt) => send("ceo:event", evt);
  const onCrewEvent = (evt) => send("crew:event", evt);
  try {
    const r = await s.runScheduleOnce(process.env.CURSOR_API_KEY, onCrewEvent, onStream, manual);
    send("sched:event", { type: "done", manual, result: r, schedule: s.getSchedule() });
    return r;
  } catch (err) {
    try {
      const log = [...(s.getSchedule().log || []), { at: Date.now(), type: "error", msg: err.message }];
      s.saveSchedule({ log, lastRunAt: Date.now(), nextRunAt: s.computeNextRun(s.getSchedule(), Date.now()) });
    } catch {}
    send("sched:event", { type: "error", manual, error: err.message, schedule: s.getSchedule() });
    return { ok: false, error: err.message };
  } finally {
    schedulerBusy = false;
  }
}

async function schedulerTick() {
  const s = await loadStore();
  const sched = s.getSchedule();
  if (!sched.enabled || schedulerBusy) return;
  const now = Date.now();
  if (!sched.nextRunAt) {
    const next = s.saveSchedule({ nextRunAt: s.computeNextRun(sched, now) });
    send("sched:event", { type: "updated", schedule: next });
    return;
  }
  if (now >= sched.nextRunAt) await fireSchedule(false);
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => { schedulerTick().catch(() => {}); }, 30_000);
}

function cleanupRuntimeResources() {
  for (const w of watchers.values()) { try { w.close(); } catch {} }
  watchers.clear();
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

app.whenReady().then(async () => {
  // Smoke test: prove the build is loadable, then exit. Used by the self-edit
  // safety gate (Slice 2) and to test boots. It must NOT touch the watchdog
  // state — a gate runs this inside a throwaway worktree on a CANDIDATE commit,
  // and we never want that recorded as "last known good".
  if (SMOKE_TEST) {
    try {
      const s = await loadStore();
      if (app.isPackaged) s.setRoot(dataRoot());
      console.log("[smoke-test] ok");
      app.exit(0);
    } catch (e) {
      console.error("[smoke-test] failed:", e && e.message);
      app.exit(1);
    }
    return;
  }

  // Defensive: a self-edit that crashed mid-run may have left the live source
  // tree read-only (OS-level hard isolation). Restore writability before the
  // watchdog runs — a `git reset --hard` rollback can't overwrite locked files.
  if (!app.isPackaged) {
    try { require("./selfedit.cjs").unlockSource(DEV_ROOT); } catch {}
  }

  // --- Self-heal watchdog: FIRST thing, before any self-editable code loads. ---
  // In dev (running from source) a bad self-edit can crash boot; the watchdog
  // rolls the source back to the last healthy commit and relaunches. Rollback is
  // disabled for the packaged .app (can't git-reset an asar).
  watchdog = createWatchdog({
    repo: DEV_ROOT,
    statePath: path.join(app.getPath("userData"), "selfheal.json"),
    enabled: !app.isPackaged,
    log: (m) => console.log("[selfheal]", m),
  });
  const boot = watchdog.beginBoot();
  if (boot.rollback) {
    console.log("[selfheal] rolled back to last-good; relaunching");
    app.relaunch();
    app.exit(0);
    return;
  }

  migrateLegacyUserData();
  loadEnv();
  registerIpc();
  const s = await loadStore();
  if (app.isPackaged) s.setRoot(dataRoot());
  // Any run still marked "running" from a previous session was interrupted by a
  // crash — flag it so the board can offer continue/rerun instead of losing work.
  try { s.markInterruptedRuns("app_crash"); } catch {}
  try { s.backfillMissionArtifacts(); } catch {}
  // Keep the app's skill mirror fresh; every agent can use the shared library.
  try { s.syncCursorSkills(); } catch {}
  createWindow();
  startScheduler();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Graceful shutdown (Phase B): if a run is in flight when the user quits, stop it,
// flag the card as interrupted (so its checkpoint survives), then exit. The first
// before-quit is deferred just long enough to persist state.
let _quitting = false;
app.on("before-quit", (e) => {
  if (_quitting || !store) return;
  if (!store.hasActiveRuns || !store.hasActiveRuns()) return;
  e.preventDefault();
  _quitting = true;
  cleanupRuntimeResources();
  try { store.cancelAllRuns?.("quit"); } catch {}
  try { store.markInterruptedRuns?.("app_quit"); } catch {}
  // The checkpoint is already persisted synchronously above. Use app.exit() for
  // the deferred second step so Electron does not re-enter the quit lifecycle
  // while Cursor SDK/native handles are still winding down.
  setTimeout(() => app.exit(0), 800);
});

app.on("window-all-closed", () => {
  cleanupRuntimeResources();
  if (process.platform !== "darwin") app.quit();
});

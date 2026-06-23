const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  envStatus: () => ipcRenderer.invoke("env:status"),
  getMeta: () => ipcRenderer.invoke("meta:get"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),

  // Agents
  listAgents: () => ipcRenderer.invoke("agents:list"),
  getAgent: (id) => ipcRenderer.invoke("agents:get", id),
  createAgent: (p) => ipcRenderer.invoke("agents:create", p),
  saveAgent: (a) => ipcRenderer.invoke("agents:save", a),
  deleteAgent: (id) => ipcRenderer.invoke("agents:delete", id),

  // Crew
  getCrew: () => ipcRenderer.invoke("crew:get"),
  saveCrew: (c) => ipcRenderer.invoke("crew:save", c),

  // Workspaces
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  listWorkspaces: () => ipcRenderer.invoke("ws:list"),
  getWorkspace: (id) => ipcRenderer.invoke("ws:get", id),
  createWorkspace: (p) => ipcRenderer.invoke("ws:create", p),
  saveWorkspace: (p) => ipcRenderer.invoke("ws:save", p),
  deleteWorkspace: (id) => ipcRenderer.invoke("ws:delete", id),

  // File tree
  fsTree: (wsId, sub) => ipcRenderer.invoke("fs:tree", wsId, sub),
  fsRead: (wsId, rel) => ipcRenderer.invoke("fs:read", wsId, rel),
  fsWatch: (wsId) => ipcRenderer.invoke("fs:watch", wsId),
  revealPath: (wsId, rel) => ipcRenderer.invoke("fs:revealPath", wsId, rel),
  onFsChanged: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("fs:changed", h);
    return () => ipcRenderer.removeListener("fs:changed", h);
  },

  // Missions
  listMissions: (wsId) => ipcRenderer.invoke("missions:list", wsId),
  listAllMissions: () => ipcRenderer.invoke("missions:listAll"),
  getMission: (wsId, stamp) => ipcRenderer.invoke("missions:get", wsId, stamp),
  revealMission: (wsId, stamp) => ipcRenderer.invoke("missions:reveal", wsId, stamp),
  getUsage: () => ipcRenderer.invoke("usage:get"),

  // The CEO conversation (+ sessions)
  ceoHistory: () => ipcRenderer.invoke("ceo:history"),
  ceoSaveHistory: (history) => ipcRenderer.invoke("ceo:saveHistory", history),
  ceoSend: (history, message, intent) => ipcRenderer.invoke("ceo:send", history, message, intent),
  ceoCancel: () => ipcRenderer.invoke("ceo:cancel"),
  ceoSessions: () => ipcRenderer.invoke("ceo:sessions"),
  ceoSessionCreate: () => ipcRenderer.invoke("ceo:sessionCreate"),
  ceoSessionSet: (id) => ipcRenderer.invoke("ceo:sessionSet", id),
  ceoSessionDelete: (id) => ipcRenderer.invoke("ceo:sessionDelete", id),
  onCeoEvent: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("ceo:event", h);
    return () => ipcRenderer.removeListener("ceo:event", h);
  },

  // Per-card CEO chat (scoped to one board card; can edit the card)
  cardChat: (ideaId, history, message) => ipcRenderer.invoke("card:chat", ideaId, history, message),
  cardCancel: () => ipcRenderer.invoke("card:cancel"),
  onCardEvent: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("card:event", h);
    return () => ipcRenderer.removeListener("card:event", h);
  },

  // Ideas backlog
  ideasList: () => ipcRenderer.invoke("ideas:list"),
  ideaAdd: (text) => ipcRenderer.invoke("ideas:add", text),
  ideaRemove: (id) => ipcRenderer.invoke("ideas:remove", id),
  ideaConfirm: (id) => ipcRenderer.invoke("ideas:confirm", id),
  ideaUpdate: (id, patch) => ipcRenderer.invoke("ideas:update", id, patch),
  ideaSetStatus: (id, status) => ipcRenderer.invoke("ideas:setStatus", id, status),
  ideaExecute: (id) => ipcRenderer.invoke("ideas:execute", id),
  ideaResume: (id) => ipcRenderer.invoke("ideas:resume", id),
  ideaRerun: (id) => ipcRenderer.invoke("ideas:rerun", id),
  ideaDiscard: (id) => ipcRenderer.invoke("ideas:discard", id),
  ideaReport: (id) => ipcRenderer.invoke("ideas:report", id),
  ideaArtifacts: (id) => ipcRenderer.invoke("ideas:artifacts", id),
  ideaGitStatus: (id) => ipcRenderer.invoke("ideas:gitStatus", id),

  // Skills (synced from Cursor)
  skillsList: () => ipcRenderer.invoke("skills:list"),
  skillsGet: (id) => ipcRenderer.invoke("skills:get", id),
  skillsSync: () => ipcRenderer.invoke("skills:sync"),

  // Self-edit (the app modifies its own source, gated + diff-reviewed)
  selfEditList: () => ipcRenderer.invoke("selfedit:list"),
  selfEditGet: (id) => ipcRenderer.invoke("selfedit:get", id),
  selfEditDirty: () => ipcRenderer.invoke("selfedit:dirty"),
  selfEditStart: (goal) => ipcRenderer.invoke("selfedit:start", goal),
  selfEditCancel: () => ipcRenderer.invoke("selfedit:cancel"),
  selfEditApply: (id) => ipcRenderer.invoke("selfedit:apply", id),
  selfEditDiscard: (id) => ipcRenderer.invoke("selfedit:discard", id),

  // Objective loop (reusable closed-loop engine)
  objList: () => ipcRenderer.invoke("obj:list"),
  objGet: (id) => ipcRenderer.invoke("obj:get", id),
  objCreate: (p) => ipcRenderer.invoke("obj:create", p),
  objUpdate: (id, patch) => ipcRenderer.invoke("obj:update", id, patch),
  objDelete: (id) => ipcRenderer.invoke("obj:delete", id),
  objStep: (id) => ipcRenderer.invoke("obj:step", id),
  objLoop: (id, maxSteps) => ipcRenderer.invoke("obj:loop", id, maxSteps),
  objScore: (id, score) => ipcRenderer.invoke("obj:score", id, score),
  objCancel: () => ipcRenderer.invoke("obj:cancel"),

  // Per-workspace chat history (project view reference; legacy)
  chatHistory: (wsId) => ipcRenderer.invoke("chat:history", wsId),
  chatSaveHistory: (wsId, history) => ipcRenderer.invoke("chat:save", wsId, history),

  // Legacy 1:1 chat (Agents page)
  chatSend: (agentId, history, message) => ipcRenderer.invoke("chat:send", agentId, history, message),

  // Crew run
  runCrew: (wsId, idea) => ipcRenderer.invoke("crew:run", wsId, idea),
  cancelCrew: (wsId) => ipcRenderer.invoke("crew:cancel", wsId),
  onCrewEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("crew:event", h);
    return () => ipcRenderer.removeListener("crew:event", h);
  },

  // Scheduler (7×24 自动跑)
  getSchedule: () => ipcRenderer.invoke("schedule:get"),
  setSchedule: (patch) => ipcRenderer.invoke("schedule:set", patch),
  runScheduleNow: () => ipcRenderer.invoke("schedule:runNow"),
  onSchedEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("sched:event", h);
    return () => ipcRenderer.removeListener("sched:event", h);
  },
});

// Lightweight workspace router. Given a free-form user message and the list of
// existing workspaces, decide which workspace it belongs to — or that it's a
// brand-new project. Fast heuristics first; a cheap model only for the fuzzy rest.

import { Agent } from "@cursor/sdk";

const ROUTER_MODEL = "claude-haiku-4-5";

// Quick keyword hints so common cases skip the model call entirely.
const HINTS = [
  { id: "pamu", re: /\b(pamu|pom[-_ ]?(search|backend|memory|deploy|ask)?|luming|echo|miyoushe|hammal)\b/i },
  { id: "hyg", re: /\b(hyg|gate|llm[_-]?route|main[_-]?service|memory[_-]?service|model[_-]?route|oryzo|npcagent)\b/i },
];

function heuristic(message, workspaces) {
  const ids = new Set(workspaces.map((w) => w.id));
  for (const h of HINTS) {
    if (ids.has(h.id) && h.re.test(message)) return { match: h.id, via: "heuristic" };
  }
  // Direct name mention
  for (const w of workspaces) {
    if (w.name && message.toLowerCase().includes(String(w.name).toLowerCase())) {
      return { match: w.id, via: "name" };
    }
  }
  return null;
}

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * @returns {Promise<{match?:string, new?:{name,kind,summary}, via:string}>}
 */
export async function classifyWorkspace(message, workspaces, apiKey) {
  const fast = heuristic(message, workspaces);
  if (fast) return fast;

  const roster = workspaces
    .map((w) => `- id "${w.id}": ${w.name} (${w.kind}, ${w.cwdDisplay || w.cwd}) — ${w.summary || ""}`)
    .join("\n");

  const prompt = `You route a user's request to a workspace. Existing workspaces:
${roster || "(none)"}

User request:
"""
${message}
"""

Decide ONE:
- If it clearly belongs to an existing workspace, return its id.
- If it's a NEW project/topic not covered above, propose a new workspace.

Return ONLY JSON, no prose:
{ "match": "<existing id>" }   // when it fits an existing workspace
OR
{ "new": { "name": "<short name, in the user's language>", "kind": "scratch", "summary": "<one line>" } }

Prefer matching an existing workspace when plausible. Only create new for genuinely new work.`;

  try {
    const res = await Agent.prompt(prompt, { apiKey, model: { id: ROUTER_MODEL } });
    const out = extractJson(res.result ?? "");
    if (out && out.match && workspaces.some((w) => w.id === out.match)) return { match: out.match, via: "model" };
    if (out && out.new && out.new.name) {
      return { new: { name: out.new.name, kind: out.new.kind === "repo" ? "repo" : "scratch", summary: out.new.summary || "" }, via: "model" };
    }
  } catch (e) {
    // fall through to default
  }
  // Default: route to the most recently active workspace, else first.
  const sorted = [...workspaces].sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  if (sorted[0]) return { match: sorted[0].id, via: "fallback" };
  return { new: { name: message.slice(0, 18) || "新项目", kind: "scratch", summary: "" }, via: "fallback" };
}

// An explicit command to execute now → dispatch the team immediately.
const EXECUTE_RE = /(做吧|去做|开始(做|干)|动手|安排上?|搞起来|上吧|干吧|开干|落地它|实现它|去干|现在(就)?做|让(他们|团队|大家)|交给团队|派给团队|派活)/i;
// Clear "I want a question answered / advice" → chat. (Bias toward chat.)
const ADVICE_RE = /[?？]|吗\s*$|呢\s*$|你觉得|觉得|建议|看法|怎么看|怎么样|值不值|要不要|该不该|好不好|可行|靠谱|有没有必要|意见|分析一下|聊聊|讨论|为什么|怎么(办|做|回事|实现)|是什么|什么意思|解释|区别|对比|如何/;

/**
 * Decide how the CEO should handle the message: chat, draft a task, or dispatch.
 * Conservative — defaults to "direct" (chat) unless there's a clear build/do intent.
 * @returns {Promise<{action:"direct"|"capture"|"delegate", brief?:string, reason?:string}>}
 */
export async function decideCeoAction(message, recent, apiKey) {
  const msg = (message || "").trim();
  if (!msg) return { action: "direct", reason: "空" };
  // Fast, unambiguous signals.
  if (EXECUTE_RE.test(msg)) return { action: "delegate", brief: msg, reason: "明确执行指令" };
  if (msg.length < 6) return { action: "direct", reason: "短消息" };

  const ctx = (recent || []).slice(-4).map((m) => `${m.role === "user" ? "用户" : "CEO"}: ${(m.text || "").slice(0, 200)}`).join("\n");
  const prompt = `判断用户最新这条消息**想要什么**，三选一。这是一个聊天 + 能派团队干活的助手。

最近对话：
${ctx || "(无)"}

用户最新消息：
"""
${msg}
"""

三选一：
- "direct"：提问 / 问建议 / 让你分析、解释、对比 / 闲聊 / 讨论方向。**这是默认**——只要不是明确要一个成品，就选它。
- "capture"：用户明确想要你或团队**做出一个具体的东西**（写代码、做工具、做出方案/文档、落地某功能），但没说"现在就做"。
- "delegate"：用户明确要求**现在就动手 / 让团队执行**。

判断要点：
- 带问号、含"你觉得/建议/怎么看/为什么/能不能/区别/如何"等，几乎都是 direct。
- 只有当用户清楚表达"我要一个成品 / 帮我做出 X / 给我写个 Y"时才是 capture/delegate。
- 拿不准一律选 direct。

只输出 JSON：{"action":"direct|capture|delegate","brief":"<capture/delegate 时给一句话任务简报>","reason":"<一句话>"}`;

  try {
    const res = await Agent.prompt(prompt, { apiKey, model: { id: ROUTER_MODEL } });
    const out = extractJson(res.result ?? "");
    if (out && ["direct", "capture", "delegate"].includes(out.action)) {
      return { action: out.action, brief: out.brief || msg, reason: out.reason || "" };
    }
  } catch { /* fall through to heuristic */ }

  // Heuristic fallback when the model is unavailable.
  if (ADVICE_RE.test(msg)) return { action: "direct", reason: "提问/建议" };
  if (/(帮我|给我)?(做|搭|写|实现|开发|生成|构建|整|来)\s*(一)?个/.test(msg)) return { action: "capture", brief: msg, reason: "明确成品需求" };
  return { action: "direct", reason: "默认" };
}

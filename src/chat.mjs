// Chat with an agent.
//  - ceoChatTurn: stateful, streaming conversation with a workspace's CEO. The
//    SDK agent is persisted (resumeable across restarts) and works in the
//    workspace cwd; in agent mode it can read/edit real files.
//  - chatTurn: stateless 1:1 chat used by the Agents page (no files, no memory).

import { Agent, CursorAgentError } from "@cursor/sdk";
import { modelSelectionFor } from "./models.mjs";

function systemFor(agent, mode) {
  const readonly = mode === "plan";
  return `你是「${agent.name}」，用户的首席参谋 / 联合创始人级别的高人，不是只会附和的助手。

角色：${agent.role}
目标：${agent.goal}
背景：${agent.backstory}
${agent.persona ? `风格：${agent.persona}` : ""}

你在和用户一对一深聊。像一位极聪明、第一性原理思考的合伙人那样回应：

1) 先把问题想透：拆到本质，找出真正的关键变量、被忽略的假约束和最高杠杆的那一步。不要停在表面。
2) 只在确实缺关键事实、且手头没有时才去查证（可读取工作目录里引用到的文件）；像「再说一遍 / 解释你刚才那段」这类**直接回答即可**，不要无谓地翻代码或拖时间。
3) 当关键结论取决于你不知道的信息时，**先反问 1-2 个最要害的问题**再给结论（像顶级顾问那样先对齐），不要替用户假设。
4) 给**具体、有数据、有取舍**的建议：明确的推荐方案 + 为什么 + 主要风险 + 立刻可做的下一步。拒绝正确的废话和泛泛而谈。
5) 深度优先而非堆字。该长则长，但每句都要有信息量；观点要鲜明，敢于指出用户想法里的问题。
6) 用中文（除非用户用英文）。

${readonly
  ? "【只读模式】你可以读文件、跑只读命令、查资料来调研，但**绝不修改/创建/删除任何文件**，也不要真的去执行落地——落地交给团队。"
  : "你可以读写工作目录里的文件。"}
当一件事大到需要团队真正动手做时，提醒用户切到「派活」让团队执行；在这里你只负责想清楚、给建议、对齐方向。`;
}

/**
 * Stateful CEO turn. On first call (no sdkAgentId) creates a persisted agent and
 * returns its id; later calls resume it. Streams text via opts.onStream.
 * @returns {Promise<{ok, text, sdkAgentId?, error?}>}
 */
export async function ceoChatTurn(agent, message, cwd, opts = {}) {
  const apiKey = opts.apiKey || process.env.CURSOR_API_KEY;
  const mode = opts.mode === "plan" ? "plan" : "agent";
  const onStream = typeof opts.onStream === "function" ? opts.onStream : null;
  if (!apiKey) return { ok: false, text: "", error: "Missing CURSOR_API_KEY" };

  const model = await modelSelectionFor(agent, apiKey);
  const local = { cwd };
  if (opts.store) local.store = opts.store;
  // NOTE: deliberately stateless (fresh agent per turn) with the recent history
  // carried in the prompt — this is far more reliable than resuming a persisted
  // agent (resume could hang or silently drop memory). We also don't load the
  // user's MCP servers here, which previously made turns hang.

  const hist = (opts.history || []).slice(-10)
    .map((m) => `${m.role === "user" ? "用户" : agent.name}：${(m.text || "").slice(0, 1200)}`)
    .join("\n");
  const skillBlock = opts.skillContext && opts.skillContext.trim() ? `\n\n# 可用团队技能（已自动匹配）\n${opts.skillContext}` : "";
  const payload = `${systemFor(agent, mode)}${skillBlock}${hist ? `\n\n# 最近对话\n${hist}` : ""}\n\n# 用户最新消息\n${message}`;

  try {
    const sdkAgent = await Agent.create({ apiKey, model, mode, name: `CEO·${agent.name}`, local });
    const run = await sdkAgent.send(payload, { mode });
    if (typeof opts.onRun === "function") opts.onRun(run);

    let liveText = "";
    try {
      for await (const m of run.stream()) {
        if (m.type === "assistant" && m.message?.content) {
          const txt = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (txt) {
            liveText = txt.startsWith(liveText) ? txt : (liveText + txt);
            onStream && onStream({ kind: "text", text: liveText });
          }
        } else if (m.type === "tool_call") {
          onStream && onStream({ kind: "tool", name: m.name, status: m.status });
        }
      }
    } catch { /* cancel/stream end */ }

    const result = await run.wait();
    try { sdkAgent.close?.(); } catch {}
    const final = result.result;
    const text = (final && final.trim().length) ? final : liveText;
    if (result.status !== "finished" && result.status !== "cancelled") {
      return { ok: false, text, error: `status: ${result.status}` };
    }
    return { ok: true, text };
  } catch (err) {
    if (err instanceof CursorAgentError) return { ok: false, text: "", error: err.message };
    return { ok: false, text: "", error: err.message };
  }
}

/**
 * The CEO turns a goal into a crisp Markdown 执行文档 (objective, key calls,
 * task breakdown assigned to teammates, acceptance criteria, risks). Pure text
 * generation — no files touched. Used to seed a board card before execution.
 * @returns {Promise<string>} markdown
 */
export async function ceoExecDoc(ceo, goal, workers, apiKey, opts = {}) {
  const key = opts.apiKey || apiKey || process.env.CURSOR_API_KEY;
  if (!key) return "";
  const roster = (workers || [])
    .map((w) => `- ${w.name}（${w.role}）：${w.goal}`)
    .join("\n") || "- 团队（通用执行）";

  // Carry the recent conversation so the plan continues what was discussed,
  // instead of treating the goal as a context-free one-liner.
  const convo = (opts.history || [])
    .filter((m) => m && m.text)
    .slice(-14)
    .map((m) => `${m.role === "user" ? "用户" : ceo.name}: ${m.text}`)
    .join("\n");
  const convoBlock = convo
    ? `\n# 最近对话（务必延续这里的结论和上下文，不要另起炉灶）\n"""\n${convo}\n"""\n`
    : "";
  const skillBlock = opts.skillContext && opts.skillContext.trim()
    ? `\n# 可用团队技能（已自动匹配，必要时按这些方法设计执行文档）\n${opts.skillContext}\n`
    : "";

  const prompt = `你是「${ceo.name}」。${ceo.persona || ceo.role}
用第一性原理把用户的目标变成一份**简洁有力、可直接执行的「执行文档」**，然后分配给团队。

# 团队成员
${roster}
${convoBlock}
${skillBlock}
# 用户目标（这是上面对话的延续，结合对话上下文来理解）
"""
${goal}
"""

严格用下面的 Markdown 结构输出（中文，直接、具体、可衡量，不要寒暄、不要解释你在做什么）：

## 🎯 目标
（一句话把目标说清楚，带可衡量结果）

## 🧭 关键判断
- （2-3 条第一性原理判断 / 砍掉的假约束）

## 🗂 任务拆解
| # | 负责人 | 任务 | 交付标准 |
|---|--------|------|----------|
（3-5 行，负责人只能从上面团队成员里选，任务要具体到能直接动手）

## ✅ 验收标准
- （2-3 条可检验的标准）

## ⚠️ 风险
- （1-2 条主要风险与对策）

只输出这份 Markdown，不要任何额外文字。`;

  const fallback = `## 🎯 目标\n${goal}\n\n## 🗂 任务拆解\n| # | 负责人 | 任务 | 交付标准 |\n|---|--------|------|----------|\n| 1 | 团队 | 落地这个目标 | 可用的交付物 |`;
  try {
    // create+send (not Agent.prompt) so the caller gets a run handle to cancel.
    const agent = await Agent.create({ apiKey: key, model: { id: ceo.model }, mode: "plan" });
    const run = await agent.send(prompt, { mode: "plan" });
    if (typeof opts.onRun === "function") opts.onRun(run);
    const result = await run.wait();
    try { agent.close?.(); } catch {}
    return (result.result || "").trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Stateless 1:1 chat (Agents page). Keeps history in the prompt; never edits files. */
export async function chatTurn(agent, history, message, cwd, opts = {}) {
  const apiKey = opts.apiKey || process.env.CURSOR_API_KEY;
  if (!apiKey) return { ok: false, text: "", error: "Missing CURSOR_API_KEY" };

  const convo = (history || []).map((m) => `${m.role === "user" ? "User" : agent.name}: ${m.text}`).join("\n");
  const prompt = `${systemFor(agent, "plan")}

# Conversation so far
${convo || "(none)"}

# New message from User
${message}

# Reply as ${agent.name}
Output only your reply text. Do NOT modify files.`;

  try {
    const result = await Agent.prompt(prompt, { apiKey, model: { id: agent.model }, mode: "plan", local: { cwd } });
    if (result.status !== "finished") return { ok: false, text: result.result ?? "", error: `status: ${result.status}` };
    return { ok: true, text: result.result ?? "" };
  } catch (err) {
    if (err instanceof CursorAgentError) return { ok: false, text: "", error: err.message };
    return { ok: false, text: "", error: err.message };
  }
}

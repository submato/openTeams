// Wrapper around the Cursor SDK. Runs ONE agent turn with live streaming.
//
// mode "agent" → the agent may read AND write files in `cwd` (真正改代码).
// mode "plan"  → read-only: analyze and return a patch/plan as text, no writes.

import { Agent, CursorAgentError } from "@cursor/sdk";
import { modelSelectionFor } from "./models.mjs";

const BUILTIN_TOOL_HINT = {
  web_search: "你可以联网检索事实。",
  code: "你可以读写代码文件。",
  file_write: "你可以创建/修改文件。",
  shell: "你可以执行 shell 命令（谨慎）。",
  browser: "你可以驱动浏览器。",
};

/**
 * Build a CrewAI-style prompt. In agent mode we explicitly *want* file edits;
 * in plan mode we forbid writes and ask for a patch instead.
 */
export function buildPrompt(agent, task, context, mode = "agent", skillContext = "") {
  const persona = agent.persona && agent.persona.trim().length ? `\n# Persona\n${agent.persona}\n` : "";
  const contextBlock = context && context.trim().length ? `\n# Context from earlier teammates\n${context}\n` : "";
  const toolHints = (agent.tools || []).map((t) => BUILTIN_TOOL_HINT[t]).filter(Boolean);
  const toolsBlock = toolHints.length ? `\n# Tools available to you\n${toolHints.join(" ")}\n` : "";
  const skillsBlock = skillContext && skillContext.trim().length ? `\n# Team skills available to you\n${skillContext}\n` : "";

  const rules = mode === "plan"
    ? `# Rules (READ-ONLY mode)
- You may READ files in the working directory to ground your answer.
- Do NOT modify, create, or delete any files. Return changes as a unified diff / patch or as clearly-labeled code blocks.
- Output ONLY the deliverable. Be concrete and specific.`
    : `# Rules (AGENT mode — you may edit files)
- Work directly in the project at the current working directory: read, create, and edit real files to accomplish the task.
- Make the smallest change that fully solves the task; prefer boring, correct solutions.
- After acting, briefly summarize WHAT you changed (files + why) and any commands to run/verify.`;

  return `You are "${agent.name}", acting strictly in this role.

# Role
${agent.role}

# Your goal
${agent.goal}

# Backstory / operating principles
${agent.backstory}
${persona}${toolsBlock}${skillsBlock}${contextBlock}
# Your task right now
${task.description}

# Expected output
${task.expectedOutput}

${rules}`;
}

/**
 * Run a single agent turn with streaming.
 * @param {object} opts { apiKey, mode, store, onStream, onRun }
 *   onStream(evt): evt = { kind:"thinking"|"tool"|"text", ... }
 *   onRun(run): receives the SDK Run handle (for cancellation)
 * @returns {Promise<{ok, text, status, error?, meta}>}
 */
export async function runAgentTurn(agent, task, context, cwd, opts = {}) {
  const apiKey = opts.apiKey || process.env.CURSOR_API_KEY;
  const mode = opts.mode === "plan" ? "plan" : "agent";
  const onStream = typeof opts.onStream === "function" ? opts.onStream : null;
  if (!apiKey) return { ok: false, status: "no_key", text: "", error: "Missing CURSOR_API_KEY", meta: {} };

  // Bounded retry for TRANSIENT SDK failures. Read-only (plan) turns are always
  // safe to retry; agent turns retry only when the run errored with no output
  // (so we never double-apply real edits). Caller may override via opts.retries.
  const maxAttempts = 1 + (Number.isInteger(opts.retries) ? opts.retries : (mode === "plan" ? 2 : 1));
  let lastFail = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await runAgentTurnOnce(agent, task, context, cwd, opts, apiKey, mode, onStream);
    if (r.ok) return r;
    lastFail = r;
    const transient = r.status === "error" || r.status === "startup_error" || r.status === "exception";
    const safeToRetry = mode === "plan" || !(r.text && r.text.trim().length);
    if (attempt < maxAttempts && transient && safeToRetry) {
      onStream && onStream({ kind: "thinking", text: `（瞬时错误，重试 ${attempt}/${maxAttempts - 1}：${r.error || r.status}）` });
      await new Promise((res) => setTimeout(res, 800 * attempt));
      continue;
    }
    break;
  }
  return lastFail;
}

async function runAgentTurnOnce(agent, task, context, cwd, opts, apiKey, mode, onStream) {
  const prompt = buildPrompt(agent, task, context, mode, opts.skillContext || "");
  const startedAt = Date.now();

  try {
    const model = await modelSelectionFor(agent, apiKey);
    const local = { cwd };
    if (opts.store) local.store = opts.store;
    // In agent mode, load the user's ambient Cursor config (tools, MCP servers,
    // rules) so capabilities the agent is configured for actually apply.
    if (mode === "agent") local.settingSources = ["user", "project"];

    // Memory: resume the agent's prior session when enabled, else create fresh.
    let sdkAgent = null;
    if (opts.resumeId) {
      try { sdkAgent = await Agent.resume(opts.resumeId, { apiKey, model, mode, local }); } catch { sdkAgent = null; }
    }
    if (!sdkAgent) sdkAgent = await Agent.create({ apiKey, model, mode, local });
    if (typeof opts.onAgentId === "function" && sdkAgent.agentId) opts.onAgentId(sdkAgent.agentId);

    const run = await sdkAgent.send(prompt, { mode });
    if (typeof opts.onRun === "function") opts.onRun(run);

    let liveText = "";
    try {
      for await (const m of run.stream()) {
        if (m.type === "assistant" && m.message?.content) {
          const txt = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (txt) { liveText = txt; onStream && onStream({ kind: "text", text: txt }); }
        } else if (m.type === "thinking" && m.text) {
          onStream && onStream({ kind: "thinking", text: m.text });
        } else if (m.type === "tool_call") {
          onStream && onStream({ kind: "tool", name: m.name, status: m.status, target: toolTarget(m) });
        }
      }
    } catch (streamErr) {
      // streaming may throw on cancel; fall through to wait()
    }

    const result = await run.wait();
    const meta = { durationMs: Date.now() - startedAt, model: agent.model, mode, usage: null };
    try { sdkAgent.close?.(); } catch {}

    const text = result.result ?? liveText ?? "";
    if (result.status === "cancelled") return { ok: false, status: "cancelled", text, error: "已取消", meta };
    if (result.status !== "finished") {
      // Surface whatever detail the SDK attached so "error" isn't a black box.
      const detail = result.error?.message || result.error || result.message
        || (result.reason ? String(result.reason) : "")
        || (result.result ? String(result.result).slice(0, 300) : "");
      return { ok: false, status: result.status, text, error: `run status: ${result.status}${detail ? " — " + detail : ""}`, meta };
    }
    return { ok: true, status: "finished", text, meta };
  } catch (err) {
    const meta = { durationMs: Date.now() - startedAt, model: agent.model, mode, usage: null };
    if (err instanceof CursorAgentError) return { ok: false, status: err.isRetryable ? "startup_error" : "fatal", text: "", error: `${err.message} (retryable=${err.isRetryable})`, meta };
    return { ok: false, status: "exception", text: "", error: err.message, meta };
  }
}

// Best-effort: pull a readable target (file path) out of a tool call's args.
function toolTarget(m) {
  const a = m.args;
  if (!a || typeof a !== "object") return "";
  return a.path || a.file || a.target_file || a.relativePath || a.command || "";
}

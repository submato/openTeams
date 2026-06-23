// The "Crew" engine — agent-centric. You assemble a crew from your Agents
// Repository: one Manager (orchestrator) + any number of Worker agents + an
// optional Reviewer. The Manager plans tasks and assigns each to a worker;
// workers run sequentially with shared context; the Reviewer signs off.
//
// Event-driven so the desktop UI can render live progress.

import { runAgentTurn } from "./runner.mjs";

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const slice = candidate.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    const end = Math.max(slice.lastIndexOf("]"), slice.lastIndexOf("}"));
    if (end === -1) return null;
    try { return JSON.parse(slice.slice(0, end + 1)); } catch { return null; }
  }
}

/**
 * @param {string} idea
 * @param {object} options { manager, workers[], reviewer?, cwd, apiKey, onEvent }
 *   each agent: { id, name, role, goal, backstory, model, persona? }
 */
export async function kickoff(idea, options = {}) {
  const { manager, workers = [], reviewer = null, cwd = process.cwd(), apiKey } = options;
  const mode = options.mode === "plan" ? "plan" : "agent";
  const store = options.store;
  const memStore = options.memStore || null;
  const onRun = options.onRun;
  const skillProvider = typeof options.skillProvider === "function" ? options.skillProvider : () => "";
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;
  const emit = (type, payload = {}) =>
    options.onEvent && options.onEvent({ type, ...payload, at: Date.now() });
  const pickSkills = (args) => {
    const picked = skillProvider(args) || "";
    if (typeof picked === "string") return { context: picked, selected: [] };
    return { context: picked.context || "", selected: picked.selected || [] };
  };

  if (!manager) throw new Error("No manager agent selected.");
  if (!workers.length) throw new Error("No worker agents selected.");

  // Resume payload from a prior interrupted run (Phase A): reuse the plan and any
  // already-finished task outputs so we never redo completed work.
  const resume = options.resume && (options.resume.tasks?.length || options.resume.results?.length)
    ? options.resume : null;

  const startedAt = resume?.startedAt || Date.now();
  const byId = new Map(workers.map((w) => [w.id, w]));
  const roster = workers
    .map((w) => `- id "${w.id}": ${w.name} — role: ${w.role}; goal: ${w.goal}`)
    .join("\n");

  // Rebuild the shared context from whatever results we already have.
  const buildContext = (rs) => {
    let c = `Original idea:\n${idea}\n`;
    for (const r of rs) c += `\n---\n## ${r.agent} — ${r.title}\n${r.output}\n`;
    return c;
  };

  // --- Step 1: Manager plans (skipped on resume) ---
  let planRes = null;
  let tasks;
  if (resume && Array.isArray(resume.tasks) && resume.tasks.length) {
    tasks = resume.tasks;
    emit("plan-done", { tasks, meta: null, resumed: true });
  } else {
    const planSkillPick = pickSkills({ stage: "plan", agent: manager, task: null, idea, context: "" });
    emit("plan-start", { agent: manager.name, model: manager.model, skills: planSkillPick.selected });
    const planTask = {
      description: `A human dropped this idea:

"""
${idea}
"""

FIRST, survey the working directory: read the existing relevant files/artifacts
(scripts, storyboards, prior outputs, candidates) that already exist here. Your
plan MUST build on what is already there — reuse and improve existing files
instead of starting from scratch. In each task, say explicitly whether the
teammate should EDIT a specific existing file or CREATE a new one.

You manage this team. Decompose the idea into 2-5 concrete tasks and assign each
to ONE teammate by their id. Available teammates:
${roster}

Order tasks so each builds on the previous one. Only assign to ids listed above.`,
      expectedOutput: `Return ONLY a JSON array. Each item:
{ "worker": "<one of the ids above>", "title": "short title", "description": "what exactly this teammate must do for THIS idea", "expected_output": "what good looks like" }
No prose outside the JSON.`,
    };

    planRes = await runAgentTurn(manager, planTask, "", cwd, {
      apiKey, mode: "plan", store, onRun,
      skillContext: planSkillPick.context,
    });
    if (!planRes.ok) { emit("error", { stage: "plan", error: planRes.error }); throw new Error(`Manager planning failed: ${planRes.error}`); }

    const rawPlan = extractJson(planRes.text);
    tasks = Array.isArray(rawPlan)
      ? rawPlan
          .filter((t) => t && byId.has(t.worker) && t.description)
          .map((t, i) => ({
            id: i + 1,
            worker: t.worker,
            agentName: byId.get(t.worker).name,
            role: byId.get(t.worker).role,
            title: t.title || `Task ${i + 1}`,
            description: t.description,
            expectedOutput: t.expected_output || "A concrete, usable deliverable.",
          }))
      : [];

    if (tasks.length === 0) { emit("error", { stage: "plan", error: "no usable tasks" }); throw new Error("Manager did not return a valid task array.\nRaw:\n" + planRes.text); }
    emit("plan-done", { tasks, meta: planRes.meta });
  }

  // --- Step 2: execute sequentially (already-finished tasks are replayed, not rerun) ---
  const results = resume?.results ? [...resume.results] : [];
  const doneIds = new Set(results.map((r) => r.id));
  let context = buildContext(results);
  for (const task of tasks) {
    if (doneIds.has(task.id)) { emit("task-done", { entry: results.find((r) => r.id === task.id), resumed: true }); continue; }
    if (isCancelled()) { emit("cancelled", { stage: "tasks" }); break; }
    const agent = byId.get(task.worker);
    const taskSkillPick = pickSkills({ stage: "task", agent, task, idea, context });
    emit("task-start", { task, agent: agent.name, model: agent.model, skills: taskSkillPick.selected });
    const onStream = (evt) => emit("task-stream", { taskId: task.id, ...evt });
    const turnOpts = {
      apiKey, mode, store, onRun, onStream,
      skillContext: taskSkillPick.context,
    };
    if (memStore && agent.memory) { turnOpts.resumeId = memStore.get(agent.id); turnOpts.onAgentId = (id) => memStore.set(agent.id, id); }
    const res = await runAgentTurn(agent, task, context, cwd, turnOpts);
    const entry = {
      id: task.id, worker: task.worker, agent: agent.name, role: agent.role,
      title: task.title, ok: res.ok,
      output: res.ok ? res.text : `ERROR: ${res.error}`, meta: res.meta,
    };
    results.push(entry);
    context += `\n---\n## ${agent.name} — ${task.title}\n${entry.output}\n`;
    emit("task-done", { entry });
  }

  // --- Step 3: optional reviewer (skipped when a resumed run already has one) ---
  let review = resume?.review || null, reviewMeta = null;
  if (reviewer && !isCancelled() && !review) {
    const reviewTask = {
      description: `Review the team's full output for this idea:\n\n"""\n${idea}\n"""\n\nAll deliverables are in the context above.`,
      expectedOutput: `Return:\n1. VERDICT: SHIP / FIX / KILL\n2. Top risks (bullets)\n3. Required fixes (numbered)\n4. One-line bottom line.`,
    };
    const reviewSkillPick = pickSkills({ stage: "review", agent: reviewer, task: reviewTask, idea, context });
    emit("review-start", { agent: reviewer.name, model: reviewer.model, skills: reviewSkillPick.selected });
    const reviewRes = await runAgentTurn(reviewer, reviewTask, context, cwd, {
      apiKey, mode: "plan", store, onRun,
      skillContext: reviewSkillPick.context,
    });
    review = reviewRes.ok ? reviewRes.text : `Reviewer failed: ${reviewRes.error}`;
    reviewMeta = reviewRes.meta;
    emit("review-done", { review, meta: reviewMeta });

    // --- Step 3b: one automatic FIX pass if the reviewer asked for it ---
    const isFix = /VERDICT:?\s*FIX/i.test(review || "");
    if (isFix && !isCancelled() && results.length) {
      const last = tasks[tasks.length - 1];
      const fixer = byId.get(last.worker);
      const fixId = `${last.id}-fix`;
      const fixTask = {
        description: `审查员对团队产出给出了 FIX。请只针对下列审查意见，产出 ${last.title} 的修订版（直接给可用结果，不要复述意见）：\n\n${review}`,
        expectedOutput: `修订后的交付物（最终可用版本）。`,
      };
      const fixSkillPick = pickSkills({ stage: "fix", agent: fixer, task: fixTask, idea, context });
      emit("task-start", { task: { id: fixId, title: `修复：${last.title}` }, agent: fixer.name, model: fixer.model, skills: fixSkillPick.selected });
      const onStream = (evt) => emit("task-stream", { taskId: fixId, ...evt });
      const fixOpts = {
        apiKey, mode, store, onRun, onStream,
        skillContext: fixSkillPick.context,
      };
      if (memStore && fixer.memory) { fixOpts.resumeId = memStore.get(fixer.id); fixOpts.onAgentId = (id) => memStore.set(fixer.id, id); }
      const fixRes = await runAgentTurn(fixer, fixTask, context, cwd, fixOpts);
      const fixEntry = {
        id: fixId, worker: last.worker, agent: fixer.name, role: fixer.role,
        title: `修复：${last.title}`, ok: fixRes.ok,
        output: fixRes.ok ? fixRes.text : `ERROR: ${fixRes.error}`, meta: fixRes.meta,
      };
      results.push(fixEntry);
      context += `\n---\n## ${fixer.name} — 修复版\n${fixEntry.output}\n`;
      emit("task-done", { entry: fixEntry });

      // Re-review once.
      emit("review-start", { agent: reviewer.name, model: reviewer.model, recheck: true });
      const reReviewTask = {
        description: `修复已完成（见上下文最新「修复版」）。请复审并给最终结论。`,
        expectedOutput: reviewTask.expectedOutput,
      };
      const reReviewSkillPick = pickSkills({ stage: "re-review", agent: reviewer, task: reReviewTask, idea, context });
      const reReview = await runAgentTurn(reviewer, reReviewTask, context, cwd, {
        apiKey, mode: "plan", store, onRun,
        skillContext: reReviewSkillPick.context,
      });
      review = reReview.ok ? reReview.text : review;
      reviewMeta = reReview.meta;
      emit("review-done", { review, meta: reviewMeta, recheck: true });
    }
  }

  const run = {
    idea, manager: { id: manager.id, name: manager.name },
    reviewer: reviewer ? { id: reviewer.id, name: reviewer.name } : null,
    tasks, results, review,
    startedAt, finishedAt: Date.now(), planMeta: planRes?.meta || null, reviewMeta,
  };
  emit("done", { run });
  return run;
}

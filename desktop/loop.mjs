// ──────────────────────────────────────────────────────────────────────────
// LOOP ENGINE  (the reusable closed-loop primitive)
//
// One pure orchestrator that drives ANY open-ended objective through repeated
// iterations:
//
//     north star ─► propose next task ─► execute ─► VERIFY ─► reflect ─► repeat
//
// The engine itself is dependency-injected and side-effect free: it never
// touches disk, git, or the SDK. The caller supplies four async functions:
//
//   propose({ objective, journal })  -> { task, rationale, done?, giveUp? }
//   execute({ objective, task, journal }) -> { ok, ref, output, error? }
//   verify ({ objective, task, exec, journal }) -> { ok, score, evidence, notes, pending? }
//   reflect({ objective, task, exec, verify, journal }) -> { note, northStarMet? }
//
// This separation is the whole point: SELF-EDIT injects a gate (syntax/smoke)
// as `verify`; a money/business objective injects a human score as `verify`
// (returning { pending: true } to suspend the loop until the human answers).
// Swapping adapters reuses the exact same control flow.
// ──────────────────────────────────────────────────────────────────────────

const noop = () => {};

/** Run ONE iteration. Returns a tagged result the driver persists + acts on. */
export async function runIteration({ objective, journal = [], deps, onEvent = noop, isCancelled = () => false }) {
  if (!deps || typeof deps.execute !== "function" || typeof deps.verify !== "function") {
    throw new Error("loop: deps.execute and deps.verify are required");
  }
  const propose = typeof deps.propose === "function" ? deps.propose : async () => ({ task: objective.northStar });
  const reflect = typeof deps.reflect === "function" ? deps.reflect : async () => ({ note: "" });
  const emit = (type, p = {}) => { try { onEvent({ type, at: Date.now(), ...p }); } catch {} };
  const n = (journal.length || 0) + 1;

  // 1) PROPOSE — what's the single next concrete step toward the north star?
  emit("loop-propose-start", { n });
  const proposal = await propose({ objective, journal });
  if (isCancelled()) return { kind: "cancelled", n };
  if (proposal && proposal.done) { emit("loop-done", { reason: proposal.rationale || "" }); return { kind: "objective-done", n, proposal }; }
  if (proposal && proposal.giveUp) { emit("loop-giveup", { reason: proposal.rationale || "" }); return { kind: "gave-up", n, proposal }; }
  const task = (proposal && proposal.task || "").trim();
  if (!task) return { kind: "error", n, error: "策略层没有给出下一步任务" };
  emit("loop-propose-done", { n, task, rationale: proposal.rationale || "" });

  // 2) EXECUTE — run the work (crew / self-edit / whatever the adapter does).
  emit("loop-execute-start", { n, task });
  let exec;
  try { exec = await execute(deps, { objective, task, journal }); }
  catch (e) { emit("loop-execute-error", { n, error: e.message }); return { kind: "error", n, task, proposal, error: e.message }; }
  if (isCancelled()) return { kind: "cancelled", n, task, proposal, exec };
  emit("loop-execute-done", { n, ok: !!exec.ok });

  // 3) VERIFY — the crux. A pending verifier (e.g. human score) suspends here.
  emit("loop-verify-start", { n });
  let verify;
  try { verify = await deps.verify({ objective, task, exec, journal }); }
  catch (e) { emit("loop-verify-error", { n, error: e.message }); return { kind: "error", n, task, proposal, exec, error: e.message }; }
  if (verify && verify.pending) { emit("loop-verify-pending", { n }); return { kind: "await-human", n, task, proposal, exec, verify }; }
  emit("loop-verify-done", { n, ok: !!verify.ok, score: verify.score });

  // 4) REFLECT — record what was learned; surface whether the north star is met.
  let reflection = { note: "" };
  try { reflection = await reflect({ objective, task, exec, verify, journal }); } catch (e) { reflection = { note: "(反思失败：" + e.message + ")" }; }
  emit("loop-reflect-done", { n, note: reflection.note || "", northStarMet: !!reflection.northStarMet });

  return { kind: "iterated", n, proposal, exec, verify, reflection };
}

async function execute(deps, args) {
  if (typeof deps.execute !== "function") throw new Error("loop: deps.execute missing");
  return deps.execute(args);
}

/** Compact the journal into a short text the propose/reflect LLM can read. */
export function summarizeJournal(journal = [], max = 8) {
  const recent = journal.slice(-max);
  return recent.map((e) => {
    const v = e.verify || {};
    const verdict = v.ok ? "✓ 通过" : (v.pending ? "… 待人工" : "✗ 未过");
    const score = (v.score != null) ? ` 分数=${v.score}` : "";
    return `#${e.n} 任务：${e.task}\n  结果：${verdict}${score}${v.notes ? " — " + v.notes : ""}${e.reflection ? "\n  复盘：" + e.reflection : ""}`;
  }).join("\n");
}

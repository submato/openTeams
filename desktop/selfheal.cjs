// ──────────────────────────────────────────────────────────────────────────
// SELF-HEAL WATCHDOG  (Slice 1 of the self-modify loop)
//
// PROTECTED FILE — must NOT be edited by the autonomous self-modify agent.
// This is the brake. If the agent could rewrite its own safety net, a single
// bad edit could disable recovery and brick the app for good.
//
// What it does:
//   - Records a "last known good" git commit every time the app boots healthy.
//   - Counts boots that crash BEFORE reaching healthy.
//   - After N consecutive bad boots, hard-resets the source tree to the last
//     known good commit and relaunches — so a broken self-edit can never make
//     the app permanently unstartable.
//
// Safety invariants:
//   - State lives in userData (OUTSIDE the git repo), so `git reset --hard`
//     never erases the watchdog's own memory.
//   - Only SOURCE CODE is tracked by git; all user data is .gitignore'd, so a
//     rollback reverts code only and leaves ideas/agents/chat/settings intact.
//   - Rollback only runs in dev (unpackaged) on a real git repo. The packaged
//     .app can't git-reset its asar, so it simply tracks health and never rolls.
// ──────────────────────────────────────────────────────────────────────────

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FAIL_THRESHOLD = 2;   // consecutive bad boots before auto-rollback

function gitOut(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function isGitRepo(repo) {
  try { return gitOut(repo, ["rev-parse", "--is-inside-work-tree"]) === "true"; }
  catch { return false; }
}
function headCommit(repo) {
  try { return gitOut(repo, ["rev-parse", "HEAD"]); } catch { return ""; }
}

function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; }
}
function writeState(statePath, st) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
  } catch { /* best-effort; watchdog must never throw on its own persistence */ }
}

/**
 * Create a watchdog bound to a source repo and a state file.
 * @param {object} opts
 * @param {string} opts.repo      Absolute path to the app's source git repo.
 * @param {string} opts.statePath Absolute path to the JSON state (in userData).
 * @param {boolean} opts.enabled  Whether rollback is allowed (dev + git only).
 * @param {(msg:string)=>void} [opts.log]
 */
function createWatchdog(opts) {
  const { repo, statePath } = opts;
  const log = opts.log || (() => {});
  const enabled = !!opts.enabled && isGitRepo(repo);

  return {
    enabled,

    /**
     * Call at the very START of boot, before loading heavy/self-editable code.
     * Detects a prior boot that never reached healthy (= it crashed), counts it,
     * and — past the threshold — rolls the source back and asks for relaunch.
     *
     * @returns {{rollback:boolean, toCommit?:string, failedBoots:number}}
     *   rollback=true means the caller should relaunch+exit immediately.
     */
    beginBoot() {
      const st = readState(statePath);

      // A pending marker still set from last time means that boot crashed
      // before markHealthy() cleared it.
      const crashedLast = !!st.pendingBootAt;
      let failedBoots = st.failedBoots || 0;
      if (crashedLast) {
        failedBoots += 1;
        log(`previous boot did not reach healthy (consecutive bad boots: ${failedBoots})`);
      }

      if (enabled && crashedLast && failedBoots >= FAIL_THRESHOLD && st.lastGoodCommit) {
        const current = headCommit(repo);
        if (current && current !== st.lastGoodCommit) {
          try {
            log(`auto-rollback: git reset --hard ${st.lastGoodCommit.slice(0, 8)} (from ${current.slice(0, 8)})`);
            execFileSync("git", ["reset", "--hard", st.lastGoodCommit], { cwd: repo, stdio: "ignore" });
            // Fresh count after recovering; the good code should boot cleanly.
            writeState(statePath, { ...st, failedBoots: 0, pendingBootAt: Date.now(), lastRollbackAt: Date.now(), rolledBackFrom: current });
            return { rollback: true, toCommit: st.lastGoodCommit, failedBoots };
          } catch (e) {
            log(`auto-rollback failed: ${e.message}`);
          }
        } else {
          // Already at the good commit but still crashing → not a code problem.
          // Don't loop forever resetting to the same thing.
          log("already at last-good commit; crash is not from a self-edit — skipping rollback");
        }
      }

      // Mark this boot as in-flight. markHealthy() clears it on success.
      writeState(statePath, { ...st, failedBoots, pendingBootAt: Date.now() });
      return { rollback: false, failedBoots };
    },

    /**
     * Call once the app is confirmed healthy (window loaded + store OK).
     * Clears the in-flight marker and records the current commit as last-good.
     */
    markHealthy() {
      const st = readState(statePath);
      const good = headCommit(repo) || st.lastGoodCommit || "";
      writeState(statePath, {
        ...st,
        pendingBootAt: 0,
        failedBoots: 0,
        lastGoodCommit: good,
        lastHealthyAt: Date.now(),
      });
      log(`boot healthy; last-good = ${good ? good.slice(0, 8) : "(none)"}`);
    },

    status() { return readState(statePath); },
  };
}

module.exports = { createWatchdog, FAIL_THRESHOLD };

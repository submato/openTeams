// ──────────────────────────────────────────────────────────────────────────
// SELF-EDIT MACHINERY  (Slice 2 of the self-modify loop)
//
// PROTECTED FILE — must NOT be edited by the autonomous self-modify agent.
//
// Lets the team edit the app's OWN source safely:
//   - The edit happens in a throwaway `git worktree` (a separate checkout that
//     shares the same .git), so the LIVE running code is never touched until
//     the human clicks "apply".
//   - A safety gate runs in that worktree: `node --check` on every changed JS
//     file + an Electron `--smoke-test` boot. A candidate that can't even load
//     is rejected before it ever reaches the live tree.
//   - "apply" merges the candidate branch into the live repo (a new commit the
//     self-heal watchdog will treat as last-known-good once it boots healthy).
//   - "discard" deletes the worktree + branch; the live tree stays clean.
//
// Nothing here runs git operations that can destroy user data: user data is
// .gitignore'd, so it is never part of a worktree, commit, or branch.
// ──────────────────────────────────────────────────────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const GIT_ID = ["-c", "user.name=ai-team-selfedit", "-c", "user.email=selfedit@local"];
const CODE_EXT = new Set([".mjs", ".cjs", ".js"]);
// The dependency dirs are symlinked into the worktree (see linkDeps); these
// magic pathspecs keep those symlinks out of every stage/diff/commit so a
// candidate never tries to overwrite the live repo's real node_modules.
const STAGE_SPEC = [".", ":(exclude)node_modules", ":(exclude)desktop/node_modules"];

function git(repo, args, opts = {}) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
// Raw (untrimmed) — needed for `status --porcelain`, whose first line begins
// with a significant leading space (e.g. " M path") that .trim() would eat.
function gitRaw(repo, args, opts = {}) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function head(repo) { return git(repo, ["rev-parse", "HEAD"]); }
function worktreesRoot() { return path.join(os.tmpdir(), "ai-team-selfedit"); }

// Symlink the (gitignored) dependency dirs into the worktree so the gate's
// Electron smoke test can actually run against the edited code.
function linkDeps(repo, dir) {
  for (const rel of ["node_modules", path.join("desktop", "node_modules")]) {
    const src = path.join(repo, rel);
    const dst = path.join(dir, rel);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.symlinkSync(src, dst); } catch { /* best effort */ }
    }
  }
}

/**
 * Create an isolated worktree for a self-edit candidate.
 * @returns {{id, dir, branch, base}}
 */
function createCandidate(repo, id) {
  const base = head(repo);
  const branch = `selfedit/${id}`;
  const dir = path.join(worktreesRoot(), id);
  fs.mkdirSync(worktreesRoot(), { recursive: true });
  git(repo, ["worktree", "add", "-b", branch, dir, base]);
  linkDeps(repo, dir);
  return { id, dir, branch, base };
}

/** Files changed in the worktree vs its base (working tree, uncommitted). */
function changedFiles(dir) {
  const out = gitRaw(dir, ["status", "--porcelain"]);
  return out.split("\n").filter((l) => l.length > 3).map((line) => {
    const status = line.slice(0, 2).trim();
    let file = line.slice(3);
    // Renames render as "old -> new"; keep the new path.
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4);
    return { status, file };
  }).filter((c) => c.file && !/(^|\/)node_modules(\/|$)/.test(c.file));
}

function diff(dir, maxBytes = 200_000) {
  const files = changedFiles(dir);
  let patch = "";
  try {
    // Stage everything (so newly-created files show up too), then diff the index
    // against HEAD. The symlinked dependency dirs are excluded.
    git(dir, ["add", "-A", "--", ...STAGE_SPEC]);
    patch = git(dir, ["diff", "--cached", "--", ...STAGE_SPEC]);
  } catch { patch = ""; }
  if (patch.length > maxBytes) patch = patch.slice(0, maxBytes) + "\n… (diff truncated) …";
  return { files, patch };
}

/**
 * Run the safety gate inside the worktree.
 * @returns {Promise<{ok, checks:[{name, ok, detail}]}>}
 */
function runGate(dir, opts = {}) {
  const checks = [];
  const changed = changedFiles(dir);

  // 1) Syntax check every changed JS file that still exists.
  const codeFiles = changed
    .filter((c) => c.status !== "D" && CODE_EXT.has(path.extname(c.file)))
    .map((c) => c.file);
  let syntaxOk = true;
  const syntaxFails = [];
  for (const f of codeFiles) {
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs)) continue;
    try {
      execFileSync(process.execPath, ["--check", abs], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      syntaxOk = false;
      syntaxFails.push(`${f}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }
  checks.push({ name: "syntax", ok: syntaxOk, detail: syntaxOk ? `${codeFiles.length} 个文件语法 OK` : syntaxFails.join(" | ") });

  // 2) Electron smoke boot against the edited code.
  return runSmoke(dir, opts).then((smoke) => {
    checks.push(smoke);
    return { ok: checks.every((c) => c.ok), checks };
  });
}

function runSmoke(dir, opts = {}) {
  const timeoutMs = opts.timeoutMs || 45_000;
  const desktop = path.join(dir, "desktop");
  const electronBin = path.join(desktop, "node_modules", ".bin", "electron");
  return new Promise((resolve) => {
    if (!fs.existsSync(electronBin)) {
      resolve({ name: "smoke", ok: false, detail: "找不到 electron(依赖未链接)" });
      return;
    }
    let out = "";
    const child = spawn(electronBin, [".", "--smoke-test"], {
      cwd: desktop,
      env: { ...process.env, AI_TEAM_DISABLE_GPU: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ name: "smoke", ok: false, detail: "冒烟测试超时" }); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && /\[smoke-test\] ok/.test(out);
      const detail = ok ? "启动加载成功" : (out.match(/\[smoke-test\] failed:.*/)?.[0] || `退出码 ${code}`).slice(0, 200);
      resolve({ name: "smoke", ok, detail });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ name: "smoke", ok: false, detail: e.message }); });
  });
}

/** Commit the candidate in its worktree (so it can be merged on apply). */
function commitCandidate(dir, message) {
  git(dir, ["add", "-A", "--", ...STAGE_SPEC]);
  git(dir, [...GIT_ID, "commit", "-m", message || "self-edit candidate"]);
  return head(dir);
}

/** Merge the candidate branch into the live repo. Returns the new HEAD. */
function apply(repo, branch, message) {
  git(repo, [...GIT_ID, "merge", "--no-ff", branch, "-m", message || `apply ${branch}`]);
  return head(repo);
}

/** Tear down the worktree + branch. Safe: never touches user data. */
function discard(repo, dir, branch) {
  try { git(repo, ["worktree", "remove", "--force", dir]); } catch {}
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { git(repo, ["branch", "-D", branch]); } catch {}
}

// ── OS-level hard isolation ────────────────────────────────────────────────
// Prompt rules + path sanitizing tell the agent to stay in the worktree, but
// nothing physically stops a confused agent from writing the LIVE source via an
// absolute path. lockSource() makes the live SOURCE TREE read-only at the OS
// level for the duration of a self-edit run, so any such write fails with
// EACCES. Only source dirs are locked — the app's runtime data lives at the
// repo root (gitignored) and stays writable, as does node_modules/.git and the
// worktree itself (a separate dir under tmp).
const PROTECTED_SOURCE = ["desktop", "src", "package.json"];
const LOCK_SKIP = new Set(["node_modules", ".git"]);
const SRCLOCK_FILE = ".selfedit-srclock.json";

function collectSourcePaths(repo, rel, acc) {
  const abs = path.join(repo, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) return;            // never follow symlinks (e.g. linked node_modules)
  if (st.isDirectory()) {
    if (LOCK_SKIP.has(path.basename(abs))) return;
    acc.push(abs);                            // dir before children (pre-order)
    let names = [];
    try { names = fs.readdirSync(abs); } catch { return; }
    for (const n of names) collectSourcePaths(repo, path.join(rel, n), acc);
  } else if (st.isFile()) {
    acc.push(abs);
  }
}

/**
 * Strip write bits from the live source tree. Records original modes to a lock
 * file so a crash mid-run can be recovered (the next lock/unlock restores them).
 * Returns the map of restored modes.
 */
function lockSource(repo) {
  unlockSource(repo);                         // recover from any prior crash first
  const acc = [];
  for (const rel of PROTECTED_SOURCE) collectSourcePaths(repo, rel, acc);
  const saved = {};
  for (const abs of acc) {
    try {
      const m = fs.statSync(abs).mode & 0o777;
      const next = m & ~0o222;                // clear u/g/o write
      if (next !== m) { fs.chmodSync(abs, next); saved[abs] = m; }
    } catch { /* best effort */ }
  }
  try { fs.writeFileSync(path.join(repo, SRCLOCK_FILE), JSON.stringify(saved)); } catch {}
  return saved;
}

/** Restore write bits recorded by lockSource (idempotent; safe if never locked). */
function unlockSource(repo) {
  const lf = path.join(repo, SRCLOCK_FILE);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(lf, "utf8")); } catch { saved = null; }
  if (saved && typeof saved === "object") {
    for (const [abs, mode] of Object.entries(saved)) {
      try { fs.chmodSync(abs, mode); } catch {}
    }
  }
  try { fs.unlinkSync(lf); } catch {}
}

module.exports = { createCandidate, changedFiles, diff, runGate, runSmoke, commitCandidate, apply, discard, worktreesRoot, lockSource, unlockSource };

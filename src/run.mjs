// CLI entry (the desktop app is the main interface now).
//   node src/run.mjs "your idea here"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kickoff } from "./crew.mjs";
import { SEED_AGENTS } from "./agents.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnv();
  const idea = process.argv.slice(2).join(" ").trim();
  if (!idea) { console.error('Usage: node src/run.mjs "your idea"'); process.exit(1); }

  const manager = SEED_AGENTS.find((a) => a.suggestManager);
  const reviewer = SEED_AGENTS.find((a) => a.suggestReviewer);
  const workers = SEED_AGENTS.filter((a) => !a.suggestManager && !a.suggestReviewer);

  console.log("=== Crew kickoff ===\nIdea:", idea);
  const run = await kickoff(idea, {
    manager, workers, reviewer, cwd: ROOT,
    onEvent: (e) => {
      if (e.type === "plan-done") console.log(`Manager planned ${e.tasks.length} task(s).`);
      if (e.type === "task-start") console.log(`[${e.agent} ${e.model}] ${e.task.title}`);
      if (e.type === "task-done") console.log(`  ${e.entry.ok ? "done" : "failed"}.`);
      if (e.type === "review-start") console.log(`[${e.agent}] reviewing...`);
    },
  });
  console.log("\n=== Done ===\n" + (run.review || "(no reviewer)"));
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

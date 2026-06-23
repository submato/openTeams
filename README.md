# AI Team (Cursor SDK, CrewAI-inspired)

A small multi-agent "company" that runs on your Cursor quota via `@cursor/sdk`.
No OpenAI/Anthropic API key needed — it uses your `CURSOR_API_KEY`.

## Concept (borrowed from CrewAI)

- **Agent** = role + goal + backstory + model (+ delegation rights) — see `src/agents.mjs`
- **Task** = description + expected output
- **Crew** = orchestration: the CEO plans, delegates to specialists in sequence
  (each output becomes the next one's context), then the Reviewer signs off.

The "communication" between agents is intentionally simple: each agent's text
output is appended to a shared context that flows downstream. That's essentially
what CrewAI does under the hood — just made explicit here.

## Team

| Agent | Role | Model |
|---|---|---|
| Elon (CEO) | First-principles planning & delegation | claude-opus-4-8 |
| Research | Market / feasibility facts | claude-sonnet-4-6 |
| Marketing | Positioning & channels | claude-sonnet-4-6 |
| Builder | Concrete deliverable / code | gpt-5.3-codex |
| Reviewer | Quality & risk, SHIP/FIX/KILL | gpt-5.5 |

## Setup

```bash
cd ai-team
npm install
cp .env.example .env   # then put your CURSOR_API_KEY in .env (do NOT commit it)
```

## Run

```bash
# inline idea
node src/run.mjs "做一个帮我整理周报的小工具"

# or edit inbox/idea.md and run
node src/run.mjs --inbox
```

Output (plan + each deliverable + reviewer verdict) is written to
`outputs/<timestamp>/report.md`.

## Desktop app (Mac)

An Electron app lives in `desktop/`. It manages projects (a folder = a project,
outputs land in that project's `runs/`), lets you edit the team per project,
kick off a run with live progress, browse outputs, see cost stats, and set a
daily schedule.

```bash
cd ai-team/desktop
npm install          # downloads Electron (~once)
npm start            # launch the app from YOUR Mac GUI session

# If you hit a GPU-related crash, launch with:
AI_TEAM_DISABLE_GPU=1 npm start
```

The app reads `CURSOR_API_KEY` from `ai-team/.env` (same key as the CLI).
The green dot in the sidebar means the key is loaded.

Layout it creates:

```
ai-team/projects/<project-id>/
  project.json     # name, schedule
  team.json        # editable team (role/goal/model/persona)
  inbox/idea.md    # standing idea for scheduled runs
  runs/<stamp>/    # report.md + run.json (deliverables)
```

Note: the in-app scheduler only fires while the app is open. For true 7×24,
wrap `npm start` (or a headless runner) in a macOS `launchd` job.

## Notes

- Agents are text-only by default (they won't edit your files). The Builder
  returns code as text; you decide what to apply.
- Change models per agent in `src/agents.mjs` to trade quality vs cost/speed.
- This is a v1 sequential crew. Hierarchical delegation, memory, and a dashboard
  can be layered on later.

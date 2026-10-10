# How the factory works (QC reference model)

Read this as the ground truth for analysis. If the code disagrees, the code
wins; flag the drift as a finding and fix this file.

## 1. Components

| Part | Where | Role |
| --- | --- | --- |
| Orchestrator | the Claude session running `/factory` (`.claude/skills/factory/SKILL.md`) | Executes actions returned by `factory-cli tick`: spawns agents, resumes the builder, runs commands, reports. Makes **no** loop decisions itself. |
| State machine | `factory/lib/tick.js` | The loop's logic. Reads agent output files, records verdicts, moves stages, enforces budgets, returns the next action as JSON. |
| CLI | `factory/bin/factory-cli.js` + `factory/lib/*` | Only writer of `job.json`, `config.json`, `backlog.md`, worktrees, delivery. Zero deps, atomic writes, schema-validated. |
| Briefs | `factory/lib/brief.js` (`factory-cli brief <job> <role>`) | The **only** context channel into an agent: paths, commands, inputs, rules, output path and a pre-filled template. |
| Agents | `.claude/agents/*.md` | spec-writer, builder, reviewer-<lens> ×N, approver. Fresh context per spawn, except the builder, which is resumed. |
| Templates | `factory/templates/*.md` | Structure of each agent's output. First lines are machine-read markers. |
| Repo profile | `factory/FACTORY.md` | Human-level guidance every agent reads: stack, commands, conventions, per-lens review focus, "Always escalate". |
| Config | `factory/config.json` (+ `schema/config.schema.json`) | Commands, git, delivery, approval policy, loop limits, ports, tools, models, reviewer toggles. |
| Init | `.claude/skills/factory-init` + `factory/lib/detect.js`, `init.js` | Detects the stack, writes config + FACTORY.md, toggles lenses. |
| Dashboard | `factory/dashboard/` + `factory/lib/server.js` | Read-mostly view of jobs (React, no build). Can append/remove backlog items. |
| QC | `.claude/skills/factory-qc` (interactive) + `.claude/agents/factory-qc.md` (background) + `factory/lib/qc.js` + `factory/qc/` | Evidence, linting, assessments, proposals, journal; surfaced in the dashboard's Insights view. |

## 2. The loop (state machine)

Stages: `setup → spec → build → review → approve → deliver → delivered`,
plus `needs-human` and `cancelled`.

| Stage | tick does | Advances when | Fails to `needs-human` when |
| --- | --- | --- | --- |
| setup | creates worktree `<worktreeRoot>/<id>` on `branchPattern` from `baseBranch`; returns `run setup` if `commands.setup` | setup exit 0 | setup exits non-zero |
| spec | spawns spec-writer | `spec.md` exists with "Acceptance criteria" and `ACn`/checkbox items | no valid spec after 1 retry |
| build | moves old `build.md` aside, spawns (round 1 / rework) or **resumes** (round ≥2) builder `builder-<id>` | `build.md` first line `STATUS: READY` **and** ≥1 commit ahead of base | `STATUS: BLOCKED`; READY with 0 commits; invalid output after 1 retry |
| review (round N) | copies `build.md` → `round-N/build.md`; spawns every active lens in parallel | every `round-N/review-<lens>.md` has a valid `VERDICT:` line (WAIT FOR ALL) | a reviewer still has no valid file after 1 retry |
| ↳ decide | all PASS → approve; any CHANGES and `resumesUsed < maxReworkRounds` → resume builder; otherwise CLI writes `decision.md` ESCALATE | | rework budget exhausted |
| approve | spawns approver (fresh `decision.md`) | `DECISION: APPROVE` (and `approval.mode=auto` or human already approved) → deliver | `DECISION: ESCALATE`; `approval.mode=human` |
| deliver | `factory-cli deliver`: snapshot diff → direct merge (`--no-ff`, clean main checkout on base) or push + `gh pr create` | success → delivered (worktree removed if configured) | dirty/wrong-branch checkout, merge conflict (aborted), push/gh failure |

Human entry points: `approve` (needs-human → deliver, works as an override),
`rework --note` (writes `rework-k.md`, resets the budget, fresh builder),
`cancel [--purge]`, `tick --retry` (re-dispatch after an interrupted session).

QC follow-up: when a job ends (`delivered` or `needs-human`), tick/deliver
attach a `followUp` (background `factory-qc` agent) per `config.qc`:
`autoReview` (`off` | `needs-human` (default) | `all`) and `auditEvery`
(audit every N deliveries; default 5). `job.qcRequested` makes each outcome
reviewed once. The orchestrator launches it and doesn't wait.

Budgets: `maxRounds = maxReworkRounds + 1` (default 3). `agentRetries`
(default 1) per agent per round. The human rework resets `resumesUsed`.

## 3. How agents communicate

Agents **never talk to each other** and never share conversation. Every
hand-off is a file in `factory/jobs/<id>/` (main checkout) plus git commits
on the job branch (worktree):

```
spec-writer ──spec.md──────────────────────────────► builder, reviewers, approver
builder ─────commits (branch) + build.md ──────────► reviewers (via round-N/build.md), approver
reviewer-X ──round-N/review-X.md ──────────────────► builder (next round, via brief), approver, next round's reviewer-X
approver ────decision.md ──────────────────────────► tick → deliver / human
human ───────rework-k.md (via CLI) ────────────────► builder
tick ────────job.json (state) + brief (context) ───► everyone / dashboard
```

- The orchestrator only relays *pointers*: each spawn prompt is just "run
  `brief`". It never pastes content between agents.
- The builder is the only stateful agent: resumed via SendMessage across
  rounds (fallback: fresh spawn; the brief is sufficient). It answers
  findings in build.md's "Review responses" table, and reviewers verify that
  table next round.
- Reviewers see each other's work only through the builder's changes; they
  don't read other lenses' reviews. The approver reads all of them.

## 4. File contracts

| File | Writer | Machine-read part | Reader |
| --- | --- | --- | --- |
| `job.json` | CLI only | everything (schema `job.schema.json`) | tick, dashboard, qc |
| `spec.md` | spec-writer | "Acceptance criteria" + `ACn` ids | tick (validity), all agents |
| `build.md` | builder | line 1 `STATUS: READY\|BLOCKED`; line 2 = blocked reason | tick |
| `round-N/review-<lens>.md` | reviewer | line 1 `VERDICT: PASS\|CHANGES`; findings table `\| # \| severity \| location \| issue \| change \|` | tick, qc (severity parsing), builder, approver |
| `decision.md` | approver (or CLI on budget exhaustion: contains "Written by factory-cli") | line 1 `DECISION: APPROVE\|ESCALATE`; first Rationale bullet = dashboard reason | tick |
| `rework-k.md` | CLI from the human's note | — | builder |
| `setup.log`, `diff.patch`, `diffstat.txt`, `pr-body.md`, `build.prev.md` | CLI | — | humans, dashboard, qc |
| `factory/qc/assessments/<date>-<scope>.md` | factory-qc agent / skill | line 1 `HEALTH: GOOD\|WATCH\|ACT`; `Scope:`; `## Verdict` first line; findings `\| # \| high\|medium\|low \| …` | dashboard Insights (via `qc index`) |
| `factory/qc/proposals/<date>-<slug>.md` | QC (draft) → human-approved | `Status:` `Type:` `Scope:` `Applied:`; `## Success metric` first line | dashboard, QC |
| `factory/qc/journal.md` | `factory-cli qc journal` only | `## <date> · <status> · <slug>` | dashboard, QC |

Severity rule: **CHANGES iff ≥1 blocker/major finding**; minor/nit never
block. qc flags violations.

## 5. Invariants (changing one needs code changes + user sign-off)
1. Only the CLI writes `job.json`/`config.json`; every write is validated and atomic.
2. First-line markers in build/review/decision files and their exact vocabulary.
3. Agents write exactly one output file; reviewers, approver and spec-writer never modify code.
4. WAIT FOR ALL: no builder resume until every active lens has a verdict.
5. Bounded loops: rework cap + one retry per agent; then a human.
6. Communication through files only; the orchestrator relays pointers, not content.
7. Job state lives in the main checkout; code work only in the job's worktree; the main checkout is touched only by delivery, only when clean.
8. Delivery never force-pushes and never merges into a dirty or wrong-branch checkout.
9. A job's reviewer list is frozen at creation (toggles affect new jobs).

## 6. Agent roster facts

| Agent | Tools | Default model | Reads | Writes |
| --- | --- | --- | --- | --- |
| spec-writer | Read Grep Glob Bash Write | opus | feature, codebase, FACTORY.md | spec.md |
| builder | + Edit | opus | spec, reviews (resume), rework | commits, build.md |
| reviewer-code | Read Grep Glob Bash Write | sonnet | diff, spec, build, prev review | review-code.md |
| reviewer-security | same | opus | same | review-security.md |
| reviewer-ui-ux | same (+ browser via Bash, own port) | sonnet | same; browser or static mode | review-ui-ux.md |
| reviewer-database | same | opus | same | review-database.md |
| reviewer-architecture | same | sonnet | same | review-architecture.md |
| approver | same | opus | all of the above + sensitive paths list | decision.md |
| factory-qc | same (background, never edits the factory) | `config.qc.model` (opus) | `qc brief`, reports, traces, all artifacts | qc/assessments/*.md (+ proposal drafts) |

- `config.roles.*.model` overrides frontmatter at spawn time (`tick` passes `model`).
- Lenses are toggled by `/factory-init` evidence: UI → ui-ux, DB/ORM/migrations → database, multi-package → architecture. Code + security are always on.
- Ports: builder `base + stride·n`, ui-ux `+1`.

## 7. Extension points

| Want to… | Mechanism |
| --- | --- |
| Give an agent new expertise permanently | `skills:` list in the agent's frontmatter preloads the skill's **full** content at spawn (Claude Code feature; ≤32 skills; skills with `disable-model-invocation: true` can't be preloaded; missing skills are skipped with a debug-log warning). Our agents' `tools` allowlists omit `Skill`, so they **cannot** load skills on demand. Preloading is the controlled channel. |
| Add repo-specific checks for a lens | `FACTORY.md` → "Review focus → <lens>" (cheapest; every agent reads it) |
| Change an agent's behaviour | its `.claude/agents/<name>.md` body (paid on every spawn of that agent) |
| Change what agents output | `factory/templates/*.md`. Keep the markers, keep the findings table columns. |
| Add a review lens | `.claude/agents/reviewer-<lens>.md` + `config set roles.reviewers.<lens> {...}`; CLI, orchestrator and dashboard adapt automatically |
| Change policy | `config.json` via `factory-cli config set` (approval, budgets, delivery, escalatePaths, models) |
| Change loop mechanics | `factory/lib/tick.js` (+ schema, + tests). Highest blast radius. |
| Add evidence | `factory/lib/qc.js` |

Agent frontmatter also supports `effort`, `maxTurns`, `disallowedTools`,
`hooks`, `memory`, `permissionMode`. These are useful levers for cost
control and safety.

## 8. Cost model (tokens)
- Per job ≈ spec-writer + builder×rounds + Σ active lenses×rounds + approver.
  Each lens you enable multiplies by the round count, and each extra round
  re-runs every lens.
- Fixed per-spawn cost: agent body + preloaded skills + brief output +
  FACTORY.md + CLAUDE.md. A 2k-token skill preloaded into a reviewer costs
  ~2k × rounds × jobs.
- Variable cost: what the agent reads (diff, files) and writes. `qc trace`
  shows artifact sizes (bytes ≈ 4 × tokens); everything an agent writes is
  read by ≥1 downstream agent.
- Orchestrator cost is small by design: one JSON line per tick.

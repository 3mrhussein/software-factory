# Software Factory

A portable, self-configuring software factory for Claude Code. Drop it into
any repository, run `/factory-init` once, then hand it features:

```
/factory Add CSV export to the reports page
```

Agents write a spec, build it in an isolated git worktree, review it through
every lens that applies to your stack, rework until reviewers pass, and then
merge it or open a pull request. A live dashboard shows every job moving
through the loop.

```
feature ─► spec-writer ─► builder ─► [ reviewers… ] ─► WAIT FOR ALL ─► approver ─► deliver
                            ▲               │ any CHANGES                 │
                            └── resume ◄────┘ (max 2 reworks)             ├─ APPROVE ─► merge / PR
                                                                          └─ ESCALATE ─► needs you
```

Nothing in the package is tied to a language or framework. `/factory-init`
inspects the target repo and adapts: commands, branch conventions, and which
reviewers exist at all.

---

## Install into a repository

Requirements: **git**, **Node.js ≥ 18** (only for the zero-dependency CLI;
your project can be any language), and **Claude Code**. Optional: `gh`
(GitHub PR delivery) and a browser CLI such as
[`agent-browser`](https://github.com/vercel-labs/agent-browser) or Playwright
(visual UI review).

**Option A: installer** (preserves files you've customised on re-install):

```bash
node /path/to/software-factory/factory/bin/factory-cli.js install /path/to/your-repo
```

**Option B: copy**: copy `.claude/` and `factory/` into your repo root
(merge `.claude/` if you already have one).

Then, inside your repo:

```bash
git add .claude factory && git commit -m "chore: add software factory"
claude
```

```
/factory-init
```

`/factory-init` scans the repo and reports what it found, asks you only what
it can't infer (PR vs. local merge, auto-approve vs. human sign-off), writes
`factory/config.json` and `factory/FACTORY.md`, and runs a health check.
Commit the result. Re-run it whenever your stack changes; it keeps your
manual choices.

## Use it

| Command | What happens |
| --- | --- |
| `/factory <feature>` | Runs a new job end to end in its own worktree |
| `/factory next` | Takes the first open item from `factory/backlog.md` |
| `/factory status [job]` | Board summary or one job's history |
| `/factory approve <job>` | Delivers a job waiting for you (overrides an ESCALATE) |
| `/factory rework <job> <note>` | Sends a job back to a fresh builder with your feedback |
| `/factory retry <job>` | Re-dispatches the current step (e.g. after closing the session) |
| `/factory cancel <job>` | Stops a job (`--purge` also deletes its worktree and branch) |
| `/factory prune` | Removes worktrees of finished jobs |
| `/factory dashboard` | Starts the live dashboard |
| `/factory-qc` | Quality-control expert: audits, post-mortems, evaluates skills you bring (see below) |

`<job>` is the full id (`004-rate-limit-login`) or just its number (`4`).

**Parallel jobs:** open several Claude Code sessions in the repo and run
`/factory` in each. Job ids are claimed atomically, each job has its own
worktree (`../<repo>-factory/<job-id>`), branch, dev-server ports and state
file, so jobs never collide. Your own checkout is never touched until
delivery.

## The dashboard

```bash
node factory/bin/factory-cli.js serve          # http://127.0.0.1:4317/dashboard/
```

- Kanban board: Backlog → Spec → Build → Review → Approve → Needs you → Done.
  Cards glide between columns as `job.json` changes, pushed over
  Server-Sent Events.
- Reviewer chips per job show **only the lenses active in this repo**
  (from `config.json`), filling in live: pending → ✓ PASS / ! CHANGES.
- Detail drawer: overview with a round-by-round verdict grid and timeline,
  rendered spec / build / reviews / decision, a diff viewer, and every raw
  file. Deep links: `#/job/<id>/<tab>`.
- Search, view filters (Active / Needs you / Done), "changes requested by"
  filter, backlog editing, light/dark themes, mobile layout.
- **Insights** tab: KPIs, growth charts and QC verdicts (see Quality control).

No build step and no `npm install`: React 18 + [htm](https://github.com/developit/htm)
load as plain scripts from a pinned CDN. For offline/air-gapped use, run
`node factory/bin/factory-cli.js vendor` once (downloads the four pinned files
into `factory/dashboard/vendor/`) and commit them. Any static server also
works in read-only mode: `cd factory && python3 -m http.server`.

## Quality control: a background agent, an expert skill, and Insights

QC has two halves sharing one knowledge base (architecture, state machine,
file contracts, how agents hand work to each other, invariants, extension
points, cost model):

- **`factory-qc` agent** (`.claude/agents/factory-qc.md`): runs unattended.
  When a job ends, the loop launches it in the background according to
  `config.qc`. By default it post-mortems every job that needed you and
  audits the whole factory every 5 deliveries. It writes a
  **HEALTH-rated assessment** (GOOD / WATCH / ACT) with evidence, findings
  and draft proposals. It never changes the factory.
- **`/factory-qc` skill**: the expert you talk to.

| You say | It does |
| --- | --- |
| `/factory-qc` | Audits from evidence: `qc check` → `qc report` → the artifacts behind each signal → ranked, evidence-cited proposals |
| `/factory-qc job 7` | Post-mortem of one job |
| `/factory-qc skill <path/url/paste>` | Intake of a skill another developer used: safety scan, essence, 40-point rubric, **which agent and mechanism** (FACTORY.md focus, agent prompt, preloaded `skills:`, new lens, template, CLI), pros/cons, whole-loop impact and token cost, adapted version |
| `/factory-qc propose <idea>` | Traces an idea through every stage and contract and writes a proposal |
| `/factory-qc apply <proposal>` | Applies an approved proposal, verifies with `qc check` (+ tests), journals it |
| `/factory-qc impact <proposal>` | Before/after metrics: keep, tune or revert |

- **Insights** (dashboard → *Insights* tab): range filter (7/30/90 days/all);
  the latest QC verdict; KPI tiles with trend sparklines (delivered,
  first-pass rate, rounds per job, autonomy, lead time, needs-you); animated
  charts that grow with the system (cumulative throughput, rolling first-pass
  rate, reviewer pushback by lens, why humans were needed, time per stage,
  artifact size ≈ tokens, hotspots), each with a table view; the QC
  assessment feed, proposals by status, signals, contract violations and
  the journal. Job drawers show that job's QC post-mortem. Updates live.

Tune the background agent:

```bash
node factory/bin/factory-cli.js config set qc '{"autoReview":"all","auditEvery":5,"model":"opus"}'   # or "needs-human" / "off"
```

QC memory lives in `factory/qc/` (`assessments/`, `proposals/`, `journal.md`).
Commit it. It's the history of how your factory was tuned and why.

Evidence tools you can also run directly:

```bash
node factory/bin/factory-cli.js qc report --since 30   # process metrics + signals
node factory/bin/factory-cli.js qc trace 7             # one job, step by step
node factory/bin/factory-cli.js qc check               # agents ↔ config ↔ templates ↔ skills lint
node factory/bin/factory-cli.js qc index               # refresh qc/index.json + report.json (static dashboards)
```

---

## How it works

### Deterministic core, LLM at the edges
Agents never hand-write JSON. `factory/bin/factory-cli.js` (Node built-ins
only) is the **only** writer of factory state:

- `tick <job>` is the whole loop as a state machine. It reads the agents'
  output files, records verdicts, enforces the rework budget, and returns the
  next action as one line of JSON (`spawn` agents, `resume` the builder,
  `run` a command, `halt` for a human, `done`). The orchestrator just
  executes it.
- `brief <job> <role>` gives an agent everything in one call: paths,
  commands, inputs to read, rules, its output path and a pre-filled template.
  No exploration of the factory itself, no context pasted through prompts.
- Every write is schema-validated (`factory/schema/*.json`) and atomic
  (temp file + rename), so the dashboard never sees a broken file.

This keeps orchestration cheap (one short command per transition) and makes
loop behaviour testable (`tests/` covers it end to end).

### Files as the interface
Agents communicate only through files in `factory/jobs/<job-id>/`:

```
job.json               state (CLI-only), drives the dashboard
spec.md                spec-writer        acceptance criteria AC1…
build.md               builder            first line: STATUS: READY | BLOCKED
round-N/build.md       snapshot of the build that round N reviewed
round-N/review-<lens>.md  reviewer        first line: VERDICT: PASS | CHANGES
decision.md            approver           first line: DECISION: APPROVE | ESCALATE
rework-K.md            your /factory rework notes
setup.log, diff.patch, pr-body.md        CLI artefacts
```

`factory/jobs/` is gitignored runtime state (it has its own `.gitignore`).

### Adaptive roster

| Agent | Active when | Model |
| --- | --- | --- |
| `spec-writer` | always | opus |
| `builder` | always | opus |
| `reviewer-code` | always | sonnet |
| `reviewer-security` | always | opus |
| `reviewer-ui-ux` | the repo has a user-facing UI (browser mode if a browser CLI exists, else static) | sonnet |
| `reviewer-database` | a schema, ORM, migrations or DB rules exist | opus |
| `reviewer-architecture` | monorepo / multi-package workspace | sonnet |
| `approver` | always | opus |
| `factory-qc` | background, per `config.qc` (outside the loop) | opus |

Override anything:

```bash
node factory/bin/factory-cli.js roles                     # list
node factory/bin/factory-cli.js roles enable architecture --reason "shared core package"
node factory/bin/factory-cli.js roles disable ui-ux --reason "internal CLI"
node factory/bin/factory-cli.js roles model reviewer-code opus
```

Toggles apply to new jobs; each job freezes its reviewer list at creation.

**Giving an agent a skill**: add `skills: [<name>]` to its frontmatter to
preload `.claude/skills/<name>/SKILL.md` at spawn (agents can't load skills
on demand; `Skill` isn't in their tool allowlists). Let `/factory-qc skill …`
decide which agent and whether a lighter mechanism is enough.

**Adding your own lens**: create `.claude/agents/reviewer-<lens>.md` (copy
an existing reviewer), then
`node factory/bin/factory-cli.js config set roles.reviewers.<lens> '{"enabled":true,"model":"sonnet","reason":"…"}'`.
The CLI, orchestrator and dashboard pick it up automatically.

### Safety rails
- Rework is capped (`loop.maxReworkRounds`, default 2 → max 3 review rounds),
  then the job escalates with a CLI-written `decision.md`.
- An agent that finishes without a valid output file is retried once
  (`loop.agentRetries`), then the job goes to you.
- `READY` with zero commits, `BLOCKED`, a failed setup, a merge conflict or a
  dirty main checkout all stop at **Needs you**. Nothing is forced.
- The approver escalates when a job touches `approval.escalatePaths` (CI,
  infra, migrations, env files by default) or anything listed under "Always
  escalate" in `FACTORY.md`. Set `approval.mode` to `human` to sign off every
  job yourself.
- Delivery never force-pushes and never merges into a checkout that is dirty
  or on another branch.

## Configuration reference

`factory/config.json` (validated by `factory/schema/config.schema.json`;
change it with `factory-cli config set <path> <value>`):

| Key | Meaning |
| --- | --- |
| `commands.{setup,build,test,lint,typecheck,format,dev}` | Run from a worktree root. `dev` may use `{port}` |
| `git.baseBranch`, `git.branchPattern` (`factory/{id}`), `git.worktreeRoot` (`../{repo}-factory`) | Branching |
| `git.commitStyle` | `conventional` or `free` (detected from history) |
| `delivery.strategy` | `direct-merge` or `github-pr`; `draftPr`, `removeWorktreeAfterDelivery` |
| `approval.mode`, `approval.escalatePaths`, `approval.notes` | Approval policy |
| `loop.maxReworkRounds`, `loop.agentRetries`, `loop.setupTimeoutSec` | Loop limits |
| `ports.base`, `ports.stride` | Per-job dev-server ports (job n → base + stride·n) |
| `roles.*` | Models and reviewer toggles |
| `qc.autoReview`, `qc.auditEvery`, `qc.model` | When the background QC agent runs |

`factory/FACTORY.md` is the human-readable repo profile every agent reads:
an auto-generated block (stack, commands, git, active reviewers) plus sections
`/factory-init` writes for you to edit: conventions, per-lens review focus,
and "Always escalate".

## CLI reference

```bash
node factory/bin/factory-cli.js help
```

## Package layout

```
.claude/
  skills/factory/SKILL.md          /factory: orchestrator (executes tick actions)
  skills/factory-init/SKILL.md     /factory-init: investigate, configure, toggle roles
  skills/factory-qc/               /factory-qc: QC lead + references/ knowledge base
  agents/*.md                      9 agents (spec-writer, builder, 5 reviewers, approver, factory-qc)
factory/
  bin/factory-cli.js               the CLI (zero dependencies)
  lib/                             detect, tick state machine, worktrees, delivery, server…
  schema/                          JSON Schemas for config.json and job.json
  templates/                       spec / build / review / decision / rework / PR / FACTORY.md
  dashboard/                       React dashboard (no build step)
  config.json                      defaults until /factory-init runs
  backlog.md                       feature queue for /factory next
  jobs/                            runtime state (gitignored)
  qc/                              QC journal + proposals (committed)
tests/                             end-to-end tests + demo board (not installed)
```

## Developing the factory

```bash
node --test tests/factory.test.js     # end-to-end: detection, loop, delivery, server
node tests/demo.js                    # throwaway repo with jobs in every stage + live dashboard
```

# Change playbook: where changes live, how to apply, how to remember

## Where changes live

| Change | Files | Blast radius | Verify with |
| --- | --- | --- | --- |
| Repo-specific checks / conventions | `factory/FACTORY.md` (outside the AUTO block) | this repo, all agents | read-through; next jobs |
| Agent behaviour | `.claude/agents/<name>.md` | every spawn of that agent | `qc check`; a trial job |
| Preloaded expertise | agent frontmatter `skills:` + `.claude/skills/<skill>/SKILL.md` | every spawn of that agent | `qc check` (resolves skills); trial job |
| Output structure | `factory/templates/*.md` | every job | `qc check` (markers); `node --test tests/` in the factory source repo |
| Policy, budgets, models, toggles | `factory-cli config set` / `roles` | new jobs | `factory-cli doctor`; `qc check` |
| New review lens | `reviewer-<lens>.md` + `config set roles.reviewers.<lens> '{"enabled":true,"model":"sonnet","reason":"…"}'` + FACTORY.md focus section | new jobs (+1 agent per round) | `qc check`; trial job |
| Orchestration rules | `.claude/skills/factory/SKILL.md` | every run | trial job |
| Loop mechanics / state / CLI | `factory/lib/*.js`, `factory/schema/*` | everything | `node --test tests/` (factory source repo) + `qc check` + trial job |
| Evidence/metrics | `factory/lib/qc.js` | QC only | `qc report` on real data |

Package vs. repo: if the improvement is stack-agnostic, it belongs in the
**factory source repo** (so every install gets it on the next
`factory-cli install --force`). If it's specific to this codebase, keep it in
this repo's FACTORY.md / config. Say which, and remind the user that a
re-install with `--force` overwrites local edits to agents, skills and
templates.

## Apply procedure (approved proposals only)
1. Re-read the proposal and the current files; make sure nothing drifted.
2. Make exactly the listed edits. Config via the CLI, never by hand.
3. `factory-cli qc check` must be free of errors. In the factory source repo also run `node --test tests/`.
4. If the change affects agent behaviour, suggest a trial: one small backlog item through `/factory`, then `/factory-qc job <id>`.
5. Update the proposal: `Status: applied`, `Applied: <date>`, and what was verified.
6. Journal entry (below). Tell the user the commit to make; don't push unless asked.

Rollback: every proposal lists its inverse (revert the edit / `config set` back / `roles disable`). Record rollbacks in the journal too.

## Proposal format (`factory/qc/proposals/<YYYY-MM-DD>-<slug>.md`)

```markdown
# <title>
Status: proposed | approved | applied | measured | reverted | rejected
Type: prompt | template | config | lens | skill | code | profile
Scope: package (all repos) | this repo

## Problem & evidence
<metrics, job ids, file paths>

## Hypothesis
If we <change>, then <metric> will <move> because <mechanism>.

## Change
<exact edits: diff blocks, CLI commands, new files>

## Impact
Agents affected · downstream readers · loop dynamics · ~token cost/job · invariants touched · portability

## Risks & mitigations

## Success metric & check-back
<metric, target, after N jobs or date>

## Rollback
<inverse steps>
```

## Journal format (`factory/qc/journal.md`)
Append-only, newest at the bottom, one block per event:

```markdown
## 2026-10-12 · proposed · tighten-security-severity
Signal: 4 contract violations (security CHANGES without blocker/major) in 12 jobs.
Proposal: proposals/2026-10-12-tighten-security-severity.md

## 2026-10-12 · applied · tighten-security-severity
Verified: qc check ok. Measure: contractViolations after 10 jobs.

## 2026-10-20 · measured · tighten-security-severity
Result: violations 4 → 0 over 11 jobs; first-pass 45% → 58%. Keep.
```

Statuses: `observed` (noted, no action), `proposed`, `rejected` (with reason, so it isn't re-proposed blindly), `applied`, `measured`, `reverted`.

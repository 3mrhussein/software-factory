# Evidence: what to measure and how to read it

## Sources (most to least structured)
1. `factory-cli qc report [--since N]`: aggregates over all `job.json` files and review artifacts.
2. `factory-cli qc trace <job>`: one job's timeline with gaps (Δ), blocker/major findings per round, artifact sizes, retries.
3. `factory-cli qc check`: definition lint (agents ↔ config ↔ templates ↔ skills).
4. Artifacts in `factory/jobs/<id>/`: the actual text. Always read these before concluding.
5. Git: `git log`/`git show` on job branches or merge commits for what was really built.
6. `factory/qc/journal.md`: what changed when (for before/after comparisons).

Job folders are gitignored runtime state. If the user prunes or deletes them,
evidence is gone; suggest archiving before large clean-ups.

## Metric dictionary (`qc report`)

| Metric | Meaning | Healthy range* |
| --- | --- | --- |
| `flow.firstPassRatePct` | % of reviewed jobs where round 1 was all PASS | 40–80%. Below: builder/spec gaps. Near 100% with many lenses: reviewers may be rubber-stamping |
| `flow.avgRounds` | review rounds per reviewed job | 1.2–1.8 |
| `flow.deliveredWithoutHuman` vs `delivered` | autonomy | depends on `approval.mode` |
| `flow.builderResumes`, `flow.humanReworks` | rework volume | humanReworks ≫ 0: the loop passes things humans reject, so review is missing something |
| `flow.medianLeadTimeMin` | job created → delivered | trend matters more than absolute |
| `lenses.<l>.changesRatePct` | how often a lens blocks | 10–40% |
| `lenses.<l>.findings` | severity counts | many nits: noisy prompt; many blockers: upstream gap |
| `lenses.<l>.unresolvedAtEscalation` | lens still CHANGES when the budget ran out | >1 = builder/reviewer disagreement or impossible demand |
| `agents.retries`, `agents.invalidOutputs` | output-contract failures | ~0 |
| `approver` APPROVE/ESCALATE/humanOverrides | gate behaviour | overrides ≫ 0: gate too conservative |
| `needsHuman` by cause | why humans got pulled in | see table below |
| `stageMinutes` | median/max time per stage | outliers → trace them |
| `artifactBytes` | output size per artifact kind (≈ tokens×4) | specs > ~3k tokens or reviews > ~2k tokens are expensive to every reader |
| `hotspots` | files with the most blocker/major findings | recurring file: missing convention in FACTORY.md |
| `contractViolations` | CHANGES without blocker/major, PASS with blocker/major | 0 |

*Ranges are heuristics for a working factory with ≥10 jobs. With fewer jobs, report counts, not rates.

## Symptom → likely cause → where to fix

| Symptom | Likely cause | Fix location (cheapest first) |
| --- | --- | --- |
| One lens dominates CHANGES | builder doesn't know that lens's standards | FACTORY.md review focus (builder reads it too) → builder prompt "before you finish, self-check against …" |
| Same finding re-appears next round | builder didn't understand / disagrees | review template "Required change" more concrete; builder must answer each finding in Review responses |
| Rework budget exhausted on one lens | reviewer demands out-of-scope work | reviewer prompt: judge against spec scope; scope creep is the spec's job |
| Lens never blocks over many jobs | low value or shallow checklist | sharpen focus, cheaper model, or disable |
| Contract violations | prompt doesn't stress the severity rule | reviewer prompt + review template guidance |
| Invalid/missing outputs, retries | agent ran out of turns, wrote elsewhere, wrong first line | brief clarity, `maxTurns`/`effort` in frontmatter, template first line |
| READY with no commits | builder wrote build.md before committing | builder prompt ordering ("write build.md LAST") |
| Many BLOCKED | spec ambiguity or missing credentials/env | spec-writer assumptions section; setup command (env files) |
| Approver escalates, human always approves | escalatePaths too broad / "Always escalate" too long | config `approval.escalatePaths`, FACTORY.md |
| Humans rework delivered/approved jobs | the loop is blind to something humans check | add focus/lens/acceptance-criteria rule for that thing |
| Setup slow | full installs per worktree | faster `commands.setup` (frozen lockfile, cache) |
| Long review stage | browser mode, big diffs, slow tests | scope specs smaller; reviewers run targeted tests |
| Huge artifacts | verbose templates or prompts | tighten template sections, "be concise" with limits |

## Reading artifacts critically
- **Spec**: are ACs testable and few? Are assumptions explicit? Do "Affected areas" point at real files?
- **Build**: does each AC have evidence (a test name or command output), or just "done"? Are validation results real?
- **Reviews**: is each finding located (`path:line`) and actionable? Is the verdict consistent with severities? Did round N+1 actually verify round N's findings?
- **Decision**: does the rationale cite evidence, or restate the reviews?
- **Cross-lens overlap**: two lenses reporting the same issue means duplicated cost. Clarify ownership in the prompts ("other reviewers cover the rest").

## Before/after measurement
Use `--since` windows around the `applied` date in the journal. Compare
the proposal's success metric on comparable job counts. Fewer than ~5 jobs
per side is anecdotal; say so.

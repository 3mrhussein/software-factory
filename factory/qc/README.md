# factory/qc/

Memory of the factory's quality-control lead (`/factory-qc`). Commit this
folder: it's the history of how your factory was tuned and why.

- `assessments/`: HEALTH-rated verdicts (GOOD / WATCH / ACT) from the `factory-qc` agent and `/factory-qc`.
- `journal.md`: append-only log (write it with `factory-cli qc journal`) of observations, proposals, decisions and measured results.
- `proposals/`: one file per change (problem, evidence, hypothesis, exact change, impact, success metric, rollback).

Evidence tools: `node factory/bin/factory-cli.js qc report | qc trace <job> | qc check | qc index`.
The dashboard's **Insights** tab shows all of it. `index.json` / `report.json` are derived (gitignored).

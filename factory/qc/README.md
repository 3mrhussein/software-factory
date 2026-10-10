# factory/qc/

Memory of the factory's quality-control lead (`/factory-qc`). Commit this
folder: it's the history of how your factory was tuned and why.

- `journal.md`: append-only log of observations, proposals, decisions and measured results.
- `proposals/`: one file per change (problem, evidence, hypothesis, exact change, impact, success metric, rollback).

Evidence tools: `node factory/bin/factory-cli.js qc report | qc trace <job> | qc check`.

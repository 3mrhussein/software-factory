# factory/

Runtime home of the software factory in this repository.

- **First time:** open Claude Code here and run `/factory-init`.
- **Build a feature:** `/factory <feature>`, or add it to `backlog.md` and run `/factory next`.
- **Watch:** `node factory/bin/factory-cli.js serve` → http://127.0.0.1:4317/dashboard/
- **Everything else:** `node factory/bin/factory-cli.js help`

| Path | What it is | Edit? |
| --- | --- | --- |
| `config.json` | Commands, git, delivery, approval policy, reviewer toggles | via `factory-cli config set` / `roles` |
| `FACTORY.md` | Repo profile every agent reads | yes, outside the AUTO block |
| `backlog.md` | Feature queue (`- [ ] item`) | yes |
| `templates/` | Structure of spec / build / review / decision files | yes, carefully: keep the first-line markers |
| `jobs/` | Per-job state and agent output (gitignored) | no |
| `bin/`, `lib/`, `schema/`, `dashboard/` | Factory code | no (replaced on upgrade) |

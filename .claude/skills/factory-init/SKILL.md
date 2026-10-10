---
name: factory-init
description: Initialize or re-tune the software factory for the current repository. Use when the user types /factory-init (optionally with --reset), after copying the factory into a new repo, or when the stack changed (new frontend, database, packages). Detects language, package manager, commands, monorepo, UI and database; toggles reviewer roles; writes factory/config.json and factory/FACTORY.md.
---

# /factory-init: adapt the factory to this repo

You investigate this repository and configure the factory so every agent
knows how to set up, build, test and review it. Mechanical work (detection,
config writes, profile rendering) is done by the CLI. You verify its findings,
fill the gaps it cannot know, and write the human-level guidance.

```
CLI = node <repo>/factory/bin/factory-cli.js     (<repo> = git rev-parse --show-toplevel)
```

## 1. Preconditions
- `git rev-parse --show-toplevel` must succeed. If the repo has no commits,
  tell the user to make an initial commit first and stop.
- `factory/bin/factory-cli.js` and `.claude/agents/` must exist. If not, the
  package wasn't copied in. Point to the README's install step and stop.

## 2. Detect
Run `$CLI init detect`. It reports languages, package managers, frameworks,
monorepo layout, frontend kind, database tech, proposed commands, git
conventions, available tools (gh, browser CLI) and CI hints, plus a
`suggestion` for reviewer toggles and delivery.

## 3. Verify (read, don't guess)
Check the report against the repo. Read the files that decide each fact:
manifest scripts, Makefile/justfile, CI workflows, README/CONTRIBUTING,
CLAUDE.md/AGENTS.md. Specifically:
- **Commands**: prefer what CI actually runs. Each command must work from a
  fresh worktree root. `setup` must install everything the others need
  (deps, codegen like `prisma generate`, env file copies such as
  `cp .env.example .env`). For `dev`, make the port configurable with
  `{port}` (e.g. `npm run dev -- --port {port}`, `PORT={port} …`).
- **UI**: is there really a user-facing UI? An admin-only template or a docs
  site may not warrant the ui-ux reviewer.
- **Database**: real persistence (schema/ORM/migrations/rules), not just a
  client library used in one script.
- **Monorepo**: is cross-package impact a real risk? Then keep architecture on.
- **Base branch and delivery**: `github-pr` needs gh authenticated and a
  GitHub remote; otherwise `direct-merge`.

## 4. Ask only what you can't infer
Use AskUserQuestion once, combining at most these (skip any you're sure of):
- Delivery: open a GitHub PR per job, or merge locally into the base branch?
- Approval: auto-deliver when the approver says APPROVE, or always stop for
  a human sign-off (`approval.mode = human`)?
- Anything genuinely ambiguous from step 3 (e.g. which of two apps is "the" UI).

## 5. Apply
```
$CLI init apply --delivery <github-pr|direct-merge> [--base <branch>] [--guidance CLAUDE.md|AGENTS.md|none] [--reset]
```
Then correct anything step 3 found, one command each:
```
$CLI config set commands.test "pnpm -r test"
$CLI config set commands.setup "pnpm install --frozen-lockfile && pnpm prisma generate"
$CLI config set approval.mode human
$CLI config set approval.escalatePaths '[".github/**","**/migrations/**","infra/**"]'
$CLI roles disable ui-ux --reason "CLI tool, no UI"
$CLI roles enable architecture --reason "3 apps share packages/core"
$CLI roles enable ui-ux --mode static --reason "React app; no browser CLI installed"
$CLI init profile        # re-render FACTORY.md's AUTO block after config changes
```
Never edit `config.json` by hand; the CLI validates every change against the
schema.

## 6. Write the profile
Edit `factory/FACTORY.md`. Leave the AUTO block alone and replace every
`TODO(/factory-init)`:
- **Project summary**: what it is, who uses it (2–3 sentences).
- **Conventions**: what you observed in the code: layout, naming, error
  handling, where tests live and how they're written, state management,
  styling system, i18n. Short bullets with example paths.
- **Review focus**: per *active* lens, 3–6 repo-specific checks (e.g.
  security: "all API routes go through `withAuth` in `src/server/auth.ts`";
  database: "migrations via `pnpm db:migrate:create`, never edit applied ones").
- **Always escalate**: repo-specific triggers (payments, auth, billing,
  public API, infra, data deletion…).

## 7. Doctor
Run `$CLI doctor`. Fix every `✗`. For `!` warnings, fix what you can and list
the rest for the user. Optionally `$CLI doctor --run lint,test` to prove the
commands work (ask first if the test suite looks slow or needs services).

## 8. Report
Show a compact summary: stack, commands, active/inactive reviewers with
reasons, delivery, approval mode, and remaining warnings. Then tell the user:
- Commit the factory setup (`.claude/`, `factory/`, the guidance file).
  Offer to do it; a dirty `factory/config.json` blocks direct-merge delivery.
- Add features with `/factory <feature>` or queue them in `factory/backlog.md`
  and run `/factory next`.
- Watch progress with `/factory dashboard` (or `node factory/bin/factory-cli.js serve`).

Re-running `/factory-init` later is safe: it keeps manual choices and
re-enables reviewers when new evidence appears (e.g. a database was added).
`--reset` re-derives everything from scratch.

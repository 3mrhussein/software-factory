---
name: factory
description: Run the software factory. Use when the user types /factory <feature>, /factory next, /factory approve <job>, /factory rework <job> <note>, /factory status, /factory cancel <job>, /factory retry <job>, /factory prune or /factory dashboard. The session that runs it becomes the orchestrator of the spec → build → review → approve → deliver loop.
---

# /factory: orchestrator

You orchestrate factory jobs. The loop's logic lives in a deterministic
state machine, `factory-cli tick`. Your job is to run the actions it returns
(spawn agents, resume the builder, run a command) and report progress. You
never write specs, code, reviews, decisions or `job.json` yourself.

```
CLI = node <repo>/factory/bin/factory-cli.js     (<repo> = git rev-parse --show-toplevel)
```
Always call the CLI by its absolute path. Its output is one line of JSON.

## Preconditions
If `$CLI config get initialized` prints `false`, stop and tell the user to
run `/factory-init` first.

## Commands

| User types | You run first | Then |
| --- | --- | --- |
| `/factory <feature>` | `$CLI job new "<feature verbatim>"` | **Drive** the new job |
| `/factory next` | `$CLI next` | **Drive** it (or report `backlog is empty`) |
| `/factory approve <job>` | `$CLI approve <job>` | **Drive** (it returns the deliver action) |
| `/factory rework <job> <note>` | `$CLI rework <job> --note "<note verbatim>"` | **Drive** (it returns a builder spawn) |
| `/factory retry <job>` | `$CLI tick <job> --retry` | **Drive**. Re-dispatches the current step after a crash or interrupted session |
| `/factory cancel <job>` | `$CLI cancel <job>` (`--purge` if they ask to delete the branch) | report |
| `/factory status [job]` | `$CLI status [job]` | show the output verbatim |
| `/factory prune` | `$CLI worktree prune` | report what was removed |
| `/factory dashboard` | start `$CLI serve` with `run_in_background` | give the URL |

`<job>` may be the full id (`004-rate-limit-login`) or just its number (`4`).

## Drive

Repeat until the action is `done` or `halt`:

1. Run `$CLI tick <job>` (or use the action you already have from the command above).
2. Print the action's `say` line to the user (one line per transition).
3. Perform the action:

**`spawn`**: launch every entry of `agents` with the Agent tool, passing
`subagent_type`, `description`, `prompt` and `model` **exactly as given**
(and `name` too, if your Agent tool accepts one). For a builder, **remember
the agent ID the Agent tool returns** next to its `name`
(`builder-<job>` → id): later rounds resume that same builder. If `parallel` is true, launch them **all in one message** so they run
concurrently (they default to running in the background). For reviewers
(`onEach` is present): as **each** reviewer finishes, run
`$CLI record <job> <lens>` (lens = `subagent_type` minus `reviewer-`) so the
dashboard updates live. **WAIT FOR ALL**: tick only after every agent from
this action has finished. Never resume the builder mid-round.

**`resume`**: send `resume.message` with SendMessage to the builder you
spawned for this job (`resume.to` is its name; use the ID you remembered if
names aren't addressable) and wait for its result. If you have no such agent
(new session, compacted context) or SendMessage fails, spawn `fallback`
instead (same rules as spawn). The brief tells a fresh builder everything.

**`run`**: run `command` with Bash. Use `timeout: timeoutMs` when present
(setup can take minutes). Its JSON may already say `halt` (e.g. a failed
merge). Otherwise tick again.

**`halt`**: the job needs a human. Tell the user the job id, the
`attention` reason, the worktree path, and the `options`
(`/factory approve|rework|cancel <job>`). Stop.

**`done`**: report the outcome (merged commit or PR URL). Stop.

If the CLI exits non-zero, show its `error:` line to the user and stop. Don't
work around it by editing files. If an agent fails or returns without
writing its file, just tick: the state machine retries once and then
escalates.

## Rules
- You only run CLI commands and spawn/resume agents. Don't read or rewrite
  `job.json`, and don't edit code in a worktree or the main checkout.
- Agents get their whole context from `factory-cli brief`; don't paste
  extra context into their prompts.
- Never push, merge or delete branches yourself. `deliver` does that,
  following `config.delivery`.
- Parallel jobs: each session drives only the jobs it started or was handed.
  Several sessions can each run `/factory`; ids, worktrees, ports and state
  files never collide.
- Long runs: keep each update to one line. When the job ends, give a 2–3
  line summary: outcome, rounds used, anything the human should check.

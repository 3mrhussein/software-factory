#!/usr/bin/env node
'use strict';
// factory-cli: the only writer of factory state. Zero dependencies (Node >= 18).
// Agents call one-line commands here instead of hand-editing JSON.

const path = require('path');
const lib = (m) => require(path.join(__dirname, '..', 'lib', m));
const { FactoryError, die, paths } = lib('util');

const HELP = `factory-cli: deterministic state & tooling for the software factory

Loop (used by the /factory orchestrator)
  job new "<feature>" [--slug s]      create a job (atomic id), prints it
  next                                claim the first open backlog item as a job
  tick <job> [--retry]                advance the state machine; prints the next action
  setup <job>                         run commands.setup in the job's worktree
  record <job> <lens>                 read round-N/review-<lens>.md, store the verdict
  deliver <job>                       merge or open a PR (per config.delivery)
  approve <job>                       human sign-off for a needs-human job → deliver
  rework <job> --note "<text>"        human feedback → fresh builder run
  cancel <job> [--purge]              stop a job (--purge removes worktree + branch)

Agents
  brief <job> <role>                  everything a role needs (role: spec-writer, builder,
                                      reviewer-<lens>, approver)
  render <spec|build|review|decision> <job> [--lens l]   print a pre-filled template
  diff <job> [--stat]                 the job's diff against its base

State
  status [job]                        board summary, or one job's details
  job list | job show <job>           JSON
  set-stage <job> <stage> [--round n] [--note t]   manual override (validated)
  set-verdict <job> <lens> <PASS|CHANGES|pending>  manual override
  error <job> "<message>"             mark a job needs-human with an error
  validate                            schema-check config.json and every job.json

Setup
  init detect                         scan the repo, print the detection report
  init apply [--delivery github-pr|direct-merge] [--base b] [--branch-pattern p]
             [--guidance CLAUDE.md|AGENTS.md|none] [--reset]
  init profile                        re-render the AUTO block of factory/FACTORY.md
  config get [path] | config set <path> <value>
  roles [list] | roles enable|disable <lens> [--reason r] [--mode browser|static]
  roles model <role|lens> <opus|sonnet|haiku|fable|inherit>
  doctor [--run test,lint]            check tools/commands (optionally run them)
  backlog [list] | backlog add "<text>" | backlog remove <n>
  worktree list | worktree create <job> | worktree remove <job> [--force] [--delete-branch]
  worktree prune [--all]              remove worktrees of finished jobs

Quality control (used by /factory-qc)
  qc report [--since <days>] [--json]   process metrics + heuristic signals from all jobs
  qc trace <job>                        one job's timeline, findings and artifact sizes
  qc check                              lint agents, skills, templates, config contracts
  qc series [--since <days>]            time series for growth charts
  qc brief [--job <job>]                context + template for the factory-qc agent
  qc journal <status> <slug> "<text>"   append to factory/qc/journal.md
  qc index                              refresh qc/index.json + report.json (dashboard)

Dashboard & distribution
  serve [--port 4317] [--host 127.0.0.1]   live dashboard at /dashboard/
  vendor                              download pinned React/htm/marked for offline use
  install <target-dir> [--force] [--dry-run]   copy the factory into another repo

Output is compact JSON for machine commands; add --pretty to indent it.`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) pos.push(a);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[m[1]] = argv[++i];
    else flags[m[1]] = true;
  }
  return { pos, flags };
}

const BOOL_FLAGS = new Set(['retry', 'purge', 'pretty', 'stat', 'force', 'dry-run', 'delete-branch', 'all', 'reset', 'json']);

async function main() {
  const raw = process.argv.slice(2);
  const { pos, flags } = parseArgs(raw);
  // Boolean flags never swallow a following positional.
  for (const f of BOOL_FLAGS) {
    if (typeof flags[f] === 'string') {
      pos.push(flags[f]);
      flags[f] = true;
    }
  }
  const [cmd, ...args] = pos;
  const out = (v) => {
    if (typeof v === 'string') return console.log(v);
    console.log(flags.pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
  };

  const jobs = () => lib('jobs');
  const config = () => lib('config');
  const tick = () => lib('tick');

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return out(HELP);

    // ------------------------------------------------------------ loop
    case 'job': {
      const [sub, ...rest] = args;
      if (sub === 'new') {
        const job = jobs().create(rest.join(' '), { slug: flags.slug });
        return out({ job: job.id, branch: job.branch, worktree: job.worktree, reviewers: job.reviewers, next: `node ${paths().cli} tick ${job.id}` });
      }
      if (sub === 'list') return out(jobs().listIds().map((id) => { const j = jobs().load(id); return { id, stage: j.stage, round: j.round, reviews: j.reviews, feature: j.feature }; }));
      if (sub === 'show') return out(jobs().load(rest[0]));
      return die('usage: job new "<feature>" | job list | job show <job>');
    }
    case 'next': {
      const job = lib('backlog').claim();
      if (!job) return out({ action: 'done', say: 'backlog is empty: no open items' });
      return out({ job: job.id, feature: job.feature, next: `node ${paths().cli} tick ${job.id}` });
    }
    case 'tick':
      return out(tick().tick(args[0], { retry: Boolean(flags.retry) }));
    case 'setup': {
      const id = jobs().resolveId(args[0]);
      return out(jobs().withJobLock(id, () => {
        const job = jobs().load(id);
        if (job.stage !== 'setup') die(`${id} is past setup (stage ${job.stage})`);
        const res = lib('worktree').setup(job);
        if (res.ok) {
          job.setupDone = true;
          jobs().save(job, 'dependencies installed');
          return { job: id, ok: true, log: res.log, then: `node ${paths().cli} tick ${id}` };
        }
        jobs().needsHuman(job, `setup command failed (exit ${res.status}); see setup.log`);
        return { job: id, ok: false, action: 'halt', log: res.log, tail: res.tail, say: `${id}: setup failed (exit ${res.status})` };
      }));
    }
    case 'record':
      return out(tick().record(args[0], args[1]));
    case 'deliver':
      return out(lib('deliver').deliver(args[0]));
    case 'approve':
      return out(tick().approve(args[0]));
    case 'rework': {
      const note = typeof flags.note === 'string' ? flags.note : args.slice(1).join(' ');
      return out(tick().rework(args[0], note));
    }
    case 'cancel':
      return out(tick().cancel(args[0], { purge: Boolean(flags.purge) }));

    // ------------------------------------------------------------ agents
    case 'brief':
      return out(lib('brief').brief(args[0], args[1]));
    case 'render': {
      const [kind, id] = args;
      if (!['spec', 'build', 'review', 'decision'].includes(kind)) die('usage: render <spec|build|review|decision> <job> [--lens l]');
      const job = jobs().load(id);
      return out(lib('templates').render(kind, job, config().load(), { lens: flags.lens, sensitive: 'see brief' }));
    }
    case 'diff': {
      const job = jobs().load(args[0]);
      return out(lib('worktree').diff(job, { stat: Boolean(flags.stat) }) || '(no changes)');
    }

    // ------------------------------------------------------------ state
    case 'status':
      return out(status(args[0]));
    case 'set-stage': {
      const id = jobs().resolveId(args[0]);
      return out(jobs().withJobLock(id, () => {
        const job = jobs().load(id);
        if (flags.round !== undefined) job.round = Number(flags.round);
        if (args[2] !== undefined && flags.round === undefined) job.round = Number(args[2]);
        if (args[1] === 'needs-human') jobs().needsHuman(job, flags.note || 'set manually');
        else {
          job.awaiting = [];
          jobs().setStage(job, args[1], flags.note ? `manual: ${flags.note}` : `manual: stage → ${args[1]}`);
        }
        return { job: id, stage: job.stage, round: job.round };
      }));
    }
    case 'set-verdict': {
      const [idArg, lens, verdict] = args;
      const id = jobs().resolveId(idArg);
      return out(jobs().withJobLock(id, () => {
        const job = jobs().load(id);
        if (!job.reviewers.includes(lens)) die(`reviewer "${lens}" is not active for ${id} (active: ${job.reviewers.join(', ')})`);
        job.reviews[lens] = String(verdict || '').toUpperCase() === 'PENDING' ? 'pending' : String(verdict || '').toUpperCase();
        const rec = job.rounds.find((r) => r.n === job.round);
        if (rec) rec.verdicts[lens] = job.reviews[lens];
        jobs().save(job, `manual: ${lens} ${job.reviews[lens]}`);
        return { job: id, round: job.round, reviews: job.reviews };
      }));
    }
    case 'error': {
      const id = jobs().resolveId(args[0]);
      const msg = args.slice(1).join(' ') || 'unspecified error';
      return out(jobs().withJobLock(id, () => {
        const job = jobs().load(id);
        job.error = msg;
        jobs().needsHuman(job, `error: ${msg}`);
        return { job: id, stage: job.stage, error: msg };
      }));
    }
    case 'validate': {
      const problems = [];
      try {
        config().load();
      } catch (e) {
        problems.push(e.message);
      }
      for (const id of jobs().listIds()) {
        try {
          jobs().load(id);
        } catch (e) {
          problems.push(e.message);
        }
      }
      if (problems.length) die(problems.join('\n'));
      return out({ ok: true, jobs: jobs().listIds().length });
    }

    // ------------------------------------------------------------ setup
    case 'init': {
      const [sub] = args;
      const init = lib('init');
      if (sub === 'detect') return out(lib('detect').detect());
      if (sub === 'apply') {
        return out(init.apply({
          delivery: flags.delivery, base: flags.base, branchPattern: flags['branch-pattern'],
          guidance: flags.guidance, reset: Boolean(flags.reset),
        }));
      }
      if (sub === 'profile') return out(init.profile());
      return die('usage: init detect | init apply [...] | init profile');
    }
    case 'config': {
      const [sub, key, ...val] = args;
      const c = config();
      if (sub === 'get' || sub === undefined) return out(c.getPath(c.load(), key) ?? null);
      if (sub === 'set') {
        if (!key) die('usage: config set <path> <value>');
        const cfg = c.load();
        c.setPath(cfg, key, c.parseValue(val.join(' ')));
        c.save(cfg);
        return out({ ok: true, [key]: c.getPath(cfg, key) });
      }
      return die('usage: config get [path] | config set <path> <value>');
    }
    case 'roles': {
      const [sub, name, model] = args;
      const c = config();
      const cfg = c.load();
      if (sub === undefined || sub === 'list') {
        return out({
          core: Object.fromEntries(['spec-writer', 'builder', 'approver'].map((r) => [r, cfg.roles[r].model])),
          reviewers: Object.fromEntries(Object.entries(cfg.roles.reviewers).map(([l, r]) => [l, `${r.enabled ? 'ON' : 'OFF'} ${r.model}${r.mode ? ` ${r.mode}` : ''}: ${r.reason}`])),
        });
      }
      if (sub === 'enable' || sub === 'disable') {
        c.setRole(cfg, name, sub === 'enable', typeof flags.reason === 'string' ? flags.reason : `${sub}d manually`);
        if (flags.mode) cfg.roles.reviewers[name].mode = flags.mode;
        c.save(cfg);
        lib('init').profile();
        return out({ ok: true, [name]: cfg.roles.reviewers[name], note: 'affects new jobs only' });
      }
      if (sub === 'model') {
        const target = cfg.roles[name] || cfg.roles.reviewers[name];
        if (!target || name === 'reviewers') die(`unknown role "${name}"`);
        target.model = model;
        c.save(cfg);
        return out({ ok: true, [name]: target });
      }
      return die('usage: roles [list] | roles enable|disable <lens> | roles model <role> <model>');
    }
    case 'doctor': {
      const res = lib('init').doctor({ run: typeof flags.run === 'string' ? flags.run.split(',') : [] });
      if (flags.json) return out(res);
      const icon = { ok: '✓', warn: '!', error: '✗' };
      const lines = res.checks.map((c) => `${icon[c.level]} ${c.name.padEnd(18)} ${c.detail}`);
      out(`${lines.join('\n')}\n\n${res.ok ? 'doctor: ok' : 'doctor: errors found'}`);
      if (!res.ok) process.exitCode = 1;
      return;
    }
    case 'backlog': {
      const b = lib('backlog');
      const [sub, ...rest] = args;
      if (sub === undefined || sub === 'list') return out(b.list());
      if (sub === 'add') return out(b.add(rest.join(' ')));
      if (sub === 'remove') return out(b.remove(Number(rest[0])));
      return die('usage: backlog [list] | backlog add "<text>" | backlog remove <n>');
    }
    case 'worktree': {
      const w = lib('worktree');
      const [sub, id] = args;
      if (sub === 'list') return out(w.registered());
      if (sub === 'prune') return out(w.prune({ all: Boolean(flags.all) }));
      const jid = jobs().resolveId(id);
      return out(jobs().withJobLock(jid, () => {
        const job = jobs().load(jid);
        if (sub === 'create') {
          w.create(job);
          jobs().save(job, `worktree ${job.worktree}`);
          return { job: jid, worktree: job.worktree, branch: job.branch };
        }
        if (sub === 'remove') return { job: jid, ...w.remove(job, { force: Boolean(flags.force), deleteBranch: Boolean(flags['delete-branch']) }) };
        return die('usage: worktree list | create <job> | remove <job> | prune');
      }));
    }

    // ------------------------------------------------------------ quality control
    case 'qc': {
      const qc = lib('qc');
      const [sub, id] = args;
      if (sub === 'report') {
        const r = qc.report({ sinceDays: flags.since ? Number(flags.since) : undefined });
        return out(flags.json ? r : JSON.stringify(r, null, 2));
      }
      if (sub === 'trace') return out(qc.trace(id));
      if (sub === 'series') return out(qc.series({ sinceDays: flags.since ? Number(flags.since) : undefined }));
      if (sub === 'brief') return out(qc.brief({ job: typeof flags.job === 'string' ? flags.job : undefined }));
      if (sub === 'journal') return out(qc.journal(args[1], args[2], args.slice(3).join(' ')));
      if (sub === 'index') return out(qc.writeIndex());
      if (sub === 'check') {
        const res = qc.check();
        if (flags.json) return out(res);
        const icon = { ok: '✓', warn: '!', error: '✗' };
        out(res.checks.map((c) => `${icon[c.level]} ${c.item.padEnd(24)} ${c.detail}`).join('\n') + `\n\n${res.ok ? 'qc check: ok' : 'qc check: errors found'}`);
        if (!res.ok) process.exitCode = 1;
        return;
      }
      return die('usage: qc report | trace <job> | check | series | brief [--job j] | journal <status> <slug> <text> | index');
    }

    // ------------------------------------------------------------ dashboard
    case 'serve': {
      const { url } = await lib('server').serve({ port: Number(flags.port || 4317), host: flags.host || '127.0.0.1' });
      console.log(`factory dashboard: ${url}   (Ctrl+C to stop)`);
      return new Promise(() => {});
    }
    case 'vendor': {
      const lines = await lib('install').vendor();
      return out(`downloaded into factory/dashboard/vendor/:\n${lines.join('\n')}`);
    }
    case 'install':
      return out(lib('install').install(args[0], { force: Boolean(flags.force), dryRun: Boolean(flags['dry-run']) }));

    default:
      return die(`unknown command "${cmd}". Run: factory-cli help`);
  }
}

function status(idArg) {
  const jobs = lib('jobs');
  if (idArg) {
    const j = jobs.load(idArg);
    const lines = [
      `${j.id}  [${j.stage}]  round ${j.round}/${j.maxRounds}`,
      `feature:  ${j.feature}`,
      `branch:   ${j.branch}  worktree: ${j.worktree}`,
      `reviews:  ${j.reviewers.map((l) => `${l}=${j.reviews[l]}`).join('  ') || '(none)'}`,
    ];
    if (j.attention) lines.push(`ATTENTION: ${j.attention}`);
    if (j.delivery) lines.push(`delivery: ${j.delivery.status}${j.delivery.prUrl ? ` ${j.delivery.prUrl}` : ''}`);
    lines.push('history:', ...j.history.slice(-8).map((h) => `  ${h.at.slice(5, 16).replace('T', ' ')}  ${h.stage.padEnd(11)} ${h.note}`));
    return lines.join('\n');
  }
  const ids = jobs.listIds();
  if (!ids.length) return 'no jobs yet: /factory <feature> or /factory next';
  return ids.map((id) => {
    const j = jobs.load(id);
    const chips = j.reviewers.map((l) => `${l}:${{ pending: '…', PASS: '✓', CHANGES: '✗' }[j.reviews[l]]}`).join(' ');
    return `${j.id.padEnd(32)} ${j.stage.padEnd(11)} r${j.round} ${chips}${j.attention ? `  ⚠ ${j.attention.slice(0, 80)}` : ''}`;
  }).join('\n');
}

main().catch((err) => {
  if (err instanceof FactoryError) {
    console.error(`error: ${err.message}`);
    process.exit(err.code || 1);
  }
  console.error(err.stack || String(err));
  process.exit(2);
});

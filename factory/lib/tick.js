'use strict';
// The factory loop as a deterministic state machine.
//
// The orchestrator never decides what happens next on its own: it runs
// `factory-cli tick <job>`, performs the returned action (spawn agents, resume
// the builder, run a command), and ticks again. tick reads the agents' output
// files, records verdicts in job.json and advances the stage.
//
//   setup → spec → build → review ─(all PASS)→ approve → deliver → delivered
//                    ▲        │
//                    └────────┘ any CHANGES (≤ maxReworkRounds), else needs-human

const fs = require('fs');
const path = require('path');
const { paths, die, now, writeFileAtomic, readText } = require('./util');
const config = require('./config');
const jobs = require('./jobs');
const worktree = require('./worktree');
const templates = require('./templates');
const { builderMode } = require('./brief');

const q = (s) => (/^[\w./:-]+$/.test(s) ? s : JSON.stringify(s));
const cli = () => `node ${q(paths().cli)}`;

function agent(job, cfg, type, { name, extra = '' } = {}) {
  const lens = type.startsWith('reviewer-') ? type.slice('reviewer-'.length) : null;
  const model = lens ? cfg.roles.reviewers[lens].model : cfg.roles[type].model;
  return {
    subagent_type: type,
    name: name || `${type}-${job.id}${job.round ? `-r${job.round}` : ''}`,
    ...(model && model !== 'inherit' ? { model } : {}),
    description: `${type} · ${job.id}`,
    prompt:
      `Factory job ${job.id}. You are ${type}.${extra ? ` ${extra}` : ''}\n` +
      `First run:  ${cli()} brief ${job.id} ${type}\n` +
      'It prints your paths, inputs, rules and a pre-filled template. Do exactly what it says and write only its OUTPUT file.',
  };
}

const spawn = (job, agents, say, extra = {}) => ({
  job: job.id, stage: job.stage, round: job.round, action: 'spawn', parallel: agents.length > 1,
  agents, say, then: `${cli()} tick ${job.id}`, ...extra,
});

const halt = (job) => ({
  job: job.id, stage: job.stage, round: job.round, action: 'halt',
  say: `${job.id}: needs human: ${job.attention}`,
  attention: job.attention, worktree: job.worktree, branch: job.branch,
  options: [`/factory approve ${job.id}`, `/factory rework ${job.id} <note>`, `/factory cancel ${job.id}`],
});

function retryKey(job, type) {
  return `${type}${job.round ? `@r${job.round}` : ''}`;
}

// Returns true if the agent may be re-run once more (and counts the retry).
function consumeRetry(job, cfg, type) {
  const key = retryKey(job, type);
  const used = job.retries[key] || 0;
  if (used >= cfg.loop.agentRetries) return false;
  job.retries[key] = used + 1;
  return true;
}

// ---------------------------------------------------------------- dispatchers

function dispatchSpec(job, cfg) {
  job.awaiting = ['spec-writer'];
  jobs.save(job, 'spec-writer started');
  return spawn(job, [agent(job, cfg, 'spec-writer')], `${job.id}: writing spec`);
}

function dispatchBuilder(job, cfg) {
  const mode = builderMode(job);
  const dir = jobs.jobDir(job.id);
  // The previous build.md is snapshotted in round-N/ (or kept as build.prev.md
  // if it never reached review); moving it aside means a fresh STATUS line can
  // only come from this builder run.
  const prev = path.join(dir, 'build.md');
  if (fs.existsSync(prev)) fs.renameSync(prev, path.join(dir, 'build.prev.md'));
  job.stage = 'build';
  job.awaiting = ['builder'];
  const name = `builder-${job.id}`;
  const extra = { initial: 'Build round 1.', resume: `Address round ${job.round} review findings for round ${job.round + 1}.`, rework: `Address the human rework request rework-${job.pendingRework}.md.` }[mode];
  jobs.save(job, `builder started (${mode})`);
  const fresh = agent(job, cfg, 'builder', { name, extra });
  if (mode === 'resume') {
    return {
      job: job.id, stage: job.stage, round: job.round, action: 'resume',
      resume: {
        to: name,
        message: `Round ${job.round} reviews are in. Run \`${cli()} brief ${job.id} builder\` for the findings to address, fix them, commit, and rewrite build.md for round ${job.round + 1}.`,
      },
      fallback: fresh,
      say: `${job.id}: round ${job.round} → CHANGES from ${job.reviewers.filter((l) => job.reviews[l] === 'CHANGES').join(', ')} → resuming builder (${job.resumesUsed}/${cfg.loop.maxReworkRounds})`,
      then: `${cli()} tick ${job.id}`,
    };
  }
  return spawn(job, [fresh], `${job.id}: building (${mode})`);
}

function startRound(job, cfg) {
  const n = job.round + 1;
  const rdir = jobs.roundDir(job.id, n);
  fs.mkdirSync(rdir, { recursive: true });
  fs.copyFileSync(path.join(jobs.jobDir(job.id), 'build.md'), path.join(rdir, 'build.md'));
  job.round = n;
  job.pendingRework = null;
  job.reviews = Object.fromEntries(job.reviewers.map((l) => [l, 'pending']));
  job.rounds.push({ n, verdicts: { ...job.reviews }, startedAt: now(), endedAt: null });
  if (!job.reviewers.length) {
    jobs.save(job, `round ${n}: no reviewers active, skipping review`);
    return dispatchApprover(job, cfg);
  }
  job.stage = 'review';
  return dispatchReviewers(job, cfg, job.reviewers, `round ${n} started`);
}

function dispatchReviewers(job, cfg, lenses, note) {
  job.awaiting = lenses.map((l) => `reviewer-${l}`);
  jobs.save(job, note);
  const agents = lenses.map((l) => agent(job, cfg, `reviewer-${l}`));
  return spawn(job, agents, `${job.id}: round ${job.round} → reviewing (${lenses.join(', ')})`, {
    onEach: `${cli()} record ${job.id} <lens>   ← run as each reviewer finishes, so the dashboard updates live`,
  });
}

function dispatchApprover(job, cfg) {
  job.stage = 'approve';
  job.awaiting = ['approver'];
  fs.rmSync(path.join(jobs.jobDir(job.id), 'decision.md'), { force: true });
  jobs.save(job, 'approver started');
  return spawn(job, [agent(job, cfg, 'approver')], `${job.id}: round ${job.round} all PASS → approver`);
}

function deliverAction(job) {
  return {
    job: job.id, stage: job.stage, round: job.round, action: 'run',
    command: `${cli()} deliver ${job.id}`,
    say: `${job.id}: delivering`,
    then: `${cli()} tick ${job.id}`,
  };
}

const awaiting = (job, type) => job.awaiting.includes(type);

// ---------------------------------------------------------------- step

function step(job, cfg) {
  switch (job.stage) {
    case 'setup': {
      if (!worktree.registered().some((w) => path.resolve(w.path) === path.resolve(job.worktree))) {
        worktree.create(job);
        jobs.save(job, `worktree ${job.worktree}`);
      }
      if (!job.setupDone && cfg.commands.setup) {
        return {
          job: job.id, stage: job.stage, round: 0, action: 'run',
          command: `${cli()} setup ${job.id}`, timeoutMs: ((cfg.loop.setupTimeoutSec || 900) + 30) * 1000,
          say: `${job.id}: installing dependencies in the worktree`,
          then: `${cli()} tick ${job.id}`,
        };
      }
      job.setupDone = true;
      job.stage = 'spec';
      jobs.save(job, 'setup done');
      return null;
    }

    case 'spec': {
      const spec = readText(path.join(jobs.jobDir(job.id), 'spec.md'));
      const valid = spec && /acceptance criteria/i.test(spec) && /\bAC\d+\b|^\s*- \[ \]/m.test(spec);
      if (valid) {
        job.awaiting = [];
        return dispatchBuilder(job, cfg);
      }
      if (awaiting(job, 'spec-writer')) {
        if (!consumeRetry(job, cfg, 'spec-writer')) {
          jobs.needsHuman(job, spec ? 'spec.md has no acceptance criteria' : 'spec-writer finished without writing spec.md');
          return halt(job);
        }
      }
      return dispatchSpec(job, cfg);
    }

    case 'build': {
      if (!awaiting(job, 'builder')) return dispatchBuilder(job, cfg);
      const s = jobs.buildStatus(job.id);
      if (s.value === 'READY') {
        if (worktree.commitsAhead(job) === 0) {
          jobs.needsHuman(job, `builder reported READY but ${job.branch} has no commits ahead of ${job.baseBranch}`);
          return halt(job);
        }
        job.build = 'READY';
        job.awaiting = [];
        return startRound(job, cfg);
      }
      if (s.value === 'BLOCKED') {
        job.build = 'BLOCKED';
        jobs.needsHuman(job, `builder BLOCKED: ${jobs.reasonFrom(s.text, 'see build.md')}`);
        return halt(job);
      }
      if (consumeRetry(job, cfg, 'builder')) {
        jobs.save(job, `builder output invalid (${s.problem}); retrying`);
        return spawn(job, [agent(job, cfg, 'builder', { name: `builder-${job.id}-retry`, extra: `Previous builder run ended without a valid build.md (${s.problem}). Inspect the worktree, finish the work, and write build.md.` })], `${job.id}: builder output invalid → retrying`);
      }
      jobs.needsHuman(job, `builder finished without a valid build.md (${s.problem})`);
      return halt(job);
    }

    case 'review': {
      const sync = jobs.syncVerdicts(job);
      if (sync.missing.length) {
        if (!job.awaiting.length) return dispatchReviewers(job, cfg, sync.missing, `round ${job.round}: re-dispatching ${sync.missing.join(', ')}`);
        const retryable = sync.missing.every((l) => consumeRetry(job, cfg, `reviewer-${l}`));
        if (!retryable) {
          jobs.needsHuman(job, `reviewer(s) ${sync.missing.join(', ')} finished without a valid review file${Object.keys(sync.invalid).length ? ` (${Object.entries(sync.invalid).map(([l, p]) => `${l}: ${p}`).join('; ')})` : ''}`);
          return halt(job);
        }
        for (const l of Object.keys(sync.invalid)) fs.rmSync(jobs.reviewFile(job.id, job.round, l), { force: true });
        return dispatchReviewers(job, cfg, sync.missing, `round ${job.round}: retrying ${sync.missing.join(', ')}`);
      }
      job.awaiting = [];
      const changes = job.reviewers.filter((l) => job.reviews[l] === 'CHANGES');
      if (!changes.length) return dispatchApprover(job, cfg);
      if (job.resumesUsed < cfg.loop.maxReworkRounds) {
        job.resumesUsed += 1;
        jobs.save(job, `round ${job.round}: CHANGES from ${changes.join(', ')}`);
        return dispatchBuilder(job, cfg);
      }
      writeFileAtomic(path.join(jobs.jobDir(job.id), 'decision.md'),
        `DECISION: ESCALATE\n\n# Decision ${job.id}\n\nReview rounds exhausted after round ${job.round} (max ${job.maxRounds}).\nOutstanding CHANGES in round-${job.round}/ from: ${changes.join(', ')}.\n\nWritten by factory-cli, not the approver.\n`);
      job.decision = 'ESCALATE';
      jobs.needsHuman(job, `review rounds exhausted; CHANGES from ${changes.join(', ')} in round ${job.round}`);
      return halt(job);
    }

    case 'approve': {
      if (!awaiting(job, 'approver')) return dispatchApprover(job, cfg);
      const d = jobs.decisionOf(job.id);
      if (!d.value) {
        if (consumeRetry(job, cfg, 'approver')) return dispatchApprover(job, cfg);
        jobs.needsHuman(job, `approver finished without a valid decision.md (${d.problem})`);
        return halt(job);
      }
      job.awaiting = [];
      job.decision = d.value;
      if (d.value === 'ESCALATE') {
        jobs.needsHuman(job, `approver escalated: ${jobs.reasonFrom(d.text.replace(/^.*\n/, ''), 'see decision.md')}`);
        return halt(job);
      }
      if (cfg.approval.mode === 'human' && !job.humanApproved) {
        jobs.needsHuman(job, `approver APPROVED; approval.mode is "human", so sign off with /factory approve ${job.id}`);
        return halt(job);
      }
      job.stage = 'deliver';
      jobs.save(job, 'approved');
      return deliverAction(job);
    }

    case 'deliver':
      return deliverAction(job);

    case 'needs-human':
      return halt(job);

    case 'delivered':
      return {
        job: job.id, stage: job.stage, round: job.round, action: 'done', delivery: job.delivery,
        say: `${job.id}: ${job.delivery?.status === 'pr-open' ? `PR opened ${job.delivery.prUrl}` : `merged into ${job.baseBranch}${job.delivery?.mergeCommit ? ` @ ${job.delivery.mergeCommit.slice(0, 10)}` : ''}`}`,
      };

    case 'cancelled':
      return { job: job.id, stage: job.stage, round: job.round, action: 'done', say: `${job.id}: cancelled` };

    default:
      die(`unknown stage ${job.stage}`);
  }
}

function tick(idOrNum, { retry = false } = {}) {
  const id = jobs.resolveId(idOrNum);
  return jobs.withJobLock(id, () => {
    const cfg = config.load({ requireInit: true });
    const job = jobs.load(id);
    if (retry) {
      if (job.stage === 'needs-human') die('job is in needs-human: use approve, rework or cancel');
      job.awaiting = [];
      job.retries = {};
      jobs.save(job, 'manual retry: re-dispatching current step');
    }
    for (let guard = 0; guard < 10; guard++) {
      const action = step(job, cfg);
      if (action) return action;
    }
    die('tick made no progress (state machine loop); inspect job.json');
  });
}

// ---------------------------------------------------------------- human commands

function record(idOrNum, lens) {
  const id = jobs.resolveId(idOrNum);
  return jobs.withJobLock(id, () => {
    const job = jobs.load(id);
    if (job.stage !== 'review') die(`${id} is not in review (stage ${job.stage})`);
    if (!job.reviewers.includes(lens)) die(`reviewer "${lens}" is not active for ${id}`);
    const v = jobs.verdictOf(id, job.round, lens);
    jobs.syncVerdicts(job);
    jobs.save(job, v.value ? `round ${job.round}: ${lens} ${v.value}` : null);
    return { job: id, round: job.round, lens, verdict: v.value || 'pending', problem: v.problem, reviews: job.reviews };
  });
}

function approve(idOrNum) {
  const id = jobs.resolveId(idOrNum);
  return jobs.withJobLock(id, () => {
    const job = jobs.load(id);
    if (job.stage !== 'needs-human') die(`${id} is not waiting for a human (stage ${job.stage})`);
    if (!worktree.branchExists(job.branch)) die(`branch ${job.branch} no longer exists`);
    if (worktree.commitsAhead(job) === 0) die(`${job.branch} has no commits to deliver`);
    job.humanApproved = true;
    job.stage = 'deliver';
    job.attention = null;
    jobs.save(job, `human approved${job.decision === 'APPROVE' ? '' : ' (override)'}`);
    return deliverAction(job);
  });
}

function rework(idOrNum, note) {
  if (!note || !note.trim()) die('rework needs a note: what should the builder change?');
  const id = jobs.resolveId(idOrNum);
  return jobs.withJobLock(id, () => {
    const cfg = config.load();
    const job = jobs.load(id);
    if (!['needs-human', 'delivered'].includes(job.stage) || (job.stage === 'delivered' && job.delivery?.status !== 'pr-open')) {
      die(`${id} can be reworked only from needs-human (or delivered with an open PR); stage is ${job.stage}`);
    }
    if (!fs.existsSync(job.worktree)) {
      // Delivered PR jobs may have had their worktree removed: recreate it on
      // the existing branch and reinstall dependencies before the builder runs.
      worktree.create(job);
      const res = worktree.setup(job);
      if (!res.ok) die(`setup failed in recreated worktree (exit ${res.status}); see ${res.log}\n${res.tail}`);
    }
    const dir = jobs.jobDir(id);
    const k = job.reworks + 1;
    writeFileAtomic(path.join(dir, `rework-${k}.md`), templates.render('rework', job, cfg, { k, note: note.trim() }));
    const decision = path.join(dir, 'decision.md');
    if (fs.existsSync(decision) && job.round) fs.renameSync(decision, path.join(jobs.roundDir(id, job.round), 'decision.md'));
    Object.assign(job, { reworks: k, pendingRework: k, resumesUsed: 0, decision: null, humanApproved: false, awaiting: [], retries: {}, attention: null, build: null });
    job.stage = 'build';
    jobs.save(job, `human rework ${k}: ${note.trim().slice(0, 120)}`);
    return dispatchBuilder(job, cfg);
  });
}

function cancel(idOrNum, { purge = false } = {}) {
  const id = jobs.resolveId(idOrNum);
  return jobs.withJobLock(id, () => {
    const job = jobs.load(id);
    if (job.stage === 'delivered') die(`${id} is already delivered`);
    job.stage = 'cancelled';
    job.awaiting = [];
    job.attention = null;
    const r = purge ? worktree.remove(job, { force: true, deleteBranch: true }) : null;
    jobs.save(job, `cancelled${purge ? ' (worktree and branch removed)' : ''}`);
    return { job: id, action: 'done', say: `${id}: cancelled`, ...(r ? { cleanup: r } : {}) };
  });
}

module.exports = { tick, record, approve, rework, cancel };

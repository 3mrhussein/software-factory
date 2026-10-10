'use strict';
// Delivery: direct merge into the base branch, or push + GitHub PR via `gh`.
// Never force-pushes, never rewrites history, never touches a dirty checkout.

const fs = require('fs');
const path = require('path');
const { paths, git, sh, die, now, writeFileAtomic, readText, fill } = require('./util');
const config = require('./config');
const jobs = require('./jobs');
const worktree = require('./worktree');
const templates = require('./templates');

function mainCheckoutProblem(job) {
  const root = paths().root;
  const branch = git(['branch', '--show-current'], { cwd: root, allowFail: true });
  if (branch !== job.baseBranch) return `main checkout is on "${branch || 'detached HEAD'}", not ${job.baseBranch}`;
  const dirty = (git(['status', '--porcelain', '--untracked-files=no'], { cwd: root, allowFail: true }) || '')
    .split('\n').filter(Boolean)
    .filter((l) => !/\sfactory\/(backlog\.md|jobs\/)/.test(l));
  if (dirty.length) return `main checkout has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')})`;
  if (fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))) return 'a merge is already in progress in the main checkout';
  return null;
}

function prBody(job, cfg) {
  const dir = jobs.jobDir(job.id);
  const spec = readText(path.join(dir, 'spec.md')) || '';
  const criteria = (spec.split(/^## Acceptance criteria\s*$/im)[1] || '').split(/^## /m)[0]
    .split('\n').filter((l) => /^\s*- \[/.test(l)).join('\n') || '_See spec.md_';
  const reviewTable = job.reviewers.length
    ? ['| Reviewer | Verdict |', '| -------- | ------- |', ...job.reviewers.map((l) => `| ${templates.lensTitle(l)} | ${job.reviews[l]} |`)].join('\n')
    : '_No reviewers active._';
  const decision = (readText(path.join(dir, 'decision.md')) || '').split('\n').slice(1).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  return fill(templates.raw('pr-body'), {
    feature: job.feature, id: job.id, rounds: job.round, criteria, reviewTable,
    decision: (job.humanApproved ? '**Approved by a human.**\n\n' : '') + (decision || '_n/a_'),
    diffstat: worktree.diff(job, { stat: true }).trim().split('\n').slice(-30).join('\n'),
  });
}

function directMerge(job, cfg) {
  const root = paths().root;
  const problem = mainCheckoutProblem(job);
  if (problem) return { ok: false, reason: `approved, but ${problem}. Fix it, then run /factory approve ${job.id}` };
  const msg = `Merge ${job.branch}: ${templates.title(job.feature)}`;
  const res = sh(`git merge --no-ff ${JSON.stringify(job.branch)} -m ${JSON.stringify(msg)}`, { cwd: root });
  if (!res.ok) {
    sh('git merge --abort', { cwd: root });
    return { ok: false, reason: `merge into ${job.baseBranch} failed (aborted): ${(res.stdout + res.stderr).trim().split('\n').slice(-4).join(' / ')}` };
  }
  const mergeCommit = git(['rev-parse', 'HEAD'], { cwd: root });
  const cleanup = cfg.delivery.removeWorktreeAfterDelivery !== false ? worktree.remove(job, { deleteBranch: true }) : null;
  return { ok: true, delivery: { strategy: 'direct-merge', status: 'merged', prUrl: null, mergeCommit, at: now() }, cleanup };
}

function githubPr(job, cfg) {
  const remote = cfg.git.remote;
  if (!remote) return { ok: false, reason: 'delivery is github-pr but git.remote is not set' };
  if (!cfg.tools.gh) return { ok: false, reason: 'delivery is github-pr but gh is not installed/authenticated (run `gh auth login`, then /factory approve)' };
  const cwd = fs.existsSync(job.worktree) ? job.worktree : paths().root;
  const push = sh(`git push -u ${JSON.stringify(remote)} ${JSON.stringify(`${job.branch}:${job.branch}`)}`, { cwd });
  if (!push.ok) return { ok: false, reason: `git push failed: ${push.stderr.trim().split('\n').slice(-3).join(' / ')}` };
  const bodyFile = path.join(jobs.jobDir(job.id), 'pr-body.md');
  writeFileAtomic(bodyFile, prBody(job, cfg));
  let prUrl = null;
  const existing = sh(`gh pr view ${JSON.stringify(job.branch)} --json url,state -q 'select(.state=="OPEN") | .url'`, { cwd });
  if (existing.ok && existing.stdout.trim()) {
    prUrl = existing.stdout.trim();
    sh(`gh pr edit ${JSON.stringify(job.branch)} --body-file ${JSON.stringify(bodyFile)}`, { cwd });
  } else {
    const title = cfg.git.commitStyle === 'conventional' && !/^\w+(\(.+\))?!?:/.test(job.feature) ? `feat: ${templates.title(job.feature)}` : templates.title(job.feature);
    const create = sh([
      'gh pr create', `--base ${JSON.stringify(job.baseBranch)}`, `--head ${JSON.stringify(job.branch)}`,
      `--title ${JSON.stringify(title)}`, `--body-file ${JSON.stringify(bodyFile)}`, cfg.delivery.draftPr ? '--draft' : '',
    ].join(' '), { cwd });
    if (!create.ok) return { ok: false, reason: `gh pr create failed: ${create.stderr.trim().split('\n').slice(-3).join(' / ')}` };
    prUrl = (create.stdout.match(/https?:\/\/\S+/) || [create.stdout.trim()])[0];
  }
  const cleanup = cfg.delivery.removeWorktreeAfterDelivery !== false ? worktree.remove(job, { deleteBranch: false }) : null;
  return { ok: true, delivery: { strategy: 'github-pr', status: 'pr-open', prUrl, mergeCommit: null, at: now() }, cleanup };
}

function deliver(idOrNum) {
  const id = jobs.resolveId(idOrNum);
  return jobs.withJobLock(id, () => {
    const cfg = config.load({ requireInit: true });
    const job = jobs.load(id);
    if (job.stage !== 'deliver') die(`${id} is not ready to deliver (stage ${job.stage}); delivery runs after APPROVE or /factory approve`);
    if (!worktree.branchExists(job.branch)) die(`branch ${job.branch} does not exist`);
    worktree.snapshotDiff(job);
    const result = cfg.delivery.strategy === 'github-pr' ? githubPr(job, cfg) : directMerge(job, cfg);
    if (!result.ok) {
      job.delivery = { strategy: cfg.delivery.strategy, status: 'failed', prUrl: null, mergeCommit: null, at: now() };
      jobs.needsHuman(job, result.reason, `delivery failed: ${result.reason}`);
      return { job: id, action: 'halt', stage: job.stage, say: `${id}: delivery failed: ${result.reason}`, attention: result.reason };
    }
    job.delivery = result.delivery;
    job.stage = 'delivered';
    job.awaiting = [];
    jobs.save(job, result.delivery.status === 'merged' ? `merged into ${job.baseBranch}` : `PR opened: ${result.delivery.prUrl}`);
    const notes = result.cleanup?.notes || [];
    return {
      job: id, action: 'done', stage: job.stage, delivery: job.delivery, cleanup: result.cleanup,
      say: `${id}: ${result.delivery.status === 'merged' ? `merged into ${job.baseBranch}` : `PR ${result.delivery.prUrl}`}${notes.length ? ` (cleanup: ${notes.join('; ')})` : ''}`,
    };
  });
}

module.exports = { deliver, prBody, mainCheckoutProblem };

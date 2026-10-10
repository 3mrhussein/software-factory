'use strict';
// Git worktree management. Each job gets <worktreeRoot>/<job-id> on its own
// branch, so jobs never touch the developer's checkout or each other.

const fs = require('fs');
const path = require('path');
const { paths, git, sh, die, writeFileAtomic, now } = require('./util');
const config = require('./config');
const jobs = require('./jobs');

const branchExists = (branch) => git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: paths().root, allowFail: true }) != null;

function registered() {
  const out = git(['worktree', 'list', '--porcelain'], { cwd: paths().root, allowFail: true }) || '';
  return out.split('\n\n').filter(Boolean).map((block) => {
    const wt = {};
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ');
      wt[k] = v.join(' ') || true;
    }
    return { path: wt.worktree, branch: (wt.branch || '').replace('refs/heads/', ''), prunable: Boolean(wt.prunable) };
  });
}

function create(job) {
  const root = paths().root;
  if (!paths().isGit) die('not a git repository');
  if (!git(['rev-parse', '--verify', '--quiet', job.baseBranch], { cwd: root, allowFail: true })) {
    die(`base branch "${job.baseBranch}" does not exist (set git.baseBranch in factory/config.json)`);
  }
  const existing = registered().find((w) => path.resolve(w.path) === path.resolve(job.worktree));
  if (existing) {
    if (existing.branch !== job.branch) die(`${job.worktree} is a worktree for ${existing.branch}, expected ${job.branch}`);
  } else {
    if (fs.existsSync(job.worktree) && fs.readdirSync(job.worktree).length) die(`${job.worktree} exists and is not empty`);
    fs.mkdirSync(path.dirname(job.worktree), { recursive: true });
    const args = branchExists(job.branch)
      ? ['worktree', 'add', job.worktree, job.branch]
      : ['worktree', 'add', '-b', job.branch, job.worktree, job.baseBranch];
    git(args, { cwd: root });
  }
  job.baseCommit ||= git(['rev-parse', job.baseBranch], { cwd: root });
  return job;
}

// Runs config.commands.setup inside the worktree, logging to setup.log.
function setup(job) {
  const cfg = config.load();
  const log = path.join(jobs.jobDir(job.id), 'setup.log');
  if (!cfg.commands.setup) {
    writeFileAtomic(log, `${now()} no setup command configured\n`);
    return { ok: true, skipped: true, log };
  }
  const res = sh(cfg.commands.setup, { cwd: job.worktree, timeoutMs: (cfg.loop.setupTimeoutSec || 900) * 1000, env: { CI: '1' } });
  writeFileAtomic(log, `$ ${cfg.commands.setup}\n# exit ${res.status}\n\n${res.stdout}\n${res.stderr}`);
  return { ok: res.ok, status: res.status, log, tail: (res.stderr || res.stdout).trim().split('\n').slice(-15).join('\n') };
}

function remove(job, { force = false, deleteBranch = false } = {}) {
  const root = paths().root;
  const result = { worktreeRemoved: false, branchDeleted: false, notes: [] };
  if (registered().some((w) => path.resolve(w.path) === path.resolve(job.worktree))) {
    const r = sh(`git worktree remove ${force ? '--force ' : ''}${JSON.stringify(job.worktree)}`, { cwd: root });
    if (r.ok) result.worktreeRemoved = true;
    else result.notes.push(`worktree remove failed: ${r.stderr.trim()}`);
  }
  if (deleteBranch && branchExists(job.branch)) {
    const r = sh(`git branch ${force ? '-D' : '-d'} ${JSON.stringify(job.branch)}`, { cwd: root });
    if (r.ok) result.branchDeleted = true;
    else result.notes.push(`branch delete failed: ${r.stderr.trim()}`);
  }
  return result;
}

// Removes worktrees of finished jobs and prunes stale git worktree metadata.
function prune({ all = false } = {}) {
  const report = [];
  for (const id of jobs.listIds()) {
    const job = jobs.load(id);
    if (!(jobs.TERMINAL.has(job.stage) || all)) continue;
    if (!fs.existsSync(job.worktree)) continue;
    const r = remove(job, { deleteBranch: job.stage === 'cancelled' || job.delivery?.status === 'merged' });
    report.push({ id, ...r });
  }
  git(['worktree', 'prune'], { cwd: paths().root, allowFail: true });
  const root = config.worktreeRoot(config.load());
  if (fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  return report;
}

function diff(job, { stat = false } = {}) {
  const root = paths().root;
  const base = job.baseCommit || job.baseBranch;
  if (branchExists(job.branch)) {
    const range = `${base}...${job.branch}`;
    return git(stat ? ['diff', '--stat', range] : ['diff', '--find-renames', range], { cwd: root, allowFail: true }) || '';
  }
  const snap = path.join(jobs.jobDir(job.id), stat ? 'diffstat.txt' : 'diff.patch');
  return fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8') : '';
}

function changedFiles(job) {
  const base = job.baseCommit || job.baseBranch;
  if (!branchExists(job.branch)) return [];
  return (git(['diff', '--name-only', `${base}...${job.branch}`], { cwd: paths().root, allowFail: true }) || '').split('\n').filter(Boolean);
}

function snapshotDiff(job) {
  const dir = jobs.jobDir(job.id);
  writeFileAtomic(path.join(dir, 'diff.patch'), diff(job));
  writeFileAtomic(path.join(dir, 'diffstat.txt'), diff(job, { stat: true }));
}

const commitsAhead = (job) =>
  Number(git(['rev-list', '--count', `${job.baseCommit || job.baseBranch}..${job.branch}`], { cwd: paths().root, allowFail: true }) || 0);

module.exports = { create, setup, remove, prune, diff, changedFiles, snapshotDiff, commitsAhead, branchExists, registered };

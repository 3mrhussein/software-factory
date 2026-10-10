'use strict';
// job.json lifecycle. Every mutation goes through save(): schema-validated,
// timestamped, atomically written, and mirrored into jobs/index.json so the
// static dashboard can list jobs without a server.

const fs = require('fs');
const path = require('path');
const { paths, readJSON, writeJSONAtomic, readText, firstLine, die, now, fill, withLock } = require('./util');
const schema = require('./schema');
const config = require('./config');

const STAGES = ['setup', 'spec', 'build', 'review', 'approve', 'deliver', 'delivered', 'needs-human', 'cancelled'];
const TERMINAL = new Set(['delivered', 'cancelled']);

const jobDir = (id) => path.join(paths().jobs, id);
const jobFile = (id) => path.join(jobDir(id), 'job.json');
const roundDir = (id, n) => path.join(jobDir(id), `round-${n}`);
const reviewFile = (id, n, lens) => path.join(roundDir(id, n), `review-${lens}.md`);

function listIds() {
  if (!fs.existsSync(paths().jobs)) return [];
  return fs.readdirSync(paths().jobs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{3,}-/.test(e.name) && fs.existsSync(jobFile(e.name)))
    .map((e) => e.name)
    .sort();
}

// Accepts a full id or just its number ("7", "007").
function resolveId(idOrNum) {
  if (!idOrNum) die('missing job id');
  if (fs.existsSync(jobFile(idOrNum))) return idOrNum;
  if (/^\d+$/.test(idOrNum)) {
    const hit = listIds().find((id) => Number(id.split('-')[0]) === Number(idOrNum));
    if (hit) return hit;
  }
  die(`no job "${idOrNum}" (have: ${listIds().join(', ') || 'none'})`);
}

function load(idOrNum) {
  const id = resolveId(idOrNum);
  return schema.check('job', readJSON(jobFile(id)), `jobs/${id}/job.json`);
}

function writeIndex() {
  const jobs = listIds();
  writeJSONAtomic(path.join(paths().jobs, 'index.json'), { updatedAt: now(), jobs });
}

function save(job, note) {
  const t = now();
  job.updatedAt = t;
  if (note) {
    job.history.push({ at: t, stage: job.stage, ...(job.round ? { round: job.round } : {}), note });
    if (job.history.length > 200) job.history = job.history.slice(-200);
  }
  schema.check('job', job, `jobs/${job.id}/job.json`);
  writeJSONAtomic(jobFile(job.id), job);
  writeIndex();
  return job;
}

function setStage(job, stage, note) {
  if (!STAGES.includes(stage)) die(`unknown stage "${stage}" (one of ${STAGES.join(', ')})`);
  job.stage = stage;
  if (stage !== 'needs-human') job.attention = null;
  return save(job, note || `stage → ${stage}`);
}

function needsHuman(job, reason, note) {
  job.stage = 'needs-human';
  job.attention = reason;
  job.awaiting = [];
  return save(job, note || `needs human: ${reason}`);
}

const slugify = (s) =>
  s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((w) => !['a', 'an', 'the', 'to', 'for', 'of', 'and', 'on', 'in', 'with', 'add', 'make'].includes(w))
    .slice(0, 4).join('-') || 'job';

function portsFor(num, cfg) {
  const base = cfg.ports.base + cfg.ports.stride * (num % Math.floor((65000 - cfg.ports.base) / cfg.ports.stride));
  return { builder: base, 'ui-ux': base + 1, approver: base + 2 };
}

// Claims the next job number with mkdir (atomic), so parallel sessions never
// collide, then writes the initial job.json.
function create(feature, { source = 'command', slug } = {}) {
  const cfg = config.load({ requireInit: true });
  feature = feature.trim().replace(/\s+/g, ' ');
  if (!feature) die('feature description is empty');
  fs.mkdirSync(paths().jobs, { recursive: true });
  const s = slug ? slugify(slug) : slugify(feature);
  // Numbers are unique across slugs, so claim under a lock (mkdir alone would
  // let "004-a" and "004-b" coexist).
  const id = withLock('ids', () => {
    const taken = fs.readdirSync(paths().jobs).filter((n) => /^\d{3,}-/.test(n)).map((n) => Number(n.split('-')[0]));
    const next = `${String(Math.max(0, ...taken) + 1).padStart(3, '0')}-${s}`;
    fs.mkdirSync(jobDir(next));
    return next;
  });
  const num = Number(id.split('-')[0]);
  const t = now();
  const reviewers = config.activeReviewers(cfg);
  const job = {
    schemaVersion: 1,
    id,
    feature,
    source,
    stage: 'setup',
    branch: fill(cfg.git.branchPattern, { id, num: String(num).padStart(3, '0'), slug: s }),
    baseBranch: cfg.git.baseBranch,
    baseCommit: null,
    worktree: path.join(config.worktreeRoot(cfg), id),
    setupDone: false,
    round: 0,
    maxRounds: cfg.loop.maxReworkRounds + 1,
    resumesUsed: 0,
    reworks: 0,
    reviewers,
    reviews: Object.fromEntries(reviewers.map((r) => [r, 'pending'])),
    rounds: [],
    build: null,
    decision: null,
    humanApproved: false,
    awaiting: [],
    retries: {},
    pendingRework: null,
    ports: portsFor(num, cfg),
    delivery: null,
    attention: null,
    error: null,
    createdAt: t,
    updatedAt: t,
    history: [],
  };
  return save(job, `created: ${feature}`);
}

// ---------------------------------------------------------------- markers
// Agents start their files with a machine-readable first line.

function readMarker(file, key, allowed) {
  const text = readText(file);
  if (text == null) return { value: null, problem: 'missing' };
  const m = firstLine(text).replace(/[*_`#]/g, '').match(new RegExp(`^${key}\\s*:\\s*([A-Z-]+)`, 'i'));
  if (!m) return { value: null, problem: `first line is not "${key}: ${allowed.join('|')}"` };
  const v = m[1].toUpperCase();
  if (!allowed.includes(v)) return { value: null, problem: `${key} "${v}" is not one of ${allowed.join('|')}` };
  return { value: v, problem: null, text };
}

const buildStatus = (id) => readMarker(path.join(jobDir(id), 'build.md'), 'STATUS', ['READY', 'BLOCKED']);
const verdictOf = (id, n, lens) => readMarker(reviewFile(id, n, lens), 'VERDICT', ['PASS', 'CHANGES']);
const decisionOf = (id) => readMarker(path.join(jobDir(id), 'decision.md'), 'DECISION', ['APPROVE', 'ESCALATE']);

// The paragraph under the first heading-ish line, for needs-human summaries.
function reasonFrom(text, fallback) {
  if (!text) return fallback;
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).slice(1).map((l) => l.trim().replace(/^([-*]|\d+\.)\s+/, '')).filter((l) => l && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('<!--'));
  return (lines[0] || fallback).slice(0, 300);
}

// Refreshes job.reviews (and the round record) from the round's files.
function syncVerdicts(job) {
  const n = job.round;
  const out = { verdicts: {}, missing: [], invalid: {} };
  for (const lens of job.reviewers) {
    const v = verdictOf(job.id, n, lens);
    if (v.value) out.verdicts[lens] = v.value;
    else {
      out.verdicts[lens] = 'pending';
      out.missing.push(lens);
      if (v.problem !== 'missing') out.invalid[lens] = v.problem;
    }
  }
  job.reviews = out.verdicts;
  const rec = job.rounds.find((r) => r.n === n);
  if (rec) {
    rec.verdicts = { ...out.verdicts };
    if (!out.missing.length && !rec.endedAt) rec.endedAt = now();
  }
  return out;
}

function withJobLock(id, fn) {
  return withLock(`job-${id}`, fn);
}

module.exports = {
  STAGES, TERMINAL, jobDir, jobFile, roundDir, reviewFile, listIds, resolveId, load, save, setStage, needsHuman,
  create, slugify, buildStatus, verdictOf, decisionOf, reasonFrom, syncVerdicts, writeIndex, withJobLock,
};

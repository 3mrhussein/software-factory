'use strict';
// End-to-end tests for factory-cli. Run: node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sh, makeRepo, f, fail, fake, jobDir, write, PKG } = require('./helpers');

const WEB_APP = {
  'package.json': JSON.stringify({
    name: 'web-app',
    scripts: { test: 'node -e 0', lint: 'node -e 0', dev: 'vite' },
    dependencies: { react: '18.3.1', '@prisma/client': '5.0.0' },
    devDependencies: { typescript: '5.4.0', vite: '5.0.0' },
  }),
  'package-lock.json': '{}',
  'tsconfig.json': '{}',
  'src/App.tsx': 'export const App = () => null;\n',
  'prisma/schema.prisma': 'model User { id Int @id }\n',
};

function initRepo(files = WEB_APP, applyArgs = []) {
  const { root } = makeRepo(files);
  f(root, 'init', 'apply', '--guidance', 'none', ...applyArgs);
  f(root, 'config', 'set', 'commands.setup', 'null');
  sh('git add -A && git commit -qm "chore: init factory"', root);
  return root;
}

test('detect: web + database repo toggles ui-ux and database on, architecture off', () => {
  const { root } = makeRepo(WEB_APP);
  const d = f(root, 'init', 'detect');
  assert.deepEqual(d.project.languages, ['TypeScript']);
  assert.equal(d.project.frontend.kind, 'web');
  assert.equal(d.project.database.detected, true);
  assert.equal(d.commands.setup, 'npm ci');
  assert.equal(d.commands.dev, 'npm run dev -- --port {port}');
  assert.equal(d.suggestion.reviewers['ui-ux'].enabled, true);
  assert.equal(d.suggestion.reviewers.database.enabled, true);
  assert.equal(d.suggestion.reviewers.architecture.enabled, false);
});

test('detect: python library has no UI/DB reviewers; go workspace enables architecture', () => {
  const py = makeRepo({ 'pyproject.toml': '[project]\nname="lib"\n[tool.pytest.ini_options]\n[tool.ruff]\n', 'uv.lock': '', 'src/lib/__init__.py': '' }).root;
  const d = f(py, 'init', 'detect');
  assert.deepEqual(d.project.languages, ['Python']);
  assert.equal(d.commands.setup, 'uv sync');
  assert.equal(d.commands.test, 'uv run pytest');
  assert.equal(d.commands.lint, 'uv run ruff check .');
  assert.equal(d.suggestion.reviewers['ui-ux'].enabled, false);
  assert.equal(d.suggestion.reviewers.database.enabled, false);

  const mono = makeRepo({
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n", 'turbo.json': '{}',
    'packages/a/package.json': '{"name":"a"}', 'packages/b/package.json': '{"name":"b"}',
  }).root;
  const m = f(mono, 'init', 'detect');
  assert.equal(m.project.monorepo.enabled, true);
  assert.deepEqual(m.project.monorepo.packages, ['packages/a', 'packages/b']);
  assert.equal(m.suggestion.reviewers.architecture.enabled, true);
  assert.equal(m.commands.setup, 'pnpm install --frozen-lockfile');
});

test('init apply writes a valid config, FACTORY.md and jobs/.gitignore; re-run keeps manual choices', () => {
  const { root } = makeRepo(WEB_APP);
  f(root, 'init', 'apply', '--guidance', 'CLAUDE.md');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'factory/config.json'), 'utf8'));
  assert.equal(cfg.initialized, true);
  assert.equal(cfg.roles.reviewers.database.enabled, true);
  assert.match(fs.readFileSync(path.join(root, 'factory/FACTORY.md'), 'utf8'), /FACTORY:AUTO:BEGIN[\s\S]*npm run test/);
  assert.ok(fs.existsSync(path.join(root, 'factory/jobs/.gitignore')));
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /software-factory:begin/);

  f(root, 'roles', 'disable', 'database', '--reason', 'read replica only');
  f(root, 'config', 'set', 'commands.test', 'npm run test:ci');
  fs.appendFileSync(path.join(root, 'factory/FACTORY.md'), '\nHAND-WRITTEN NOTE\n');
  f(root, 'init', 'apply', '--guidance', 'CLAUDE.md');
  const again = JSON.parse(fs.readFileSync(path.join(root, 'factory/config.json'), 'utf8'));
  assert.equal(again.roles.reviewers.database.enabled, true, 'detector re-enables a lens it finds evidence for');
  assert.equal(again.commands.test, 'npm run test:ci', 'manual command kept');
  assert.match(fs.readFileSync(path.join(root, 'factory/FACTORY.md'), 'utf8'), /HAND-WRITTEN NOTE/);
  assert.equal((fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').match(/software-factory:begin/g) || []).length, 1);
});

test('config set rejects schema violations and unknown keys', () => {
  const root = initRepo();
  assert.match(fail(root, 'config', 'set', 'delivery.strategy', 'ftp'), /must be one of/);
  assert.match(fail(root, 'config', 'set', 'loop.maxReworkRounds', '"two"'), /expected integer/);
  assert.match(fail(root, 'config', 'set', 'git.colour', 'blue'), /unknown property/);
});

test('happy path: spec → build → review (CHANGES) → resume → review (PASS) → approve → direct merge', () => {
  const root = initRepo();
  const { job: id } = f(root, 'job', 'new', 'Add a dark mode toggle to settings');
  assert.match(id, /^001-dark-mode-toggle-settings$/);

  let a = f(root, 'tick', id);
  assert.equal(a.action, 'spawn');
  assert.equal(a.agents[0].subagent_type, 'spec-writer');
  let job = f(root, 'job', 'show', id);
  assert.ok(fs.existsSync(job.worktree), 'worktree created');

  fake.spec(root, id);
  a = f(root, 'tick', id);
  assert.equal(a.agents[0].subagent_type, 'builder');
  assert.equal(a.agents[0].name, `builder-${id}`);

  fake.build(root, job);
  a = f(root, 'tick', id);
  assert.equal(a.action, 'spawn');
  assert.equal(a.parallel, true);
  assert.deepEqual(a.agents.map((x) => x.subagent_type).sort(), ['reviewer-code', 'reviewer-database', 'reviewer-security', 'reviewer-ui-ux']);
  assert.ok(fs.existsSync(path.join(jobDir(root, id), 'round-1', 'build.md')), 'build.md snapshotted into round-1');

  fake.review(root, id, 1, 'code', 'CHANGES');
  let r = f(root, 'record', id, 'code');
  assert.equal(r.verdict, 'CHANGES');
  for (const l of ['security', 'ui-ux', 'database']) fake.review(root, id, 1, l, 'PASS');

  a = f(root, 'tick', id);
  assert.equal(a.action, 'resume');
  assert.equal(a.resume.to, `builder-${id}`);
  assert.equal(a.fallback.subagent_type, 'builder');
  job = f(root, 'job', 'show', id);
  assert.equal(job.stage, 'build');
  assert.equal(job.resumesUsed, 1);
  assert.ok(!fs.existsSync(path.join(jobDir(root, id), 'build.md')), 'stale build.md moved aside');

  const brief = f(root, 'brief', id, 'builder');
  assert.match(brief, /Mode: RESUME/);
  assert.match(brief, /round-1\/review-code\.md/);

  fake.build(root, job, { file: 'fix.txt' });
  a = f(root, 'tick', id);
  assert.equal(a.round, 2);
  for (const l of ['code', 'security', 'ui-ux', 'database']) fake.review(root, id, 2, l, 'PASS');
  a = f(root, 'tick', id);
  assert.equal(a.agents[0].subagent_type, 'approver');
  assert.match(f(root, 'brief', id, 'approver'), /Sensitive paths touched \(approval\.escalatePaths\): none/);

  fake.decide(root, id, 'APPROVE');
  a = f(root, 'tick', id);
  assert.equal(a.action, 'run');
  assert.match(a.command, /deliver/);
  const d = f(root, 'deliver', id);
  assert.equal(d.delivery.status, 'merged');
  assert.equal(sh('git log -1 --format=%s', root), `Merge factory/${id}: Add a dark mode toggle to settings`);
  assert.ok(fs.existsSync(path.join(root, 'fix.txt')), 'merged content on main');
  job = f(root, 'job', 'show', id);
  assert.equal(job.stage, 'delivered');
  assert.ok(!fs.existsSync(job.worktree), 'worktree removed');
  assert.equal(sh(`git branch --list factory/${id}`, root), '', 'branch deleted');
  assert.ok(fs.existsSync(path.join(jobDir(root, id), 'diff.patch')), 'diff snapshot kept for the dashboard');
  assert.equal(f(root, 'tick', id).action, 'done');
  assert.deepEqual(job.rounds.map((x) => x.verdicts.code), ['CHANGES', 'PASS']);
});

test('rework budget: CHANGES three rounds in a row escalates with a factory-written decision', () => {
  const root = initRepo(WEB_APP);
  f(root, 'roles', 'disable', 'ui-ux');
  f(root, 'roles', 'disable', 'database');
  sh('git add -A && git commit -qm cfg', root);
  const { job: id } = f(root, 'job', 'new', 'Rate limit login');
  f(root, 'tick', id);
  fake.spec(root, id);
  f(root, 'tick', id);
  const job = f(root, 'job', 'show', id);
  assert.deepEqual(job.reviewers, ['code', 'security']);
  let a;
  for (let n = 1; n <= 3; n++) {
    fake.build(root, job, { file: `r${n}.txt` });
    a = f(root, 'tick', id);
    assert.equal(a.round, n);
    fake.review(root, id, n, 'code', 'CHANGES');
    fake.review(root, id, n, 'security', 'PASS');
    a = f(root, 'tick', id);
  }
  assert.equal(a.action, 'halt');
  assert.match(a.attention, /review rounds exhausted/);
  assert.match(fs.readFileSync(path.join(jobDir(root, id), 'decision.md'), 'utf8'), /^DECISION: ESCALATE/);

  // Human rework gives a fresh budget and a fresh builder.
  a = f(root, 'rework', id, '--note', 'Use a sliding window, not a fixed one');
  assert.equal(a.action, 'spawn');
  assert.match(f(root, 'brief', id, 'builder'), /Mode: REWORK[\s\S]*rework-1\.md/);
  assert.ok(fs.existsSync(path.join(jobDir(root, id), 'round-3', 'decision.md')), 'old decision archived');
  fake.build(root, job, { file: 'r4.txt' });
  assert.equal(f(root, 'tick', id).round, 4);
});

test('builder BLOCKED, missing outputs and READY-without-commits go to needs-human', () => {
  const root = initRepo();
  const { job: id } = f(root, 'job', 'new', 'Integrate payments');
  f(root, 'tick', id);
  fake.spec(root, id);
  f(root, 'tick', id);
  const job = f(root, 'job', 'show', id);
  fake.build(root, job, { status: 'BLOCKED' });
  const a = f(root, 'tick', id);
  assert.equal(a.action, 'halt');
  assert.match(a.attention, /BLOCKED: Need the API key decision/);

  const { job: id2 } = f(root, 'job', 'new', 'Another thing');
  f(root, 'tick', id2);
  fake.spec(root, id2);
  f(root, 'tick', id2);
  write(path.join(jobDir(root, id2), 'build.md'), 'STATUS: READY\n');
  assert.match(f(root, 'tick', id2).attention, /no commits ahead/);

  const { job: id3 } = f(root, 'job', 'new', 'Third thing');
  f(root, 'tick', id3);
  let b = f(root, 'tick', id3); // spec-writer "finished" without output → one retry
  assert.equal(b.action, 'spawn');
  b = f(root, 'tick', id3); // retries exhausted
  assert.equal(b.action, 'halt');
  assert.match(b.attention, /spec-writer finished without writing spec\.md/);
});

test('reviewer with malformed verdict is retried once, then escalated', () => {
  const root = initRepo();
  f(root, 'roles', 'disable', 'ui-ux');
  f(root, 'roles', 'disable', 'database');
  sh('git add -A && git commit -qm cfg', root);
  const { job: id } = f(root, 'job', 'new', 'Add audit log');
  f(root, 'tick', id);
  fake.spec(root, id);
  f(root, 'tick', id);
  fake.build(root, f(root, 'job', 'show', id));
  f(root, 'tick', id);
  fake.review(root, id, 1, 'code', 'PASS');
  write(path.join(jobDir(root, id), 'round-1', 'review-security.md'), 'Looks good to me!\n');
  let a = f(root, 'tick', id);
  assert.deepEqual(a.agents.map((x) => x.subagent_type), ['reviewer-security']);
  assert.ok(!fs.existsSync(path.join(jobDir(root, id), 'round-1', 'review-security.md')), 'invalid file removed before retry');
  a = f(root, 'tick', id);
  assert.equal(a.action, 'halt');
  assert.match(a.attention, /security/);
});

test('approver ESCALATE → human approve → merge; dirty main checkout blocks merge safely', () => {
  const root = initRepo();
  f(root, 'roles', 'disable', 'ui-ux');
  f(root, 'roles', 'disable', 'database');
  f(root, 'roles', 'disable', 'security');
  sh('git add -A && git commit -qm cfg', root);
  const { job: id } = f(root, 'job', 'new', 'Change CI pipeline');
  f(root, 'tick', id);
  fake.spec(root, id);
  f(root, 'tick', id);
  const job = f(root, 'job', 'show', id);
  fake.build(root, job, { file: '.github/workflows/ci.yml', content: 'on: push\n' });
  f(root, 'tick', id);
  fake.review(root, id, 1, 'code', 'PASS');
  f(root, 'tick', id);
  assert.match(f(root, 'brief', id, 'approver'), /Sensitive paths touched \(approval\.escalatePaths\): \.github\/workflows\/ci\.yml/);
  fake.decide(root, id, 'ESCALATE');
  let a = f(root, 'tick', id);
  assert.equal(a.action, 'halt');
  assert.match(a.attention, /approver escalated: Touches deploy config/);

  fs.appendFileSync(path.join(root, 'package.json'), '\n');
  a = f(root, 'approve', id);
  assert.equal(a.action, 'run');
  const d = f(root, 'deliver', id);
  assert.equal(d.action, 'halt');
  assert.match(d.attention, /uncommitted changes \(package\.json\)/);
  assert.equal(sh('git status --porcelain --untracked-files=no', root), 'M package.json', 'nothing merged into a dirty checkout');

  sh('git checkout -q package.json', root);
  f(root, 'approve', id);
  assert.equal(f(root, 'deliver', id).delivery.status, 'merged');
  assert.ok(fs.existsSync(path.join(root, '.github/workflows/ci.yml')));
});

test('approval.mode=human stops after APPROVE until /factory approve', () => {
  const root = initRepo();
  f(root, 'config', 'set', 'approval.mode', 'human');
  for (const l of ['ui-ux', 'database', 'security', 'code']) f(root, 'roles', 'disable', l);
  sh('git add -A && git commit -qm cfg', root);
  const { job: id } = f(root, 'job', 'new', 'Tiny change');
  f(root, 'tick', id);
  fake.spec(root, id);
  f(root, 'tick', id);
  fake.build(root, f(root, 'job', 'show', id));
  const a = f(root, 'tick', id);
  assert.equal(a.agents[0].subagent_type, 'approver', 'no reviewers active → straight to approver');
  fake.decide(root, id, 'APPROVE');
  assert.match(f(root, 'tick', id).attention, /approval\.mode is "human"/);
  assert.equal(f(root, 'approve', id).action, 'run');
});

test('backlog: add, claim in order, empty', () => {
  const root = initRepo();
  f(root, 'backlog', 'add', 'First feature');
  f(root, 'backlog', 'add', 'Second feature');
  const one = f(root, 'next');
  assert.equal(one.feature, 'First feature');
  assert.match(fs.readFileSync(path.join(root, 'factory/backlog.md'), 'utf8'), new RegExp(`- \\[x\\] First feature → ${one.job}`));
  assert.equal(f(root, 'job', 'show', one.job).source, 'backlog');
  assert.equal(f(root, 'next').feature, 'Second feature');
  assert.equal(f(root, 'next').action, 'done');
});

test('parallel job creation never reuses an id', async () => {
  const root = initRepo();
  const { spawn } = require('child_process');
  const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
    const p = spawn('node', [path.join(root, 'factory/bin/factory-cli.js'), 'job', 'new', `Feature number ${i}`], { cwd: root });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(JSON.parse(out).job));
  }));
  const ids = await Promise.all(runs);
  assert.equal(new Set(ids.map((id) => id.split('-')[0])).size, 6);
  const index = JSON.parse(fs.readFileSync(path.join(root, 'factory/jobs/index.json'), 'utf8'));
  assert.equal(index.jobs.length, 6);
});

test('CLI invoked from inside a job worktree still writes to the main checkout', () => {
  const root = initRepo();
  const { job: id } = f(root, 'job', 'new', 'Worktree check');
  f(root, 'tick', id);
  const job = f(root, 'job', 'show', id);
  const res = require('child_process').spawnSync('node', [path.join(job.worktree, 'factory/bin/factory-cli.js'), 'job', 'show', id], { cwd: job.worktree, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).id, id);
  assert.ok(!fs.existsSync(path.join(job.worktree, 'factory/jobs', id)), 'no state written inside the worktree');
});

test('cancel --purge removes worktree and branch; prune cleans finished jobs', () => {
  const root = initRepo();
  const { job: id } = f(root, 'job', 'new', 'Throwaway');
  f(root, 'tick', id);
  const job = f(root, 'job', 'show', id);
  f(root, 'cancel', id, '--purge');
  assert.ok(!fs.existsSync(job.worktree));
  assert.equal(sh(`git branch --list ${job.branch}`, root), '');
  assert.deepEqual(f(root, 'worktree', 'prune'), []);
});

test('install into a repo with existing tailored files does not clobber them', () => {
  const { root } = makeRepo({});
  fs.writeFileSync(path.join(root, '.claude/agents/builder.md'), 'custom');
  const res = require('child_process').spawnSync('node', [path.join(PKG, 'factory/bin/factory-cli.js'), 'install', root], { encoding: 'utf8' });
  const report = JSON.parse(res.stdout);
  assert.ok(report.skipped.includes('.claude/agents/builder.md'));
  assert.equal(fs.readFileSync(path.join(root, '.claude/agents/builder.md'), 'utf8'), 'custom');
});

test('dashboard server: state, files, diff, path traversal, backlog write, SSE', async () => {
  const root = initRepo();
  const { job: id } = f(root, 'job', 'new', 'Server check');
  f(root, 'tick', id);
  fake.spec(root, id);
  const { serve } = require(path.join(root, 'factory/lib/server.js'));
  const srv = await serve({ port: 0 });
  const base = srv.url.replace('/dashboard/', '');
  try {
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.jobs[0].id, id);
    assert.equal(st.config.initialized, true);
    const files = await (await fetch(`${base}/api/jobs/${id}/files`)).json();
    assert.ok(files.files.includes('spec.md'));
    assert.match(await (await fetch(`${base}/api/jobs/${id}/file?path=spec.md`)).text(), /Acceptance criteria/);
    assert.equal((await fetch(`${base}/api/jobs/${id}/file?path=../../config.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/${id}/file?path=..%2F..%2Fconfig.json`)).status, 404);
    assert.equal((await fetch(`${base}/dashboard/index.html`)).status, 200);
    assert.equal((await fetch(`${base}/jobs/index.json`)).status, 200, 'static mode paths also served');
    const add = await fetch(`${base}/api/backlog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'From the dashboard' }) });
    assert.equal(add.status, 200);
    const evil = await fetch(`${base}/api/backlog`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"text":"x"}' });
    assert.equal(evil.status, 403);
    const diff = await (await fetch(`${base}/api/jobs/${id}/diff`)).json();
    assert.equal(diff.live, true);
  } finally {
    srv.close();
  }
});

test('qc: report aggregates verdicts, findings, contract violations; trace and check work', () => {
  const root = initRepo();
  f(root, 'roles', 'disable', 'ui-ux');
  f(root, 'roles', 'disable', 'database');
  sh('git add -A && git commit -qm cfg', root);
  const { job: id } = f(root, 'job', 'new', 'Add export button');
  f(root, 'tick', id);
  fake.spec(root, id);
  f(root, 'tick', id);
  const job = f(root, 'job', 'show', id);
  fake.build(root, job);
  f(root, 'tick', id);
  const table = (rows) => `\n## Findings\n| # | Severity | Location | Issue | Required change |\n| - | - | - | - | - |\n${rows}\n`;
  write(path.join(jobDir(root, id), 'round-1', 'review-code.md'), `VERDICT: CHANGES\n${table('| 1 | major | `src/export.ts:10` | no tests | add tests |')}`);
  write(path.join(jobDir(root, id), 'round-1', 'review-security.md'), `VERDICT: CHANGES\n${table('| 1 | nit | `src/export.ts:3` | naming | rename |')}`);
  f(root, 'tick', id);
  fake.build(root, job, { file: 'b.txt' });
  f(root, 'tick', id);
  for (const l of ['code', 'security']) fake.review(root, id, 2, l, 'PASS');
  f(root, 'tick', id);
  fake.decide(root, id, 'APPROVE');
  f(root, 'tick', id);
  f(root, 'deliver', id);

  const r = f(root, 'qc', 'report', '--json');
  assert.equal(r.jobs.total, 1);
  assert.equal(r.flow.delivered, 1);
  assert.equal(r.flow.avgRounds, 2);
  assert.equal(r.flow.firstPassRatePct, 0);
  assert.equal(r.lenses.code.changes, 1);
  assert.equal(r.lenses.code.findings.major, 1);
  assert.deepEqual(r.hotspots, [{ file: 'src/export.ts', blockingFindings: 1 }]);
  assert.equal(r.contractViolations.length, 1);
  assert.match(r.contractViolations[0], /security: CHANGES without a blocker\/major/);
  assert.equal(r.approver.APPROVE, 1);

  const t = f(root, 'qc', 'trace', id);
  assert.match(t, /R1: code=CHANGES security=CHANGES/);
  assert.match(t, /code major: src\/export\.ts:10: no tests/);

  assert.match(f(root, 'qc', 'check'), /qc check: ok/);
  fs.writeFileSync(path.join(root, 'factory/templates/review.md'), 'Verdict: pass\n');
  fs.writeFileSync(path.join(root, '.claude/agents/reviewer-perf.md'), '---\nname: reviewer-perf\ntools: Read, Write, Bash\nskills:\n  - perf-budget\n---\nrun brief\n');
  const res = require('child_process').spawnSync('node', [path.join(root, 'factory/bin/factory-cli.js'), 'qc', 'check', '--json'], { encoding: 'utf8' });
  const checks = JSON.parse(res.stdout).checks;
  assert.ok(checks.some((c) => c.level === 'error' && /review\.md/.test(c.item)), 'broken marker detected');
  assert.ok(checks.some((c) => c.level === 'warn' && /reviewer-perf/.test(c.item) && /never run/.test(c.detail)), 'orphan lens agent detected');
});

test('qc agent: follow-up policy, brief, journal, index', () => {
  const root = initRepo();
  for (const l of ['ui-ux', 'database', 'security']) f(root, 'roles', 'disable', l);
  f(root, 'config', 'set', 'qc', '{"autoReview":"needs-human","auditEvery":2,"model":"sonnet"}');
  sh('git add -A && git commit -qm cfg', root);
  const run = (feature, outcome) => {
    const { job: id } = f(root, 'job', 'new', feature);
    f(root, 'tick', id);
    fake.spec(root, id);
    f(root, 'tick', id);
    fake.build(root, f(root, 'job', 'show', id), { file: `${id}.txt`, status: outcome === 'blocked' ? 'BLOCKED' : 'READY' });
    const a = f(root, 'tick', id);
    if (outcome === 'blocked') return { id, a };
    fake.review(root, id, 1, 'code', 'PASS');
    f(root, 'tick', id);
    fake.decide(root, id, 'APPROVE');
    f(root, 'tick', id);
    return { id, a: f(root, 'deliver', id) };
  };
  const blocked = run('Blocked thing', 'blocked');
  assert.equal(blocked.a.action, 'halt');
  assert.equal(blocked.a.followUp.subagent_type, 'factory-qc');
  assert.equal(blocked.a.followUp.run_in_background, true);
  assert.equal(blocked.a.followUp.model, 'sonnet');
  assert.match(blocked.a.followUp.prompt, new RegExp(`qc brief --job ${blocked.id}`));
  assert.equal(f(root, 'tick', blocked.id).followUp, undefined, 'same outcome is reviewed once');

  const d1 = run('First delivery', 'deliver');
  assert.equal(d1.a.followUp, undefined, 'delivered jobs are not post-mortemed under needs-human policy');
  const d2 = run('Second delivery', 'deliver');
  assert.match(d2.a.followUp.prompt, /Factory audit after 2 delivered jobs/);

  const brief = f(root, 'qc', 'brief', '--job', blocked.id);
  assert.match(brief, /post-mortem of/);
  assert.match(brief, /OUTPUT: write exactly .*assessments\/\d{4}-\d{2}-\d{2}-job-/);
  assert.match(brief, /^HEALTH: GOOD/m);

  write(path.join(root, 'factory/qc/assessments/2026-10-10-job-x.md'), `HEALTH: ACT\n\n# QC assessment: Job ${blocked.id}\nScope: job ${blocked.id}\nDate: 2026-10-10\n\n## Verdict\nSpec lacked the API decision.\n\n## Findings\n| # | Severity | Area | Finding | Recommendation |\n| - | - | - | - | - |\n| 1 | high | agent | x | y |\n`);
  write(path.join(root, 'factory/qc/proposals/2026-10-10-spec-api.md'), '# Ask for API decisions in specs\nStatus: proposed\nType: prompt\n\n## Success metric & check-back\nBLOCKED rate below 5%\n');
  f(root, 'qc', 'journal', 'proposed', 'spec-api', 'Spec-writer should surface API decisions.');
  assert.match(fail(root, 'qc', 'journal', 'maybe', 'x', 'y'), /journal status/);
  assert.deepEqual(f(root, 'qc', 'index'), { assessments: 1, proposals: 1, journal: 1 });
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'factory/qc/index.json'), 'utf8'));
  assert.equal(idx.assessments[0].health, 'ACT');
  assert.equal(idx.assessments[0].job, blocked.id);
  assert.equal(idx.assessments[0].verdict, 'Spec lacked the API decision.');
  assert.equal(idx.assessments[0].findings.high, 1);
  assert.equal(idx.proposals[0].status, 'proposed');
  assert.equal(idx.proposals[0].metric, 'BLOCKED rate below 5%');
  assert.ok(fs.existsSync(path.join(root, 'factory/qc/report.json')));
  const series = f(root, 'qc', 'series');
  assert.equal(series.unit, 'day');
  assert.equal(series.points[series.points.length - 1].cumDelivered, 2);
});

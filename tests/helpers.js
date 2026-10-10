'use strict';
// Test harness: builds throwaway git repos with the factory installed and
// plays the role of the agents by writing their output files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');

function sh(cmd, cwd) {
  return execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(files = {}, { name = 'app' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  const root = path.join(base, name);
  fs.mkdirSync(root);
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content);
  }
  sh('git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -qm init --allow-empty', root);
  const res = cli(root, ['install', root]);
  // install refuses to target the package itself; here target is a temp repo
  if (res.status !== 0) throw new Error(res.stderr);
  sh('git add -A && git commit -qm "add factory"', root);
  return { base, root };
}

function cli(root, args) {
  const bin = fs.existsSync(path.join(root, 'factory/bin/factory-cli.js')) ? path.join(root, 'factory/bin/factory-cli.js') : path.join(PKG, 'factory/bin/factory-cli.js');
  return spawnSync('node', [bin, ...args], { cwd: root, encoding: 'utf8' });
}

function f(root, ...args) {
  const res = cli(root, args);
  if (res.status !== 0) throw new Error(`factory-cli ${args.join(' ')} failed (${res.status}):\n${res.stderr}${res.stdout}`);
  const out = res.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function fail(root, ...args) {
  const res = cli(root, args);
  if (res.status === 0) throw new Error(`expected failure: factory-cli ${args.join(' ')}\n${res.stdout}`);
  return res.stderr;
}

const jobDir = (root, id) => path.join(root, 'factory', 'jobs', id);
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// ---- fake agents --------------------------------------------------------

const fake = {
  spec(root, id) {
    write(path.join(jobDir(root, id), 'spec.md'), `# Spec ${id}\n\n## Acceptance criteria\n- [ ] **AC1**: Given x, when y, then z\n`);
  },
  build(root, job, { status = 'READY', file = 'feature.txt', content = 'hello\n' } = {}) {
    write(path.join(job.worktree, file), content);
    sh(`git add -A && git commit -qm "feat: ${file}"`, job.worktree);
    write(path.join(jobDir(root, job.id), 'build.md'), `STATUS: ${status}\n\n# Build\n\n${status === 'BLOCKED' ? 'Need the API key decision.\n' : ''}`);
  },
  review(root, id, round, lens, verdict) {
    write(path.join(jobDir(root, id), `round-${round}`, `review-${lens}.md`), `VERDICT: ${verdict}\n\n# Review\n`);
  },
  decide(root, id, decision) {
    write(path.join(jobDir(root, id), 'decision.md'), `DECISION: ${decision}\n\n# Decision\n\n## Rationale\n- Touches deploy config.\n`);
  },
};

module.exports = { PKG, sh, makeRepo, cli, f, fail, fake, jobDir, write };

'use strict';
// `factory-cli install <target>` copies this package into another repo.
// `factory-cli vendor` downloads the dashboard's pinned browser libraries for
// fully offline use (otherwise the dashboard falls back to a CDN).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { die } = require('./util');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

// Always refreshed on upgrade: pure code, never customised per repo.
const CODE = ['factory/bin', 'factory/lib', 'factory/schema', 'factory/dashboard'];
// Copied when missing; on upgrade only with --force (repos may tailor them).
const TAILORABLE = [
  'factory/templates', 'factory/README.md',
  '.claude/skills/factory', '.claude/skills/factory-init', '.claude/skills/factory-qc', 'factory/qc/README.md',
  ...['spec-writer', 'builder', 'approver', 'reviewer-code', 'reviewer-security', 'reviewer-ui-ux', 'reviewer-database', 'reviewer-architecture']
    .map((a) => `.claude/agents/${a}.md`),
];
// Per-repo state: created once, never overwritten.
const STATE = ['factory/config.json'];

function filesUnder(rel) {
  const abs = path.join(PKG_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.DS_Store' || e.name.endsWith('.tmp')) return [];
    return e.isDirectory() ? filesUnder(path.join(rel, e.name)) : [path.join(rel, e.name)];
  });
}

const same = (a, b) => fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

function install(target, { force = false, dryRun = false } = {}) {
  if (!target) die('usage: factory-cli install <target-repo-dir> [--force] [--dry-run]');
  const dest = path.resolve(target);
  if (!fs.existsSync(dest)) die(`${dest} does not exist`);
  if (dest === PKG_ROOT) die('target is the factory package itself');
  const report = { target: dest, written: [], unchanged: [], skipped: [] };
  const copy = (rel, mode) => {
    const from = path.join(PKG_ROOT, rel);
    const to = path.join(dest, rel);
    if (same(from, to)) return report.unchanged.push(rel);
    if (fs.existsSync(to) && (mode === 'state' || (mode === 'tailorable' && !force))) return report.skipped.push(rel);
    report.written.push(rel);
    if (dryRun) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (rel.startsWith('factory/bin/')) fs.chmodSync(to, 0o755);
  };
  CODE.flatMap(filesUnder).forEach((f) => copy(f, 'code'));
  TAILORABLE.flatMap(filesUnder).forEach((f) => copy(f, 'tailorable'));
  STATE.flatMap(filesUnder).forEach((f) => copy(f, 'state'));
  if (!dryRun) {
    const jobsDir = path.join(dest, 'factory', 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const gi = path.join(jobsDir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Job folders are runtime state; keep them out of git.\n*\n!.gitignore\n');
  }
  report.next = [
    `cd ${dest}`,
    'claude   # then run: /factory-init',
  ];
  return report;
}

// ---------------------------------------------------------------- vendor

const VENDOR = {
  'react.production.min.js': 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'react-dom.production.min.js': 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  'htm.umd.js': 'https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.umd.js',
  'marked.min.js': 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
};

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function vendor() {
  const dir = path.join(PKG_ROOT, 'factory', 'dashboard', 'vendor');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [name, url] of Object.entries(VENDOR)) {
    const buf = await fetchUrl(url);
    fs.writeFileSync(path.join(dir, name), buf);
    out.push(`${name} ${(buf.length / 1024).toFixed(0)}KB ← ${url}`);
  }
  const index = path.join(PKG_ROOT, 'factory', 'dashboard', 'index.html');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('var vendored = false;', 'var vendored = true;'));
  out.push('index.html now prefers the vendored copies');
  return out;
}

module.exports = { install, vendor, VENDOR, PKG_ROOT };

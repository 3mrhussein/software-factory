'use strict';
// Shared helpers: path resolution, atomic writes, locks, git/shell exec, globs.
// Zero dependencies — only Node built-ins.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

class FactoryError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function die(message, code) {
  throw new FactoryError(message, code);
}

const now = () => new Date().toISOString();

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------- exec

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
  } catch (err) {
    if (opts.allowFail) return null;
    const stderr = (err.stderr || '').toString().trim();
    die(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

// Runs a shell command; returns { ok, status, stdout, stderr }.
function sh(command, opts = {}) {
  const res = spawnSync(command, {
    cwd: opts.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: (res.stderr || '') + (res.error ? String(res.error.message) : ''),
  };
}

function which(bin) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.split('\n')[0].trim() : null;
}

// ---------------------------------------------------------------- paths

let cachedPaths = null;

// Resolves the MAIN checkout even when the CLI is invoked from inside a job
// worktree, so job state always lands in <main>/factory/jobs/.
function paths() {
  if (cachedPaths) return cachedPaths;
  const localFactory = path.resolve(__dirname, '..');
  let root = path.dirname(localFactory);
  let factory = localFactory;
  const top = git(['rev-parse', '--show-toplevel'], { cwd: localFactory, allowFail: true });
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: localFactory, allowFail: true });
  if (top && common) {
    const rel = path.relative(top, localFactory);
    root = path.basename(common) === '.git' ? path.dirname(common) : top;
    factory = path.join(root, rel);
    if (!fs.existsSync(factory)) factory = localFactory; // factory not committed on this branch
  }
  cachedPaths = {
    root,
    factory,
    repoName: path.basename(root),
    config: path.join(factory, 'config.json'),
    jobs: path.join(factory, 'jobs'),
    backlog: path.join(factory, 'backlog.md'),
    templates: path.join(factory, 'templates'),
    schema: path.join(factory, 'schema'),
    dashboard: path.join(factory, 'dashboard'),
    cli: path.join(factory, 'bin', 'factory-cli.js'),
    isGit: Boolean(top),
  };
  return cachedPaths;
}

const rel = (p) => path.relative(paths().root, p) || '.';

// ---------------------------------------------------------------- files

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) die(`${rel(file)} is not valid JSON: ${err.message}`);
    throw err;
  }
}

// Write to a temp file in the same directory, then rename: readers (the
// dashboard, parallel sessions) never observe a half-written file.
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const writeJSONAtomic = (file, obj) => writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const firstLine = (text) => (text || '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() || '';

// Cross-process lock using mkdir (atomic on every filesystem we care about).
function withLock(name, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  const dir = path.join(paths().jobs, `.lock-${name}`);
  fs.mkdirSync(paths().jobs, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* raced with another cleaner */ }
      if (Date.now() - start > timeoutMs) die(`timed out waiting for lock ${name}`);
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- globs

// Minimal glob → RegExp: `**` spans directories, `*` and `?` do not.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

// Fills {placeholders} and {{dotted.placeholders}}.
function fill(str, vars) {
  return str
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
      const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
      return v == null ? '' : String(v);
    })
    .replace(/\{(\w+)\}/g, (m, key) => (vars[key] == null ? m : String(vars[key])));
}

module.exports = {
  FactoryError, die, now, sleepMs, git, sh, which, paths, rel,
  readJSON, readText, writeFileAtomic, writeJSONAtomic, firstLine, withLock,
  globToRegExp, matchesAny, fill,
};

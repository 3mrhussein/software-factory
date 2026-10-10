'use strict';
// `factory-cli serve`: zero-dependency local server for the dashboard.
// Serves factory/ statically (so the dashboard also works under any static
// server) plus a small JSON API with live updates over Server-Sent Events.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { paths } = require('./util');
const config = require('./config');
const jobs = require('./jobs');
const backlog = require('./backlog');
const worktree = require('./worktree');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.patch': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Resolves `rel` under `base`, refusing anything that escapes it.
function safeJoin(base, rel) {
  const target = path.resolve(base, `.${path.sep}${decodeURIComponent(rel)}`);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

function listFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.') || e.name.endsWith('.tmp')) return [];
    const relp = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return listFiles(path.join(dir, e.name), relp);
    return /\.(md|log|txt|patch|json)$/.test(e.name) ? [relp] : [];
  });
}

function state() {
  let cfg = null;
  let configError = null;
  try {
    cfg = config.load();
  } catch (err) {
    configError = err.message;
  }
  const list = [];
  for (const id of jobs.listIds()) {
    try {
      list.push(jobs.load(id));
    } catch (err) {
      list.push({ id, invalid: err.message });
    }
  }
  return { server: true, repo: paths().repoName, root: paths().root, config: cfg, configError, jobs: list, backlog: backlog.list(), at: new Date().toISOString() };
}

// Cheap change signature: mtimes of config, backlog and every job file.
function signature() {
  const h = crypto.createHash('sha1');
  const stamp = (f) => {
    try {
      h.update(`${f}:${fs.statSync(f).mtimeMs};`);
    } catch { /* missing is a state too */ }
  };
  stamp(paths().config);
  stamp(paths().backlog);
  for (const id of jobs.listIds()) {
    const dir = jobs.jobDir(id);
    for (const f of listFiles(dir)) stamp(path.join(dir, f));
  }
  return h.digest('hex');
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

function serve({ port = 4317, host = '127.0.0.1' } = {}) {
  const factoryDir = paths().factory;
  const clients = new Set();
  let sig = signature();

  const timer = setInterval(() => {
    if (!clients.size) return;
    const next = signature();
    if (next === sig) return;
    sig = next;
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ sig })}\n\n`);
  }, 800);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      // Writes only from our own origin: blocks drive-by requests from other sites.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin write refused' });
        if (!/application\/json/.test(req.headers['content-type'] || '') && req.method === 'POST') return send(res, 415, { error: 'JSON only' });
      }

      if (p === '/') {
        res.writeHead(302, { Location: '/dashboard/' });
        return res.end();
      }
      if (p === '/api/state') return send(res, 200, state());
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ sig })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (p === '/api/backlog' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, { backlog: backlog.add(body.text) });
      }
      const delItem = p.match(/^\/api\/backlog\/(\d+)$/);
      if (delItem && req.method === 'DELETE') return send(res, 200, { backlog: backlog.remove(Number(delItem[1])) });

      const m = p.match(/^\/api\/jobs\/([^/]+)\/(files|file|diff)$/);
      if (m) {
        const id = jobs.resolveId(decodeURIComponent(m[1]));
        const dir = jobs.jobDir(id);
        if (m[2] === 'files') return send(res, 200, { files: listFiles(dir) });
        if (m[2] === 'diff') {
          const job = jobs.load(id);
          return send(res, 200, { diff: worktree.diff(job), stat: worktree.diff(job, { stat: true }), live: worktree.branchExists(job.branch) });
        }
        const target = safeJoin(dir, url.searchParams.get('path') || '');
        if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return send(res, 404, { error: 'not found' });
        return send(res, 200, fs.readFileSync(target, 'utf8'), MIME[path.extname(target)] || 'text/plain; charset=utf-8');
      }
      if (p.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });

      // Static: factory/ tree (dashboard, config.json, jobs/, backlog.md).
      let target = safeJoin(factoryDir, p.replace(/^\/+/, ''));
      if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      if (!target || !fs.existsSync(target) || /[\\/]\.lock-/.test(target)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(target), MIME[path.extname(target)] || 'application/octet-stream');
    } catch (err) {
      return send(res, err.code === 1 ? 400 : 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}/dashboard/`, close: () => { clearInterval(timer); server.close(); } });
    });
  });
}

module.exports = { serve, state, signature };

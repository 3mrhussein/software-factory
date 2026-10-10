'use strict';
// Load, validate and mutate factory/config.json.

const path = require('path');
const { paths, readJSON, writeJSONAtomic, die, fill } = require('./util');
const schema = require('./schema');

function load({ requireInit = false } = {}) {
  const cfg = schema.check('config', readJSON(paths().config), 'factory/config.json');
  if (requireInit && !cfg.initialized) die('factory is not initialized: run /factory-init first');
  return cfg;
}

function save(cfg) {
  schema.check('config', cfg, 'factory/config.json');
  writeJSONAtomic(paths().config, cfg);
  return cfg;
}

const activeReviewers = (cfg) =>
  Object.entries(cfg.roles.reviewers).filter(([, r]) => r.enabled).map(([lens]) => lens);

// "a.b.c" → value. Array/object values are parsed from JSON; "null", "true",
// "false" and numbers are coerced; everything else stays a string.
function parseValue(raw) {
  if (raw === undefined) die('missing value');
  const t = raw.trim();
  if (/^(null|true|false|-?\d+(\.\d+)?)$/.test(t) || /^[[{"]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch { /* fall through to string */ }
  }
  return raw;
}

function getPath(obj, dotted) {
  if (!dotted) return obj;
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => {
    if (o[k] == null || typeof o[k] !== 'object') die(`config path "${dotted}" does not exist`);
    return o[k];
  }, obj);
  parent[last] = value; // unknown keys are rejected by schema validation in save()
}

function setRole(cfg, lens, enabled, reason) {
  const r = cfg.roles.reviewers[lens];
  if (!r) die(`unknown reviewer lens "${lens}" (have: ${Object.keys(cfg.roles.reviewers).join(', ')})`);
  r.enabled = enabled;
  if (reason) r.reason = reason;
  return cfg;
}

function worktreeRoot(cfg) {
  const p = paths();
  return path.resolve(p.root, fill(cfg.git.worktreeRoot, { repo: p.repoName }));
}

module.exports = { load, save, activeReviewers, parseValue, getPath, setPath, setRole, worktreeRoot };

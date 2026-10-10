'use strict';
// /factory-init backend: turn a detection report into config.json, render the
// repo profile (FACTORY.md), wire up .gitignore and agent guidance, and check
// that the configured tools really exist.

const fs = require('fs');
const path = require('path');
const { paths, readText, writeFileAtomic, fill, now, which, sh, die, git } = require('./util');
const config = require('./config');
const templates = require('./templates');
const { detect } = require('./detect');
const backlog = require('./backlog');

const AUTO_BEGIN = '<!-- FACTORY:AUTO:BEGIN -->';
const AUTO_END = '<!-- FACTORY:AUTO:END -->';
const GUIDE_BEGIN = '<!-- software-factory:begin -->';
const GUIDE_END = '<!-- software-factory:end -->';

function apply(opts = {}) {
  const report = detect();
  const cfg = config.load();
  const s = report.suggestion;

  // A re-run on an initialized factory refreshes detected facts but keeps the
  // human's / init agent's choices (commands, toggles, delivery) unless --reset.
  const fresh = !cfg.initialized || opts.reset;
  cfg.project = { ...cfg.project, ...report.project, summary: cfg.project.summary || null };
  for (const [k, v] of Object.entries(report.commands)) if (fresh || cfg.commands[k] == null) cfg.commands[k] = v;
  cfg.git.baseBranch = opts.base || (fresh ? report.git.baseBranch : cfg.git.baseBranch) || cfg.git.baseBranch;
  cfg.git.remote = report.git.remote;
  if (fresh) cfg.git.commitStyle = report.git.commitStyle;
  if (opts.branchPattern) cfg.git.branchPattern = opts.branchPattern;
  if (opts.delivery || fresh) cfg.delivery.strategy = opts.delivery || s.delivery;
  cfg.tools = { gh: report.tools.gh, browser: report.tools.browser, docker: report.tools.docker };
  for (const [lens, sug] of Object.entries(s.reviewers)) {
    const r = cfg.roles.reviewers[lens] || (cfg.roles.reviewers[lens] = { enabled: false, model: 'sonnet', reason: '' });
    if (fresh || (sug.enabled && !r.enabled)) {
      r.enabled = sug.enabled;
      r.reason = sug.reason;
    }
    if (sug.mode && (fresh || r.mode === 'browser')) r.mode = sug.mode; // downgrade if the browser tool vanished
  }
  cfg.initialized = true;
  cfg.initializedAt = now();
  config.save(cfg);

  const actions = [];
  actions.push(...ensureGitignore());
  backlog.ensure();
  actions.push(profile());
  const guide = opts.guidance === 'none' ? null : wireGuidance(opts.guidance);
  if (guide) actions.push(guide);
  return { config: summary(cfg), detected: { evidence: report.evidence, hints: report.hints, git: report.git, guidance: report.guidance }, actions, doctor: doctor() };
}

function ensureGitignore() {
  const out = [];
  const jobsIgnore = path.join(paths().jobs, '.gitignore');
  if (!fs.existsSync(jobsIgnore)) {
    writeFileAtomic(jobsIgnore, '# Job folders are runtime state; keep them out of git.\n*\n!.gitignore\n');
    out.push(`wrote ${path.relative(paths().root, jobsIgnore)}`);
  }
  return out;
}

const list = (a) => (a && a.length ? a.join(', ') : 'none');

function autoSection(cfg) {
  const p = cfg.project;
  const v = {
    languages: list(p.languages), packageManagers: list(p.packageManagers), frameworks: list(p.frameworks),
    monorepo: p.monorepo.enabled ? `${p.monorepo.tool}: ${list(p.monorepo.packages.slice(0, 20))}` : 'no',
    frontend: p.frontend.kind === 'none' ? 'none' : `${p.frontend.kind} (${list(p.frontend.frameworks)})${p.frontend.paths.length ? ` in ${p.frontend.paths.slice(0, 6).join(', ')}` : ''}`,
    database: p.database.detected ? `${list(p.database.technologies)}${p.database.paths.length ? ` (${p.database.paths.slice(0, 6).join(', ')})` : ''}` : 'none',
    commandRows: Object.entries(cfg.commands).map(([k, c]) => `| ${k} | ${c ? `\`${c}\`` : 'none'} |`).join('\n'),
    commitStyle: cfg.git.commitStyle === 'conventional' ? 'Conventional Commits (`feat: …`, `fix: …`)' : 'free-form, imperative mood',
    delivery: cfg.delivery.strategy === 'github-pr' ? `push the branch and open a GitHub PR${cfg.delivery.draftPr ? ' (draft)' : ''}` : `merge --no-ff into ${cfg.git.baseBranch} locally (never pushed)`,
    reviewerRows: Object.entries(cfg.roles.reviewers).map(([l, r]) => `- ${r.enabled ? '✅' : '⛔'} **${l}**${l === 'ui-ux' && r.enabled ? ` (${r.mode})` : ''}: ${r.reason}`).join('\n'),
  };
  const tmpl = templates.raw('FACTORY');
  const section = tmpl.slice(tmpl.indexOf(AUTO_BEGIN), tmpl.indexOf(AUTO_END) + AUTO_END.length);
  return fill(section, { ...cfg, ...v, project: cfg.project });
}

// (Re)renders factory/FACTORY.md. Only the AUTO block is replaced on an
// existing file, so hand-written sections survive re-runs.
function profile() {
  const cfg = config.load();
  const file = path.join(paths().factory, 'FACTORY.md');
  const existing = readText(file);
  const auto = autoSection(cfg);
  let out;
  if (existing && existing.includes(AUTO_BEGIN) && existing.includes(AUTO_END)) {
    out = existing.slice(0, existing.indexOf(AUTO_BEGIN)) + auto + existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length);
  } else {
    const tmpl = templates.raw('FACTORY');
    const filled = fill(tmpl, {
      project: cfg.project, date: now().slice(0, 10),
      summary: cfg.project.summary || '<!-- TODO(/factory-init): what this project is and who uses it, 2-3 sentences. -->',
      conventions: '<!-- TODO(/factory-init) -->',
      focus: Object.entries(cfg.roles.reviewers).filter(([, r]) => r.enabled).map(([l]) => `### ${l}\n<!-- TODO(/factory-init) -->`).join('\n\n'),
      escalate: '<!-- TODO(/factory-init) -->',
    });
    out = filled.slice(0, filled.indexOf(AUTO_BEGIN)) + auto + filled.slice(filled.indexOf(AUTO_END) + AUTO_END.length);
  }
  writeFileAtomic(file, out);
  return `wrote ${path.relative(paths().root, file)}`;
}

// Adds a short pointer block to CLAUDE.md / AGENTS.md so any session in the
// repo knows the factory exists. Idempotent via markers.
function wireGuidance(prefer) {
  const root = paths().root;
  const target = prefer || ['CLAUDE.md', 'AGENTS.md'].find((f) => fs.existsSync(path.join(root, f))) || 'CLAUDE.md';
  const file = path.join(root, target);
  const block = [
    GUIDE_BEGIN,
    '## Software factory',
    'This repo runs an autonomous software factory (`/factory <feature>`, `/factory next`, `/factory-init`).',
    '- Repo profile for agents: `factory/FACTORY.md`. Config: `factory/config.json` (edit via `node factory/bin/factory-cli.js config set`).',
    '- Job state lives in `factory/jobs/<id>/` and is written only by `factory/bin/factory-cli.js`. Never hand-edit `job.json`.',
    '- Dashboard: `node factory/bin/factory-cli.js serve`.',
    GUIDE_END,
  ].join('\n');
  const existing = readText(file);
  let out;
  if (existing && existing.includes(GUIDE_BEGIN)) {
    out = existing.replace(new RegExp(`${GUIDE_BEGIN}[\\s\\S]*?${GUIDE_END}`), block);
    if (out === existing) return null;
  } else out = `${existing ? `${existing.replace(/\n*$/, '\n\n')}` : ''}${block}\n`;
  writeFileAtomic(file, out);
  return `${existing ? 'updated' : 'created'} ${target} (factory pointer block)`;
}

function summary(cfg) {
  return {
    project: `${cfg.project.name}: ${list(cfg.project.languages)} · ${list(cfg.project.frameworks)}`,
    commands: cfg.commands,
    git: `${cfg.git.baseBranch} · ${cfg.git.branchPattern} · ${cfg.git.commitStyle}`,
    delivery: cfg.delivery.strategy,
    reviewers: Object.fromEntries(Object.entries(cfg.roles.reviewers).map(([l, r]) => [l, `${r.enabled ? 'ON ' : 'OFF'} ${l === 'ui-ux' && r.enabled ? `(${r.mode}) ` : ''}${r.reason}`])),
  };
}

// Checks every external dependency the configuration relies on. Warnings,
// not failures, wherever the factory can degrade gracefully.
function doctor({ run = [] } = {}) {
  const p = paths();
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 18 ? 'ok' : 'error', 'node', `v${process.versions.node}${nodeMajor < 18 ? ' (need >= 18)' : ''}`);
  add(p.isGit ? 'ok' : 'error', 'git repo', p.isGit ? p.root : 'not a git repository: run `git init` and commit first');
  let cfg;
  try {
    cfg = config.load();
    add('ok', 'config.json', 'valid');
  } catch (err) {
    add('error', 'config.json', err.message);
    return { ok: false, checks };
  }
  if (!cfg.initialized) add('warn', 'initialized', 'run /factory-init');
  if (p.isGit) {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: p.root, allowFail: true });
    if (!head) add('error', 'commits', 'repository has no commits yet; commit once so worktrees can branch');
    const base = git(['rev-parse', '--verify', '--quiet', cfg.git.baseBranch], { cwd: p.root, allowFail: true });
    add(base ? 'ok' : 'error', 'base branch', base ? cfg.git.baseBranch : `"${cfg.git.baseBranch}" does not exist`);
    const tracked = git(['ls-files', '--', 'factory/bin/factory-cli.js', '.claude/skills/factory/SKILL.md'], { cwd: p.root, allowFail: true });
    if (!tracked) add('warn', 'committed', 'factory/ and .claude/ are not committed yet; commit them so every clone has the factory');
  }
  const ghOk = which('gh') && sh('gh auth status', { timeoutMs: 8000 }).ok;
  if (cfg.delivery.strategy === 'github-pr') add(ghOk ? 'ok' : 'error', 'gh', ghOk ? 'authenticated' : 'delivery is github-pr but gh is missing or not logged in (gh auth login)');
  if (Boolean(ghOk) !== cfg.tools.gh) add('warn', 'tools.gh', `config says ${cfg.tools.gh}, actual ${Boolean(ghOk)} (re-run init apply)`);
  const ux = cfg.roles.reviewers['ui-ux'];
  if (ux?.enabled && ux.mode === 'browser') {
    const b = cfg.tools.browser;
    const present = b === 'agent-browser' ? which('agent-browser') : b === 'playwright' ? (which('playwright') || fs.existsSync(path.join(p.root, 'node_modules', 'playwright')) || fs.existsSync(path.join(p.root, 'node_modules', '@playwright', 'test'))) : null;
    add(present ? 'ok' : 'warn', 'browser', present ? b : `ui-ux is in browser mode but ${b || 'no browser CLI'} was not found; set roles.reviewers.ui-ux.mode=static or install it`);
  }
  if (ux?.enabled && cfg.commands.dev && !/\{port\}|PORT/.test(cfg.commands.dev)) add('warn', 'dev port', 'commands.dev does not use {port}; parallel jobs may fight over one port');
  for (const [k, c] of Object.entries(cfg.commands)) {
    if (!c) {
      if (['test', 'lint'].includes(k)) add('warn', `commands.${k}`, 'not configured; builder and reviewers have less to verify with');
      continue;
    }
    const bin = c.replace(/^(\w+=\S+\s+)+/, '').split(/\s+/)[0];
    const found = bin.startsWith('./') || bin.startsWith('.venv/') ? fs.existsSync(path.join(p.root, bin)) : Boolean(which(bin));
    if (!found) add('warn', `commands.${k}`, `"${bin}" not found on PATH`);
    if (run.includes(k)) {
      const r = sh(c, { cwd: p.root, timeoutMs: 10 * 60 * 1000 });
      add(r.ok ? 'ok' : 'warn', `run ${k}`, r.ok ? 'passed' : `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' / ')}`);
    }
  }
  for (const f of ['spec-writer', 'builder', 'approver', ...Object.keys(cfg.roles.reviewers).filter((l) => cfg.roles.reviewers[l].enabled).map((l) => `reviewer-${l}`)]) {
    if (!fs.existsSync(path.join(p.root, '.claude', 'agents', `${f}.md`))) add('error', `agent ${f}`, `.claude/agents/${f}.md is missing`);
  }
  if (!fs.existsSync(path.join(p.factory, 'FACTORY.md'))) add('warn', 'FACTORY.md', 'missing: run `factory-cli init profile`');
  else if (/TODO\(\/factory-init\)/.test(readText(path.join(p.factory, 'FACTORY.md')))) add('warn', 'FACTORY.md', 'still has TODO(/factory-init) sections');
  return { ok: !checks.some((c) => c.level === 'error'), checks };
}

module.exports = { apply, profile, wireGuidance, doctor, summary };

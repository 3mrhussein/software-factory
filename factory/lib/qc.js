'use strict';
// Quality control: turns the factory's own records (job.json histories and
// agent output files) into evidence about how the process performs, and lints
// the factory's definition (agents, skills, templates, config) for drift.

const fs = require('fs');
const path = require('path');
const { paths, readText, firstLine } = require('./util');
const config = require('./config');
const jobs = require('./jobs');

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];

// ---------------------------------------------------------------- parsing

// Rows of the review template's findings table: | # | severity | location | issue | change |
function parseFindings(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\|\s*\d+\s*\|\s*\**(blocker|major|minor|nit)\**[^|]*\|\s*([^|]*)\|\s*([^|]*)\|/i);
    if (!m) continue;
    const loc = m[2].replace(/[`*]/g, '').trim();
    out.push({ severity: m[1].toLowerCase(), location: loc, file: loc.split(/[:\s]/)[0] || null, issue: m[3].trim() });
  }
  return out;
}

const verdictLine = (text) => (firstLine(text).match(/VERDICT\s*:\s*(PASS|CHANGES)/i) || [])[1]?.toUpperCase() || null;

function frontmatter(text) {
  const m = (text || '').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      fm[listKey].push(item[1].trim());
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    listKey = null;
    let v = kv[2].trim();
    if (v === '') {
      fm[kv[1]] = [];
      listKey = kv[1];
    } else if (/^\[.*\]$/.test(v)) fm[kv[1]] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else fm[kv[1]] = v.replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(',').map((s) => s.trim()).filter(Boolean));

// Time spent per stage, attributing each gap between history entries to the
// stage recorded on the earlier entry.
function stageDurations(job) {
  const out = {};
  const h = job.history;
  for (let i = 0; i < h.length - 1; i++) {
    const ms = new Date(h[i + 1].at) - new Date(h[i].at);
    out[h[i].stage] = (out[h[i].stage] || 0) + Math.max(0, ms);
  }
  return out;
}

function needsHumanCause(text) {
  const t = text || '';
  if (/BLOCKED/.test(t)) return 'builder blocked';
  if (/rounds exhausted/.test(t)) return 'rework budget exhausted';
  if (/approver escalated/.test(t)) return 'approver escalated';
  if (/approval\.mode/.test(t)) return 'human sign-off policy';
  if (/finished without|output invalid|no acceptance criteria/.test(t)) return 'agent output missing/invalid';
  if (/no commits/.test(t)) return 'builder made no commits';
  if (/setup/.test(t)) return 'setup failed';
  if (/merge|push|gh pr|checkout|delivery/.test(t)) return 'delivery problem';
  if (/^error:/.test(t)) return 'manual error';
  return 'other';
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const mins = (ms) => (ms == null ? null : Math.round(ms / 6000) / 10);
const sizeOf = (f) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- report

function report({ sinceDays } = {}) {
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
  const all = jobs.listIds().map((id) => {
    try {
      return jobs.load(id);
    } catch {
      return null;
    }
  }).filter((j) => j && new Date(j.createdAt).getTime() >= cutoff);

  const r = {
    window: sinceDays ? `last ${sinceDays} days` : 'all time',
    jobs: { total: all.length, byStage: {} },
    flow: {},
    lenses: {},
    agents: { retries: {}, invalidOutputs: 0 },
    approver: { APPROVE: 0, ESCALATE: 0, humanOverrides: 0 },
    needsHuman: {},
    delivery: { merged: 0, prOpen: 0, failedAttempts: 0 },
    stageMinutes: {},
    artifactBytes: {},
    hotspots: [],
    contractViolations: [],
    signals: [],
  };

  const reviewed = all.filter((j) => j.rounds.length);
  const stageMs = {};
  const bytes = {};
  const hot = {};
  const addBytes = (kind, f) => {
    const s = sizeOf(f);
    if (s != null) (bytes[kind] ||= []).push(s);
  };

  for (const j of all) {
    r.jobs.byStage[j.stage] = (r.jobs.byStage[j.stage] || 0) + 1;
    const dir = jobs.jobDir(j.id);
    for (const [k, v] of Object.entries(j.retries || {})) {
      const agent = k.split('@')[0];
      r.agents.retries[agent] = (r.agents.retries[agent] || 0) + v;
    }
    for (const h of j.history) {
      if (/output invalid|retrying/.test(h.note)) r.agents.invalidOutputs++;
      if (h.stage === 'needs-human') {
        const cause = needsHumanCause(h.note);
        r.needsHuman[cause] = (r.needsHuman[cause] || 0) + 1;
      }
      if (/delivery failed/.test(h.note)) r.delivery.failedAttempts++;
      if (/human approved \(override\)/.test(h.note)) r.approver.humanOverrides++;
    }
    for (const [stage, ms] of Object.entries(stageDurations(j))) (stageMs[stage] ||= []).push(ms);
    if (j.delivery?.status === 'merged') r.delivery.merged++;
    if (j.delivery?.status === 'pr-open') r.delivery.prOpen++;
    const decisionText = readText(path.join(dir, 'decision.md'));
    const decision = (firstLine(decisionText).match(/DECISION\s*:\s*(APPROVE|ESCALATE)/i) || [])[1];
    if (decision && !/Written by factory-cli/.test(decisionText)) r.approver[decision.toUpperCase()]++;

    addBytes('spec', path.join(dir, 'spec.md'));
    addBytes('decision', path.join(dir, 'decision.md'));
    for (const round of j.rounds) {
      const rdir = jobs.roundDir(j.id, round.n);
      addBytes('build', path.join(rdir, 'build.md'));
      for (const lens of Object.keys(round.verdicts)) {
        const file = path.join(rdir, `review-${lens}.md`);
        const text = readText(file);
        if (text == null) continue;
        addBytes(`review-${lens}`, file);
        const L = (r.lenses[lens] ||= { reviews: 0, changes: 0, findings: { blocker: 0, major: 0, minor: 0, nit: 0 }, unresolvedAtEscalation: 0 });
        const v = verdictLine(text);
        const f = parseFindings(text);
        L.reviews++;
        if (v === 'CHANGES') L.changes++;
        for (const x of f) {
          L.findings[x.severity]++;
          if ((x.severity === 'blocker' || x.severity === 'major') && x.file && /[./]/.test(x.file)) hot[x.file] = (hot[x.file] || 0) + 1;
        }
        const blocking = f.some((x) => x.severity === 'blocker' || x.severity === 'major');
        if (v === 'CHANGES' && !blocking) r.contractViolations.push(`${j.id} round ${round.n} ${lens}: CHANGES without a blocker/major finding`);
        if (v === 'PASS' && blocking) r.contractViolations.push(`${j.id} round ${round.n} ${lens}: PASS despite a blocker/major finding`);
      }
    }
    const last = j.rounds[j.rounds.length - 1];
    if (last && /exhausted/.test(j.attention || '')) {
      for (const [lens, v] of Object.entries(last.verdicts)) if (v === 'CHANGES' && r.lenses[lens]) r.lenses[lens].unresolvedAtEscalation++;
    }
  }

  const delivered = all.filter((j) => j.stage === 'delivered');
  const firstPass = reviewed.filter((j) => Object.values(j.rounds[0].verdicts).every((v) => v === 'PASS'));
  r.flow = {
    reachedReview: reviewed.length,
    delivered: delivered.length,
    deliveredWithoutHuman: delivered.filter((j) => !j.humanApproved && !j.reworks).length,
    firstPassRatePct: pct(firstPass.length, reviewed.length),
    avgRounds: reviewed.length ? Math.round((10 * reviewed.reduce((s, j) => s + j.rounds.length, 0)) / reviewed.length) / 10 : null,
    builderResumes: all.reduce((s, j) => s + (j.resumesUsed || 0), 0),
    humanReworks: all.reduce((s, j) => s + (j.reworks || 0), 0),
    openNeedsHuman: all.filter((j) => j.stage === 'needs-human').length,
    medianLeadTimeMin: mins(median(delivered.map((j) => new Date(j.delivery?.at || j.updatedAt) - new Date(j.createdAt)))),
  };
  for (const l of Object.values(r.lenses)) l.changesRatePct = pct(l.changes, l.reviews);
  for (const [s, a] of Object.entries(stageMs)) r.stageMinutes[s] = { median: mins(median(a)), max: mins(Math.max(...a)) };
  for (const [k, a] of Object.entries(bytes)) r.artifactBytes[k] = { median: median(a), approxTokens: Math.round(median(a) / 4), n: a.length };
  r.hotspots = Object.entries(hot).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, n]) => ({ file, blockingFindings: n }));

  // Heuristic signals: starting points for the QC analyst, not verdicts.
  const S = r.signals;
  let cfg = null;
  try {
    cfg = config.load();
  } catch { /* reported by check() */ }
  for (const [lens, l] of Object.entries(r.lenses)) {
    if (l.reviews >= 5 && l.changesRatePct >= 50) S.push(`${lens}: requests changes in ${l.changesRatePct}% of reviews. Builder may lack this lens's standards (FACTORY.md review focus → builder brief), or the reviewer is too strict.`);
    if (l.reviews >= 10 && l.changes === 0) S.push(`${lens}: ${l.reviews} reviews, never CHANGES. Either the lens adds little here (consider disabling/cheaper model) or its checklist is too shallow.`);
    if (l.unresolvedAtEscalation >= 2) S.push(`${lens}: blocked ${l.unresolvedAtEscalation} jobs at the rework cap. Builder and reviewer disagree; read those rounds' Review responses.`);
  }
  if (r.flow.reachedReview >= 5 && r.flow.firstPassRatePct != null && r.flow.firstPassRatePct < 30) S.push(`First-pass rate ${r.flow.firstPassRatePct}%: most jobs need rework. Look at which lens drives it and whether specs carry enough acceptance detail.`);
  if (r.agents.invalidOutputs) S.push(`${r.agents.invalidOutputs} agent run(s) produced missing/invalid output. Check marker format or brief clarity for: ${Object.keys(r.agents.retries).join(', ') || 'see traces'}.`);
  if (r.contractViolations.length) S.push(`${r.contractViolations.length} verdict/severity contract violation(s): reviewers are not applying "CHANGES iff blocker/major".`);
  if (r.approver.humanOverrides >= 2) S.push(`Humans overrode ${r.approver.humanOverrides} escalations: the approver (or approval.escalatePaths) may be too conservative.`);
  if ((r.needsHuman['delivery problem'] || 0) >= 2) S.push('Repeated delivery problems: check the main checkout state, gh auth, or switch delivery strategy.');
  if (cfg && r.stageMinutes.setup && r.stageMinutes.setup.median > 5) S.push(`Setup takes ${r.stageMinutes.setup.median} min median: consider a faster commands.setup (cache, frozen lockfile, skip optional steps).`);
  if (r.artifactBytes.spec && r.artifactBytes.spec.median > 12000) S.push(`Specs average ~${r.artifactBytes.spec.approxTokens} tokens. Every downstream agent reads them, so tighten the spec template.`);
  return r;
}

// ---------------------------------------------------------------- trace

function trace(idOrNum) {
  const j = jobs.load(idOrNum);
  const dir = jobs.jobDir(j.id);
  const lines = [`${j.id}: ${j.feature}`, `stage ${j.stage} · round ${j.round}/${j.maxRounds} · resumes ${j.resumesUsed} · human reworks ${j.reworks}`];
  if (j.attention) lines.push(`attention: ${j.attention}`);
  lines.push('', 'timeline (Δ = time until next event):');
  j.history.forEach((h, i) => {
    const next = j.history[i + 1];
    const d = next ? `${Math.round((new Date(next.at) - new Date(h.at)) / 1000)}s` : '';
    lines.push(`  ${h.at.slice(11, 19)}  ${h.stage.padEnd(11)} ${(h.round != null ? `r${h.round}` : '').padEnd(3)} ${h.note}${d ? `   Δ ${d}` : ''}`);
  });
  lines.push('', 'rounds:');
  for (const round of j.rounds) {
    lines.push(`  R${round.n}: ${Object.entries(round.verdicts).map(([l, v]) => `${l}=${v}`).join(' ')}`);
    for (const lens of Object.keys(round.verdicts)) {
      const text = readText(path.join(jobs.roundDir(j.id, round.n), `review-${lens}.md`));
      const f = parseFindings(text).filter((x) => x.severity === 'blocker' || x.severity === 'major');
      for (const x of f) lines.push(`      ${lens} ${x.severity}: ${x.location}: ${x.issue.slice(0, 110)}`);
    }
  }
  lines.push('', 'artifacts (bytes ≈ tokens×4):');
  const walk = (d, prefix = '') => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.name.startsWith('.')) return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
    else lines.push(`  ${`${prefix}${e.name}`.padEnd(34)} ${String(fs.statSync(p).size).padStart(7)}`);
  });
  walk(dir);
  if (Object.keys(j.retries).length) lines.push('', `retries: ${JSON.stringify(j.retries)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- check

// Lints the factory definition: the contracts every part relies on.
function check() {
  const p = paths();
  const out = [];
  const add = (level, item, detail) => out.push({ level, item, detail });
  const agentsDir = path.join(p.root, '.claude', 'agents');
  const skillsDir = path.join(p.root, '.claude', 'skills');
  let cfg = null;
  try {
    cfg = config.load();
    add('ok', 'config.json', 'schema-valid');
  } catch (e) {
    add('error', 'config.json', e.message);
  }

  const lenses = cfg ? Object.keys(cfg.roles.reviewers) : [];
  const expected = ['spec-writer', 'builder', 'approver', ...lenses.map((l) => `reviewer-${l}`)];
  const readOnly = (name) => name !== 'builder';
  for (const name of expected) {
    const file = path.join(agentsDir, `${name}.md`);
    const text = readText(file);
    const lens = name.startsWith('reviewer-') ? name.slice(9) : null;
    const enabled = !lens || (cfg && cfg.roles.reviewers[lens].enabled);
    if (text == null) {
      add(enabled ? 'error' : 'warn', name, `.claude/agents/${name}.md missing${enabled ? '' : ' (lens disabled)'}`);
      continue;
    }
    const fm = frontmatter(text);
    if (!fm) {
      add('error', name, 'no YAML frontmatter');
      continue;
    }
    if (fm.name !== name) add('error', name, `frontmatter name "${fm.name}" ≠ file name`);
    const tools = toList(fm.tools);
    if (tools.length) {
      if (!tools.includes('Write')) add('error', name, 'tools lack Write; the agent cannot write its output file');
      if (!tools.includes('Bash')) add('error', name, 'tools lack Bash; the agent cannot run `factory-cli brief`');
      if (readOnly(name) && (tools.includes('Edit') || tools.includes('NotebookEdit'))) add('warn', name, 'has Edit but its role is read-only on code');
      if (name === 'builder' && !tools.includes('Edit')) add('warn', name, 'builder without Edit will rewrite whole files');
      if (tools.includes('Agent')) add('warn', name, 'can spawn agents; the loop assumes only the orchestrator does');
    }
    if (!/\bbrief\b/.test(text)) add('warn', name, 'body never mentions `brief`; the agent may not load its context');
    if (lens && !/VERDICT: PASS|VERDICT: CHANGES/.test(text)) add('warn', name, 'body does not restate the VERDICT first-line contract');
    for (const s of toList(fm.skills)) {
      if (fs.existsSync(path.join(skillsDir, s, 'SKILL.md'))) {
        const sfm = frontmatter(readText(path.join(skillsDir, s, 'SKILL.md'))) || {};
        if (String(sfm['disable-model-invocation']) === 'true') add('error', name, `preloads skill "${s}" which has disable-model-invocation: true (cannot be preloaded)`);
        else add('ok', name, `preloads project skill "${s}"`);
      } else add('warn', name, `preloads skill "${s}" not found in .claude/skills/ (fine if it is a user/plugin skill; skipped if missing at runtime)`);
    }
    if (fm.model && cfg) {
      const cfgModel = lens ? cfg.roles.reviewers[lens].model : cfg.roles[name].model;
      if (cfgModel !== fm.model && cfgModel !== 'inherit') add('ok', name, `model: config "${cfgModel}" overrides frontmatter "${fm.model}" at spawn`);
    }
  }
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir)) {
      const m = f.match(/^reviewer-(.+)\.md$/);
      if (m && !lenses.includes(m[1])) add('warn', f, `reviewer agent with no roles.reviewers.${m[1]} entry in config; it will never run`);
    }
  }

  const markers = { 'review.md': /^VERDICT: (PASS|CHANGES)/, 'build.md': /^STATUS: (READY|BLOCKED)/, 'decision.md': /^DECISION: (APPROVE|ESCALATE)/, 'spec.md': /Acceptance criteria/ };
  for (const [t, re] of Object.entries(markers)) {
    const text = readText(path.join(p.templates, t));
    if (text == null) add('error', `templates/${t}`, 'missing');
    else if (!re.test(t === 'spec.md' ? text : firstLine(text))) add('error', `templates/${t}`, `lost its marker ${re}; tick can no longer parse agent output`);
    else add('ok', `templates/${t}`, 'marker intact');
  }
  for (const s of ['factory', 'factory-init', 'factory-qc']) {
    add(fs.existsSync(path.join(skillsDir, s, 'SKILL.md')) ? 'ok' : (s === 'factory-qc' ? 'warn' : 'error'), `skill ${s}`, fs.existsSync(path.join(skillsDir, s, 'SKILL.md')) ? 'present' : 'missing');
  }
  const profile = readText(path.join(p.factory, 'FACTORY.md'));
  if (profile && cfg) {
    for (const [lens, r] of Object.entries(cfg.roles.reviewers)) {
      if (r.enabled && !new RegExp(`###\\s*${lens}\\b`).test(profile)) add('warn', 'FACTORY.md', `no "### ${lens}" review focus for an active lens`);
    }
  }
  return { ok: !out.some((c) => c.level === 'error'), checks: out };
}

module.exports = { report, trace, check, parseFindings, frontmatter, stageDurations };

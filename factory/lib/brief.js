'use strict';
// `factory-cli brief <job> <role>` prints everything an agent needs in one
// compact block: paths, commands, inputs, output file and the pre-filled
// template. Agents start with this instead of exploring the factory.

const fs = require('fs');
const path = require('path');
const { paths, matchesAny, fill, die } = require('./util');
const config = require('./config');
const jobs = require('./jobs');
const templates = require('./templates');
const worktree = require('./worktree');

const ROLES = ['spec-writer', 'builder', 'approver'];

function parseRole(role) {
  if (ROLES.includes(role)) return { role, lens: null };
  const m = role.match(/^reviewer-(.+)$/);
  if (m) return { role: 'reviewer', lens: m[1] };
  die(`unknown role "${role}" (spec-writer, builder, reviewer-<lens>, approver)`);
}

function builderMode(job) {
  if (job.pendingRework) return 'rework';
  return job.round === 0 ? 'initial' : 'resume';
}

function commandsBlock(cfg, port) {
  const rows = Object.entries(cfg.commands).filter(([, v]) => v).map(([k, v]) => {
    const cmd = k === 'dev' ? fill(v, { port }) : v;
    return `  ${k.padEnd(9)} ${cmd}${k === 'dev' && port ? `   (PORT=${port}; use exactly this port)` : ''}`;
  });
  return rows.length ? rows.join('\n') : '  (none configured; see FACTORY.md)';
}

function guidanceFiles() {
  const root = paths().root;
  return ['factory/FACTORY.md', 'CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(root, f)));
}

function brief(idOrNum, roleArg) {
  const job = jobs.load(idOrNum);
  const cfg = config.load();
  const { role, lens } = parseRole(roleArg);
  const p = paths();
  const dir = jobs.jobDir(job.id);
  const base = (job.baseCommit || job.baseBranch).slice(0, 10);
  const L = [];
  const add = (...lines) => L.push(...lines);

  add(`# Factory brief: ${roleArg} · job ${job.id}${job.round ? ` · round ${job.round}` : ''}`, '');
  add(`Feature:   ${job.feature}`);
  add(`Worktree:  ${job.worktree}   ← ALL code reading/editing/commands happen here`);
  add(`Branch:    ${job.branch} (from ${job.baseBranch} @ ${base})`);
  add(`Job dir:   ${dir}   ← factory state (in the main checkout)`);
  add(`Main repo: ${p.root}   ← never edit, checkout, commit or run builds here`);
  add(`Guidance:  ${guidanceFiles().map((f) => path.join(p.root, f)).join(', ') || 'none'}  (read FACTORY.md first)`);
  add('', 'Commands (run with the worktree as cwd, e.g. `cd <worktree> && <cmd>` in one Bash call):');
  const port = role === 'builder' ? job.ports.builder : lens === 'ui-ux' ? job.ports['ui-ux'] : null;
  add(commandsBlock(cfg, port));
  if (port) add(`Port: ${port}. Stop any server you start before you finish.`);
  add('');

  let output;
  let template;
  if (role === 'spec-writer') {
    output = path.join(dir, 'spec.md');
    add('Inputs: the feature line above, the codebase (read-only), guidance files.');
    template = templates.render('spec', job, cfg);
  } else if (role === 'builder') {
    const mode = builderMode(job);
    const nextRound = job.round + 1;
    output = path.join(dir, 'build.md');
    add(`Mode: ${mode.toUpperCase()}. You are building the code that review round ${nextRound} will check.`);
    add(`Inputs: ${path.join(dir, 'spec.md')}`);
    if (mode === 'resume') {
      const changes = job.reviewers.filter((l) => job.reviews[l] === 'CHANGES');
      add(`        Round ${job.round} reviews asking for CHANGES (address every blocker/major finding):`);
      for (const l of changes) add(`          ${jobs.reviewFile(job.id, job.round, l)}`);
      add(`        Your previous build report: ${path.join(jobs.roundDir(job.id, job.round), 'build.md')}`);
    }
    if (mode === 'rework') {
      add(`        Human rework request: ${path.join(dir, `rework-${job.pendingRework}.md`)}  (highest priority)`);
      if (job.round) add(`        Last review round for context: ${jobs.roundDir(job.id, job.round)}/`);
    }
    add('', 'Rules:');
    add(`- Commit on ${job.branch} inside the worktree (${cfg.git.commitStyle === 'conventional' ? 'Conventional Commits: feat:/fix:/test:/refactor:' : 'clear imperative messages'}). Never push, never merge, never rewrite history that was already reviewed.`);
    add('- Implement exactly the spec; no drive-by refactors. Add or update tests for every acceptance criterion.');
    add('- Run every validation command above before writing build.md; fix failures you caused.');
    add('- Write build.md LAST, after your final commit. STATUS: BLOCKED only if a human decision is truly required.');
    template = templates.render('build', job, cfg, { round: nextRound });
  } else if (role === 'reviewer') {
    if (!job.reviewers.includes(lens)) die(`reviewer "${lens}" is not active for ${job.id} (active: ${job.reviewers.join(', ')})`);
    const n = job.round;
    output = jobs.reviewFile(job.id, n, lens);
    add(`Inputs: ${path.join(dir, 'spec.md')}, ${path.join(jobs.roundDir(job.id, n), 'build.md')}`);
    if (n > 1) add(`        Your round ${n - 1} review: ${jobs.reviewFile(job.id, n - 1, lens)} (check every blocker/major is resolved)`);
    if (job.pendingRework || job.reworks) add(`        Human rework notes: ${path.join(dir, 'rework-*.md')}`);
    add(`Diff:   cd ${job.worktree} && git diff ${base}...HEAD   (log: git log --oneline ${base}..HEAD)`);
    const stat = worktree.diff(job, { stat: true }).trim();
    if (stat) add('', 'Diff stat:', ...stat.split('\n').slice(-40).map((l) => `  ${l}`));
    if (lens === 'ui-ux') {
      const mode = cfg.roles.reviewers['ui-ux'].mode || 'static';
      add('', `UI review mode: ${mode.toUpperCase()}${mode === 'browser' ? ` via ${cfg.tools.browser}` : ''}.`);
      if (mode === 'browser') {
        add(`- Start the dev server from the worktree on port ${port}, exercise every changed screen/flow, check loading/empty/error states, keyboard navigation and a narrow (375px) viewport.`);
        if (cfg.tools.browser === 'agent-browser') add(`- Use agent-browser with session name ${job.id}-uiux so you never share a browser with another job.`);
        if (cfg.tools.browser === 'playwright') add('- Use Playwright (npx playwright / a scratch script outside the worktree) to navigate and screenshot.');
      } else {
        add('- No browser tool is available: review templates/components/styles statically. Say in "Checked" that nothing was rendered.');
      }
    }
    add('', 'Rules: read-only. Never edit, commit or stage in the worktree. Run tests/linters if useful.',
      'Severity: blocker (wrong/unsafe/breaks AC) · major (must fix before merge) · minor · nit. CHANGES iff any blocker/major.',
      `Review only through the ${templates.lensTitle(lens)} lens; other reviewers cover the rest.`);
    template = templates.render('review', job, cfg, { lens });
  } else if (role === 'approver') {
    output = path.join(dir, 'decision.md');
    const changed = worktree.changedFiles(job);
    const sensitive = changed.filter((f) => matchesAny(f, cfg.approval.escalatePaths));
    add(`Inputs: spec.md, round-${job.round}/build.md, round-${job.round}/review-*.md (all in ${dir})`);
    add(`Final round ${job.round} verdicts: ${job.reviewers.map((l) => `${l}=${job.reviews[l]}`).join(', ') || '(no reviewers active)'}`);
    add(`Changed files (${changed.length}): ${changed.slice(0, 60).join(', ')}${changed.length > 60 ? ', …' : ''}`);
    add(`Sensitive paths touched (approval.escalatePaths): ${sensitive.length ? sensitive.join(', ') : 'none'}`);
    if (cfg.approval.notes.length) add('Approval policy notes:', ...cfg.approval.notes.map((n) => `- ${n}`));
    add(`Approval mode: ${cfg.approval.mode}${cfg.approval.mode === 'human' ? ' (a human signs off after you either way)' : ''}.`);
    add('', 'Rules: read-only. ESCALATE when sensitive paths are touched (unless the change there is trivially safe and you say why),',
      'when acceptance criteria are not evidenced, when scope drifted, or for anything listed under "Always escalate" in FACTORY.md.');
    template = templates.render('decision', job, cfg, { sensitive: sensitive.length ? sensitive.join(', ') : 'none' });
  }

  add('', `OUTPUT: write exactly ${output}`, 'Keep the first line format. Replace every <!-- comment --> with content (or delete it). Be concise.', '', '----- template -----', template.trimEnd(), '----- end template -----');
  return L.join('\n');
}

module.exports = { brief, parseRole, builderMode };

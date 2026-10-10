'use strict';
// Renders factory/templates/*.md with job context, so agents only fill in
// sections instead of inventing structure.

const fs = require('fs');
const path = require('path');
const { paths, fill, die } = require('./util');

const LENS_TITLES = { code: 'Code', security: 'Security', 'ui-ux': 'UI/UX', database: 'Database', architecture: 'Architecture' };
const lensTitle = (lens) => LENS_TITLES[lens] || lens.replace(/(^|-)(\w)/g, (m, d, c) => (d ? ' ' : '') + c.toUpperCase());

function raw(kind) {
  const file = path.join(paths().templates, `${kind}.md`);
  if (!fs.existsSync(file)) die(`no template "${kind}" in ${paths().templates}`);
  return fs.readFileSync(file, 'utf8');
}

const title = (feature) => (feature.length > 72 ? `${feature.slice(0, 69)}…` : feature);

function vars(job, cfg, extra = {}) {
  const validationRows = Object.entries(cfg.commands)
    .filter(([k, v]) => v && !['setup', 'dev'].includes(k))
    .map(([k, v]) => `| ${k}: \`${v}\` | pass / fail (summary) |`)
    .join('\n') || '| (no validation commands configured) | describe what you ran |';
  const round = extra.round ?? job.round;
  return {
    ...job,
    title: title(job.feature),
    baseCommitShort: (job.baseCommit || job.baseBranch).slice(0, 10),
    validationRows,
    round,
    prevRound: Math.max(1, round - 1),
    date: new Date().toISOString().slice(0, 10),
    ...extra,
    lensTitle: extra.lens ? lensTitle(extra.lens) : '',
  };
}

const render = (kind, job, cfg, extra) => fill(raw(kind), vars(job, cfg, extra));

module.exports = { render, raw, lensTitle, title };

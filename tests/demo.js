#!/usr/bin/env node
'use strict';
// Builds a throwaway repo with jobs in every stage and serves the dashboard.
//   node tests/demo.js [--port 4317]
// Useful for developing the dashboard without running real agents.

const fs = require('fs');
const path = require('path');
const { makeRepo, f, fake, jobDir, write, sh } = require('./helpers');

const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || process.argv[process.argv.indexOf('--port') + 1] || 4317);

const { root } = makeRepo({
  'package.json': JSON.stringify({ name: 'acme-store', scripts: { test: 'vitest run', lint: 'eslint .', dev: 'vite' }, dependencies: { react: '18.3.1', '@prisma/client': '5.0.0' }, devDependencies: { typescript: '5.4.0', vite: '5.0.0' } }),
  'package-lock.json': '{}', 'tsconfig.json': '{}', 'src/App.tsx': 'export const App = () => null;\n', 'prisma/schema.prisma': 'model User { id Int @id }\n',
}, { name: 'acme-store' });
f(root, 'init', 'apply', '--guidance', 'none');
f(root, 'config', 'set', 'commands.setup', 'null');
sh('git add -A && git commit -qm "chore: init factory"', root);

const review = (id, n, lens, verdict, body) =>
  write(path.join(jobDir(root, id), `round-${n}`, `review-${lens}.md`), `VERDICT: ${verdict}\n\n# ${lens} review ${id}: round ${n}\n\n## Summary\n${body}\n\n## Findings\n| # | Severity | Location | Issue | Required change |\n| - | -------- | -------- | ----- | --------------- |\n${verdict === 'CHANGES' ? '| 1 | major | `src/api/cart.ts:42` | Quantity is not validated server-side | Reject quantities < 1 or > 99 with 400 |\n' : '| 1 | nit | `src/ui/Cart.tsx:12` | Prefer the `Price` component | optional |\n'}\n## Checked\n- Ran \`npm test\`: 48 passed\n`);
const spec = (id, feature) =>
  write(path.join(jobDir(root, id), 'spec.md'), `# Spec ${id}: ${feature}\n\n> Feature request (verbatim): ${feature}\n\n## Problem\nShoppers can't do this today, so they abandon carts.\n\n## Acceptance criteria\n- [ ] **AC1**: Given a cart, when the shopper changes quantity, then the total updates.\n- [ ] **AC2**: Given an invalid quantity, when submitted, then an inline error is shown.\n\n## Affected areas\n- \`src/ui/Cart.tsx\`: quantity stepper\n- \`src/api/cart.ts\`: validation\n`);
const build = (job, file, status = 'READY') => {
  write(path.join(job.worktree, file), `export const v = ${Math.random()};\n`);
  sh(`git add -A && git commit -qm "feat: ${file}"`, job.worktree);
  write(path.join(jobDir(root, job.id), 'build.md'), `STATUS: ${status}\n\n# Build ${job.id}\n\n## Summary\n- Added quantity stepper\n- Server-side validation\n\n## Acceptance criteria\n| AC | Status | Evidence |\n| -- | ------ | -------- |\n| AC1 | done | \`cart.test.ts\` |\n| AC2 | done | \`cart.test.ts\` |\n\n## Validation\n| Command | Result |\n| ------- | ------ |\n| \`npm test\` | pass (48) |\n`);
};
const advance = (feature, steps) => {
  const { job: id } = f(root, 'job', 'new', feature);
  f(root, 'tick', id);
  if (steps === 'spec') return id;
  spec(id, feature);
  f(root, 'tick', id);
  if (steps === 'build') return id;
  const job = f(root, 'job', 'show', id);
  return { id, job };
};

// 1. delivered after one CHANGES round
let { id, job } = advance('Let shoppers change item quantity in the cart');
build(job, 'src/ui/Cart.tsx');
f(root, 'tick', id);
review(id, 1, 'code', 'PASS', 'Clean and well tested.');
review(id, 1, 'security', 'CHANGES', 'Quantity is trusted from the client.');
review(id, 1, 'ui-ux', 'PASS', 'Stepper matches the design system.');
review(id, 1, 'database', 'PASS', 'No schema change.');
f(root, 'tick', id);
build(job, 'src/api/cart.ts');
f(root, 'tick', id);
for (const l of ['code', 'security', 'ui-ux', 'database']) review(id, 2, l, 'PASS', 'Looks good.');
f(root, 'tick', id);
fake.decide(root, id, 'APPROVE');
f(root, 'tick', id);
f(root, 'deliver', id);

// 2. needs human: approver escalated a migration
({ id, job } = advance('Store order notes on the order record'));
build(job, 'prisma/migrations/20261010_notes/migration.sql');
f(root, 'tick', id);
for (const l of ['code', 'security', 'ui-ux', 'database']) review(id, 1, l, 'PASS', 'Fine.');
f(root, 'tick', id);
write(path.join(jobDir(root, id), 'decision.md'), 'DECISION: ESCALATE\n\n# Decision\n\n## Rationale\n- Adds a migration on the 40M-row orders table; a human should schedule it.\n');
f(root, 'tick', id);

// 3. in review, verdicts landing
({ id, job } = advance('Show estimated delivery date on product pages'));
build(job, 'src/ui/Delivery.tsx');
f(root, 'tick', id);
review(id, 1, 'code', 'PASS', 'Good.');
f(root, 'record', id, 'code');
review(id, 1, 'ui-ux', 'CHANGES', 'Date wraps badly on mobile.');
f(root, 'record', id, 'ui-ux');

// 4. building, 5. spec
advance('Add wishlist sharing via link', 'build');
advance('Rate limit the login endpoint', 'spec');

// ---- 30 days of synthetic history so the Insights charts have a story.
// Fixture-only: writes job.json directly (schema-checked by `validate` below).
const DAY = 86400000;
const lensesAll = ['code', 'security', 'ui-ux', 'database'];
const features = ['Coupon codes at checkout', 'Saved addresses', 'Order history pagination', 'Product image zoom', 'Low-stock badge',
  'Email receipts', 'Search autocomplete', 'Guest checkout', 'Return requests', 'Size guide modal', 'Bulk price update', 'Reorder button',
  'Stock alerts', 'Recently viewed', 'Gift wrapping option', 'Loyalty points', 'Shipping estimator', 'Abandoned cart email'];
features.forEach((feature, k) => {
  const created = Date.now() - (29 - Math.floor((k * 28) / features.length)) * DAY - 3 * 3600000;
  const iso = (ms) => new Date(created + ms).toISOString();
  const early = k < 7;
  const rounds = early ? (k % 3 === 0 ? 3 : 2) : (k % 4 === 0 ? 2 : 1);
  const escalated = k === 3 || k === 11;
  const { job: hid } = f(root, 'job', 'new', feature);
  const jf = path.join(jobDir(root, hid), 'job.json');
  const job = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const history = [{ at: iso(0), stage: 'setup', note: `created: ${feature}` }, { at: iso(60000), stage: 'spec', note: 'spec-writer started' }, { at: iso(6 * 60000), stage: 'build', note: 'builder started (initial)' }];
  let t = 30 * 60000;
  job.rounds = [];
  for (let n = 1; n <= rounds; n++) {
    const last = n === rounds;
    const verdicts = {};
    lensesAll.forEach((l, i) => {
      const changes = !last && ((early && (l === 'security' || l === 'ui-ux')) || (!early && i === k % 4));
      verdicts[l] = changes ? 'CHANGES' : 'PASS';
      review(hid, n, l, verdicts[l], changes ? 'Needs work.' : 'Fine.');
    });
    write(path.join(jobDir(root, hid), `round-${n}`, 'build.md'), 'STATUS: READY\n\n# Build\n');
    history.push({ at: iso(t), stage: 'review', round: n, note: `round ${n} started` });
    job.rounds.push({ n, verdicts, startedAt: iso(t), endedAt: iso(t + 9 * 60000) });
    t += 25 * 60000;
    if (!last) history.push({ at: iso(t - 10 * 60000), stage: 'build', round: n, note: 'builder started (resume)' });
  }
  spec(hid, feature);
  Object.assign(job, { round: rounds, resumesUsed: rounds - 1, reviews: job.rounds[rounds - 1].verdicts, awaiting: [], createdAt: iso(0), setupDone: true, build: 'READY' });
  if (escalated) {
    write(path.join(jobDir(root, hid), 'decision.md'), 'DECISION: ESCALATE\n\n# Decision\n\n## Rationale\n- Touches the payments adapter.\n');
    history.push({ at: iso(t), stage: 'needs-human', round: rounds, note: 'needs human: approver escalated: Touches the payments adapter.' });
    history.push({ at: iso(t + 3 * 3600000), stage: 'deliver', round: rounds, note: 'human approved (override)' });
    t += 3 * 3600000;
    job.humanApproved = true;
  } else write(path.join(jobDir(root, hid), 'decision.md'), 'DECISION: APPROVE\n\n# Decision\n\n## Rationale\n- All ACs evidenced.\n');
  history.push({ at: iso(t + 2 * 60000), stage: 'delivered', round: rounds, note: 'merged into main' });
  Object.assign(job, { stage: 'delivered', decision: escalated ? 'ESCALATE' : 'APPROVE', delivery: { strategy: 'direct-merge', status: 'merged', prUrl: null, mergeCommit: 'abc1234def5678', at: iso(t + 2 * 60000) }, history, updatedAt: iso(t + 2 * 60000) });
  fs.writeFileSync(jf, JSON.stringify(job, null, 2));
});
f(root, 'validate');

// ---- QC memory: an audit, a post-mortem, proposals and journal lines.
const qcd = path.join(root, 'factory/qc');
write(path.join(qcd, 'assessments', `${new Date().toISOString().slice(0, 10)}-audit.md`), `HEALTH: WATCH\n\n# QC assessment: Factory audit\nScope: audit\nDate: ${new Date().toISOString().slice(0, 10)}\n\n## Verdict\nFirst-pass rate doubled since UI focus was added; security still drives most rework.\n\n## Evidence\n| Metric / artifact | Value | Source |\n| - | - | - |\n| first-pass rate | 0% → 64% | qc report |\n\n## Findings\n| # | Severity | Area | Finding | Recommendation |\n| - | - | - | - | - |\n| 1 | high | agent | Builder never validates cart quantities (7 security CHANGES) | Add input-validation item to FACTORY.md security focus so the builder sees it |\n| 2 | medium | template | Reviews average 1.4k tokens | Cap Summary to 2 sentences |\n`);
write(path.join(qcd, 'assessments', `${new Date().toISOString().slice(0, 10)}-job-002-store-order-notes-order.md`), `HEALTH: ACT\n\n# QC assessment: Job 002-store-order-notes-order\nScope: job 002-store-order-notes-order\nDate: ${new Date().toISOString().slice(0, 10)}\n\n## Verdict\nEscalation was correct: the migration rewrites a 40M-row table; spec-writer should have flagged it.\n\n## Findings\n| # | Severity | Area | Finding | Recommendation |\n| - | - | - | - | - |\n| 1 | high | agent | spec missed migration risk | spec-writer: list schema changes under Constraints & risks |\n`);
write(path.join(qcd, 'proposals', '2026-09-20-ui-focus-in-profile.md'), '# Add UI states checklist to FACTORY.md\nStatus: measured\nType: profile\nScope: this repo\nApplied: 2026-09-20\n\n## Success metric & check-back\nui-ux CHANGES rate below 20% after 8 jobs\n');
write(path.join(qcd, 'proposals', `${new Date().toISOString().slice(0, 10)}-security-input-validation.md`), '# Teach the builder input validation up front\nStatus: proposed\nType: profile\nScope: this repo\n\n## Success metric & check-back\nsecurity CHANGES rate below 25% after 10 jobs\n');
f(root, 'qc', 'journal', 'applied', 'ui-focus-in-profile', 'Added UI states checklist.');
f(root, 'qc', 'journal', 'measured', 'ui-focus-in-profile', 'ui-ux CHANGES 71% → 12%. Keep.');
f(root, 'qc', 'journal', 'proposed', 'security-input-validation', 'Builder misses quantity validation.');

f(root, 'backlog', 'add', 'Gift cards at checkout');
f(root, 'backlog', 'add', 'Dark mode for the storefront');

// Serve the package's dashboard directly so edits show up on reload.
fs.rmSync(path.join(root, 'factory/dashboard'), { recursive: true, force: true });
fs.symlinkSync(path.join(__dirname, '..', 'factory', 'dashboard'), path.join(root, 'factory/dashboard'));

console.log(`demo repo: ${root}`);
const { serve } = require(path.join(root, 'factory/lib/server.js')); // the demo's own copy: paths resolve to the demo repo
serve({ port }).then(({ url }) => console.log(`dashboard: ${url}`));

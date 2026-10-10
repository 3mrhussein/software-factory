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

f(root, 'backlog', 'add', 'Gift cards at checkout');
f(root, 'backlog', 'add', 'Dark mode for the storefront');

// Serve the package's dashboard directly so edits show up on reload.
fs.rmSync(path.join(root, 'factory/dashboard'), { recursive: true, force: true });
fs.symlinkSync(path.join(__dirname, '..', 'factory', 'dashboard'), path.join(root, 'factory/dashboard'));

console.log(`demo repo: ${root}`);
const { serve } = require(path.join(root, 'factory/lib/server.js'));
serve({ port }).then(({ url }) => console.log(`dashboard: ${url}`));

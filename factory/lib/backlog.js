'use strict';
// factory/backlog.md: a plain markdown checklist.
//   - [ ] open item
//   - [x] claimed item → 004-job-id

const fs = require('fs');
const { paths, readText, writeFileAtomic, withLock, die } = require('./util');
const jobs = require('./jobs');

const HEADER = '# Backlog\n\n`/factory next` builds the first unchecked item and checks it off with its job id.\nReorder lines to change priority.\n\n';
const ITEM = /^(\s*)- \[( |x|X)\] (.+?)\s*$/;

function read() {
  const text = readText(paths().backlog) ?? HEADER;
  const lines = text.split('\n');
  const items = [];
  lines.forEach((line, i) => {
    const m = line.match(ITEM);
    if (!m) return;
    const [text_, jobId] = m[3].split(/\s+→\s+/);
    items.push({ line: i, done: m[2] !== ' ', text: text_.trim(), job: jobId ? jobId.trim() : null });
  });
  return { text, lines, items };
}

function list() {
  return read().items;
}

function add(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) die('backlog item is empty');
  if (clean.length > 500) die('backlog item is longer than 500 characters');
  return withLock('backlog', () => {
    const { text: body } = read();
    writeFileAtomic(paths().backlog, `${body.replace(/\n*$/, '\n')}- [ ] ${clean}\n`);
    return list();
  });
}

function remove(index) {
  return withLock('backlog', () => {
    const { lines, items } = read();
    const open = items.filter((i) => !i.done);
    const item = open[index];
    if (!item) die(`no open backlog item #${index}`);
    lines.splice(item.line, 1);
    writeFileAtomic(paths().backlog, lines.join('\n'));
    return list();
  });
}

// Atomically takes the first open item and creates its job.
function claim() {
  return withLock('backlog', () => {
    const { lines, items } = read();
    const item = items.find((i) => !i.done);
    if (!item) return null;
    const job = jobs.create(item.text, { source: 'backlog' });
    lines[item.line] = lines[item.line].replace(/- \[ \] .+$/, `- [x] ${item.text} → ${job.id}`);
    writeFileAtomic(paths().backlog, lines.join('\n'));
    return job;
  });
}

function ensure() {
  if (!fs.existsSync(paths().backlog)) writeFileAtomic(paths().backlog, HEADER);
}

module.exports = { list, add, remove, claim, ensure, HEADER };

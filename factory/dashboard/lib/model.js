// Board model shared by components: columns, stage metadata, formatting.

export const COLUMNS = [
  { key: 'backlog', title: 'Backlog', stages: [] },
  { key: 'spec', title: 'Spec', stages: ['setup', 'spec'] },
  { key: 'build', title: 'Build', stages: ['build'] },
  { key: 'review', title: 'Review', stages: ['review'] },
  { key: 'approve', title: 'Approve', stages: ['approve', 'deliver'] },
  { key: 'human', title: 'Needs you', stages: ['needs-human'] },
  { key: 'done', title: 'Done', stages: ['delivered', 'cancelled'] },
];

export const STAGE_LABEL = {
  setup: 'Setting up', spec: 'Writing spec', build: 'Building', review: 'In review', approve: 'Approving',
  deliver: 'Delivering', delivered: 'Delivered', 'needs-human': 'Needs you', cancelled: 'Cancelled',
};

export const columnOf = (job) => COLUMNS.find((c) => c.stages.includes(job.stage))?.key || 'spec';

export const isActive = (job) => !['delivered', 'cancelled', 'needs-human'].includes(job.stage);

const LENS_SHORT = { code: 'Code', security: 'Sec', 'ui-ux': 'UI/UX', database: 'DB', architecture: 'Arch' };
const LENS_LONG = { code: 'Code', security: 'Security', 'ui-ux': 'UI / UX', database: 'Database', architecture: 'Architecture' };
export const lensShort = (l) => LENS_SHORT[l] || l;
export const lensLong = (l) => LENS_LONG[l] || l;

export const jobNumber = (id) => `#${id.split('-')[0]}`;

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(fromIso, toIso) {
  const s = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

// Who is working on the job right now, in plain words.
export function activity(job) {
  // Reviewers stay in `awaiting` until the round is ticked; a landed verdict means done.
  const busy = (job.awaiting || []).filter((a) => !a.startsWith('reviewer-') || (job.reviews || {})[a.slice(9)] === 'pending');
  if (busy.length) {
    const names = busy.map((a) => (a.startsWith('reviewer-') ? lensShort(a.slice(9)) : a));
    return job.stage === 'review' ? `${names.length} reviewer${names.length > 1 ? 's' : ''} working` : `${names.join(', ')} working`;
  }
  if (job.stage === 'setup') return 'preparing worktree';
  if (job.stage === 'deliver') return 'delivering';
  return null;
}

// The files a job may have, derived from job.json (used when no server lists them).
export function candidateFiles(job) {
  const files = ['spec.md', 'build.md', 'build.prev.md', 'decision.md', 'pr-body.md', 'setup.log', 'diffstat.txt'];
  for (let k = 1; k <= (job.reworks || 0); k++) files.push(`rework-${k}.md`);
  for (const r of job.rounds || []) {
    files.push(`round-${r.n}/build.md`, `round-${r.n}/decision.md`);
    for (const l of Object.keys(r.verdicts)) files.push(`round-${r.n}/review-${l}.md`);
  }
  return files;
}

export function splitMarker(text) {
  const m = (text || '').match(/^\s*(VERDICT|STATUS|DECISION)\s*:\s*([A-Z-]+)\s*\n?/i);
  return m ? { marker: m[2].toUpperCase(), body: text.slice(m[0].length) } : { marker: null, body: text || '' };
}

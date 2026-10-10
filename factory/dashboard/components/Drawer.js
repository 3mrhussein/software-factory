import { html, useEffect, useRef, useState } from '../lib/h.js';
import { ReviewerChips } from './ReviewerChips.js';
import { JobFile } from './Markdown.js';
import { DiffView } from './DiffView.js';
import { STAGE_LABEL, lensLong, timeAgo, duration, activity } from '../lib/model.js';
import { listFiles, useQc } from '../lib/api.js';
import { HealthBadge } from './Insights.js';

const TABS = ['overview', 'spec', 'build', 'reviews', 'decision', 'diff', 'files'];
const TAB_LABEL = { overview: 'Overview', spec: 'Spec', build: 'Build', reviews: 'Reviews', decision: 'Decision', diff: 'Diff', files: 'Files' };

function Copy({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch { /* clipboard blocked: the text is still selectable */ }
  };
  return html`<button class="copy" onClick=${copy} title="Copy to clipboard"><code>${label || text}</code><span>${done ? 'copied' : 'copy'}</span></button>`;
}

function RoundsGrid({ job, onPick }) {
  if (!job.rounds.length) return html`<p class="muted">No review rounds yet.</p>`;
  return html`
    <table class="rounds-grid">
      <thead><tr><th>Round</th><th>Verdicts</th><th>Took</th></tr></thead>
      <tbody>
        ${job.rounds.map((r) => html`
          <tr key=${r.n}>
            <td>R${r.n}</td>
            <td><${ReviewerChips} lenses=${Object.keys(r.verdicts)} verdicts=${r.verdicts} working=${r.n === job.round ? job.awaiting : []} onPick=${(l) => onPick(r.n, l)} /></td>
            <td class="muted">${r.endedAt ? duration(r.startedAt, r.endedAt) : 'running'}</td>
          </tr>`)}
      </tbody>
    </table>`;
}

function QcVerdict({ job, server }) {
  const { data } = useQc({ server, version: job.updatedAt });
  const a = data && data.index.assessments.find((x) => x.job === job.id);
  if (!a) return null;
  return html`<div class="callout callout-qc"><${HealthBadge} health=${a.health} /><div><strong>QC post-mortem</strong><p>${a.verdict || a.title}</p><span class="muted small">factory/qc/${a.file} · ${a.date}</span></div></div>`;
}

function Overview({ job, now, onPickReview, server }) {
  const act = activity(job);
  const facts = [
    ['Stage', STAGE_LABEL[job.stage]],
    ['Branch', html`<code>${job.branch}</code>`],
    ['Base', html`<code>${job.baseBranch}${job.baseCommit ? ` @ ${job.baseCommit.slice(0, 7)}` : ''}</code>`],
    ['Round', `${job.round} of max ${job.maxRounds}${job.resumesUsed ? ` · ${job.resumesUsed} rework${job.resumesUsed > 1 ? 's' : ''}` : ''}`],
    ['Human reworks', job.reworks || 0],
    ['Created', `${timeAgo(job.createdAt, now)} · ${new Date(job.createdAt).toLocaleString()}`],
    ['Source', job.source === 'backlog' ? 'backlog' : '/factory command'],
  ];
  if (job.delivery) facts.push(['Delivery', job.delivery.prUrl ? html`<a href=${job.delivery.prUrl} target="_blank" rel="noopener noreferrer">${job.delivery.prUrl}</a>` : `${job.delivery.status}${job.delivery.mergeCommit ? ` · ${job.delivery.mergeCommit.slice(0, 10)}` : ''}`]);
  return html`
    <div class="overview">
      ${job.stage === 'needs-human' ? html`
        <div class="callout callout-human">
          <strong>Needs you</strong>
          <p>${job.attention}</p>
          <div class="callout-actions">
            <${Copy} text=${`/factory approve ${job.id}`} />
            <${Copy} text=${`/factory rework ${job.id} `} label=${`/factory rework ${job.id} <note>`} />
            <${Copy} text=${`/factory cancel ${job.id}`} />
          </div>
          <p class="muted small">Worktree: <code>${job.worktree}</code></p>
        </div>` : null}
      <${QcVerdict} job=${job} server=${server} />
      ${act ? html`<div class="callout callout-live"><span class="pulse"></span>${act}</div>` : null}
      <dl class="facts">
        ${facts.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}
      </dl>
      <h4>Review rounds</h4>
      <${RoundsGrid} job=${job} onPick=${onPickReview} />
      <h4>Timeline</h4>
      <ol class="timeline">
        ${[...job.history].reverse().map((h, i) => html`
          <li key=${i} class=${`tl-${h.stage}`}>
            <span class="tl-dot"></span>
            <span class="tl-note">${h.note}</span>
            <time title=${h.at}>${timeAgo(h.at, now)}</time>
          </li>`)}
      </ol>
    </div>`;
}

function Reviews({ job, server, version, pick, setPick }) {
  const rounds = job.rounds.map((r) => r.n);
  if (!rounds.length) return html`<div class="empty-state">Reviews start after the first build.</div>`;
  const round = pick.round || rounds[rounds.length - 1];
  const rec = job.rounds.find((r) => r.n === round);
  const lenses = Object.keys(rec.verdicts);
  const lens = pick.lens && lenses.includes(pick.lens) ? pick.lens : lenses[0];
  return html`
    <div class="reviews">
      <div class="subtabs">
        <div class="pills">
          ${rounds.map((n) => html`<button key=${n} class=${n === round ? 'on' : ''} onClick=${() => setPick({ round: n, lens })}>Round ${n}</button>`)}
        </div>
        <${ReviewerChips} lenses=${lenses} verdicts=${rec.verdicts} working=${round === job.round ? job.awaiting : []} size="lg" onPick=${(l) => setPick({ round, lens: l })} />
      </div>
      <div class="review-for">${lensLong(lens)} · round ${round}</div>
      <${JobFile} job=${job} path=${`round-${round}/review-${lens}.md`} server=${server} version=${version} empty="This reviewer has not written its review yet." />
      <details class="round-build">
        <summary>Build report reviewed in round ${round}</summary>
        <${JobFile} job=${job} path=${`round-${round}/build.md`} server=${server} version=${version} />
      </details>
    </div>`;
}

function Files({ job, server, version }) {
  const [files, setFiles] = useState(null);
  const [cur, setCur] = useState(null);
  useEffect(() => {
    listFiles(job, server).then(setFiles);
  }, [job.id, server, version]);
  if (!files) return html`<div class="loading">Loading…</div>`;
  return html`
    <div class="files">
      <ul class="file-list">
        ${files.filter((f) => f !== 'job.json').map((f) => html`<li key=${f}><button class=${cur === f ? 'on' : ''} onClick=${() => setCur(f)}><code>${f}</code></button></li>`)}
        <li><button class=${cur === 'job.json' ? 'on' : ''} onClick=${() => setCur('job.json')}><code>job.json</code></button></li>
      </ul>
      ${cur ? html`<${JobFile} key=${cur} job=${job} path=${cur} server=${server} version=${version} empty="Not written (yet)." />` : html`<p class="muted">Pick a file.</p>`}
    </div>`;
}

export function Drawer({ job, server, tab, setTab, onClose, now }) {
  const panel = useRef(null);
  const [pick, setPick] = useState({});
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [job.id]);
  useEffect(() => setPick({}), [job.id]);
  const version = job.updatedAt;
  const active = TABS.includes(tab) ? tab : 'overview';
  const onPickReview = (round, lens) => {
    setPick({ round, lens });
    setTab('reviews');
  };
  return html`
    <div class="drawer-backdrop" onClick=${onClose}></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label=${`Job ${job.id}`} tabindex="-1" ref=${panel}>
      <header class="drawer-head">
        <div class="drawer-title">
          <span class=${`stage-pill stage-${job.stage}`}>${STAGE_LABEL[job.stage]}</span>
          <code class="drawer-id">${job.id}</code>
          <button class="icon-btn close" onClick=${onClose} aria-label="Close">×</button>
        </div>
        <h2>${job.feature}</h2>
        <nav class="tabs" role="tablist">
          ${TABS.map((t) => html`<button key=${t} role="tab" aria-selected=${active === t} class=${active === t ? 'on' : ''} onClick=${() => setTab(t)}>${TAB_LABEL[t]}</button>`)}
        </nav>
      </header>
      <div class="drawer-body">
        ${active === 'overview' ? html`<${Overview} job=${job} now=${now} onPickReview=${onPickReview} server=${server} />` : null}
        ${active === 'spec' ? html`<${JobFile} job=${job} path="spec.md" server=${server} version=${version} empty="The spec-writer has not finished yet." />` : null}
        ${active === 'build' ? html`<${JobFile} job=${job} path="build.md" server=${server} version=${version} empty=${job.round ? 'The builder is working on the next round. Earlier build reports are under Reviews.' : 'The builder has not finished yet.'} />` : null}
        ${active === 'reviews' ? html`<${Reviews} job=${job} server=${server} version=${version} pick=${pick} setPick=${setPick} />` : null}
        ${active === 'decision' ? html`<${JobFile} job=${job} path="decision.md" server=${server} version=${version} empty="No decision yet: the approver runs after a round where every reviewer passes." />` : null}
        ${active === 'diff' ? html`<${DiffView} job=${job} server=${server} version=${version} />` : null}
        ${active === 'files' ? html`<${Files} job=${job} server=${server} version=${version} />` : null}
      </div>
    </aside>`;
}

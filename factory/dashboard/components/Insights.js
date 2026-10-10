import { html, useEffect, useState } from '../lib/h.js';
import { useQc, readQcFile } from '../lib/api.js';
import { ChartCard, LineChart, BarList, Sparkline } from './charts.js';
import { Markdown } from './Markdown.js';
import { lensLong, timeAgo } from '../lib/model.js';

const RANGES = [
  { key: 7, label: '7 days' },
  { key: 30, label: '30 days' },
  { key: 90, label: '90 days' },
  { key: 0, label: 'All time' },
];
const HEALTH = {
  GOOD: { cls: 'good', icon: '✓', label: 'Good' },
  WATCH: { cls: 'warning', icon: '!', label: 'Watch' },
  ACT: { cls: 'critical', icon: '‼', label: 'Act' },
};
const PROPOSAL_ORDER = ['proposed', 'approved', 'applied', 'measured', 'reverted', 'rejected'];

export function HealthBadge({ health }) {
  const h = HEALTH[health];
  if (!h) return html`<span class="health health-none">no verdict</span>`;
  return html`<span class=${`health health-${h.cls}`}><i aria-hidden="true">${h.icon}</i>${h.label}</span>`;
}

function Stat({ label, value, unit, sub, trend }) {
  return html`
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value ?? '–'}${value != null && unit ? html`<small>${unit}</small>` : null}</div>
      <div class="stat-foot">${sub ? html`<span>${sub}</span>` : html`<span></span>`}${trend ? html`<${Sparkline} values=${trend} />` : null}</div>
    </div>`;
}

function QcDoc({ path, server, onClose }) {
  const [text, setText] = useState(undefined);
  useEffect(() => {
    readQcFile(path, server).then(setText);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path]);
  return html`
    <div class="drawer-backdrop" onClick=${onClose}></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label=${path}>
      <header class="drawer-head">
        <div class="drawer-title"><code class="drawer-id">factory/qc/${path}</code><button class="icon-btn close" onClick=${onClose} aria-label="Close">×</button></div>
        <div style=${{ height: '12px' }}></div>
      </header>
      <div class="drawer-body">
        ${text === undefined ? html`<div class="loading">Loading…</div>` : text === null ? html`<div class="empty-state">Not found.</div>` : html`<${Markdown} text=${text} />`}
      </div>
    </aside>`;
}

export function Insights({ server, version, onOpenJob }) {
  const [range, setRange] = useState(() => {
    try {
      return Number(localStorage.getItem('factory.range') ?? 30);
    } catch {
      return 30;
    }
  });
  const [doc, setDoc] = useState(null);
  const { data, error } = useQc({ server, since: range || undefined, version });
  const pick = (r) => {
    setRange(r);
    try {
      localStorage.setItem('factory.range', String(r));
    } catch { /* per-viewer convenience */ }
  };

  if (error && !data) {
    return html`<div class="hero"><h2>No insights yet</h2><p>${server ? error : html`Static mode reads <code>factory/qc/report.json</code>. Run <code>node factory/bin/factory-cli.js qc index</code>, or serve with <code>factory-cli serve</code> for live insights.`}</p></div>`;
  }
  if (!data) return html`<div class="loading">Loading insights…</div>`;

  const { report: r, series: s, index } = data;
  const pts = s.points;
  const x = pts.map((p) => p.t.slice(5));
  const latestAudit = index.assessments.find((a) => !a.job) || index.assessments[0];
  const lenses = Object.entries(r.lenses).sort((a, b) => b[1].changesRatePct - a[1].changesRatePct);
  const causes = Object.entries(r.needsHuman).sort((a, b) => b[1] - a[1]);
  const stageOrder = ['setup', 'spec', 'build', 'review', 'approve', 'deliver', 'needs-human'];
  const stages = stageOrder.filter((st) => r.stageMinutes[st]).map((st) => [st, r.stageMinutes[st]]);
  const sizes = Object.entries(r.artifactBytes).sort((a, b) => b[1].approxTokens - a[1].approxTokens);
  const autonomy = r.flow.delivered ? Math.round((100 * r.flow.deliveredWithoutHuman) / r.flow.delivered) : null;
  const proposals = [...index.proposals].sort((a, b) => PROPOSAL_ORDER.indexOf(a.status) - PROPOSAL_ORDER.indexOf(b.status));

  return html`
    <div class=${`insights${data && error ? ' stale' : ''}`}>
      <div class="filterbar insights-filters">
        <div class="segmented" role="tablist" aria-label="Time range">
          ${RANGES.map((g) => html`<button key=${g.key} role="tab" aria-selected=${range === g.key} class=${range === g.key ? 'on' : ''} disabled=${!server && g.key !== 0} onClick=${() => pick(g.key)}>${g.label}</button>`)}
        </div>
        <span class="muted small">${data.snapshot ? `Snapshot from qc index · ${timeAgo(data.at)}` : `Live · ${r.window} · ${r.jobs.total} job${r.jobs.total === 1 ? '' : 's'}`}${r.jobs.total && r.jobs.total < 5 ? ' · small sample: read counts, not rates' : ''}</span>
      </div>

      <div class="insights-body">
        <section class="qc-headline">
          ${latestAudit
            ? html`
              <${HealthBadge} health=${latestAudit.health} />
              <div class="qc-headline-text">
                <strong>${latestAudit.verdict || latestAudit.title}</strong>
                <span class="muted small">QC ${latestAudit.job ? `post-mortem of ${latestAudit.job}` : 'audit'} · ${latestAudit.date}</span>
              </div>
              <button class="viz-toggle" onClick=${() => setDoc(latestAudit.file)}>Read assessment</button>`
            : html`<span class="health health-none">no verdict</span><div class="qc-headline-text"><strong>No QC assessment yet</strong><span class="muted small">The factory-qc agent reviews jobs that need you and audits every few deliveries (config.qc), or run /factory-qc.</span></div>`}
        </section>

        <div class="stats">
          <${Stat} label="Delivered" value=${r.flow.delivered} sub=${`${r.flow.reachedReview} reached review`} trend=${pts.map((p) => p.cumDelivered)} />
          <${Stat} label="First-pass rate" value=${r.flow.firstPassRatePct} unit="%" sub="round 1 all PASS" trend=${pts.map((p) => p.firstPassRolling)} />
          <${Stat} label="Review rounds per job" value=${r.flow.avgRounds} sub=${`${r.flow.builderResumes} builder reworks`} trend=${pts.map((p) => p.avgRoundsRolling)} />
          <${Stat} label="Autonomy" value=${autonomy} unit="%" sub="delivered without a human" />
          <${Stat} label="Median lead time" value=${r.flow.medianLeadTimeMin} unit="min" sub="created → delivered" />
          <${Stat} label="Needs you" value=${r.flow.openNeedsHuman} sub=${`${r.flow.humanReworks} human reworks`} />
        </div>

        <div class="viz-grid">
          <${ChartCard} wide title="Throughput" subtitle=${`Cumulative jobs, per ${s.unit}`}
            table=${{ columns: ['Date', 'Created', 'Delivered', 'Needs-human events'], rows: pts.map((p) => [p.t, p.cumCreated, p.cumDelivered, p.needsHuman]) }}>
            <${LineChart} x=${x} area series=${[
              { key: 'created', label: 'Created', color: '--series-1', values: pts.map((p) => p.cumCreated) },
              { key: 'delivered', label: 'Delivered', color: '--series-2', values: pts.map((p) => p.cumDelivered) },
            ]} />
          </${ChartCard}>

          <${ChartCard} title="First-pass rate" subtitle=${`Share of jobs whose first review round passed every lens · rolling ${s.window} ${s.unit}s`}
            table=${{ columns: ['Date', 'Rolling first-pass %', 'That ' + s.unit + ' %'], rows: pts.filter((p) => p.firstPassRolling != null).map((p) => [p.t, p.firstPassRolling, p.firstPassPct ?? '–']) }}>
            <${LineChart} x=${x} yMax=${100} area format=${(v) => `${Math.round(v)}%`} series=${[{ key: 'fp', label: 'First-pass rate', color: '--series-1', values: pts.map((p) => p.firstPassRolling) }]} emptyText="No first review rounds finished in this range." />
          </${ChartCard}>

          <${ChartCard} title="Reviewer pushback" subtitle="Share of reviews that asked for changes, by lens"
            table=${{ columns: ['Lens', 'Reviews', 'CHANGES', 'Rate', 'Blocker', 'Major', 'Minor', 'Nit'], rows: lenses.map(([l, v]) => [lensLong(l), v.reviews, v.changes, `${v.changesRatePct}%`, v.findings.blocker, v.findings.major, v.findings.minor, v.findings.nit]) }}>
            <${BarList} max=${100} rows=${lenses.map(([l, v]) => ({ label: lensLong(l), value: v.changesRatePct, display: `${v.changesRatePct}% · ${v.changes}/${v.reviews}`, detail: `blocker ${v.findings.blocker} · major ${v.findings.major} · minor ${v.findings.minor} · nit ${v.findings.nit}` }))} emptyText="No reviews in this range." />
          </${ChartCard}>

          <${ChartCard} title="Why humans were needed" subtitle="needs-human events by cause"
            table=${{ columns: ['Cause', 'Events'], rows: causes }}>
            <${BarList} rows=${causes.map(([c, n]) => ({ label: c, value: n }))} emptyText="No human interventions in this range." />
          </${ChartCard}>

          <${ChartCard} title="Time per stage" subtitle="Median minutes spent in each stage"
            table=${{ columns: ['Stage', 'Median min', 'Max min'], rows: stages.map(([st, v]) => [st, v.median, v.max]) }}>
            <${BarList} rows=${stages.map(([st, v]) => ({ label: st, value: v.median, display: `${v.median} min`, detail: `max ${v.max} min` }))} emptyText="No timing data yet." />
          </${ChartCard}>

          <${ChartCard} title="Artifact size" subtitle="Median ≈ tokens each downstream reader pays"
            table=${{ columns: ['Artifact', '≈ tokens', 'bytes', 'n'], rows: sizes.map(([k, v]) => [k, v.approxTokens, v.median, v.n]) }}>
            <${BarList} rows=${sizes.map(([k, v]) => ({ label: k, value: v.approxTokens, display: `${v.approxTokens.toLocaleString()} tok`, detail: `${v.n} files` }))} emptyText="No artifacts yet." />
          </${ChartCard}>

          <${ChartCard} title="Hotspots" subtitle="Files with the most blocker/major findings"
            table=${{ columns: ['File', 'Blocking findings'], rows: r.hotspots.map((h) => [h.file, h.blockingFindings]) }}>
            <${BarList} rows=${r.hotspots.map((h) => ({ label: h.file, value: h.blockingFindings }))} emptyText="No blocking findings in this range." />
          </${ChartCard}>
        </div>

        <div class="qc-panels">
          <section class="viz-card">
            <header class="viz-head"><div><h3>QC assessments</h3><p>Verdicts from the factory-qc agent and /factory-qc</p></div></header>
            ${index.assessments.length
              ? html`<ul class="qc-list">${index.assessments.slice(0, 12).map((a) => html`
                <li key=${a.file}>
                  <button class="qc-item" onClick=${() => setDoc(a.file)}>
                    <${HealthBadge} health=${a.health} />
                    <span class="qc-item-main"><strong>${a.verdict || a.title}</strong>
                      <span class="muted small">${a.job ? `job ${a.job}` : a.scope} · ${a.date}${a.findings.high ? ` · ${a.findings.high} high` : ''}${a.findings.medium ? ` · ${a.findings.medium} medium` : ''}</span></span>
                  </button>
                  ${a.job ? html`<button class="link small" onClick=${() => onOpenJob(a.job)}>open job</button>` : null}
                </li>`)}</ul>`
              : html`<div class="viz-empty">No assessments yet.</div>`}
          </section>

          <section class="viz-card">
            <header class="viz-head"><div><h3>Improvement proposals</h3><p>One change each, with a success metric</p></div></header>
            ${proposals.length
              ? html`<ul class="qc-list">${proposals.slice(0, 12).map((p) => html`
                <li key=${p.file}><button class="qc-item" onClick=${() => setDoc(p.file)}>
                  <span class=${`pstatus pstatus-${p.status}`}>${p.status}</span>
                  <span class="qc-item-main"><strong>${p.title}</strong><span class="muted small">${[p.type, p.scope, p.applied ? `applied ${p.applied}` : p.date].filter(Boolean).join(' · ')}${p.metric ? ` · metric: ${p.metric}` : ''}</span></span>
                </button></li>`)}</ul>`
              : html`<div class="viz-empty">No proposals yet.</div>`}
          </section>

          <section class="viz-card">
            <header class="viz-head"><div><h3>Signals & contract checks</h3><p>Computed from the evidence; leads for QC, not verdicts</p></div></header>
            ${r.signals.length || r.contractViolations.length
              ? html`<ul class="signal-list">
                  ${r.signals.map((t, i) => html`<li key=${`s${i}`}><span class="health health-warning"><i>!</i>signal</span><span>${t}</span></li>`)}
                  ${r.contractViolations.slice(0, 8).map((t, i) => html`<li key=${`c${i}`}><span class="health health-critical"><i>‼</i>contract</span><span>${t}</span></li>`)}
                </ul>`
              : html`<div class="viz-empty">No signals. Nothing unusual in this range.</div>`}
            ${index.journal.length ? html`<h4 class="journal-h">Journal</h4><ul class="journal">${index.journal.slice(0, 8).map((j, i) => html`<li key=${i}><span class=${`pstatus pstatus-${j.status}`}>${j.status}</span><code>${j.slug}</code><span class="muted small">${j.date}</span></li>`)}</ul>` : null}
          </section>
        </div>
      </div>
      ${doc ? html`<${QcDoc} path=${doc} server=${server} onClose=${() => setDoc(null)} />` : null}
    </div>`;
}

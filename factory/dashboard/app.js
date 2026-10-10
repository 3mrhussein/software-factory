import { html, ReactDOM, useEffect, useMemo, useRef, useState } from './lib/h.js';
import { useFactoryState } from './lib/api.js';
import { isActive } from './lib/model.js';
import { Header } from './components/Header.js';
import { FilterBar } from './components/FilterBar.js';
import { KanbanBoard } from './components/KanbanBoard.js';
import { Drawer } from './components/Drawer.js';
import { Insights } from './components/Insights.js';

// #/job/<id>/<tab> deep links.
function useHashRoute() {
  const parse = () => {
    if (/^#\/insights/.test(location.hash)) return { view: 'insights', job: null, tab: 'overview' };
    const m = location.hash.match(/^#\/job\/([^/]+)(?:\/(\w+))?/);
    return m ? { view: 'board', job: decodeURIComponent(m[1]), tab: m[2] || 'overview' } : { view: 'board', job: null, tab: 'overview' };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (job, tab = 'overview') => {
    const h = job === 'insights' ? '#/insights' : job ? `#/job/${encodeURIComponent(job)}/${tab}` : '#/';
    if (location.hash !== h) location.hash = h;
  };
  return [route, go];
}

// Briefly highlights cards whose job.json changed since the last render.
function useFlash(jobs) {
  const prev = useRef(new Map());
  const [flashing, setFlashing] = useState(new Set());
  useEffect(() => {
    const changed = [];
    for (const j of jobs) {
      const before = prev.current.get(j.id);
      if (before && before !== j.updatedAt) changed.push(j.id);
      prev.current.set(j.id, j.updatedAt);
    }
    if (!changed.length) return;
    setFlashing(new Set(changed));
    const t = setTimeout(() => setFlashing(new Set()), 1600);
    return () => clearTimeout(t);
  }, [jobs.map((j) => j.updatedAt).join()]);
  return flashing;
}

function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, []);
  return now;
}

function loadFilters() {
  const base = { q: '', view: 'all', lens: '', backlog: true };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem('factory.filters') || '{}'), q: '' };
  } catch {
    return base;
  }
}

function EmptyState({ state }) {
  const cfg = state.config;
  if (state.configError) return html`<div class="hero"><h2>config.json is invalid</h2><pre class="raw">${state.configError}</pre></div>`;
  if (cfg && !cfg.initialized) {
    return html`<div class="hero"><h2>Factory not initialized</h2><p>Open Claude Code in this repository and run <code>/factory-init</code>. It detects your stack, configures commands and turns reviewer roles on or off.</p></div>`;
  }
  return html`
    <div class="hero">
      <h2>No jobs yet</h2>
      <p>Start one from Claude Code:</p>
      <pre class="raw">/factory Add a dark mode toggle to the settings page</pre>
      <p>or queue features in the Backlog column and run <code>/factory next</code>.</p>
    </div>`;
}

function App() {
  const { state, mode, error, refresh, server } = useFactoryState();
  const [route, go] = useHashRoute();
  const [filters, setFiltersRaw] = useState(loadFilters);
  const now = useNow();
  const setFilters = (f) => {
    setFiltersRaw(f);
    try {
      localStorage.setItem('factory.filters', JSON.stringify({ view: f.view, lens: f.lens, backlog: f.backlog }));
    } catch { /* per-viewer convenience only */ }
  };
  const jobs = (state && state.jobs) || [];
  const flashing = useFlash(jobs);

  const lenses = useMemo(() => {
    const s = new Set();
    for (const j of jobs) (j.reviewers || []).forEach((l) => s.add(l));
    if (state && state.config) Object.entries(state.config.roles.reviewers).forEach(([l, r]) => r.enabled && s.add(l));
    return [...s];
  }, [state]);

  const counts = useMemo(() => ({
    all: jobs.length,
    active: jobs.filter((j) => !j.invalid && isActive(j)).length,
    human: jobs.filter((j) => j.invalid || j.stage === 'needs-human').length,
    done: jobs.filter((j) => ['delivered', 'cancelled'].includes(j.stage)).length,
  }), [state]);

  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return jobs.filter((j) => {
      if (j.invalid) return true;
      if (filters.view === 'active' && !isActive(j)) return false;
      if (filters.view === 'human' && j.stage !== 'needs-human') return false;
      if (filters.view === 'done' && !['delivered', 'cancelled'].includes(j.stage)) return false;
      if (filters.lens && !(j.rounds || []).some((r) => r.verdicts[filters.lens] === 'CHANGES')) return false;
      if (q && !`${j.id} ${j.feature} ${j.branch}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [state, filters]);

  useEffect(() => {
    const human = counts.human;
    document.title = human ? `(${human}) Software Factory` : 'Software Factory';
  }, [counts.human]);

  const selected = route.job ? jobs.find((j) => j.id === route.job) : null;

  return html`
    <div class="app">
      <${Header} state=${state} mode=${mode} error=${error} view=${route.view} onView=${(v) => go(v === 'insights' ? 'insights' : null)} needsYou=${counts.human} />
      ${!state
        ? html`<div class="hero">${error ? html`<h2>Can't load factory state</h2><pre class="raw">${error}</pre><p>Serve the dashboard with <code>node factory/bin/factory-cli.js serve</code>, or run <code>python3 -m http.server</code> from <code>factory/</code>.</p>` : html`<div class="loading">Loading…</div>`}</div>`
        : route.view === 'insights'
        ? html`<${Insights} server=${server} version=${state.at} onOpenJob=${(id) => go(id)} />`
        : html`
          <${FilterBar} filters=${filters} setFilters=${setFilters} counts=${counts} lenses=${lenses} />
          ${!jobs.length ? html`<${EmptyState} state=${state} />` : null}
          <${KanbanBoard} jobs=${visible} backlog=${state.backlog} server=${server} selected=${route.job}
            flashing=${flashing} onOpen=${(id) => go(id)} now=${now} showBacklog=${filters.backlog} onBacklogChange=${refresh} />
        `}
      ${selected ? html`<${Drawer} job=${selected} server=${server} tab=${route.tab} setTab=${(t) => go(selected.id, t)} onClose=${() => go(null)} now=${now} />` : null}
    </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);

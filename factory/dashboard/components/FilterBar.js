import { html, useEffect, useRef } from '../lib/h.js';
import { lensLong } from '../lib/model.js';

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'human', label: 'Needs you' },
  { key: 'done', label: 'Done' },
];

export function FilterBar({ filters, setFilters, counts, lenses }) {
  const search = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const set = (patch) => setFilters({ ...filters, ...patch });
  return html`
    <div class="filterbar" role="search">
      <div class="search">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="m14 14 4 4" /></svg>
        <input ref=${search} type="search" value=${filters.q} onInput=${(e) => set({ q: e.target.value })}
          placeholder="Search jobs, branches…" aria-label="Search jobs" />
        <kbd>/</kbd>
      </div>
      <div class="segmented" role="tablist" aria-label="View">
        ${VIEWS.map((v) => html`
          <button key=${v.key} role="tab" aria-selected=${filters.view === v.key} class=${filters.view === v.key ? 'on' : ''}
            onClick=${() => set({ view: v.key })}>
            ${v.label}${counts[v.key] != null ? html`<span class="seg-count">${counts[v.key]}</span>` : null}
          </button>`)}
      </div>
      <label class="select">
        <span>Changes from</span>
        <select value=${filters.lens} onChange=${(e) => set({ lens: e.target.value })}>
          <option value="">any reviewer</option>
          ${lenses.map((l) => html`<option key=${l} value=${l}>${lensLong(l)}</option>`)}
        </select>
      </label>
      <label class="toggle">
        <input type="checkbox" checked=${filters.backlog} onChange=${(e) => set({ backlog: e.target.checked })} />
        <span>Backlog</span>
      </label>
    </div>`;
}

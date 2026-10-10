import { html, useLayoutEffect, useRef } from '../lib/h.js';
import { JobCard } from './JobCard.js';
import { BacklogColumn } from './BacklogColumn.js';
import { COLUMNS, columnOf } from '../lib/model.js';

// FLIP animation: cards glide to their new column instead of jumping.
function useFlip(containerRef, deps) {
  const rects = useRef(new Map());
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map();
    el.querySelectorAll('[data-flip]').forEach((node) => {
      const id = node.getAttribute('data-flip');
      const r = node.getBoundingClientRect();
      next.set(id, r);
      const prev = rects.current.get(id);
      if (!prev || reduce) return;
      const dx = prev.left - r.left;
      const dy = prev.top - r.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    rects.current = next;
  }, deps);
}

export function KanbanBoard({ jobs, backlog, server, selected, flashing, onOpen, now, showBacklog, onBacklogChange }) {
  const ref = useRef(null);
  useFlip(ref, [jobs.map((j) => `${j.id}:${j.stage}`).join('|')]);
  const byCol = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  for (const j of jobs) byCol[j.invalid ? 'human' : columnOf(j)].push(j);
  // Most recent activity first, except Done which reads oldest→newest naturally reversed.
  for (const k of Object.keys(byCol)) byCol[k].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const cols = COLUMNS.filter((c) => c.key !== 'backlog' || showBacklog);
  return html`
    <div class="board" ref=${ref} style=${{ '--cols': cols.length }}>
      ${cols.map((c) => c.key === 'backlog'
        ? html`<${BacklogColumn} key="backlog" items=${backlog} server=${server} onChange=${onBacklogChange} />`
        : html`
          <section key=${c.key} class=${`col col-${c.key}`} aria-label=${c.title}>
            <header class="col-head">
              <span class="col-title">${c.title}</span>
              <span class="col-count">${byCol[c.key].length}</span>
            </header>
            <div class="col-body">
              ${byCol[c.key].length
                ? byCol[c.key].map((j) => html`<${JobCard} key=${j.id} job=${j} selected=${selected === j.id} flash=${flashing.has(j.id)} onOpen=${onOpen} now=${now} />`)
                : html`<div class="col-empty">—</div>`}
            </div>
          </section>`)}
    </div>`;
}

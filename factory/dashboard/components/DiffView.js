import { html, useEffect, useMemo, useState } from '../lib/h.js';
import { readDiff } from '../lib/api.js';

// Splits a unified diff into files with +/- counts.
function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of (text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : line.slice(11), lines: [], add: 0, del: 0, binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |similarity |rename |new file|deleted file|old mode|new mode)/.test(line)) {
      if (line.startsWith('new file')) cur.status = 'added';
      if (line.startsWith('deleted file')) cur.status = 'deleted';
      if (line.startsWith('rename from')) cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files')) cur.binary = true;
    if (line.startsWith('+')) cur.add++;
    else if (line.startsWith('-')) cur.del++;
    cur.lines.push(line);
  }
  return files;
}

const MAX_LINES = 1500;

function FileDiff({ file, open, toggle }) {
  return html`
    <section class="dfile" id=${`f-${file.path}`}>
      <button class="dfile-head" onClick=${toggle} aria-expanded=${open}>
        <span class="caret">${open ? '▾' : '▸'}</span>
        <code class="dfile-path">${file.path}</code>
        ${file.status ? html`<span class=${`tag tag-${file.status}`}>${file.status}</span>` : null}
        <span class="dstat"><span class="add">+${file.add}</span> <span class="del">−${file.del}</span></span>
      </button>
      ${open ? html`
        <div class="dlines" role="table">
          ${file.binary ? html`<div class="dline meta">Binary file</div>` : null}
          ${file.lines.slice(0, MAX_LINES).map((l, i) => {
            const kind = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('\\') ? 'meta' : 'ctx';
            return html`<div key=${i} class=${`dline ${kind}`}>${l || ' '}</div>`;
          })}
          ${file.lines.length > MAX_LINES ? html`<div class="dline meta">… ${file.lines.length - MAX_LINES} more lines</div>` : null}
        </div>` : null}
    </section>`;
}

export function DiffView({ job, server, version }) {
  const [data, setData] = useState(null);
  const [closed, setClosed] = useState({});
  useEffect(() => {
    let alive = true;
    readDiff(job, server).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [job.id, server, version]);
  const files = useMemo(() => parseDiff(data && data.diff), [data]);
  if (!data) return html`<div class="loading">Loading diff…</div>`;
  if (!files.length) {
    return html`<div class="empty-state">${job.round === 0 && job.stage !== 'delivered' ? 'No commits yet: the builder has not finished.' : 'No diff available.'}
      ${!server ? html`<br /><small>Static mode only shows diffs snapshotted at delivery. Use <code>factory-cli serve</code> for live diffs.</small>` : null}</div>`;
  }
  const add = files.reduce((s, f) => s + f.add, 0);
  const del = files.reduce((s, f) => s + f.del, 0);
  const many = files.length > 12;
  return html`
    <div class="diff">
      <div class="diff-summary">
        <span>${files.length} file${files.length === 1 ? '' : 's'} changed</span>
        <span class="add">+${add}</span><span class="del">−${del}</span>
        <span class="muted">${data.live ? `live · ${job.branch}` : 'snapshot at delivery'}</span>
      </div>
      <ul class="diff-index">
        ${files.map((f) => html`<li key=${f.path}><a href=${`#f-${f.path}`} onClick=${(e) => { e.preventDefault(); document.getElementById(`f-${f.path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
          <code>${f.path}</code></a><span class="dstat"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></li>`)}
      </ul>
      ${files.map((f) => {
        const open = closed[f.path] === undefined ? !many : !closed[f.path];
        return html`<${FileDiff} key=${f.path} file=${f} open=${open} toggle=${() => setClosed({ ...closed, [f.path]: open })} />`;
      })}
    </div>`;
}

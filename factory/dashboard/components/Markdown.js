import { html, useEffect, useState, useMemo } from '../lib/h.js';
import { renderMarkdown } from '../lib/markdown.js';
import { readFile } from '../lib/api.js';
import { splitMarker } from '../lib/model.js';

const MARKER_CLASS = { PASS: 'pass', CHANGES: 'changes', READY: 'pass', BLOCKED: 'changes', APPROVE: 'pass', ESCALATE: 'changes', GOOD: 'pass', WATCH: 'changes', ACT: 'critical' };

export function Markdown({ text }) {
  const { marker, body } = splitMarker(text);
  const out = useMemo(() => renderMarkdown(body), [body]);
  return html`
    <div class="doc">
      ${marker ? html`<div class=${`marker marker-${MARKER_CLASS[marker] || 'neutral'}`}>${marker}</div>` : null}
      <div class="md" dangerouslySetInnerHTML=${{ __html: out }} />
    </div>`;
}

// Loads one job file and renders it; re-fetches when `version` changes (live updates).
export function JobFile({ job, path, server, version, empty }) {
  const [text, setText] = useState(undefined);
  useEffect(() => {
    let alive = true;
    readFile(job, path, server).then((t) => alive && setText(t));
    return () => {
      alive = false;
    };
  }, [job.id, path, server, version]);
  if (text === undefined) return html`<div class="loading">Loading ${path}…</div>`;
  if (text === null) return html`<div class="empty-state">${empty || `${path} has not been written yet.`}</div>`;
  if (/\.(log|txt|patch|json)$/.test(path)) return html`<pre class="raw">${text}</pre>`;
  return html`<${Markdown} text=${text} />`;
}

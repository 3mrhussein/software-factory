import { html, useState } from '../lib/h.js';
import { addBacklogItem, removeBacklogItem } from '../lib/api.js';

export function BacklogColumn({ items, server, onChange }) {
  const open = (items || []).filter((i) => !i.done);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await addBacklogItem(text.trim());
      setText('');
      onChange();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (idx) => {
    try {
      await removeBacklogItem(idx);
      onChange();
    } catch (x) {
      setErr(x.message);
    }
  };

  return html`
    <section class="col col-backlog" aria-label="Backlog">
      <header class="col-head">
        <span class="col-title">Backlog</span>
        <span class="col-count">${open.length}</span>
      </header>
      <div class="col-body">
        ${open.map((item, idx) => html`
          <div key=${`${idx}-${item.text}`} class="backlog-item">
            <span class="backlog-rank">${idx === 0 ? 'next' : idx + 1}</span>
            <span class="backlog-text">${item.text}</span>
            ${server ? html`<button class="icon-btn" title="Remove from backlog" aria-label=${`Remove ${item.text}`} onClick=${() => remove(idx)}>×</button>` : null}
          </div>`)}
        ${!open.length ? html`<div class="col-empty">Empty. Add a feature, then run <code>/factory next</code></div>` : null}
        ${server
          ? html`
            <form class="backlog-add" onSubmit=${submit}>
              <input value=${text} onInput=${(e) => setText(e.target.value)} placeholder="Add a feature…" aria-label="New backlog item" maxlength="500" disabled=${busy} />
              <button type="submit" disabled=${busy || !text.trim()}>Add</button>
            </form>`
          : html`<p class="hint">Read-only in static mode. Edit <code>factory/backlog.md</code> or use <code>factory-cli serve</code>.</p>`}
        ${err ? html`<p class="error-text">${err}</p>` : null}
      </div>
    </section>`;
}

// Markdown → HTML with raw HTML escaped and unsafe link schemes dropped.
// Agent output is local, but it may quote untrusted text from the codebase.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = (href) => /^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(href || '') ? href : null;

let configured = false;
function setup(marked) {
  if (configured) return;
  configured = true;
  marked.use({
    gfm: true,
    renderer: {
      // marked ≤12 passes positional args; ≥13 passes a token object.
      html(arg) {
        return esc(typeof arg === 'string' ? arg : arg.text || arg.raw || '');
      },
      link(href, title, text) {
        if (href && typeof href === 'object') ({ href, title, text } = href);
        const safe = safeHref(href);
        if (!safe) return text;
        return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
      },
      image(href, title, text) {
        if (href && typeof href === 'object') ({ text } = href);
        return esc(text || '');
      },
    },
  });
}

export function renderMarkdown(md) {
  const marked = window.marked;
  if (!marked) return `<pre>${esc(md)}</pre>`;
  setup(marked);
  // Hide template guidance comments that agents forgot to delete.
  return marked.parse(String(md || '').replace(/<!--[\s\S]*?-->/g, ''));
}

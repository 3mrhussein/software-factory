import { html } from '../lib/h.js';
import { lensShort, lensLong } from '../lib/model.js';

const ICON = { PASS: '✓', CHANGES: '!', pending: '' };
const WORD = { PASS: 'passed', CHANGES: 'requested changes', pending: 'pending' };

// One chip per reviewer lens active for this job. `working` lenses pulse.
export function ReviewerChips({ lenses, verdicts, working = [], size = 'sm', onPick, muted = false }) {
  if (!lenses || !lenses.length) return html`<span class="chips-empty">no reviewers</span>`;
  return html`
    <div class=${`chips chips-${size}${muted ? ' chips-muted' : ''}`} role="list">
      ${lenses.map((l) => {
        const v = (verdicts && verdicts[l]) || 'pending';
        const busy = v === 'pending' && working.includes(`reviewer-${l}`);
        const label = `${lensLong(l)}: ${WORD[v]}`;
        const Tag = onPick ? 'button' : 'span';
        return html`
          <${Tag} key=${l} role="listitem" class=${`chip chip-${v.toLowerCase()}${busy ? ' chip-busy' : ''}`} title=${label} aria-label=${label}
            onClick=${onPick ? (e) => { e.stopPropagation(); onPick(l); } : undefined}>
            <span class="chip-dot" aria-hidden="true">${ICON[v]}</span>${size === 'lg' ? lensLong(l) : lensShort(l)}
          </${Tag}>`;
      })}
    </div>`;
}

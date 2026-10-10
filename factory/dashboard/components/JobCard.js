import { html, memo } from '../lib/h.js';
import { ReviewerChips } from './ReviewerChips.js';
import { STAGE_LABEL, activity, jobNumber, timeAgo } from '../lib/model.js';

function RoundDots({ round, max }) {
  if (!max) return null;
  return html`
    <span class="rounds" title=${`Review round ${round} of max ${max}`}>
      ${Array.from({ length: max }, (_, i) => html`<i key=${i} class=${i < round ? 'on' : ''}></i>`)}
      <span class="rounds-label">R${round}/${max}</span>
    </span>`;
}

export const JobCard = memo(function JobCard({ job, selected, flash, onOpen, now }) {
  if (job.invalid) {
    return html`<article class="card card-invalid" data-flip=${job.id}><div class="card-top"><span class="card-id">${job.id}</span></div><p class="card-attn">Invalid job.json: ${job.invalid}</p></article>`;
  }
  const act = activity(job);
  const lastRound = job.rounds && job.rounds[job.rounds.length - 1];
  const verdicts = job.stage === 'review' ? job.reviews : lastRound ? lastRound.verdicts : null;
  const open = () => onOpen(job.id);
  return html`
    <article
      class=${`card stage-${job.stage}${selected ? ' card-selected' : ''}${flash ? ' card-flash' : ''}`}
      data-flip=${job.id}
      tabindex="0"
      role="button"
      aria-label=${`${job.id}: ${job.feature}. ${STAGE_LABEL[job.stage]}`}
      onClick=${open}
      onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}>
      <div class="card-top">
        <span class="card-id">${jobNumber(job.id)}</span>
        <${RoundDots} round=${job.round} max=${job.maxRounds} />
        <span class="card-time" title=${job.updatedAt}>${timeAgo(job.updatedAt, now)}</span>
      </div>
      <h3 class="card-title">${job.feature}</h3>
      ${job.round > 0 || job.stage === 'review' ? html`<${ReviewerChips} lenses=${job.reviewers} verdicts=${verdicts} working=${job.awaiting} muted=${job.stage !== 'review'} />` : null}
      ${act ? html`<div class="card-activity"><span class="pulse" aria-hidden="true"></span>${act}</div>` : null}
      ${job.stage === 'needs-human' && job.attention ? html`<p class="card-attn">${job.attention}</p>` : null}
      ${job.delivery && job.delivery.status !== 'failed' && job.stage === 'delivered'
        ? html`<div class="card-delivery">${job.delivery.status === 'pr-open'
          ? html`<a href=${job.delivery.prUrl} target="_blank" rel="noopener noreferrer" onClick=${(e) => e.stopPropagation()}>PR open ↗</a>`
          : html`<span>merged${job.delivery.mergeCommit ? html` · <code>${job.delivery.mergeCommit.slice(0, 7)}</code>` : ''}</span>`}</div>`
        : null}
      ${job.stage === 'cancelled' ? html`<div class="card-delivery muted">cancelled</div>` : null}
    </article>`;
});

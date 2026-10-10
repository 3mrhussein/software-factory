import { html, useState } from '../lib/h.js';
import { lensLong } from '../lib/model.js';

const MODE = {
  live: ['live', 'Live: pushed by factory-cli serve'],
  polling: ['polling', 'Polling every 2s'],
  static: ['static', 'Static files, polling every 2s'],
  connecting: ['connecting', 'Connecting…'],
};

function ThemeToggle() {
  const read = () => document.documentElement.dataset.theme || 'system';
  const [theme, setTheme] = useState(read);
  const cycle = () => {
    const next = { system: 'light', light: 'dark', dark: 'system' }[theme];
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('factory.theme');
      else localStorage.setItem('factory.theme', next);
    } catch { /* storage unavailable: preference lasts this page view */ }
    setTheme(next);
  };
  const icon = { system: '◐', light: '☀', dark: '☾' }[theme];
  return html`<button class="icon-btn theme" onClick=${cycle} title=${`Theme: ${theme}`} aria-label=${`Theme: ${theme}. Click to change.`}>${icon}</button>`;
}

export function Header({ state, mode, error }) {
  const cfg = state && state.config;
  const reviewers = cfg ? Object.entries(cfg.roles.reviewers) : [];
  const stack = cfg ? [...(cfg.project.languages || []), ...(cfg.project.frameworks || [])].slice(0, 6) : [];
  const [modeKey, modeTitle] = MODE[mode] || MODE.connecting;
  return html`
    <header class="topbar">
      <div class="brand">
        <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" /><path d="M8 22V12l5 3v-3l5 3v-3l6 4v6z" /></svg>
        <div>
          <h1>Software Factory</h1>
          <div class="repo">${state ? state.repo : '…'}${stack.length ? html` · <span class="muted">${stack.join(' · ')}</span>` : null}</div>
        </div>
      </div>
      <div class="roster" aria-label="Reviewer roster">
        ${reviewers.map(([l, r]) => html`
          <span key=${l} class=${`role ${r.enabled ? 'role-on' : 'role-off'}`} title=${`${lensLong(l)}: ${r.enabled ? 'active' : 'inactive'}. ${r.reason}${l === 'ui-ux' && r.enabled ? ` (${r.mode} mode)` : ''}`}>
            ${lensLong(l)}${l === 'ui-ux' && r.enabled && r.mode === 'static' ? html`<small> static</small>` : null}
          </span>`)}
      </div>
      <div class="topbar-right">
        ${cfg ? html`<span class="delivery" title="Delivery strategy">${cfg.delivery.strategy === 'github-pr' ? 'GitHub PR' : `merge → ${cfg.git.baseBranch}`}${cfg.approval.mode === 'human' ? ' · human sign-off' : ''}</span>` : null}
        <span class=${`conn conn-${error ? 'error' : modeKey}`} title=${error || modeTitle}><i></i>${error ? 'offline' : modeKey}</span>
        <${ThemeToggle} />
      </div>
    </header>`;
}

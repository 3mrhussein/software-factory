// Small, dependency-free chart kit: line chart (crosshair tooltip), horizontal
// bar list, sparkline, and a card with a table view. Marks follow the dataviz
// spec: 2px lines, ≤24px bars with 4px rounded ends, hairline grid, text in ink
// tokens (never the series color), legend for ≥2 series.
import { html, useRef, useState, useLayoutEffect } from '../lib/h.js';
import { useTweened } from '../lib/tween.js';

const fmtInt = (v) => (v == null ? '–' : Math.round(v).toLocaleString());

// Clean axis ticks: 0 … max rounded to 1/2/5×10^n.
function niceMax(max, ticks = 4) {
  if (!max || max <= 0) return { top: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { top: step * Math.ceil(max / step), step };
}

export function ChartCard({ title, subtitle, table, children, wide }) {
  const [showTable, setShowTable] = useState(false);
  return html`
    <section class=${`viz-card${wide ? ' viz-wide' : ''}`}>
      <header class="viz-head">
        <div>
          <h3>${title}</h3>
          ${subtitle ? html`<p>${subtitle}</p>` : null}
        </div>
        ${table ? html`<button class="viz-toggle" aria-pressed=${showTable} onClick=${() => setShowTable(!showTable)}>${showTable ? 'Chart' : 'Table'}</button>` : null}
      </header>
      ${showTable && table
        ? html`<div class="viz-table-wrap"><table class="viz-table">
            <thead><tr>${table.columns.map((c) => html`<th key=${c}>${c}</th>`)}</tr></thead>
            <tbody>${table.rows.map((r, i) => html`<tr key=${i}>${r.map((c, j) => html`<td key=${j}>${c}</td>`)}</tr>`)}</tbody>
          </table></div>`
        : children}
    </section>`;
}

// Measures the container so SVG units = CSS pixels (text never scales).
function useWidth(ref, fallback = 640) {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return w;
}

export function LineChart({ x, series, format = fmtInt, height = 200, yMax, area = false, emptyText = 'No data in this range yet.' }) {
  const box = useRef(null);
  const [hover, setHover] = useState(null);
  const W = useWidth(box);
  const H = height;
  const pad = { l: 40, r: 64, t: 12, b: 26 };
  const flat = series.flatMap((s) => s.values.filter((v) => v != null));
  const { top, step } = niceMax(yMax ?? Math.max(1, ...flat));
  const tweened = series.map((s) => useTweened(s.values)); // eslint-disable-line react-hooks/rules-of-hooks
  if (!flat.length) return html`<div class="viz-plot" ref=${box}><div class="viz-empty">${emptyText}</div></div>`;
  const n = x.length;
  const px = (i) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const py = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const pathOf = (vals) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const xLabels = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const onMove = (e) => {
    const r = box.current.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    setHover({ i, left: (px(i) / W) * 100 });
  };
  const lastIdx = (vals) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i;
    return -1;
  };
  return html`
    <div class="viz-plot" ref=${box} onPointerMove=${onMove} onPointerLeave=${() => setHover(null)}>
      ${series.length > 1 ? html`<div class="viz-legend">${series.map((s) => html`<span key=${s.key}><i class="key-line" style=${{ background: `var(${s.color})` }}></i>${s.label}</span>`)}</div>` : null}
      <svg viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} role="img" aria-label=${series.map((s) => s.label).join(', ')}>
        ${ticks.map((v) => html`<g key=${v}>
          <line class="viz-gridline" x1=${pad.l} x2=${W - pad.r} y1=${py(v)} y2=${py(v)} />
          <text class="viz-tick" x=${pad.l - 8} y=${py(v) + 4} text-anchor="end">${format(v)}</text>
        </g>`)}
        ${xLabels.map((i) => html`<text key=${`x${i}`} class="viz-tick" x=${px(i)} y=${H - 6} text-anchor=${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>${x[i]}</text>`)}
        ${series.map((s, si) => {
          const vals = tweened[si];
          const d = pathOf(vals);
          const li = lastIdx(vals);
          return html`<g key=${s.key}>
            ${area && d ? html`<path class="viz-area" d=${`${d}L${px(li)},${py(0)}L${px(vals.findIndex((v) => v != null))},${py(0)}Z`} style=${{ fill: `var(${s.color})` }} />` : null}
            <path class="viz-line" d=${d} style=${{ stroke: `var(${s.color})` }} />
            ${li >= 0 ? html`<circle class="viz-dot" cx=${px(li)} cy=${py(vals[li])} r="4" style=${{ fill: `var(${s.color})` }} />` : null}
            ${li >= 0 && series.length <= 4 ? html`<text class="viz-endlabel" x=${px(li) + 9} y=${py(vals[li]) + 4}>${format(s.values[li])}</text>` : null}
          </g>`;
        })}
        ${hover ? html`<line class="viz-cross" x1=${px(hover.i)} x2=${px(hover.i)} y1=${pad.t} y2=${H - pad.b} />` : null}
        ${hover ? series.map((s) => (s.values[hover.i] == null ? null : html`<circle key=${`h${s.key}`} class="viz-dot" cx=${px(hover.i)} cy=${py(s.values[hover.i])} r="4" style=${{ fill: `var(${s.color})` }} />`)) : null}
      </svg>
      ${hover ? html`
        <div class=${`viz-tip${hover.left > 60 ? ' left' : ''}`} style=${{ left: `${hover.left}%` }}>
          <div class="viz-tip-x">${x[hover.i]}</div>
          ${series.map((s) => html`<div key=${s.key} class="viz-tip-row"><i class="key-line" style=${{ background: `var(${s.color})` }}></i><strong>${s.values[hover.i] == null ? '–' : format(s.values[hover.i])}</strong><span>${s.label}</span></div>`)}
        </div>` : null}
    </div>`;
}

// Horizontal bars for one measure across categories (single series → one color).
export function BarList({ rows, format = fmtInt, max, emptyText = 'Nothing to show yet.', color = '--series-1' }) {
  const [tip, setTip] = useState(null);
  const top = max ?? Math.max(1, ...rows.map((r) => r.value || 0));
  if (!rows.length) return html`<div class="viz-empty">${emptyText}</div>`;
  return html`
    <ul class="barlist" onPointerLeave=${() => setTip(null)}>
      ${rows.map((r) => html`
        <li key=${r.label} tabindex="0" onPointerEnter=${() => setTip(r.label)} onFocus=${() => setTip(r.label)} onBlur=${() => setTip(null)} class=${tip === r.label ? 'hot' : ''}>
          <span class="bar-label" title=${r.label}>${r.label}</span>
          <span class="bar-track">
            <span class="bar-fill" style=${{ width: `${Math.max(r.value ? 1.5 : 0, (100 * (r.value || 0)) / top)}%`, background: `var(${r.color || color})` }}></span>
            <span class="bar-value">${r.display ?? format(r.value)}</span>
          </span>
          ${tip === r.label && r.detail ? html`<span class="bar-tip">${r.detail}</span>` : null}
        </li>`)}
    </ul>`;
}

export function Sparkline({ values, color = '--series-1' }) {
  const v = useTweened(values.map((x) => x ?? null));
  const pts = v.map((y, i) => [i, y]).filter(([, y]) => y != null);
  if (pts.length < 2) return null;
  const W = 100;
  const H = 28;
  const lo = Math.min(...pts.map((p) => p[1]));
  const hi = Math.max(...pts.map((p) => p[1]));
  const sx = (i) => (i / (values.length - 1)) * W;
  const sy = (y) => H - 3 - ((y - lo) / (hi - lo || 1)) * (H - 6);
  const d = pts.map(([i, y], k) => `${k ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(y).toFixed(1)}`).join('');
  const [li, ly] = pts[pts.length - 1];
  return html`<svg class="spark" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
    <path d=${d} style=${{ stroke: `var(--spark)` }} />
    <circle cx=${sx(li)} cy=${sy(ly)} r="2.5" style=${{ fill: `var(${color})` }} />
  </svg>`;
}

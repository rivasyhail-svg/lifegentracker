/**
 * Minimal dependency-free SVG charts (responsive via viewBox).
 */
import { esc } from './ui.js';

const PAD = { top: 18, right: 12, bottom: 30, left: 36 };

function niceMax(max) {
  if (max <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.ceil(max / (p * step / 5)) * (p * step / 5) || 5;
}

function frame(w, h, max, ticks = 4) {
  const innerH = h - PAD.top - PAD.bottom;
  let out = '<g class="grid">';
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = PAD.top + innerH - (v / max) * innerH;
    out += `<line x1="${PAD.left}" x2="${w - PAD.right}" y1="${y}" y2="${y}"/>`;
    out += `<text x="${PAD.left - 6}" y="${y + 3.5}" text-anchor="end">${Math.round(v)}</text>`;
  }
  return out + '</g>';
}

/**
 * Bar chart. data: [{label, value, alt?, title?}]
 * opts: { height, showValues, stacked: [{key, cls}], }
 */
export function barChart(data, opts = {}) {
  const w = opts.width || 560, h = opts.height || 230;
  if (!data.length) return `<div class="chart-empty">${esc(opts.empty || 'No data yet.')}</div>`;
  const stacked = opts.stacked;
  const max = niceMax(Math.max(1, ...data.map((d) => (stacked ? stacked.reduce((s, k) => s + (d[k.key] || 0), 0) : d.value))));
  const innerW = w - PAD.left - PAD.right, innerH = h - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const bw = Math.min(42, slot * 0.64);
  let bars = '';
  data.forEach((d, i) => {
    const x = PAD.left + slot * i + (slot - bw) / 2;
    if (stacked) {
      let yTop = PAD.top + innerH;
      const total = stacked.reduce((s, k) => s + (d[k.key] || 0), 0);
      for (const k of stacked) {
        const v = d[k.key] || 0;
        const bh = (v / max) * innerH;
        yTop -= bh;
        bars += `<rect class="bar ${k.cls || ''}" x="${x}" y="${yTop}" width="${bw}" height="${bh}" rx="3"><title>${esc(d.title || d.label)}: ${k.label || k.key} ${v}</title></rect>`;
      }
      if (opts.showValues && total) bars += `<text class="value" x="${x + bw / 2}" y="${yTop - 4}" text-anchor="middle">${total}</text>`;
    } else {
      const bh = (d.value / max) * innerH;
      const y = PAD.top + innerH - bh;
      bars += `<rect class="bar ${d.alt ? 'bar--alt' : ''} ${d.muted ? 'bar--muted' : ''}" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="3"><title>${esc(d.title || d.label)}: ${d.value}</title></rect>`;
      if (opts.showValues !== false && data.length <= 16) bars += `<text class="value" x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${d.value}</text>`;
    }
    const every = data.length > 16 ? Math.ceil(data.length / 12) : 1;
    if (i % every === 0 || i === data.length - 1) {
      bars += `<text class="${data.length > 10 ? 'label--sm' : ''}" x="${x + bw / 2}" y="${h - 10}" text-anchor="middle">${esc(d.label)}</text>`;
    }
  });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opts.aria || 'Bar chart')}">${frame(w, h, max)}${bars}</svg>`;
}

/** Line/area chart. data: [{label, value, title?}] */
export function lineChart(data, opts = {}) {
  const w = opts.width || 560, h = opts.height || 230;
  if (data.length < 2) return `<div class="chart-empty">${esc(opts.empty || 'At least two Sundays are needed to show a trend.')}</div>`;
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const innerW = w - PAD.left - PAD.right, innerH = h - PAD.top - PAD.bottom;
  const pts = data.map((d, i) => [PAD.left + (innerW / (data.length - 1)) * i, PAD.top + innerH - (d.value / max) * innerH]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${PAD.top + innerH} L${pts[0][0].toFixed(1)},${PAD.top + innerH} Z`;
  let dots = '', labels = '';
  const every = Math.max(1, Math.ceil(data.length / 8));
  pts.forEach((p, i) => {
    dots += `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="3.5"><title>${esc(data[i].title || data[i].label)}: ${data[i].value}</title></circle>`;
    if (i % every === 0 || i === pts.length - 1) labels += `<text class="label--sm" x="${p[0]}" y="${h - 10}" text-anchor="middle">${esc(data[i].label)}</text>`;
  });
  // Moving average (4 Sundays)
  let avgPath = '';
  if (opts.average && data.length >= 4) {
    const avgPts = pts.map((p, i) => {
      const slice = data.slice(Math.max(0, i - 3), i + 1);
      const v = slice.reduce((s, d) => s + d.value, 0) / slice.length;
      return [p[0], PAD.top + innerH - (v / max) * innerH];
    });
    avgPath = `<path d="${avgPts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="#9aa0a6" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  }
  return `<svg class="chart ${opts.cls || ''}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opts.aria || 'Trend chart')}">
    <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0f766e" stop-opacity=".12"/><stop offset="1" stop-color="#0f766e" stop-opacity="0"/></linearGradient></defs>
    ${frame(w, h, max)}<path class="area" d="${area}"/><path class="line" d="${path}"/>${avgPath}${dots}${labels}</svg>`;
}

/**
 * Several lines on one chart (e.g. boys groups vs girls groups).
 * labels: ['May', 'Jun', ...]; series: [{name, color, values:[...]}]
 */
export function multiLineChart(labels, series, opts = {}) {
  const w = opts.width || 560, h = opts.height || 230;
  if (labels.length < 2) return `<div class="chart-empty">${esc(opts.empty || 'At least two months are needed to show growth.')}</div>`;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const innerW = w - PAD.left - PAD.right, innerH = h - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (innerW / (labels.length - 1)) * i;
  const y = (v) => PAD.top + innerH - (v / max) * innerH;
  let out = '';
  for (const s of series) {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    out += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    pts.forEach((p, i) => { out += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${s.color}"><title>${esc(s.name)} · ${esc(labels[i])}: ${s.values[i]}</title></circle>`; });
  }
  const every = Math.max(1, Math.ceil(labels.length / 8));
  let lab = '';
  labels.forEach((l, i) => { if (i % every === 0 || i === labels.length - 1) lab += `<text class="label--sm" x="${x(i)}" y="${h - 10}" text-anchor="middle">${esc(l)}</text>`; });
  const legend = series.map((s) => `<span class="legend__item"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(opts.aria || 'Growth chart')}">${frame(w, h, max)}${out}${lab}</svg><div class="legend">${legend}</div>`;
}

/** Donut. parts: [{label, value, color}] */
export function donutChart(parts, opts = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const size = opts.size || 160, r = 60, c = 2 * Math.PI * r;
  let offset = 0, segs = '';
  for (const p of parts) {
    if (!p.value) continue;
    const len = (p.value / total) * c;
    segs += `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${p.color}" stroke-width="22" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(p.label)}: ${p.value}</title></circle>`;
    offset += len;
  }
  if (!total) segs = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--ink-200)" stroke-width="22"/>`;
  const center = opts.center ?? total;
  const legend = parts.map((p) => `<div><i style="background:${p.color}"></i>${esc(p.label)}<b>${p.value}${total ? ` <span class="muted small">(${Math.round((p.value / total) * 100)}%)</span>` : ''}</b></div>`).join('');
  return `<div class="donut-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(opts.aria || 'Breakdown')}">${segs}
      <text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" style="font-size:26px;font-weight:700;fill:var(--ink-900)">${esc(center)}</text>
      <text x="${size / 2}" y="${size / 2 + 18}" text-anchor="middle" style="font-size:11px;fill:var(--ink-500)">${esc(opts.centerLabel || 'total')}</text>
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

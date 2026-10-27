// Shared helpers: API client, formatting, icons, chart defaults.
// The dashboard key is kept in memory and in a session cookie so a refresh does not ask again.
const readCookie = () => { try { return decodeURIComponent((document.cookie.match(/(?:^|; )dashKey=([^;]*)/) || [])[1] || '') || null; } catch { return null; } };
let dashKey = readCookie();

export function setKey(k) {
  dashKey = k;
  try { document.cookie = `dashKey=${encodeURIComponent(k)}; path=/; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`; } catch { /* ignore */ }
}

export class AuthError extends Error {}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (dashKey) headers['X-Dashboard-Key'] = dashKey;
  const res = await fetch(`${window.API_BASE}${path}`, {
    method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  if (res.status === 401) throw new AuthError('Dashboard key required');
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch { /* not json */ }
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export function apiUrl(path) {
  return `${window.API_BASE}${path}`;
}

// ---------- formatting
export const fmt = {
  n(v, d = 0) {
    if (v === null || v === undefined || Number.isNaN(+v)) return '–';
    return (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  },
  compact(v) {
    if (v === null || v === undefined) return '–';
    return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(+v);
  },
  date(d) {
    if (!d) return '–';
    const x = typeof d === 'string' && d.length === 10 ? new Date(d + 'T00:00:00') : new Date(d);
    return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
  short(d) {
    if (!d) return '–';
    const x = typeof d === 'string' && d.length === 10 ? new Date(d + 'T00:00:00') : new Date(d);
    return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },
  time(d, tz) {
    if (!d) return '–';
    try {
      return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' });
    } catch { return new Date(d).toLocaleString(); }
  },
  clock(d, tz) {
    if (!d) return '–';
    try { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }); }
    catch { return new Date(d).toLocaleTimeString(); }
  },
  ago(days) {
    if (days === null || days === undefined) return 'Never';
    if (days === 0) return 'Today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const OBJECT_LABELS = {
  columns: 'Columns', etl_programs: 'ETL programs', bi_tables: 'BI tables', dq_rules: 'DQ rules',
  data_domains: 'Data domains', use_cases: 'Use cases', db_tables: 'DB tables', jobs: 'Jobs', alarms: 'Alarms', other: 'Other',
};
export const objLabel = (o) => OBJECT_LABELS[o] || o.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const STATUS_LABEL = { healthy: 'Healthy', watch: 'Needs attention', at_risk: 'At risk' };
export const CONF_LABEL = { calibrating: 'Calibrating', building: 'Building baseline', calibrated: 'Calibrated' };
export const COMP_LABEL = {
  engagement: 'Engagement', recency: 'Recency', breadth: 'User breadth', adoption: 'Adoption',
  consistency: 'Consistency', platform: 'Platform',
};

export const ICON = {
  healthy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  watch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4.5v4.5M8 11.5v.5"/><circle cx="8" cy="8" r="6.5" stroke-width="1.6"/></svg>',
  at_risk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2l6.5 11.5h-13z" stroke-linejoin="round" stroke-width="1.6"/><path d="M8 6.5v3M8 11.5v.3"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v3.5M8 5v.3"/></svg>',
  good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 11l4-4 3 3 5-5"/><path d="M10 5h4v4"/></svg>',
  risk: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2l6.5 11.5h-13z" stroke-linejoin="round" stroke-width="1.6"/><path d="M8 6.5v3M8 11.5v.3"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19V5M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  dotc: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>',
};

export function badge(status, size = '') {
  return `<span class="badge ${status} ${size}">${ICON[status] || ''}${STATUS_LABEL[status] || status}</span>`;
}
export function confBadge(c) {
  return `<span class="badge ${c}" title="How much history the score is based on">${CONF_LABEL[c] || c}</span>`;
}
export function delta(pct, { invert = false, suffix = '%' } = {}) {
  if (pct === null || pct === undefined) return '<span class="delta flat">no prior data</span>';
  const v = +pct;
  if (Math.abs(v) < 0.5) return '<span class="delta flat">0' + suffix + '</span>';
  const good = invert ? v < 0 : v > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${v > 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(Math.abs(v) < 10 && suffix === '%' ? 0 : 0)}${suffix}</span>`;
}
export function pctChange(cur, prev) {
  if (!prev) return cur ? null : 0;
  return ((cur - prev) / prev) * 100;
}
export function scoreColor(score, th) {
  if (score >= th.healthy) return 'var(--healthy)';
  if (score >= th.watch) return 'var(--watch)';
  return 'var(--risk)';
}

export function sparkline(values, { w = 96, h = 26, color = 'var(--primary)', min, max } = {}) {
  if (!values || values.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 2) + 1},${h - 2 - ((v - lo) / span) * (h - 4)}`).join(' ');
  const last = pts.split(' ').pop().split(',');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="${color}"/></svg>`;
}

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- charts
const charts = new Map();
export function chart(id, config) {
  const el = document.getElementById(id);
  if (!el || !window.Chart) return null;
  if (charts.has(id)) charts.get(id).destroy();
  const c = new window.Chart(el, config);
  charts.set(id, c);
  return c;
}
export function destroyCharts() {
  for (const c of charts.values()) c.destroy();
  charts.clear();
}
export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const PALETTE = () => ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map(css);

export function chartDefaults() {
  const C = window.Chart;
  if (!C || C._csSet) return;
  C._csSet = true;
  C.defaults.font.family = "'General Sans', system-ui, sans-serif";
  C.defaults.font.size = 12;
  C.defaults.color = css('--text-muted');
  C.defaults.borderColor = css('--divider');
  C.defaults.plugins.legend.display = false;
  C.defaults.plugins.tooltip.backgroundColor = css('--text');
  C.defaults.plugins.tooltip.padding = 10;
  C.defaults.plugins.tooltip.cornerRadius = 6;
  C.defaults.plugins.tooltip.boxPadding = 4;
  C.defaults.plugins.tooltip.titleFont = { weight: '600' };
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation.duration = 650;
  C.defaults.interaction = { mode: 'index', intersect: false };
}

export function fillDates(rows, key = 'd', from, to) {
  // Return a continuous day list from..to, merging rows by date.
  const map = new Map(rows.map((r) => [String(r[key]).slice(0, 10), r]));
  const out = [];
  const start = new Date((from || rows[0]?.[key]) + 'T00:00:00Z');
  const end = new Date((to || rows[rows.length - 1]?.[key]) + 'T00:00:00Z');
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    const k = d.toISOString().slice(0, 10);
    out.push(map.get(k) || { [key]: k, _empty: true });
  }
  return out;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function download(path, filename) {
  const headers = {};
  if (dashKey) headers['X-Dashboard-Key'] = dashKey;
  const res = await fetch(`${window.API_BASE}${path}`, { headers });
  if (!res.ok) { toast(`Download failed (${res.status})`); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

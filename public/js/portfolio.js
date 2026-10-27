import { state, crumbs } from './app.js';
import { fmt, esc, badge, confBadge, delta, pctChange, sparkline, scoreColor, chart, css, fillDates, addDays, ICON, download } from './lib.js';

let sortKey = 'score', sortDir = 1, filter = 'all';

export async function renderPortfolio(view) {
  crumbs('<b>Portfolio</b>');
  const p = state.portfolio;
  if (!p || !p.accounts.length) {
    view.innerHTML = `<div class="card empty">
      <h2>No data yet</h2>
      <p>Upload an activity log CSV to build your first health scores.</p>
      <a class="btn primary" href="#/upload">${ICON.upload}Upload CSV</a></div>`;
    return;
  }
  const th = p.thresholds;
  const n = p.accounts.length;
  const avg = p.accounts.reduce((s, a) => s + a.score, 0) / n;
  const t = p.totals;
  const c = p.counts;
  const calibrating = p.accounts.filter((a) => a.confidence !== 'calibrated').length;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Portfolio health</h1>
        <div class="sub">${n} account${n > 1 ? 's' : ''} · data through ${fmt.date(p.data_through)}</div>
      </div>
      <div class="head-meta">
        <button class="btn" id="pf-export">${ICON.download}Export daily summary</button>
      </div>
    </div>
    ${calibrating ? `<div class="alert info" style="margin-bottom:var(--space-4)">${ICON.info}<div>${calibrating} of ${n} account${n > 1 ? 's are' : ' is'} still calibrating. Scores use default targets until each account has 4+ weeks of history.</div></div>` : ''}
    <div class="grid kpis">
      <div class="card kpi">
        <div class="label">Accounts by status</div>
        <div class="value num">${c.healthy}<small> healthy</small></div>
        <div class="statusbar" aria-hidden="true">
          ${c.healthy ? `<span style="flex:${c.healthy};background:var(--healthy)"></span>` : ''}
          ${c.watch ? `<span style="flex:${c.watch};background:var(--watch)"></span>` : ''}
          ${c.at_risk ? `<span style="flex:${c.at_risk};background:var(--risk)"></span>` : ''}
        </div>
        <div class="foot"><span><i class="dot watch"></i> ${c.watch} attention</span><span><i class="dot at_risk"></i> ${c.at_risk} at risk</span></div>
      </div>
      <div class="card kpi">
        <div class="label">Average health score</div>
        <div class="value num" style="color:${scoreColor(avg, th)}">${fmt.n(avg)}<small> / 100</small></div>
        <div class="foot">Healthy ≥ ${th.healthy}, at risk &lt; ${th.watch}</div>
      </div>
      <div class="card kpi">
        <div class="label">User actions, 14 days</div>
        <div class="value num">${fmt.n(t.actions_14d)}</div>
        <div class="foot">${pctChange(t.actions_14d, t.actions_prev_14d) == null ? 'No earlier period to compare' : delta(pctChange(t.actions_14d, t.actions_prev_14d)) + ' vs prior 14 days'}</div>
      </div>
      <div class="card kpi">
        <div class="label">Active users, 14 days</div>
        <div class="value num">${fmt.n(t.active_users_14d)}</div>
        <div class="foot">across all accounts</div>
      </div>
      <div class="card kpi">
        <div class="label">System alarms, 14 days</div>
        <div class="value num">${fmt.n(t.alarms_critical_14d + t.alarms_warning_14d)}</div>
        <div class="foot"><span style="color:var(--risk)">${t.alarms_critical_14d} critical</span> · ${t.alarms_warning_14d} warning</div>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head">
          <div><h2>Daily activity</h2><div class="sub">Last 30 days, all accounts</div></div>
          <div class="legend"><span><i style="background:var(--c1)"></i>User actions</span><span><i style="background:var(--c2)"></i>Active users</span></div>
        </div>
        <div class="chart"><canvas id="pf-activity" aria-label="Daily activity chart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Health score trend</h2><div class="sub">Last 30 days per account</div></div></div>
        <div class="chart"><canvas id="pf-health" aria-label="Health score trend chart"></canvas></div>
      </div>
    </div>

    <div class="card section">
      <div class="card-head">
        <div><h2>Accounts</h2><div class="sub">Lowest score first. Select a row for details.</div></div>
        <div class="seg" id="pf-filter">
          ${['all', 'at_risk', 'watch', 'healthy'].map((f) => `<button data-f="${f}" class="${filter === f ? 'on' : ''}">${{ all: 'All', at_risk: 'At risk', watch: 'Attention', healthy: 'Healthy' }[f]}</button>`).join('')}
        </div>
      </div>
      <div class="table-wrap"><table id="pf-table"></table></div>
    </div>`;

  document.getElementById('pf-export').addEventListener('click', () => download('/api/export/daily.csv', 'daily_activity_all.csv'));
  drawTable(p);
  view.querySelectorAll('#pf-filter button').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    view.querySelectorAll('#pf-filter button').forEach((x) => x.classList.toggle('on', x === b));
    drawTable(p);
  }));
  drawCharts(p);
}

function drawTable(p) {
  const th = p.thresholds;
  const cols = [
    ['name', 'Account'], ['status', 'Status'], ['score', 'Score', 'n'], ['trend', '30-day trend'],
    ['actions', 'Actions 14d', 'n'], ['users', 'Active users', 'n'], ['last', 'Last activity'], ['signal', 'Top signal'],
  ];
  const val = {
    name: (a) => a.name.toLowerCase(), status: (a) => ({ at_risk: 0, watch: 1, healthy: 2 }[a.status]), score: (a) => a.score,
    actions: (a) => a.metrics.actions_14d, users: (a) => a.metrics.active_users_14d, last: (a) => -(a.metrics.days_since_activity ?? 999),
  };
  let rows = p.accounts.filter((a) => filter === 'all' || a.status === filter);
  if (val[sortKey]) rows = [...rows].sort((a, b) => (val[sortKey](a) > val[sortKey](b) ? 1 : -1) * sortDir);
  const tbl = document.getElementById('pf-table');
  tbl.innerHTML = `<thead><tr>${cols.map(([k, l, cls]) => `<th class="${cls || ''} ${val[k] ? 'sortable' : ''}" data-k="${k}">${l}${sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((a) => {
    const m = a.metrics;
    const sig = a.reasons.find((r) => r.level === 'risk') || a.reasons.find((r) => r.level === 'watch') || a.reasons[0];
    return `<tr class="click" data-id="${a.account_id}" tabindex="0">
      <td><div class="acct-name">${esc(a.name)}</div><div class="small faint">#${a.account_id}</div></td>
      <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">${badge(a.status)}${a.confidence !== 'calibrated' ? confBadge(a.confidence) : ''}</div></td>
      <td class="n"><div class="score-cell" style="justify-content:flex-end"><b class="num">${fmt.n(a.score)}</b>
        <span class="meter"><i style="width:${a.score}%;background:${scoreColor(a.score, th)}"></i></span></div>
        <div class="small">${a.score_change_7d === null ? '' : delta(a.score_change_7d, { suffix: '' }) + ' <span class="faint">7d</span>'}</div></td>
      <td>${sparkline(a.sparkline.map((s) => s.score), { color: scoreColor(a.score, th), min: 0, max: 100 })}</td>
      <td class="n"><b class="num">${fmt.n(m.actions_14d)}</b><div class="small">${delta(m.actions_delta_14d)}</div></td>
      <td class="n num">${m.active_users_14d}<span class="faint"> / ${m.user_pool}</span></td>
      <td><div>${fmt.ago(m.days_since_activity)}</div><div class="small faint">${fmt.short(m.last_activity_date)}</div></td>
      <td><span class="reason-chip" title="${esc(sig?.text || '')}">${esc(sig?.text || '–')}</span></td></tr>`;
  }).join('') || `<tr><td colspan="8" class="muted" style="text-align:center;padding:var(--space-8)">No accounts in this group</td></tr>`}</tbody>`;
  tbl.querySelectorAll('th.sortable').forEach((h) => h.addEventListener('click', () => {
    if (sortKey === h.dataset.k) sortDir *= -1; else { sortKey = h.dataset.k; sortDir = 1; }
    drawTable(p);
  }));
  tbl.querySelectorAll('tr.click').forEach((r) => {
    const go = () => { location.hash = `#/account/${r.dataset.id}`; };
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

function drawCharts(p) {
  const through = p.data_through;
  const from = addDays(through, -29);
  const byDay = new Map();
  for (const a of p.accounts) for (const r of a.activity) {
    const k = String(r.d).slice(0, 10);
    const cur = byDay.get(k) || { d: k, actions: 0, users: 0 };
    cur.actions += r.actions || 0; cur.users += r.users || 0;
    byDay.set(k, cur);
  }
  const days = fillDates([...byDay.values()].sort((a, b) => a.d.localeCompare(b.d)), 'd', from, through);
  chart('pf-activity', {
    data: {
      labels: days.map((d) => d.d),
      datasets: [
        { type: 'bar', label: 'User actions', data: days.map((d) => d.actions || 0), backgroundColor: css('--c1'), borderRadius: 3, yAxisID: 'y', maxBarThickness: 18 },
        { type: 'line', label: 'Active users', data: days.map((d) => d.users || 0), borderColor: css('--c2'), backgroundColor: css('--c2'), yAxisID: 'y1', tension: 0.3, pointRadius: 0, borderWidth: 2 },
      ],
    },
    options: {
      scales: {
        x: { type: 'category', grid: { display: false }, ticks: { maxTicksLimit: 8, callback(v) { return fmt.short(this.getLabelForValue(v)); } } },
        y: { beginAtZero: true, grid: { color: css('--divider') }, title: { display: true, text: 'Actions' } },
        y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { precision: 0 }, title: { display: true, text: 'Users' } },
      },
      plugins: { tooltip: { callbacks: { title: (i) => fmt.date(i[0].label) } } },
    },
  });
  const pal = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map(css);
  const labels = fillDates([], 'd', from, through).map((d) => d.d);
  chart('pf-health', {
    type: 'line',
    data: {
      labels,
      datasets: p.accounts.slice(0, 8).map((a, i) => {
        const m = new Map(a.sparkline.map((s) => [String(s.d).slice(0, 10), s.score]));
        return { label: a.name, data: labels.map((l) => m.get(l) ?? null), borderColor: pal[i % 8], backgroundColor: pal[i % 8], pointRadius: 0, borderWidth: 2, tension: 0.25, spanGaps: true };
      }),
    },
    options: {
      plugins: { legend: { display: p.accounts.length > 1, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: false } },
        tooltip: { callbacks: { title: (i) => fmt.date(i[0].label) } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, callback(v) { return fmt.short(this.getLabelForValue(v)); } } },
        y: { min: 0, max: 100, grid: { color: css('--divider') } },
      },
    },
    plugins: [thresholdBands(p.thresholds)],
  });
}

export function thresholdBands(th) {
  return {
    id: 'bands',
    beforeDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { y } } = c;
      if (!y) return;
      const band = (lo, hi, color) => {
        const top = y.getPixelForValue(hi), bot = y.getPixelForValue(lo);
        ctx.fillStyle = color;
        ctx.fillRect(a.left, top, a.right - a.left, bot - top);
      };
      ctx.save();
      band(th.healthy, 100, 'rgba(47,125,79,0.06)');
      band(th.watch, th.healthy, 'rgba(168,101,11,0.06)');
      band(0, th.watch, 'rgba(179,54,47,0.05)');
      ctx.restore();
    },
  };
}

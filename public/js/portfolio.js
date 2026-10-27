import { state, crumbs } from './app.js';
import { fmt, esc, badge, confBadge, delta, pctChange, sparkline, scoreColor, chart, css, fillDates, addDays, ICON, download } from './lib.js';

let sortKey = 'score', sortDir = 1, filter = 'all';

export async function renderPortfolio(view) {
  crumbs('<b>All customers</b>');
  const p = state.portfolio;
  if (!p || !p.accounts.length) {
    view.innerHTML = `<div class="card empty">
      <h2>No customers yet</h2>
      <p>Add a customer and upload its activity export to build the first health scores.</p>
      <a class="btn primary" href="#/new">${ICON.plus}Add customer</a></div>`;
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
        <h1>All customers</h1>
        <div class="sub">${n} customer${n > 1 ? 's' : ''} · latest data ${fmt.date(p.data_through)} · select a customer in the sidebar to open its dashboard</div>
      </div>
      <div class="head-meta">
        <button class="btn" id="pf-export">${ICON.download}Export daily summary</button>
      </div>
    </div>
    ${calibrating ? `<div class="alert info" style="margin-bottom:var(--space-4)">${ICON.info}<div>${calibrating} of ${n} customer${n > 1 ? 's are' : ' is'} still calibrating. Scores use default targets until each customer has 4+ weeks of history.</div></div>` : ''}
    <div class="grid kpis">
      <div class="card kpi">
        <div class="label">Customers by status</div>
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
        <div class="label">User actions, latest 14 days</div>
        <div class="value num">${fmt.n(t.actions_14d)}</div>
        <div class="foot">${pctChange(t.actions_14d, t.actions_prev_14d) == null ? 'No earlier period to compare' : delta(pctChange(t.actions_14d, t.actions_prev_14d)) + ' vs prior 14 days'}</div>
      </div>
      <div class="card kpi">
        <div class="label">Active users, 14 days</div>
        <div class="value num">${fmt.n(t.active_users_14d)}</div>
        <div class="foot">across all customers</div>
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
          <div><h2>Usage by customer</h2><div class="sub">User actions in each customer's latest 14 days of data</div></div>
          <div class="legend"><span><i style="background:var(--healthy)"></i>Healthy</span><span><i style="background:var(--watch)"></i>Attention</span><span><i style="background:var(--risk)"></i>At risk</span></div>
        </div>
        <div class="chart" id="pf-activity-wrap"><canvas id="pf-activity" aria-label="User actions by customer"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Health score trend</h2><div class="sub">Each customer's latest 30 days of data</div></div></div>
        <div class="chart"><canvas id="pf-health" aria-label="Health score trend chart"></canvas></div>
      </div>
    </div>

    <div class="card section">
      <div class="card-head">
        <div><h2>Customers</h2><div class="sub">Lowest score first. Select a row for details.</div></div>
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
    ["name", "Customer"], ['status', 'Status'], ['score', 'Score', 'n'], ['trend', '30-day trend'],
    ['actions', 'Actions 14d', 'n'], ['users', 'Active users', 'n'], ['last', 'Last activity'], ['data', 'Data through'], ['signal', 'Top signal'],
  ];
  const val = {
    name: (a) => a.name.toLowerCase(), status: (a) => ({ at_risk: 0, watch: 1, healthy: 2 }[a.status]), score: (a) => a.score,
    actions: (a) => a.metrics.actions_14d, users: (a) => a.metrics.active_users_14d, last: (a) => -(a.metrics.days_since_activity ?? 999), data: (a) => String(a.data_through || ''),
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
      <td class="n"><b class="num">${fmt.n(m.actions_14d)}</b><div class="small">${m.actions_delta_14d == null ? '' : delta(m.actions_delta_14d)}</div></td>
      <td class="n num">${m.active_users_14d}<span class="faint"> / ${m.user_pool}</span></td>
      <td class="nw"><div>${fmt.short(m.last_activity_date)}</div><div class="small faint">${m.days_since_activity ? `${m.days_since_activity}d before data end` : 'last day of data'}</div></td>
      <td class="nw"><div>${fmt.short(a.data_through)}</div><div class="small ${a.stale_days > 14 ? '' : 'faint'}" style="${a.stale_days > 14 ? 'color:var(--watch)' : ''}">${a.stale_days > 14 ? `${a.stale_days} days old` : `uploaded ${a.last_upload ? fmt.short(a.last_upload) : '–'}`}</div></td>
      <td><span class="reason-chip" title="${esc(sig?.text || '')}">${esc(sig?.text || '–')}</span></td></tr>`;
  }).join('') || `<tr><td colspan="9" class="muted" style="text-align:center;padding:var(--space-8)">No customers in this group</td></tr>`}</tbody>`;
  tbl.querySelectorAll('th.sortable').forEach((h) => h.addEventListener('click', () => {
    if (sortKey === h.dataset.k) sortDir *= -1; else { sortKey = h.dataset.k; sortDir = 1; }
    drawTable(p);
  }));
  tbl.querySelectorAll('tr.click').forEach((r) => {
    const go = () => { location.hash = `#/c/${r.dataset.id}`; };
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

function drawCharts(p) {
  const statusColor = { healthy: css('--healthy'), watch: css('--watch'), at_risk: css('--risk') };
  // usage per customer, each measured at the end of its own data
  const byUse = [...p.accounts].sort((a, b) => (b.metrics.actions_14d || 0) - (a.metrics.actions_14d || 0)).slice(0, 15);
  const wrap = document.getElementById('pf-activity-wrap');
  if (byUse.length > 6) wrap.style.height = `${Math.max(290, byUse.length * 30 + 40)}px`;
  chart('pf-activity', {
    type: 'bar',
    data: {
      labels: byUse.map((a) => a.name),
      datasets: [{ label: 'User actions, 14 days', data: byUse.map((a) => a.metrics.actions_14d || 0),
        backgroundColor: byUse.map((a) => statusColor[a.status]), borderRadius: 4, maxBarThickness: 26 }],
    },
    options: {
      indexAxis: 'y',
      onClick: (_, els) => { if (els[0]) location.hash = `#/c/${byUse[els[0].index].account_id}`; },
      scales: {
        x: { beginAtZero: true, grid: { color: css('--divider') }, title: { display: true, text: 'User actions' } },
        y: { grid: { display: false }, ticks: { callback(v) { const l = this.getLabelForValue(v); return l.length > 22 ? l.slice(0, 21) + '…' : l; } } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        afterLabel: (i) => { const a = byUse[i.dataIndex]; return `${a.metrics.active_users_14d} active users · data through ${fmt.short(a.data_through)}`; } } } },
    },
  });

  // health trend on a shared calendar, each line covering its customer's latest 30 days
  const pal = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map(css);
  const shown = p.accounts.slice(0, 8);
  const all = shown.flatMap((a) => a.sparkline.map((s) => String(s.d).slice(0, 10))).sort();
  if (!all.length) return;
  let from = all[0];
  const through = all[all.length - 1];
  if (from < addDays(through, -119)) from = addDays(through, -119);
  const labels = fillDates([], 'd', from, through).map((d) => d.d);
  chart('pf-health', {
    type: 'line',
    data: {
      labels,
      datasets: shown.map((a, i) => {
        const m = new Map(a.sparkline.map((s) => [String(s.d).slice(0, 10), s.score]));
        return { label: a.name, data: labels.map((l) => m.get(l) ?? null), borderColor: pal[i % 8], backgroundColor: pal[i % 8],
          pointRadius: a.sparkline.length < 3 ? 3 : 0, borderWidth: 2, tension: 0.25, spanGaps: false };
      }),
    },
    options: {
      plugins: { legend: { display: shown.length > 1, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: false } },
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

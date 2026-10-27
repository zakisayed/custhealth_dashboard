import { crumbs, refreshShell, state } from './app.js';
import {
  currentUser, api, fmt, esc, badge, confBadge, delta, pctChange, sparkline, scoreColor, chart, css, fillDates, addDays,
  ICON, COMP_LABEL, objLabel, toast, download,
} from './lib.js';
import { thresholdBands } from './portfolio.js';

let range = 30, mode = 'action', detailUser = 'all', currentThrough = null;
const ACTIONS = ['created', 'updated', 'deleted', 'executed'];
const OBJECTS = ['columns', 'etl_programs', 'bi_tables', 'dq_rules', 'data_domains', 'use_cases', 'db_tables', 'jobs', 'other'];

export async function renderAccount(view, id) {
  view.innerHTML = skeleton();
  const [d, daily] = await Promise.all([api(`/api/accounts/${id}`), api(`/api/accounts/${id}/daily`)]);
  const a = d.account, L = d.latest, th = d.thresholds;
  crumbs(`<a href="#/">Customers</a><span class="faint">/</span><b>${esc(a.name)}</b>`);
  if (!L) {
    view.innerHTML = `<div class="card empty"><h2>No scored activity yet</h2><p>Upload an activity export for ${esc(a.name)}.</p>
      <a class="btn primary" href="#/c/${a.account_id}/upload">${ICON.upload}Upload CSV</a></div>`;
    return;
  }
  const F = d.freshness || {};
  currentThrough = L.as_of_date;
  const m = L.metrics, comp = L.components;
  const hist = d.history.map((h) => ({ ...h, score: +h.score }));
  const prev7 = hist.length > 7 ? hist[hist.length - 8].score : null;
  const scoreChg = prev7 === null ? null : +L.score - prev7;
  const types = m.object_types_30d || [];

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap">
          <h1>${esc(a.name)}</h1>${badge(L.status, 'lg')}${confBadge(L.confidence)}
        </div>
        <div class="sub">Account #${a.account_id} · ${esc(a.timezone)} days · data ${fmt.date(F.data_from)} to ${fmt.date(L.as_of_date)} · ${m.history_days} days of history · last upload ${F.last_upload ? fmt.time(F.last_upload) : 'never'}</div>
      </div>
      <div class="head-meta">
        <button class="btn" id="dl-csv">${ICON.download}Daily summary CSV</button>
        ${currentUser?.role === 'admin' ? `<button class="btn" id="settings">${ICON.gear}Settings</button>` : ''}
      </div>
    </div>
    ${F.stale_days > 14 ? `<div class="alert info" style="margin-bottom:var(--space-4)">${ICON.info}<div>The latest data for ${esc(a.name)} is from ${fmt.date(F.data_through)}, ${F.stale_days} days ago. Scores reflect usage up to that date. <a href="#/c/${a.account_id}/upload">Upload a newer export</a> to refresh them.</div></div>` : ''}

    <div class="grid kpis">
      <div class="card kpi"><div class="label">Health score</div>
        <div class="value num" style="color:${scoreColor(+L.score, th)}">${fmt.n(L.score)}<small> / 100</small></div>
        <div class="foot">${scoreChg === null ? '<span class="faint">No 7-day history yet</span>' : delta(scoreChg, { suffix: ' pts' }) + ' vs 7 days ago'}</div></div>
      <div class="card kpi"><div class="label">User actions, 14 days</div>
        <div class="value num">${fmt.n(m.actions_14d)}</div>
        <div class="foot">${m.actions_delta_14d == null ? 'No earlier period to compare' : delta(m.actions_delta_14d) + ' vs prior 14 days'}</div></div>
      <div class="card kpi"><div class="label">Active users, 14 days</div>
        <div class="value num">${m.active_users_14d}<small> of ${m.user_pool}</small></div>
        <div class="foot">${m.active_users_7d} this week, ${m.active_users_prev_7d} last week</div></div>
      <div class="card kpi"><div class="label">Last user activity</div>
        <div class="value num" style="font-size:var(--text-lg);margin-top:var(--space-3)">${fmt.date(m.last_activity_date)}</div>
        <div class="foot">${m.days_since_activity ? `${m.days_since_activity} day${m.days_since_activity > 1 ? 's' : ''} before the data ends` : 'On the last day of data'} · usual gap ${fmt.n(m.expected_gap_days)} days · ${m.active_days_14d} active days in 14</div></div>
      <div class="card kpi"><div class="label">Feature adoption, 30 days</div>
        <div class="value num">${types.length}<small> object types</small></div>
        <div class="foot" title="${esc(types.map(objLabel).join(', '))}">${esc(types.map(objLabel).join(', ') || 'None')}</div></div>
      <div class="card kpi"><div class="label">System alarms, 14 days</div>
        <div class="value num">${m.alarms_critical_14d + m.alarms_warning_14d}</div>
        <div class="foot"><span style="color:var(--risk)">${m.alarms_critical_14d} critical</span> · ${m.alarms_warning_14d} warning · ${m.alarms_open_14d ?? 0} open</div></div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><div><h2>Health score history</h2><div class="sub">Recomputed daily from all uploaded history</div></div>
          ${rangeSeg('hist')}</div>
        <div class="chart"><canvas id="ac-health"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Why this score</h2><div class="sub">Weighted components, 0 to 100</div></div></div>
        <div id="comps"></div>
        <ul class="reasons">${L.reasons.map((r) => `<li class="${r.level}">${ICON[r.level] || ICON.info}<span>${esc(r.text)}</span></li>`).join('')}</ul>
      </div>
    </div>

    <div class="card section">
      <div class="card-head">
        <div><h2>Daily activity</h2><div class="sub">User events per day. System events and alarms are excluded.</div></div>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
          <div class="seg" id="mode-seg">${[['action', 'By action'], ['object', 'By object'], ['manual', 'Manual vs automated']].map(([k, l]) => `<button data-m="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          ${rangeSeg('act')}
        </div>
      </div>
      <div class="legend" id="act-legend" style="margin-bottom:var(--space-3)"></div>
      <div class="chart tall"><canvas id="ac-activity"></canvas></div>
    </div>

    <div class="grid cols-2e section">
      <div class="card">
        <div class="card-head"><div><h2>Usage by object type</h2><div class="sub">All-time user events, split by action</div></div></div>
        <div id="objects"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>When users work</h2><div class="sub">User actions by weekday and hour (${esc(a.timezone)})</div></div></div>
        <div id="heat"></div>
      </div>
    </div>

    <div class="card section">
      <div class="card-head"><div><h2>Users</h2><div class="sub">System activity shown separately</div></div></div>
      <div class="table-wrap"><table id="users"></table></div>
    </div>

    <div class="grid cols-2e section">
      <div class="card">
        <div class="card-head"><div><h2>System alarms</h2><div class="sub">From saws_alarms, not counted as usage</div></div></div>
        <div class="table-wrap scroll-y"><table id="alarms">${alarmRows(d.alarms, a.timezone)}</table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>DQ rule runs</h2><div class="sub">Executed rules and exception counts</div></div></div>
        <div class="table-wrap scroll-y"><table id="dqruns">${dqRows(d.dq_runs, a.timezone)}</table></div>
      </div>
    </div>

    <div class="card section">
      <div class="card-head">
        <div><h2>Daily summary by user</h2><div class="sub">The usage-engine feed: one row per day per user</div></div>
        <select id="du-user" class="btn" aria-label="Filter user">
          <option value="all">All users</option>
          ${d.users.map((u) => `<option value="${esc(u.user_id)}">${esc(u.user_name || u.user_id)}</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap scroll-y" style="max-height:520px"><table id="daily"></table></div>
    </div>

    <div class="card section">
      <div class="card-head"><div><h2>Data quality of this feed</h2></div></div>
      <dl class="kv">
        <dt>Events stored</dt><dd>${fmt.n(d.quality.total)}</dd>
        <dt>Mirrored duplicates ignored</dt><dd>${fmt.n(d.quality.duplicates)} <span class="faint small">(same DQ action in nodes and node_dynamo_log)</span></dd>
        <dt>Automated events</dt><dd>${fmt.n(d.quality.automated)} <span class="faint small">(machine-speed bursts such as scans and imports)</span></dd>
        <dt>Coverage</dt><dd>${fmt.time(d.quality.min_ts, a.timezone)} to ${fmt.time(d.quality.max_ts, a.timezone)}</dd>
        <dt>Logins and sessions</dt><dd>Not in the log. Sessions are estimated from 30-minute activity gaps.</dd>
      </dl>
    </div>`;

  // components
  const W = state.portfolio?.weights || null;
  document.getElementById('comps').innerHTML = Object.entries(COMP_LABEL).map(([k, lbl]) => {
    const v = +comp[k];
    return `<div class="comp"><span>${lbl}</span><span class="bar"><i style="width:0;background:${scoreColor(v, th)}" data-w="${v}"></i></span><b>${fmt.n(v)}</b></div>`;
  }).join('');
  requestAnimationFrame(() => document.querySelectorAll('#comps i').forEach((i) => { i.style.width = i.dataset.w + '%'; }));

  const through = L.as_of_date;
  const drawHist = () => {
    const first = hist[0]?.d || through;
    const from = range ? [addDays(through, -(range - 1)), first].sort()[1] : first;
    const rows = hist.filter((h) => String(h.d) >= from);
    chart('ac-health', {
      type: 'line',
      data: { labels: rows.map((r) => r.d), datasets: [{
        label: 'Health score', data: rows.map((r) => r.score), borderColor: css('--primary'), borderWidth: 2.2, tension: 0.25,
        pointRadius: rows.length < 20 ? 3 : 0, pointBackgroundColor: rows.map((r) => scoreColor(r.score, th)), pointBorderWidth: 0,
        fill: false,
      }] },
      options: {
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 7, callback(v) { return fmt.short(this.getLabelForValue(v)); } } },
          y: { min: 0, max: 100, grid: { color: css('--divider') } } },
        plugins: { tooltip: { callbacks: { title: (i) => fmt.date(i[0].label), afterLabel: (i) => rows[i.dataIndex].status.replace('_', ' ') } } },
      },
      plugins: [thresholdBands(th)],
    });
  };

  const drawActivity = () => {
    const first = String(d.daily[0]?.d || through).slice(0, 10);
    const from = range ? [addDays(through, -(range - 1)), first].sort()[1] : first;
    const days = fillDates(d.daily.filter((r) => String(r.d) >= from), 'd', from, through);
    const pal = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--text-faint'].map(css);
    let series;
    if (mode === 'action') series = ACTIONS.map((k, i) => ({ label: k[0].toUpperCase() + k.slice(1), key: k, color: pal[i] }));
    else if (mode === 'object') series = OBJECTS.map((k, i) => ({ label: objLabel(k), key: k, color: pal[i] }));
    else series = [{ label: 'Manual', key: 'manual', color: pal[0] }, { label: 'Automated', key: 'automated', color: css('--text-faint') }];
    series = series.filter((s) => days.some((x) => +x[s.key] > 0));
    document.getElementById('act-legend').innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')
      + `<span><i style="background:transparent;border:2px solid ${css('--c2')};border-radius:50%"></i>Active users</span>`;
    chart('ac-activity', {
      data: {
        labels: days.map((x) => x.d),
        datasets: [
          ...series.map((s) => ({ type: 'bar', label: s.label, data: days.map((x) => +x[s.key] || 0), backgroundColor: s.color, stack: 'a', maxBarThickness: 22, borderRadius: 2 })),
          { type: 'line', label: 'Active users', data: days.map((x) => (+x.active_users ? +x.active_users : null)), borderColor: css('--c2'), backgroundColor: css('--surface'), yAxisID: 'y1', pointRadius: 3, pointBorderWidth: 2, borderWidth: 0, showLine: false },
        ],
      },
      options: {
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 10, callback(v) { return fmt.short(this.getLabelForValue(v)); } } },
          y: { stacked: true, beginAtZero: true, grid: { color: css('--divider') }, title: { display: true, text: 'Events' } },
          y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { precision: 0 }, suggestedMax: 3, title: { display: true, text: 'Users' } },
        },
        plugins: { tooltip: { filter: (i) => i.raw !== 0, callbacks: { title: (i) => fmt.date(i[0].label) } } },
      },
    });
  };

  // object usage: proportional bars (sqrt scale so small features stay visible), split by action
  const objTotals = {};
  for (const r of d.matrix) {
    if (r.object_type === 'alarms') continue;
    const o = OBJECTS.includes(r.object_type) ? r.object_type : 'other';
    objTotals[o] = objTotals[o] || { total: 0 };
    objTotals[o][r.action] = (objTotals[o][r.action] || 0) + +r.events;
    objTotals[o].total += +r.events;
  }
  const objKeys = Object.keys(objTotals).sort((x, y) => objTotals[y].total - objTotals[x].total);
  const maxObj = Math.max(1, ...objKeys.map((o) => objTotals[o].total));
  const apal = ['--c1', '--c2', '--c3', '--c4'].map(css);
  document.getElementById('objects').innerHTML = objKeys.length ? `<div class="objlist">${objKeys.map((o) => {
    const t = objTotals[o];
    const width = Math.max(2, Math.sqrt(t.total / maxObj) * 100);
    return `<div class="objrow"><span class="nw">${objLabel(o)}</span>
      <span class="track" style="width:${width}%">${ACTIONS.map((ac, i) => t[ac] ? `<i style="flex:${t[ac]};background:${apal[i]}" title="${ac}: ${t[ac]}"></i>` : '').join('')}</span>
      <b>${fmt.n(t.total)}</b>
      <span class="split">${ACTIONS.filter((ac) => t[ac]).map((ac) => `${fmt.n(t[ac])} ${ac}`).join(' · ')}</span></div>`;
  }).join('')}</div>
  <div class="legend" style="margin-top:var(--space-4)">${ACTIONS.map((ac, i) => `<span><i style="background:${apal[i]}"></i>${ac[0].toUpperCase() + ac.slice(1)}</span>`).join('')}<span class="faint">Bar length uses a square-root scale</span></div>`
    : '<div class="empty">No user activity</div>';

  drawHeat(d.hours);
  drawUsers(d.users, a.timezone, th);
  const drawDaily = () => dailyTable(daily, a.timezone);
  drawDaily();
  drawHist();
  drawActivity();

  view.querySelectorAll('.seg[data-range]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    range = +b.dataset.r;
    view.querySelectorAll('.seg[data-range] button').forEach((x) => x.classList.toggle('on', +x.dataset.r === range));
    drawHist(); drawActivity();
  })));
  view.querySelectorAll('#mode-seg button').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.m;
    view.querySelectorAll('#mode-seg button').forEach((x) => x.classList.toggle('on', x === b));
    drawActivity();
  }));
  document.getElementById('du-user').value = detailUser;
  document.getElementById('du-user').addEventListener('change', (e) => { detailUser = e.target.value; drawDaily(); });
  document.getElementById('dl-csv').addEventListener('click', () => download(`/api/export/daily.csv?account_id=${id}`, `daily_activity_${id}.csv`));
  document.getElementById('settings')?.addEventListener('click', () => openSettings(a));
}

function rangeSeg(kind) {
  return `<div class="seg" data-range="${kind}">${[[30, '30d'], [90, '90d'], [0, 'All']].map(([r, l]) => `<button data-r="${r}" class="${range === r ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function drawHeat(hours) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const h of hours) { const v = +h.actions; grid[h.dow - 1][h.hr] = v; max = Math.max(max, v); }
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const base = css('--primary');
  let html = '<div class="heat" role="img" aria-label="Activity heatmap"><span></span>';
  for (let h = 0; h < 24; h++) html += `<span class="hr ${h % 6 === 0 ? 'show' : ''}">${h % 3 === 0 ? h : ''}</span>`;
  days.forEach((dn, i) => {
    html += `<span class="lbl">${dn}</span>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[i][h];
      const a = v ? 0.15 + 0.85 * Math.sqrt(v / max) : 0;
      html += `<span class="c" title="${dn} ${h}:00, ${v} actions" style="${v ? `background:color-mix(in srgb, ${base} ${Math.round(a * 100)}%, transparent)` : ''}"></span>`;
    }
  });
  html += '</div>';
  document.getElementById('heat').innerHTML = max ? html + `<p class="small muted" style="margin:var(--space-3) 0 0">Darker means more actions. Peak hour has ${max}.</p>` : '<div class="empty">No user activity</div>';
}

function drawUsers(users, tz, th) {
  const through = currentThrough;
  const rows = users.map((u) => {
    const daysSince = through ? Math.round((new Date(through) - new Date(String(u.last_day))) / 86400000) : null;
    const st = u.actor_type === 'system' ? 'system' : daysSince <= 14 ? 'active' : 'inactive';
    const vals = u.daily.map((x) => x.actions);
    return `<tr>
      <td><div class="acct-name">${esc(u.user_name || u.user_id)}</div><div class="small faint">ID ${esc(u.user_id)}</div></td>
      <td>${st === 'system' ? '<span class="badge info">System</span>' : st === 'active' ? '<span class="badge healthy">Active</span>' : '<span class="badge watch">Inactive 14d+</span>'}</td>
      <td class="nw">${fmt.time(u.last_activity, tz)}</td>
      <td class="n num">${u.active_days}</td>
      <td class="n num">${fmt.n(u.actions)}</td>
      <td class="n num">${fmt.n(u.events)}${+u.automated ? `<div class="small faint">${fmt.n(u.automated)} automated</div>` : ''}</td>
      <td class="n num">${u.sessions === null ? '–' : fmt.n(u.sessions)}</td>
      <td class="n num">${fmt.n(u.created)}</td><td class="n num">${fmt.n(u.updated)}</td><td class="n num">${fmt.n(u.deleted)}</td><td class="n num">${fmt.n(u.executed)}</td>
      <td>${u.actor_type === 'system' ? '' : sparkline(vals, { w: 80 })}</td></tr>`;
  }).join('');
  document.getElementById('users').innerHTML = `<thead><tr><th>User</th><th>Status</th><th>Last activity</th><th class="n">Active days</th><th class="n">Actions</th><th class="n">Events</th><th class="n">Est. sessions</th><th class="n">Created</th><th class="n">Updated</th><th class="n">Deleted</th><th class="n">Executed</th><th>Actions/day</th></tr></thead><tbody>${rows}</tbody>`;
}

function alarmRows(rows, tz) {
  if (!rows.length) return '<tbody><tr><td class="muted">No alarms</td></tr></tbody>';
  const sev = (s) => s === 'critical' ? '<span class="badge at_risk">Critical</span>' : s === 'warning' ? '<span class="badge watch">Warning</span>' : `<span class="badge info">${esc(s || 'Info')}</span>`;
  return `<thead><tr><th>Time</th><th>Alarm</th><th>Severity</th><th>Status</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmt.time(r.ts, tz)}</td><td>${esc(r.entity_name)}<div class="small faint">${esc(r.alarm_type || '')}</div></td><td>${sev(r.alarm_severity)}</td><td>${r.alarm_status === 'RSL' ? 'Resolved' : esc(r.alarm_status || '–')}</td></tr>`).join('')}</tbody>`;
}

function dqRows(rows, tz) {
  if (!rows.length) return '<tbody><tr><td class="muted">No DQ rule runs</td></tr></tbody>';
  return `<thead><tr><th>Time</th><th>Rule</th><th>By</th><th class="n">Exceptions</th><th class="n">Rate</th></tr></thead><tbody>${rows.map((r) => {
    const rate = r.dq_total ? (r.dq_exceptions / r.dq_total) * 100 : null;
    return `<tr><td>${fmt.time(r.ts, tz)}</td><td>${esc(r.entity_name)}${r.dq_alert ? ' <span class="badge watch">Alert</span>' : ''}</td><td>${esc(r.user_name || '')}</td><td class="n num">${fmt.n(r.dq_exceptions)} <span class="faint">/ ${fmt.n(r.dq_total)}</span></td><td class="n num">${rate === null ? '–' : fmt.n(rate, rate < 1 ? 2 : 0) + '%'}</td></tr>`;
  }).join('')}</tbody>`;
}

function dailyTable(rows, tz) {
  const list = rows.filter((r) => detailUser === 'all' || r.user_id === detailUser).sort((x, y) => String(y.activity_date).localeCompare(String(x.activity_date)));
  const objCols = [['obj_columns', 'Cols'], ['obj_etl_programs', 'ETL'], ['obj_bi_tables', 'BI'], ['obj_dq_rules', 'DQ'], ['obj_data_domains', 'Domains'], ['obj_use_cases', 'Use cases']];
  document.getElementById('daily').innerHTML = `<thead><tr><th>Date</th><th>User</th><th class="n">Events</th><th class="n">Actions</th>
    <th class="n">Created</th><th class="n">Updated</th><th class="n">Deleted</th><th class="n">Executed</th>
    ${objCols.map(([, l]) => `<th class="n">${l}</th>`).join('')}<th class="n">Alarms</th><th>First</th><th>Last</th><th class="n">Sessions</th><th>Flags</th></tr></thead>
    <tbody>${list.map((r) => `<tr>
      <td>${fmt.short(r.activity_date)}</td>
      <td>${r.actor_type === 'system' ? '<span class="badge info">System</span>' : esc(r.user_name || r.user_id)}</td>
      <td class="n">${fmt.n(r.total_events)}</td><td class="n">${fmt.n(r.actions)}</td>
      <td class="n">${fmt.n(r.created)}</td><td class="n">${fmt.n(r.updated)}</td><td class="n">${fmt.n(r.deleted)}</td><td class="n">${fmt.n(r.executed)}</td>
      ${objCols.map(([k]) => `<td class="n">${+r[k] ? fmt.n(r[k]) : '<span class="faint">0</span>'}</td>`).join('')}
      <td class="n">${+r.alarms_total ? `${r.alarms_total}${+r.alarms_critical ? ' <span class="small" style="color:var(--risk)">crit</span>' : ''}` : '<span class="faint">0</span>'}</td>
      <td>${fmt.clock(r.first_activity, tz)}</td><td>${fmt.clock(r.last_activity, tz)}</td>
      <td class="n">${r.est_sessions ?? '–'}</td>
      <td>${+r.automated_events ? `<span class="tag" title="${r.automated_events} automated events">${fmt.compact(r.automated_events)} automated</span>` : ''}</td>
    </tr>`).join('')}</tbody>`;
}

function openSettings(a) {
  const dr = document.getElementById('drawer'), bg = document.getElementById('drawer-bg');
  const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Asia/Karachi']);
  if (!zones.includes('UTC')) zones.unshift('UTC');
  dr.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>Customer settings</h2><button class="btn" id="dr-close" aria-label="Close">${ICON.x}</button></div>
    <div class="field"><label for="s-name">Display name</label><input id="s-name" value="${esc(a.name)}" /></div>
    <div class="field"><label for="s-tz">Time zone</label><select id="s-tz">${zones.map((z) => `<option ${z === a.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select>
      <span class="hint">Sets day boundaries and work-hour heatmap. Changing it rebuilds this account's history.</span></div>
    <div class="field"><label for="s-seats">Licensed seats</label><input id="s-seats" type="number" min="0" value="${a.licensed_seats ?? ''}" placeholder="Not set" />
      <span class="hint">Optional. User breadth uses seats when set, otherwise users seen in 90 days.</span></div>
    <div class="danger-zone">
      <h3 style="font-size:var(--text-sm);margin:0 0 var(--space-2)">Remove customer</h3>
      <p class="hint" style="margin:0 0 var(--space-3)">Deletes ${esc(a.name)} and all of its stored events, rollups and scores. Other customers are rescored. This cannot be undone.</p>
      <div id="rm-box"><button class="btn danger" id="dr-remove">${ICON.trash}Remove ${esc(a.name)}</button></div>
    </div>
    <div class="actions"><button class="btn" id="dr-cancel">Cancel</button><button class="btn primary" id="dr-save">Save</button></div>`;
  const close = () => { dr.classList.remove('open'); bg.classList.remove('open'); dr.setAttribute('aria-hidden', 'true'); };
  dr.classList.add('open'); bg.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
  bg.onclick = close;
  document.getElementById('dr-close').onclick = close;
  document.getElementById('dr-cancel').onclick = close;
  document.getElementById('dr-remove').onclick = () => {
    const box = document.getElementById('rm-box');
    box.innerHTML = `<div class="field" style="margin:0"><label for="rm-confirm">Type the customer name to confirm</label>
      <input id="rm-confirm" autocomplete="off" placeholder="${esc(a.name)}" /></div>
      <button class="btn danger solid" id="rm-go" disabled style="margin-top:var(--space-3)">${ICON.trash}Remove permanently</button>`;
    const inp = document.getElementById('rm-confirm'), go = document.getElementById('rm-go');
    inp.focus();
    inp.oninput = () => { go.disabled = inp.value.trim() !== a.name.trim(); };
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Removing…';
      try {
        await api(`/api/accounts/${a.account_id}`, { method: 'DELETE' });
        close(); toast(`${a.name} removed`);
        await refreshShell();
        location.hash = '#/';
      } catch (err) { go.disabled = false; go.textContent = 'Remove permanently'; toast(err.message); }
    };
  };
  document.getElementById('dr-save').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Saving…';
    const body = { name: document.getElementById('s-name').value.trim() || null };
    const tz = document.getElementById('s-tz').value; if (tz !== a.timezone) body.timezone = tz;
    const seats = document.getElementById('s-seats').value;
    if (String(seats) !== String(a.licensed_seats ?? '')) body.licensed_seats = seats === '' ? 0 : +seats;
    try {
      await api(`/api/accounts/${a.account_id}`, { method: 'PATCH', json: body });
      close(); toast('Settings saved, scores rebuilt');
      await refreshShell();
      renderAccount(document.getElementById('view'), a.account_id);
    } catch (err) { btn.disabled = false; btn.textContent = 'Save'; toast(err.message); }
  };
}

function skeleton() {
  const k = '<div class="card kpi"><div class="skeleton" style="height:12px;width:60%"></div><div class="skeleton" style="height:28px;width:45%;margin-top:12px"></div><div class="skeleton" style="height:10px;width:70%;margin-top:12px"></div></div>';
  return `<div class="skeleton" style="height:30px;width:280px;margin-bottom:var(--space-6)"></div>
    <div class="grid kpis">${k.repeat(6)}</div>
    <div class="grid cols-2"><div class="card"><div class="skeleton" style="height:290px"></div></div><div class="card"><div class="skeleton" style="height:290px"></div></div></div>`;
}

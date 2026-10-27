import { crumbs, state } from './app.js';
import { api, fmt, esc, COMP_LABEL, CONF_LABEL } from './lib.js';

const DESC = {
  engagement: 'User actions in the last 14 days compared with the account’s own median 14-day baseline. Falls back to the peer median, then a default target, until history exists.',
  recency: 'Days since any user activity, compared with the account’s usual gap between active days (75th percentile).',
  breadth: 'Share of users active in 14 days. Denominator is licensed seats if set, otherwise users seen in 90 days.',
  adoption: 'Distinct object types used in 30 days: columns, ETL programs, BI tables, DQ rules, data domains, use cases, DB tables.',
  consistency: 'Active days in the last 14, compared with the account’s own typical number of active days.',
  platform: 'Starts at 100. Critical alarms cost 30, warnings 10. Auto-resolved alarms cost half.',
};

export async function renderModel(view) {
  crumbs('<b>Scoring model</b>');
  const m = await api('/api/model');
  const run = m.latest_run?.params;
  const names = new Map((state.portfolio?.accounts || []).map((a) => [String(a.account_id), a.name]));
  view.innerHTML = `
    <div class="page-head"><div><h1>How health is scored</h1>
      <div class="sub">Last calibrated ${m.latest_run ? fmt.time(m.latest_run.computed_at) : 'never'} · data through ${fmt.date(m.latest_run?.data_through)}</div></div></div>
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><h2>Components</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Component</th><th class="n">Weight</th><th>How it is measured</th></tr></thead>
        <tbody>${Object.entries(COMP_LABEL).map(([k, l]) => `<tr><td><b>${l}</b></td><td class="n num">${Math.round(m.weights[k] * 100)}%</td><td class="small muted">${DESC[k]}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Status rules</h2></div>
        <ul class="reasons" style="border:0;padding:0;margin:0">
          <li class="good"><span class="dot healthy" style="margin-top:6px"></span><span><b>Healthy</b>: score ${m.healthy_at} or higher</span></li>
          <li class="watch"><span class="dot watch" style="margin-top:6px"></span><span><b>Needs attention</b>: ${m.watch_at} to ${m.healthy_at - 1}, or actions below half of baseline</span></li>
          <li class="risk"><span class="dot at_risk" style="margin-top:6px"></span><span><b>At risk</b>: below ${m.watch_at}, or no user activity for 30+ days (or 4x the usual gap)</span></li>
        </ul>
        <h3 style="margin-top:var(--space-6)">Activity rules</h3>
        <dl class="kv" style="margin-top:var(--space-3)">
          <dt>Action</dt><dd>One user save (distinct transaction). Bulk saves count once.</dd>
          <dt>Automated</dt><dd>${m.auto_tx_per_minute}+ saves in a minute, or ${m.auto_sustained_per_minute}+/min held for 10 minutes. Excluded from engagement.</dd>
          <dt>Session</dt><dd>New session after ${m.session_gap_minutes} minutes idle (estimate)</dd>
          <dt>System</dt><dd>user_id -1 / SYSTEM, kept separate. Alarms scored under Platform.</dd>
          <dt>Confidence</dt><dd>${CONF_LABEL.calibrating} under ${m.calibrating_days} days, ${CONF_LABEL.building.toLowerCase()} under ${m.calibrated_days}, then calibrated</dd>
        </dl>
      </div>
    </div>
    <div class="card section">
      <div class="card-head"><div><h2>Calibration state</h2><div class="sub">Learned from uploaded history on every upload</div></div></div>
      ${run ? `<dl class="kv" style="margin-bottom:var(--space-4)">
        <dt>Peer benchmark</dt><dd>${run.peers.accounts >= 1 ? `${fmt.n(run.peers.median_actions_14d)} actions and ${fmt.n(run.peers.median_active_days_14d)} active days per 14 days (median of ${run.peers.accounts} accounts)` : 'Needs accounts with 14+ days of history'}</dd>
      </dl>
      <div class="table-wrap"><table><thead><tr><th>Account</th><th>First activity</th><th class="n">Active days</th><th class="n">Usual gap (days)</th><th class="n">Baseline windows</th><th>Engagement reference</th></tr></thead>
      <tbody>${Object.entries(run.per_account).map(([id, p]) => {
        const acct = (state.portfolio?.accounts || []).find((a) => String(a.account_id) === id);
        return `<tr><td><a href="#/account/${id}">${esc(names.get(id) || id)}</a></td><td>${fmt.date(p.first_activity)}</td><td class="n num">${p.active_days}</td><td class="n num">${fmt.n(p.expected_gap_days)}</td><td class="n num">${p.baseline_windows} of ${run.baseline_windows}</td><td class="small">${esc(acct?.metrics.engagement_reference_source || '–')} (${fmt.n(acct?.metrics.engagement_reference)})</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">Upload data to calibrate.</p>'}
      <p class="small muted" style="margin-top:var(--space-4)">All weights and thresholds can be changed with environment variables (see README).</p>
    </div>`;
}

// Scoring model: everyone can read it; the admin can edit it, preview the impact, and save.
// Saving rescores every customer's full history and recalibrates baselines and peers.
import { crumbs, state, refreshShell } from './app.js';
import { api, fmt, esc, badge, COMP_LABEL, CONF_LABEL, ICON, toast, currentUser } from './lib.js';

const DESC = {
  engagement: 'User actions in the last 14 days compared with the customer\u2019s own median 14-day baseline. Falls back to the peer median, then the starting target, until history exists.',
  recency: 'Days since any user activity, compared with the customer\u2019s usual gap between active days (75th percentile).',
  breadth: 'Share of users active in 14 days. Denominator is licensed seats if set, otherwise users seen in 90 days.',
  adoption: 'Distinct object types used in 30 days: columns, ETL programs, BI tables, DQ rules, data domains, use cases, DB tables.',
  consistency: 'Active days in the last 14, compared with the customer\u2019s own typical number of active days.',
  platform: 'Starts at 100. Each critical and warning alarm costs points. Auto-resolved alarms cost half.',
};
const COMPS = Object.keys(COMP_LABEL);
const GROUPS = [
  ['targets', 'Targets', 'Used to turn raw usage into 0 to 100 component scores.'],
  ['calibration', 'Confidence', 'How much history a customer needs before its score is trusted.'],
  ['classification', 'Activity classification', 'Changing these re-reads every stored event, so saving takes longer.'],
];
const STATUS_TXT = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk' };

let draft = null;          // working copy while editing
let saved = null;          // last loaded payload
let previewTimer = null, previewSeq = 0;

export async function renderModel(view, opts = {}) {
  crumbs('<b>Scoring model</b>');
  saved = await api('/api/model');
  const isAdmin = currentUser?.role === 'admin';
  const editing = isAdmin && opts.edit;
  if (editing && !draft) draft = { ...saved.model };
  if (!editing) draft = null;
  const m = saved.model;
  const run = saved.latest_run;
  view.innerHTML = `
    <div class="page-head"><div><h1>Scoring model</h1>
      <div class="sub">${saved.is_default ? 'Default model' : `Custom model, changed by ${esc(saved.updated_by)} on ${fmt.time(saved.updated_at)}`}
        · last calibrated ${run ? fmt.time(run.computed_at) : 'never'}${run?.data_through ? ` · data through ${fmt.date(run.data_through)}` : ''}</div></div>
      ${isAdmin && !editing ? `<button class="btn primary" id="edit-model">${ICON.gear}Edit model</button>` : ''}
    </div>
    ${editing ? editorHtml() : readHtml(m)}
    ${calibrationHtml(run)}
    ${historyHtml()}`;

  if (!editing) {
    view.querySelector('#edit-model')?.addEventListener('click', () => renderModel(view, { edit: true }));
    return;
  }
  wireEditor(view);
}

// ----------------------------------------------------------------------------- read-only view
function readHtml(m) {
  return `<div class="grid cols-2">
    <div class="card">
      <div class="card-head"><h2>Components</h2></div>
      ${weightBar(m)}
      <div class="table-wrap"><table><thead><tr><th>Component</th><th class="n">Weight</th><th>How it is measured</th></tr></thead>
      <tbody>${COMPS.map((k) => `<tr><td><b>${COMP_LABEL[k]}</b></td><td class="n num">${fmt.n(m['w_' + k])}%</td><td class="small muted">${DESC[k]}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Status rules</h2></div>
      ${bandHtml(m)}
      <ul class="reasons" style="border:0;padding:0">
        <li class="good"><span class="dot healthy" style="margin-top:6px"></span><span><b>Healthy</b>: score ${fmt.n(m.healthy_at)} or higher</span></li>
        <li class="watch"><span class="dot watch" style="margin-top:6px"></span><span><b>Needs attention</b>: ${fmt.n(m.watch_at)} up to ${fmt.n(m.healthy_at)}, or actions below half of the customer's baseline</span></li>
        <li class="risk"><span class="dot at_risk" style="margin-top:6px"></span><span><b>At risk</b>: below ${fmt.n(m.watch_at)}, or no user activity for 30+ days (or 4x the usual gap)</span></li>
      </ul>
      <h3 style="margin-top:var(--space-6)">Targets and rules</h3>
      <dl class="kv" style="margin-top:var(--space-3)">
        <dt>Starting targets</dt><dd>${fmt.n(m.fallback_actions_14d)} actions and ${fmt.n(m.fallback_active_days_14d)} active days per 14 days, until a baseline exists</dd>
        <dt>Breadth</dt><dd>Full marks at ${fmt.n(m.target_active_user_share)}% of users active</dd>
        <dt>Adoption</dt><dd>Full marks at ${fmt.n(m.target_object_types)} object types in 30 days</dd>
        <dt>Alarms</dt><dd>${fmt.n(m.alarm_critical_penalty)} points per critical, ${fmt.n(m.alarm_warning_penalty)} per warning</dd>
        <dt>Automated</dt><dd>${fmt.n(m.auto_tx_per_minute)}+ saves in a minute, or ${fmt.n(m.auto_sustained_per_minute)}+/min for 10 minutes. Excluded from engagement.</dd>
        <dt>Session</dt><dd>New session after ${fmt.n(m.session_gap_minutes)} minutes idle (estimate)</dd>
        <dt>Confidence</dt><dd>${CONF_LABEL.calibrating} under ${m.calibrating_days} days, ${CONF_LABEL.building.toLowerCase()} under ${m.calibrated_days}, then calibrated</dd>
      </dl>
    </div>
  </div>`;
}

function weightBar(m) {
  const total = COMPS.reduce((a, k) => a + (+m['w_' + k] || 0), 0) || 1;
  return `<div class="wbar" aria-hidden="true">${COMPS.map((k, i) => {
    const v = (+m['w_' + k] || 0) / total * 100;
    return v > 0 ? `<span style="width:${v}%;background:var(--c${i + 1})" title="${COMP_LABEL[k]} ${Math.round(v)}%">${v >= 17 ? `${COMP_LABEL[k]} ${Math.round(v)}%` : v >= 6 ? `${Math.round(v)}%` : ''}</span>` : '';
  }).join('')}</div>`;
}

function bandHtml(m) {
  const w = Math.max(0, Math.min(100, +m.watch_at)), h = Math.max(0, Math.min(100, +m.healthy_at));
  return `<div class="band" aria-hidden="true">
    <span class="at_risk" style="width:${w}%">${w >= 10 ? 'At risk' : ''}</span>
    <span class="watch" style="width:${Math.max(0, h - w)}%">${h - w >= 18 ? 'Needs attention' : h - w >= 8 ? 'Attention' : ''}</span>
    <span class="healthy" style="width:${100 - h}%">${100 - h >= 10 ? 'Healthy' : ''}</span>
  </div><div class="band-scale"><span>0</span><span style="left:${w}%">${fmt.n(w)}</span><span style="left:${h}%">${fmt.n(h)}</span><span style="left:100%">100</span></div>`;
}

// ----------------------------------------------------------------------------- editor
function field(k) {
  const f = saved.fields[k];
  const v = draft[k];
  const changed = Math.abs(+v - +saved.model[k]) > 1e-9;
  return `<div class="mf ${changed ? 'changed' : ''}" data-k="${k}">
    <label for="f-${k}">${esc(f.label)}</label>
    <div class="mf-in"><input id="f-${k}" type="number" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" inputmode="decimal" /><span>${esc(f.unit)}</span></div>
    <div class="hint">${esc(f.help)}. Default ${fmt.n(saved.defaults[k])}.</div>
  </div>`;
}

function editorHtml() {
  const total = COMPS.reduce((a, k) => a + (+draft['w_' + k] || 0), 0);
  return `
    <div class="alert info edit-note">${ICON.gear}<div>You are editing the model for every customer. Changes are previewed below as you type. <b>Save and recalibrate</b> rescores every customer's full history and recalibrates baselines and peer benchmarks.</div></div>
    <div class="grid cols-2e">
      <section class="card">
        <div class="card-head"><div><h2>Component weights</h2><div class="sub">Weights are scaled to add up to 100%.</div></div>
          <span class="badge ${Math.abs(total - 100) < 0.05 ? 'calibrated' : 'watch'}" id="w-total">Total ${fmt.n(total)}%</span></div>
        <div id="w-bar">${weightBar(draft)}</div>
        <div class="weights">${COMPS.map((k, i) => {
          const key = 'w_' + k;
          const changed = Math.abs(+draft[key] - +saved.model[key]) > 1e-9;
          return `<div class="wrow ${changed ? 'changed' : ''}" data-k="${key}">
            <label for="r-${key}"><i style="background:var(--c${i + 1})"></i>${COMP_LABEL[k]}</label>
            <input type="range" id="r-${key}" min="0" max="100" step="1" value="${draft[key]}" aria-label="${COMP_LABEL[k]} weight" />
            <div class="mf-in sm"><input type="number" id="f-${key}" min="0" max="100" step="1" value="${draft[key]}" aria-label="${COMP_LABEL[k]} weight value" /><span>%</span></div>
            <div class="hint">${DESC[k]}</div>
          </div>`;
        }).join('')}</div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Status thresholds</h2><div class="sub">Where Healthy, Needs attention and At risk begin.</div></div></div>
        <div id="band">${bandHtml(draft)}</div>
        <div class="mf-grid">${field('healthy_at')}${field('watch_at')}</div>
        ${GROUPS.map(([g, title, sub]) => `
          <details class="mgroup" ${g === 'targets' ? 'open' : ''}>
            <summary><b>${title}</b><span class="muted small">${sub}</span></summary>
            <div class="mf-grid">${Object.keys(saved.fields).filter((k) => saved.fields[k].group === g).map(field).join('')}</div>
          </details>`).join('')}
      </section>
    </div>
    <section class="card section">
      <div class="card-head"><div><h2>Impact preview</h2><div class="sub" id="pv-sub">Change a value to see how each customer's current score moves.</div></div></div>
      <div id="pv-body" class="muted small">No changes yet.</div>
    </section>
    <div class="savebar">
      <div class="field savebar-note"><input id="m-note" type="text" maxlength="200" placeholder="Reason for the change (optional, shown in the change log)" aria-label="Reason for the change" /></div>
      <div class="alert err" id="m-err" hidden></div>
      <div class="savebar-actions">
        ${saved.is_default ? '' : '<button class="btn danger" id="m-reset">Reset to defaults</button>'}
        <span class="spacer"></span>
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn primary" id="m-save" disabled>Save and recalibrate</button>
      </div>
    </div>`;
}

function dirty() {
  return Object.keys(saved.fields).some((k) => Math.abs(+draft[k] - +saved.model[k]) > 1e-9);
}

function wireEditor(view) {
  const update = (k, v, from) => {
    draft[k] = v === '' ? '' : +v;
    const row = view.querySelector(`[data-k="${k}"]`);
    if (k.startsWith('w_')) {
      if (from !== 'range') view.querySelector(`#r-${k}`).value = draft[k] || 0;
      if (from !== 'num') view.querySelector(`#f-${k}`).value = draft[k];
      const total = COMPS.reduce((a, c) => a + (+draft['w_' + c] || 0), 0);
      const t = view.querySelector('#w-total');
      t.textContent = `Total ${fmt.n(total)}%${Math.abs(total - 100) >= 0.05 && total > 0 ? ', scaled on save' : ''}`;
      t.className = `badge ${Math.abs(total - 100) < 0.05 ? 'calibrated' : 'watch'}`;
      view.querySelector('#w-bar').innerHTML = weightBar(draft);
    }
    if (k === 'healthy_at' || k === 'watch_at') view.querySelector('#band').innerHTML = bandHtml(draft);
    row?.classList.toggle('changed', Math.abs(+draft[k] - +saved.model[k]) > 1e-9);
    view.querySelector('#m-save').disabled = !dirty();
    schedulePreview(view);
  };
  view.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('input', () => update(r.id.slice(2), r.value, 'range')));
  view.querySelectorAll('.mf-in input, .wrow .mf-in input').forEach((n) => n.addEventListener('input', () => update(n.id.slice(2), n.value, 'num')));

  view.querySelector('#m-cancel').addEventListener('click', () => { draft = null; renderModel(view); });
  view.querySelector('#m-save').addEventListener('click', () => save(view));
  view.querySelector('#m-reset')?.addEventListener('click', () => reset(view));
}

function schedulePreview(view) {
  clearTimeout(previewTimer);
  const body = view.querySelector('#pv-body');
  if (!dirty()) { body.className = 'muted small'; body.textContent = 'No changes yet.'; view.querySelector('#m-err').hidden = true; return; }
  body.classList.add('loading');
  previewTimer = setTimeout(() => preview(view), 700);
}

async function preview(view) {
  const seq = ++previewSeq;
  const err = view.querySelector('#m-err'), body = view.querySelector('#pv-body');
  try {
    const r = await api('/api/model/preview', { json: { model: draft } });
    if (seq !== previewSeq || !document.body.contains(body)) return;
    err.hidden = true;
    body.className = '';
    body.innerHTML = impactTable(r.customers, 'Now', 'With changes');
    const moved = r.customers.filter((c) => c.status_before !== c.status_after).length;
    view.querySelector('#pv-sub').textContent = `${r.customers.length} customer${r.customers.length === 1 ? '' : 's'} scored with the draft. ${moved ? `${moved} would change status.` : 'No status changes.'}`;
  } catch (ex) {
    if (seq !== previewSeq) return;
    body.className = 'muted small'; body.textContent = 'Fix the highlighted problem to see the preview.';
    err.textContent = ex.message; err.hidden = false;
  }
}

function impactTable(rows, a, b) {
  if (!rows.length) return '<p class="muted small">No customers yet. Upload data to see the impact.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Customer</th><th class="n">${a}</th><th></th><th class="n">${b}</th><th class="n">Change</th></tr></thead>
    <tbody>${rows.map((c) => {
      const d = c.score_before == null ? null : c.score_after - c.score_before;
      return `<tr class="${c.status_before !== c.status_after ? 'moved' : ''}">
        <td class="nw"><a href="#/c/${c.account_id}">${esc(c.name)}</a></td>
        <td class="n nw"><span class="num">${fmt.n(c.score_before, 1)}</span> ${c.status_before ? badge(c.status_before) : ''}</td>
        <td class="muted" aria-hidden="true">\u2192</td>
        <td class="n nw"><b class="num">${fmt.n(c.score_after, 1)}</b> ${badge(c.status_after)}</td>
        <td class="n num nw ${d > 0.05 ? 'pos' : d < -0.05 ? 'neg' : 'muted'}">${d == null ? '' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

async function save(view) {
  const btn = view.querySelector('#m-save'), err = view.querySelector('#m-err');
  btn.disabled = true; btn.textContent = 'Recalibrating...';
  err.hidden = true;
  try {
    const r = await api('/api/model', { method: 'PUT', json: { model: draft, note: view.querySelector('#m-note').value } });
    draft = null;
    state.status = null;
    await refreshShell();
    await renderModel(view);
    showResult(view, r, 'Model saved. Every customer was rescored and recalibrated.');
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    btn.disabled = false; btn.textContent = 'Save and recalibrate';
  }
}

async function reset(view) {
  if (!confirm('Reset every setting to the defaults and rescore all customers?')) return;
  try {
    const r = await api('/api/model/reset', { method: 'POST' });
    draft = null;
    state.status = null;
    await refreshShell();
    await renderModel(view);
    showResult(view, r, 'Model reset to defaults. Every customer was rescored.');
  } catch (ex) { toast(ex.message, 5000); }
}

function showResult(view, r, msg) {
  toast(msg, 4000);
  const box = document.createElement('section');
  box.className = 'card section result-card';
  box.innerHTML = `<div class="card-head"><div><h2>What changed</h2><div class="sub">${esc(msg)}</div></div>
    <button class="btn sm" data-x>Dismiss</button></div>${impactTable(r.customers || [], 'Before', 'After')}`;
  view.querySelector('.page-head').after(box);
  box.querySelector('[data-x]').addEventListener('click', () => box.remove());
}

// ----------------------------------------------------------------------------- calibration and history
function calibrationHtml(run) {
  const p = run?.params;
  const names = new Map((state.customers || []).map((a) => [String(a.account_id), a.name]));
  return `<div class="card section">
    <div class="card-head"><div><h2>Calibration state</h2><div class="sub">Learned automatically from each customer's history on every upload and every model change</div></div></div>
    ${p ? `<dl class="kv" style="margin-bottom:var(--space-4)">
      <dt>Peer benchmark</dt><dd>${p.peers.accounts >= 1 ? `${fmt.n(p.peers.median_actions_14d)} actions and ${fmt.n(p.peers.median_active_days_14d)} active days per 14 days (median of ${p.peers.accounts} customers)` : 'Needs customers with 14+ days of history'}</dd>
      ${p.trigger ? `<dt>Last run</dt><dd>${esc(p.trigger)}</dd>` : ''}
    </dl>
    <div class="table-wrap"><table><thead><tr><th>Customer</th><th>First activity</th><th>Data through</th><th class="n">Active days</th><th class="n">Usual gap (days)</th><th class="n">Baseline windows</th><th>Engagement reference</th></tr></thead>
    <tbody>${Object.entries(p.per_account).map(([id, a]) => {
      const acct = (state.portfolio?.accounts || []).find((x) => String(x.account_id) === id);
      return `<tr><td class="nw"><a href="#/c/${id}">${esc(names.get(id) || id)}</a></td><td class="nw">${fmt.date(a.first_activity)}</td><td class="nw">${fmt.date(a.data_through)}</td><td class="n num">${a.active_days}</td><td class="n num">${fmt.n(a.expected_gap_days)}</td><td class="n num">${a.baseline_windows} of ${p.baseline_windows}</td><td class="small nw">${esc(acct?.metrics?.engagement_reference_source || '')}${acct?.metrics ? ` (${fmt.n(acct.metrics.engagement_reference)})` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="muted">Upload data to calibrate.</p>'}
  </div>`;
}

function historyHtml() {
  const v = saved.versions || [];
  if (!v.length) return '';
  return `<div class="card section">
    <div class="card-head"><h2>Change log</h2></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Changed by</th><th>Note</th></tr></thead>
    <tbody>${v.map((x) => `<tr><td class="nw">${fmt.time(x.changed_at)}</td><td class="nw">${esc(x.changed_by || '')}</td><td class="small">${esc(x.note || '')}</td></tr>`).join('')}</tbody></table></div>
  </div>`;
}

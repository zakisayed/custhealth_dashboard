// SharePoint folder watch: settings page (admin), per-customer folder editor and file list.
import { crumbs, refreshShell, state } from './app.js';
import { api, currentUser, esc, fmt, ICON, toast } from './lib.js';

const isAdmin = () => currentUser?.role === 'admin';
const STATUS = {
  complete: ['healthy', 'Imported'], failed: ['at_risk', 'Failed'], pending: ['watch', 'Waiting'],
  processing: ['watch', 'Importing'], skipped: ['info', 'Skipped'], baseline: ['info', 'Ignored'],
};
const SRC = { ok: ['healthy', 'OK'], partial: ['watch', 'Partly failed'], error: ['at_risk', 'Error'] };
const TZ = { UTC: 'UTC', PKT: 'Asia/Karachi' };
const when = (v) => (v ? fmt.time(v) : 'never');
let runTz = 'PKT';
const atTz = (v, tz = runTz) => (v ? `${new Date(v).toLocaleString('en-US', { timeZone: TZ[tz], month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} ${tz}` : 'never');
const daily = (st) => `daily at ${esc(st.label)}`;
const nextCheck = (s) => {
  if (!s.enabled) return 'Paused';
  if (!s.next_check_at || s.next_check_at === 'next run') return 'Next scheduler run';
  return new Date(s.next_check_at) < new Date() ? 'Next scheduler run' : atTz(s.next_check_at);
};
const EXEC = { success: ['healthy', 'Success'], no_activity: ['info', 'No activity'], failed: ['at_risk', 'Failed'] };
const RUN = { ok: ['healthy', 'Finished OK'], partial: ['watch', 'Finished with failures'], failed: ['at_risk', 'Failed'],
  running: ['watch', 'Running'], incomplete: ['at_risk', 'Did not finish'] };
const LOG = { ok: ['healthy', 'OK'], unchanged: ['info', 'No change'], error: ['at_risk', 'Error'] };

function badge(map, key) {
  const [cls, label] = map[key] || ['info', key || 'Not checked'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function runSummary(out) {
  if (out.busy || out.ok === false) return out.message;
  const bad = (out.customers || []).flatMap((c) => (c.files || []).filter((f) => f.status !== 'complete').map((f) => `${c.name}: ${f.name}: ${f.message}`));
  const errs = (out.customers || []).filter((c) => c.status === 'error' && !(c.files || []).length).map((c) => `${c.name}: ${c.message}`);
  return [out.message, ...errs, ...bad].join('\n');
}

// ----------------------------------------------------------------------------- settings page
export async function renderSync(view) {
  crumbs('<b>SharePoint sync</b>');
  if (!isAdmin()) {
    view.innerHTML = '<div class="card"><h2>Admins only</h2><p class="muted">Ask your admin to set up SharePoint folders.</p></div>';
    return;
  }
  const info = await api('/api/sharepoint');
  const cred = info.credentials, st = info.settings;
  runTz = st.run_tz;
  const credRow = (k, name) => `<li class="${cred[k] ? 'done' : 'err'}">${cred[k] ? ICON.check : ICON.x}<span><code>${name}</code> ${cred[k] ? 'is set' : 'is missing'}</span></li>`;
  const withFolder = new Set(info.sources.map((s) => s.account_id));
  const without = (state.customers || []).filter((c) => !withFolder.has(c.account_id));
  const lastRun = info.runs[0];
  view.innerHTML = `
    <div class="page-head"><div><h1>SharePoint sync</h1>
      <div class="sub">New files saved in a customer's SharePoint folder are imported automatically, the same way as a manual upload.</div></div>
      <div class="actions"><button class="btn primary" id="run-all" ${info.configured && info.sources.length ? '' : 'disabled'}>${ICON.upload}Check all folders now</button></div></div>
    <div class="grid cols-2">
      <section class="card">
        <div class="card-head"><div><h2>Daily check time</h2><div class="sub">Customer folders and the execution log are checked once a day at this time.</div></div></div>
        <form id="int-form" class="sync-int" novalidate>
          <div class="field" style="margin:0"><label for="run-time">Time</label>
            <select id="run-time">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === st.run_hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div>
          <div class="field" style="margin:0"><label for="run-tz">Timezone</label>
            <select id="run-tz">${Object.entries(info.timezones).map(([k, l]) => `<option value="${k}" ${k === st.run_tz ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <button class="btn primary" id="int-save">Save</button>
        </form>
        <p class="small muted" style="margin-top:var(--space-3)">Next check: <b>${atTz(st.next_run_at)}</b> (${atTz(st.next_run_at, st.run_tz === 'UTC' ? 'PKT' : 'UTC')}).
          The scheduler wakes up every hour, so the check starts within the hour after this time. Pick a time after the export job finishes.</p>
        ${st.updated_by ? `<p class="small faint">Last changed by ${esc(st.updated_by)} on ${fmt.time(st.updated_at)}</p>` : ''}
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Connection</h2><div class="sub">Set in the Vercel project environment variables, then redeploy.</div></div>
          <button class="btn sm" id="test-conn" ${info.configured ? '' : 'disabled'}>${ICON.key}Test sign in</button></div>
        <ul class="steps">
          ${credRow('tenant', 'SHAREPOINT_TENANT_ID')}${credRow('client', 'SHAREPOINT_CLIENT_ID')}${credRow('secret', 'SHAREPOINT_CLIENT_SECRET')}
          <li class="${info.cron_secret_set ? 'done' : 'err'}">${info.cron_secret_set ? ICON.check : ICON.x}<span><code>CRON_SECRET</code> ${info.cron_secret_set ? 'is set' : 'is missing, scheduled checks are refused until it is set'}</span></li>
        </ul>
        <p class="small muted" style="margin-top:var(--space-3)">Last scheduled or manual run: ${lastRun ? `${fmt.time(lastRun.started_at)} (${esc(lastRun.trigger)}) · ${esc(lastRun.message || 'running')}` : 'none yet'}</p>
      </section>
    </div>
    <section class="card section" id="exec-card"></section>
    <section class="card section">
      <div class="card-head"><div><h2>Customer folders</h2><div class="sub">${info.sources.length} of ${(state.customers || []).length} customers watched</div></div>
        ${without.length ? `<div class="add-folder"><select id="add-cust" aria-label="Customer">${without.map((c) => `<option value="${c.account_id}">${esc(c.name)}</option>`).join('')}</select>
          <button class="btn" id="add-folder">${ICON.plus}Add folder</button></div>` : ''}</div>
      <div class="table-wrap"><table class="tbl" id="src-tbl">
        <thead><tr><th>Customer</th><th>Folder</th><th>Status</th><th>Last check</th><th>Next check</th><th class="n">Imported</th><th class="n">Failed</th><th class="n">Actions</th></tr></thead>
        <tbody>${info.sources.map((s) => `<tr data-id="${s.account_id}">
          <td class="nw"><a href="#/c/${s.account_id}/upload"><b>${esc(s.name)}</b></a></td>
          <td class="sp-folder"><a href="${esc(s.folder_url)}" target="_blank" rel="noopener">${esc(s.folder_name || s.folder_url)}</a>${s.enabled ? '' : ' <span class="tag">Paused</span>'}</td>
          <td>${badge(SRC, s.last_status)}${s.last_message ? `<div class="small muted sp-msg">${esc(s.last_message)}</div>` : ''}</td>
          <td class="nw small">${when(s.last_checked_at)}</td>
          <td class="nw small">${nextCheck(s)}</td>
          <td class="n num">${fmt.n(s.files_imported)}</td><td class="n num">${fmt.n(s.files_failed)}</td>
          <td class="n nw"><button class="btn sm" data-act="check" ${s.enabled && info.configured ? '' : 'disabled'}>Check now</button>
            <button class="btn sm" data-act="edit">Edit</button></td></tr>`).join('')
          || '<tr><td colspan="8" class="empty">No folders yet. Pick a customer above and add its SharePoint folder.</td></tr>'}</tbody>
      </table></div>
    </section>`;

  view.querySelector('#int-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = view.querySelector('#int-save');
    const h = +view.querySelector('#run-time').value, m = 0;
    btn.disabled = true;
    try {
      const v = await api('/api/sharepoint/settings', { method: 'PUT', json: { run_hour: h, run_minute: m || 0, run_tz: view.querySelector('#run-tz').value } });
      toast(`Folders and the execution log are now checked ${daily(v)}`);
      renderSync(view);
    } catch (err) { toast(err.message, 5000); btn.disabled = false; }
  });
  renderExecution(view.querySelector('#exec-card'), info, () => renderSync(view));
  view.querySelector('#test-conn')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { toast((await api('/api/sharepoint/test', { json: {} })).message); } catch (err) { toast(err.message, 8000); }
    b.disabled = false;
  });
  view.querySelector('#run-all')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
    try { const out = await api('/api/sharepoint/run', { json: {} }); toast(runSummary(out), 8000); await refreshShell(); } catch (err) { toast(err.message, 8000); }
    renderSync(view);
  });
  view.querySelector('#add-folder')?.addEventListener('click', () => {
    const id = +view.querySelector('#add-cust').value;
    openFolderEditor(id, () => renderSync(view));
  });
  view.querySelectorAll('#src-tbl [data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = +b.closest('tr').dataset.id;
    if (b.dataset.act === 'edit') { openFolderEditor(id, () => renderSync(view)); return; }
    b.disabled = true; b.textContent = 'Checking…';
    try { const out = await api(`/api/accounts/${id}/sharepoint/check`, { json: {} }); toast(runSummary(out), 8000); await refreshShell(); } catch (err) { toast(err.message, 8000); }
    renderSync(view);
  }));
}

// ----------------------------------------------------------------------------- folder editor (drawer)
export async function openFolderEditor(accountId, onSaved) {
  const c = (state.customers || []).find((x) => x.account_id === accountId) || { name: `#${accountId}` };
  const data = await api(`/api/accounts/${accountId}/sharepoint`);
  const s = data.source;
  runTz = data.settings.run_tz;
  const dr = document.getElementById('drawer'), bg = document.getElementById('drawer-bg');
  dr.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>SharePoint folder</h2><button class="btn" id="dr-close" aria-label="Close">${ICON.x}</button></div>
    <p class="muted small">${esc(c.name)} · checked ${daily(data.settings)}. New .csv, .xlsx and .xlsm files are imported into this customer.</p>
    ${data.configured ? '' : `<div class="alert err">${ICON.at_risk}<div>SharePoint is not set up yet. Add <code>SHAREPOINT_TENANT_ID</code>, <code>SHAREPOINT_CLIENT_ID</code> and <code>SHAREPOINT_CLIENT_SECRET</code> in Vercel and redeploy.</div></div>`}
    <div class="field"><label for="sp-url">Folder link</label>
      <input id="sp-url" type="url" placeholder="https://yourcompany.sharepoint.com/sites/Team/Shared Documents/Exports/${esc(c.name)}" value="${esc(s?.folder_url || '')}" autocomplete="off" />
      <span class="hint">Open the folder in SharePoint and copy the address bar, or use Copy link on the folder.</span></div>
    <label class="check-row"><input type="checkbox" id="sp-on" ${!s || s.enabled ? 'checked' : ''} /> <span>Watch this folder</span></label>
    <label class="check-row" ${s ? 'hidden' : ''}><input type="checkbox" id="sp-existing" checked /> <span>Also import files already in the folder</span></label>
    <div class="alert err" id="sp-err" hidden></div>
    <div class="alert info" id="sp-ok" hidden></div>
    ${s ? `<div class="danger-zone"><h3 style="font-size:var(--text-sm);margin:0 0 var(--space-2)">Stop watching</h3>
      <p class="hint" style="margin:0 0 var(--space-3)">Removes the folder link. Data already imported stays.</p>
      <button class="btn danger" id="sp-remove">${ICON.trash}Remove folder</button></div>` : ''}
    <div class="actions"><button class="btn" id="dr-cancel">Cancel</button><button class="btn primary" id="sp-save" ${data.configured ? '' : 'disabled'}>Check and save</button></div>`;
  const close = () => { dr.classList.remove('open'); bg.classList.remove('open'); dr.setAttribute('aria-hidden', 'true'); };
  dr.classList.add('open'); bg.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
  bg.onclick = close;
  dr.querySelector('#dr-close').onclick = close;
  dr.querySelector('#dr-cancel').onclick = close;
  const err = dr.querySelector('#sp-err'), ok = dr.querySelector('#sp-ok');
  dr.querySelector('#sp-save').onclick = async (e) => {
    const b = e.currentTarget; err.hidden = true; ok.hidden = true;
    const url = dr.querySelector('#sp-url').value.trim();
    if (!url) { err.innerHTML = `${ICON.at_risk}<div>Paste the folder link.</div>`; err.hidden = false; return; }
    b.disabled = true; b.textContent = 'Checking folder…';
    try {
      const r = await api(`/api/accounts/${accountId}/sharepoint`, { method: 'PUT', json: {
        folder_url: url, enabled: dr.querySelector('#sp-on').checked, include_existing: dr.querySelector('#sp-existing').checked } });
      toast(`Watching "${r.folder_name}" · ${r.supported_files} export file${r.supported_files === 1 ? '' : 's'} found. Press Check now to import right away.`, 6000);
      close(); onSaved?.();
    } catch (ex) {
      err.innerHTML = `${ICON.at_risk}<div>${esc(ex.message)}</div>`; err.hidden = false;
      b.disabled = false; b.textContent = 'Check and save';
    }
  };
  dr.querySelector('#sp-remove')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api(`/api/accounts/${accountId}/sharepoint`, { method: 'DELETE' }); toast('Folder removed'); close(); onSaved?.(); } catch (ex) { toast(ex.message); }
  });
}

// ----------------------------------------------------------------------------- customer upload page card
export async function renderFolderCard(el, accountId) {
  let data;
  try { data = await api(`/api/accounts/${accountId}/sharepoint`); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const s = data.source;
  runTz = data.settings.run_tz;
  const head = `<div class="card-head"><div><h2>SharePoint folder</h2><div class="sub">${s
    ? `Checked ${daily(data.settings)} · last check ${when(s.last_checked_at)} · next check: ${/^[A-Z][a-z]+ [a-z]/.test(nextCheck(s)) ? nextCheck(s).toLowerCase() : nextCheck(s)}`
    : 'New files in a SharePoint folder can be imported automatically'}</div></div>
    ${isAdmin() ? `<div class="actions">${s ? `<button class="btn sm" id="sp-check" ${s.enabled && data.configured ? '' : 'disabled'}>Check now</button>` : ''}
      <button class="btn sm" id="sp-edit">${s ? 'Edit' : `${ICON.plus}Set folder`}</button></div>` : ''}</div>`;
  if (!s) {
    el.innerHTML = `${head}<p class="muted small">${isAdmin() ? 'Add the folder this customer\'s exports are saved in.' : 'Ask your admin to add this customer\'s SharePoint folder.'}</p>`;
  } else {
    el.innerHTML = `${head}
      <p class="small"><a href="${esc(s.folder_url)}" target="_blank" rel="noopener">${esc(s.folder_name || s.folder_url)}</a>
        ${s.enabled ? '' : '<span class="tag">Paused</span>'} ${badge(SRC, s.last_status)} <span class="muted">${esc(s.last_message || '')}</span></p>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>File</th><th>Status</th><th>Details</th><th>Modified</th><th>Imported</th></tr></thead>
        <tbody>${data.files.map((f) => `<tr><td>${f.web_url ? `<a href="${esc(f.web_url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name)}<div class="faint small">${f.size ? `${fmt.n(f.size / 1048576, 1)} MB` : ''}</div></td>
          <td>${badge(STATUS, f.status)}</td><td class="small sp-msg">${esc(f.message || '')}</td>
          <td class="nw small">${when(f.modified_at)}</td><td class="nw small">${when(f.processed_at)}</td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">No files seen yet. Files appear here after the next check.</td></tr>'}</tbody>
      </table></div>`;
  }
  el.querySelector('#sp-edit')?.addEventListener('click', () => openFolderEditor(accountId, () => renderFolderCard(el, accountId)));
  el.querySelector('#sp-check')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
    try {
      const out = await api(`/api/accounts/${accountId}/sharepoint/check`, { json: {} });
      toast(runSummary(out), 8000);
      await refreshShell();
      el.dispatchEvent(new CustomEvent('sp-imported', { bubbles: true }));
    } catch (ex) { toast(ex.message, 8000); }
    renderFolderCard(el, accountId);
  });
}

// ----------------------------------------------------------------------------- execution status
function dashboardCell(r) {
  if (!r.dashboard_name) return '<span class="faint">Not in the dashboard</span>';
  if (r.status === 'no_activity') return r.marked_no_activity ? 'Shown as no activity' : '-';
  if (r.status === 'failed') return '<span class="faint">Nothing to import</span>';
  if (!r.watched) return '<span class="faint">Folder not watched</span>';
  if (!r.file_status) return r.watch_enabled ? 'Waiting for the next check' : 'Watching paused';
  const [cls, label] = STATUS[r.file_status] || ['info', r.file_status];
  return `<span class="badge ${cls}">${esc(label)}</span>${r.file_status === 'failed' && r.file_message ? `<div class="small muted sp-msg">${esc(r.file_message)}</div>` : ''}`;
}

function execBody(ex) {
  if (!ex) return '<p class="muted small">No run read yet. The log is read at the daily check time, or press Read log now.</p>';
  const c = ex.counts;
  return `
    <div class="exec-sum">
      <div><span class="label">Export date</span><b>${fmt.date(ex.export_date)}</b></div>
      <div><span class="label">Run</span>${badge(RUN, ex.status)}</div>
      <div><span class="label">Started</span><span>${atTz(ex.started_at)}</span></div>
      <div><span class="label">Finished</span><span>${ex.finished_at ? atTz(ex.finished_at) : 'not finished'}</span></div>
      <div><span class="label">Customers</span><span>${c.success} success · ${c.no_activity} no activity · <span style="${c.failed ? 'color:var(--risk)' : ''}">${c.failed} failed</span></span></div>
      <div><span class="label">Records extracted</span><b class="num">${fmt.n(ex.records)}</b></div>
    </div>
    ${ex.message ? `<div class="alert ${ex.status === 'ok' ? 'info' : 'err'}" style="margin:var(--space-3) 0">${ICON.info}<div>${esc(ex.message)}</div></div>` : ''}
    <div class="table-wrap"><table class="tbl" id="exec-tbl">
      <thead><tr><th>Customer</th><th>Account</th><th>Status</th><th class="n">Records</th><th>File</th><th>Dashboard</th></tr></thead>
      <tbody>${ex.results.map((r) => `<tr>
        <td class="nw">${r.dashboard_name ? `<a href="#/c/${r.account_id}"><b>${esc(r.dashboard_name)}</b></a>` : `<b>${esc(r.customer_name)}</b>`}</td>
        <td class="num small">${r.account_id}</td>
        <td>${badge(EXEC, r.status)}${r.status === 'failed' && r.message ? `<div class="small muted sp-msg">${esc(r.message)}</div>` : ''}</td>
        <td class="n num">${r.records == null ? '-' : fmt.n(r.records)}</td>
        <td class="small sp-msg">${r.file_name ? (r.file_url ? `<a href="${esc(r.file_url)}" target="_blank" rel="noopener">${esc(r.file_name)}</a>` : esc(r.file_name)) : '<span class="faint">No file</span>'}</td>
        <td class="small">${dashboardCell(r)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No customers in this run.</td></tr>'}</tbody>
    </table></div>`;
}

function renderExecution(el, info, reload) {
  const log = info.log, hist = info.execution_history || [];
  el.innerHTML = `
    <div class="card-head"><div><h2>Execution status</h2><div class="sub">${log
      ? `From <a href="${esc(log.folder_url)}" target="_blank" rel="noopener">${esc(log.log_name || log.folder_name || 'the log folder')}</a> · last read ${log.last_read_at ? atTz(log.last_read_at) : 'never'} ${log.last_status ? badge(LOG, log.last_status) : ''}`
      : 'Shows which customer exports ran, failed or found no activity, read from the export job log'}</div></div>
      <div class="actions">${hist.length > 1 ? `<select id="exec-run" aria-label="Export date">${hist.map((h) => `<option value="${esc(h.run_key)}">${fmt.date(h.export_date)}${h.failed ? ` · ${h.failed} failed` : ''}</option>`).join('')}</select>` : ''}
        ${log ? `<button class="btn sm" id="log-read" ${info.configured ? '' : 'disabled'}>Read log now</button>` : ''}
        <button class="btn sm" id="log-edit">${log ? 'Change folder' : `${ICON.plus}Set log folder`}</button></div></div>
    ${log?.last_status === 'error' && log.last_message ? `<div class="alert err" style="margin-bottom:var(--space-3)">${ICON.at_risk}<div>${esc(log.last_message)}</div></div>` : ''}
    <form id="log-form" class="add-folder" ${log ? 'hidden' : ''} style="margin-bottom:var(--space-3)" novalidate>
      <input id="log-url" type="url" placeholder="https://yourcompany.sharepoint.com/sites/Team/Shared Documents/Execution_Logs" value="${esc(log?.folder_url || '')}" style="flex:1 1 320px" autocomplete="off" />
      <button class="btn primary" id="log-save" ${info.configured ? '' : 'disabled'}>Check and save</button>
      ${log ? '<button class="btn danger" type="button" id="log-remove">Remove</button>' : ''}
      <span class="hint" style="flex-basis:100%">The folder that holds the export job's .log file. The newest .log file is read at each daily check.</span>
    </form>
    <div id="exec-body">${execBody(info.execution)}</div>`;
  const form = el.querySelector('#log-form');
  el.querySelector('#log-edit').onclick = () => { form.hidden = !form.hidden; if (!form.hidden) el.querySelector('#log-url').focus(); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = el.querySelector('#log-save'), url = el.querySelector('#log-url').value.trim();
    if (!url) { toast('Paste the execution log folder link'); return; }
    b.disabled = true; b.textContent = 'Checking folder…';
    try {
      const r = await api('/api/sharepoint/log', { method: 'PUT', json: { folder_url: url } });
      toast(r.log_name ? `Reading ${r.log_name} from "${r.folder_name}". ${r.read?.message || ''}` : `Saved "${r.folder_name}". No .log file in it yet.`, 6000);
      await refreshShell(); reload();
    } catch (ex) { toast(ex.message, 8000); b.disabled = false; b.textContent = 'Check and save'; }
  });
  el.querySelector('#log-remove')?.addEventListener('click', async () => {
    try { await api('/api/sharepoint/log', { method: 'DELETE' }); toast('Execution log folder removed'); reload(); } catch (ex) { toast(ex.message); }
  });
  el.querySelector('#log-read')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Reading…';
    try { const r = await api('/api/sharepoint/log/read', { json: {} }); toast(r.message || 'Done', 6000); await refreshShell(); } catch (ex) { toast(ex.message, 8000); }
    reload();
  });
  el.querySelector('#exec-run')?.addEventListener('change', async (e) => {
    const body = el.querySelector('#exec-body');
    try { body.innerHTML = execBody(await api(`/api/sharepoint/executions?run_key=${encodeURIComponent(e.target.value)}`)); } catch (ex) { toast(ex.message); }
  });
}

// SharePoint folder watch: settings page (admin), per-customer folder editor and file list.
import { crumbs, refreshShell, state } from './app.js';
import { api, currentUser, esc, fmt, ICON, toast } from './lib.js';

const isAdmin = () => currentUser?.role === 'admin';
const STATUS = {
  complete: ['healthy', 'Imported'], failed: ['at_risk', 'Failed'], pending: ['watch', 'Waiting'],
  processing: ['watch', 'Importing'], skipped: ['info', 'Skipped'], baseline: ['info', 'Ignored'],
};
const SRC = { ok: ['healthy', 'OK'], partial: ['watch', 'Partly failed'], error: ['at_risk', 'Error'] };
const when = (v) => (v ? fmt.time(v) : 'never');
const hours = (h) => `${fmt.n(h, h % 1 ? 1 : 0)} hour${+h === 1 ? '' : 's'}`;
const nextCheck = (s) => {
  if (!s.enabled) return 'Paused';
  if (!s.next_check_at || s.next_check_at === 'next run') return 'Next scheduled run';
  return new Date(s.next_check_at) < new Date() ? 'Next scheduled run' : fmt.time(s.next_check_at);
};

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
  const cred = info.credentials;
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
        <div class="card-head"><div><h2>Check interval</h2><div class="sub">How often each customer's folder is checked for new files.</div></div></div>
        <form id="int-form" class="sync-int" novalidate>
          <div class="field" style="margin:0"><label for="int-h">Check every (hours)</label>
            <input id="int-h" type="number" min="${info.limits.min}" max="${info.limits.max}" step="1" value="${info.settings.interval_hours}" />
            <span class="hint">Between ${info.limits.min} and ${info.limits.max} hours. The scheduler wakes up every hour and checks the customers that are due.</span></div>
          <button class="btn primary" id="int-save">Save</button>
        </form>
        ${info.settings.updated_by ? `<p class="small faint" style="margin-top:var(--space-3)">Last changed by ${esc(info.settings.updated_by)} on ${fmt.time(info.settings.updated_at)}</p>` : ''}
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
    const btn = view.querySelector('#int-save'); btn.disabled = true;
    try {
      const v = await api('/api/sharepoint/settings', { method: 'PUT', json: { interval_hours: +view.querySelector('#int-h').value } });
      toast(`Folders are now checked every ${hours(v.interval_hours)}`);
      renderSync(view);
    } catch (err) { toast(err.message, 5000); btn.disabled = false; }
  });
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
  const dr = document.getElementById('drawer'), bg = document.getElementById('drawer-bg');
  dr.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>SharePoint folder</h2><button class="btn" id="dr-close" aria-label="Close">${ICON.x}</button></div>
    <p class="muted small">${esc(c.name)} · checked every ${hours(data.settings.interval_hours)}. New .csv, .xlsx and .xlsm files are imported into this customer.</p>
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
  const head = `<div class="card-head"><div><h2>SharePoint folder</h2><div class="sub">${s
    ? `Checked every ${hours(data.settings.interval_hours)} · last check ${when(s.last_checked_at)} · next check: ${/^[A-Z][a-z]+ [a-z]/.test(nextCheck(s)) ? nextCheck(s).toLowerCase() : nextCheck(s)}`
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

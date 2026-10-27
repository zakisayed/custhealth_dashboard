import { crumbs, refreshShell } from './app.js';
import { api, fmt, esc, ICON, toast } from './lib.js';

const REQUIRED = ['account_id', 'timestamp', 'event_type', 'entity_type', 'user_id'];
const KEEP = [
  'PK', 'SK', 'account_id', 'timestamp', 'user_id', 'user_name', 'event_type', 'event_type_name',
  'entity_type', 'entity_type_name', 'entity_sub_type', 'entity_id', 'entity_name', 'entity_status',
  'source_table', 'transaction_id', 'node_alert_status', 'description', 'changed_fields', 'after_image',
];
const CHUNK = 1500;

export async function renderUpload(view) {
  crumbs('<b>Upload data</b>');
  view.innerHTML = `
    <div class="page-head"><div><h1>Upload activity log</h1>
      <div class="sub">Drop a CSV export. New rows are added to history, overlaps are ignored, and every score is recalculated.</div></div></div>
    <div class="grid cols-2">
      <div>
        <label class="drop" id="drop" tabindex="0">
          ${ICON.file}
          <h2>Drop CSV here or browse</h2>
          <p>Same format as the Brown and Caldwell export. Any size, any number of accounts.</p>
          <input type="file" id="file" accept=".csv,text/csv" hidden />
        </label>
        <div class="card section" id="job" hidden></div>
      </div>
      <div class="card">
        <h2>What happens on upload</h2>
        <ul class="steps" style="margin-top:var(--space-4)">
          <li class="done">${ICON.check}Parsed in your browser, large JSON columns dropped</li>
          <li class="done">${ICON.check}Rows normalized: actions, object types, statuses, system user</li>
          <li class="done">${ICON.check}Deduplicated by log key, so re-uploads are safe</li>
          <li class="done">${ICON.check}Mirrored DQ rows and machine-speed bursts flagged</li>
          <li class="done">${ICON.check}Daily rollups rebuilt per account, user and day</li>
          <li class="done">${ICON.check}Baselines recalibrated, health history rescored</li>
        </ul>
        <p class="small muted" style="margin-top:var(--space-4)">Required columns: ${REQUIRED.map((c) => `<code>${c}</code>`).join(' ')}</p>
      </div>
    </div>
    <div class="card section">
      <div class="card-head"><div><h2>Upload history</h2></div></div>
      <div class="table-wrap"><table id="hist"></table></div>
    </div>`;

  const drop = document.getElementById('drop'), input = document.getElementById('file');
  drop.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) start(f); });
  input.addEventListener('change', () => { if (input.files[0]) start(input.files[0]); input.value = ''; });
  loadHistory();
}

async function loadHistory() {
  const rows = await api('/api/uploads');
  const el = document.getElementById('hist');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<tbody><tr><td class="muted">No uploads yet</td></tr></tbody>'; return; }
  const st = { complete: 'healthy', failed: 'at_risk', processing: 'watch', receiving: 'watch' };
  el.innerHTML = `<thead><tr><th>When</th><th>File</th><th>Status</th><th class="n">Rows</th><th class="n">New</th><th class="n">Already stored</th><th class="n">Rejected</th><th>Covers</th></tr></thead>
    <tbody>${rows.map((u) => `<tr><td>${fmt.time(u.created_at)}</td><td>${esc(u.filename || '–')}</td>
      <td><span class="badge ${st[u.status] || 'info'}">${esc(u.status)}</span></td>
      <td class="n num">${fmt.n(u.rows_received)}</td><td class="n num">${fmt.n(u.rows_inserted)}</td><td class="n num">${fmt.n(u.rows_duplicate)}</td><td class="n num">${fmt.n(u.rows_rejected)}</td>
      <td class="small">${u.min_ts ? `${fmt.short(u.min_ts)} to ${fmt.short(u.max_ts)}` : '–'}</td></tr>`).join('')}</tbody>`;
}

function parse(file) {
  return new Promise((resolve, reject) => {
    window.Papa.parse(file, {
      header: true, skipEmptyLines: true, worker: false,
      complete: (r) => resolve(r), error: reject,
    });
  });
}

async function start(file) {
  const job = document.getElementById('job');
  job.hidden = false;
  const steps = [
    ['read', `Reading ${esc(file.name)} (${fmt.n(file.size / 1048576, 1)} MB)`],
    ['check', 'Checking columns'], ['send', 'Uploading rows'], ['score', 'Rebuilding rollups and scores'],
  ];
  job.innerHTML = `<h2>Processing ${esc(file.name)}</h2>
    <ul class="steps" id="steps">${steps.map(([k, l]) => `<li id="st-${k}">${ICON.dotc}<span>${l}</span></li>`).join('')}</ul>
    <div class="progress"><i id="bar"></i></div><div id="result"></div>`;
  const mark = (k, cls = 'done', text) => {
    const li = document.getElementById(`st-${k}`);
    li.className = cls; li.querySelector('svg').outerHTML = cls === 'err' ? ICON.x : ICON.check;
    if (text) li.querySelector('span').textContent = text;
  };
  const bar = document.getElementById('bar');
  try {
    const parsed = await parse(file);
    const cols = parsed.meta.fields || [];
    mark('read', 'done', `Read ${fmt.n(parsed.data.length)} rows`);
    const missing = REQUIRED.filter((c) => !cols.includes(c));
    if (missing.length) { mark('check', 'err', `Missing columns: ${missing.join(', ')}`); return; }
    const rows = parsed.data.map((r) => {
      const o = {};
      for (const k of KEEP) if (r[k] !== undefined && r[k] !== '') o[k] = r[k];
      const isAlarm = r.entity_type === 'ALM' || r.source_table === 'saws_alarms';
      if (!isAlarm) delete o.after_image;
      if (o.changed_fields) o.changed_fields = String((o.changed_fields.match(/field_name/g) || []).length);
      return o;
    });
    const accts = new Set(rows.map((r) => r.account_id));
    mark('check', 'done', `Columns OK · ${accts.size} account${accts.size > 1 ? 's' : ''}`);

    const up = await api('/api/uploads', { json: { filename: file.name } });
    const tot = { inserted: 0, duplicates: 0, rejected: 0, errors: [] };
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await api(`/api/uploads/${up.upload_id}/rows`, { json: { rows: rows.slice(i, i + CHUNK) } });
      tot.inserted += r.inserted; tot.duplicates += r.duplicates; tot.rejected += r.rejected; tot.errors.push(...r.errors);
      bar.style.width = `${Math.min(85, ((i + CHUNK) / rows.length) * 85)}%`;
    }
    mark('send', 'done', `Uploaded ${fmt.n(rows.length)} rows`);
    const done = await api(`/api/uploads/${up.upload_id}/complete`, { json: {} });
    bar.style.width = '100%';
    mark('score', 'done', `Scored ${done.recompute.accounts} account${done.recompute.accounts > 1 ? 's' : ''} through ${fmt.date(done.recompute.data_through)}`);
    document.getElementById('result').innerHTML = `
      <div class="stat-row">
        <div><b>${fmt.n(tot.inserted)}</b><span>New events</span></div>
        <div><b>${fmt.n(tot.duplicates)}</b><span>Already stored</span></div>
        <div><b>${fmt.n(tot.rejected)}</b><span>Rejected</span></div>
        <div><b>${fmt.short(done.upload.min_ts)} to ${fmt.short(done.upload.max_ts)}</b><span>Date range</span></div>
      </div>
      ${tot.errors.length ? `<div class="alert err" style="margin-top:var(--space-4)">${ICON.at_risk}<div>${tot.errors.map(esc).join('<br>')}</div></div>` : ''}
      <div style="display:flex;gap:var(--space-2);margin-top:var(--space-5);flex-wrap:wrap">
        <a class="btn primary" href="#/">View portfolio</a>
        ${done.upload.account_ids.length === 1 ? `<a class="btn" href="#/account/${done.upload.account_ids[0]}">Open account</a>` : ''}
      </div>`;
    toast('Upload complete');
    await refreshShell();
    loadHistory();
  } catch (e) {
    console.error(e);
    const open = [...document.querySelectorAll('#steps li')].find((li) => !li.className);
    if (open) { open.className = 'err'; open.querySelector('span').textContent += ` · ${e.message}`; }
    toast('Upload failed');
  }
}

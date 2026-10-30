import { crumbs, refreshShell, state } from './app.js';
import { api, fmt, esc, ICON, toast } from './lib.js';

const REQUIRED = ['account_id', 'timestamp', 'event_type', 'entity_type', 'user_id'];
const KEEP = [
  'PK', 'SK', 'account_id', 'timestamp', 'user_id', 'user_name', 'event_type', 'event_type_name',
  'entity_type', 'entity_type_name', 'entity_sub_type', 'entity_id', 'entity_name', 'entity_status',
  'source_table', 'transaction_id', 'node_alert_status', 'description', 'changed_fields', 'after_image',
];
const CHUNK = 1500;
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// after_image / before_image arrive double-encoded with CSV-doubled quotes. Peel until it parses.
function loose(text) {
  let t = text;
  for (let i = 0; i < 4; i++) {
    if (t && typeof t === 'object') return t;
    if (typeof t !== 'string') return null;
    try { t = JSON.parse(t); continue; } catch { /* peel */ }
    let t2 = t.trim();
    if (t2.startsWith('"') && t2.endsWith('"')) t2 = t2.slice(1, -1);
    t2 = t2.replaceAll('""', '"');
    if (t2 === t) return null;
    t = t2;
  }
  return t && typeof t === 'object' ? t : null;
}

// Owner, steward and similar records pair a user with an email, for example
// system_owner_id + system_owner_name + system_owner_email. Collect every pair so each user
// can be matched by id first, then by name.
const normName = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();

export function emailMap(data) {
  const byId = new Map(), byName = new Map();
  const vote = (map, key, em) => {
    if (!key) return;
    const m = map.get(key) || new Map(); m.set(em, (m.get(em) || 0) + 1); map.set(key, m);
  };
  const add = (id, name, em) => {
    em = String(em || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return;
    if (id !== undefined && id !== null && String(id).trim() !== '') vote(byId, String(id).trim().replace(/^'+/, ''), em);
    vote(byName, normName(name), em);
  };
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/email$/i.test(k) && typeof v === 'string') {
        const pre = k.slice(0, -5);
        const pick = (keys) => keys.map((x) => o[x]).find((x) => x !== undefined && x !== null && x !== '');
        add(pick([pre + 'id', pre + 'user_id', 'user_id', 'id']), pick([pre + 'name', pre + 'user_name', 'user_name', 'name']), v);
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  // Text fallback for payloads that do not parse as JSON: look inside the {...} around each email.
  const EM_KEY = /"*([A-Za-z_]*?)email"*\s*:\s*"*([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const scan = (t) => {
    for (const m of t.matchAll(EM_KEY)) {
      const lo = t.lastIndexOf('{', m.index), hi = t.indexOf('}', m.index);
      const seg = t.slice(lo < 0 ? 0 : lo, hi < 0 ? undefined : hi);
      const pre = m[1].replace(/[^A-Za-z_]/g, '');
      const id = seg.match(new RegExp(`"*${pre}(?:user_)?id"*\\s*:\\s*"*'?(\\d+)`)) || seg.match(/"*user_id"*\s*:\s*"*'?(\d+)/);
      const nm = seg.match(new RegExp(`"*${pre}(?:user_)?name"*\\s*:\\s*"+([^"]+)"`)) || seg.match(/"*user_name"*\s*:\s*"+([^"]+)"/);
      add(id && id[1], nm && nm[1], m[2]);
    }
  };
  for (const r of data) {
    for (const c of ['after_image', 'before_image', 'changed_fields', 'description']) {
      const s = r[c];
      if (!s || !s.includes('@')) continue;
      const o = loose(s);
      if (o) walk(o); else scan(s);
    }
  }
  const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const ids = new Map([...byId].map(([k, m]) => [k, top(m)]));
  const names = new Map([...byName].map(([k, m]) => [k, top(m)]));
  return {
    ids, names,
    lookup(userId, userName) {
      const id = String(userId || '').trim().replace(/^'+/, '');
      if (ids.has(id)) return ids.get(id);
      const n = normName(userName);
      if (names.has(n)) return names.get(n);
      return EMAIL_RE.test(String(userName || '').trim()) ? String(userName).trim().toLowerCase() : null;
    },
  };
}

const STEPS_HTML = `
  <div class="card">
    <h2>What happens on upload</h2>
    <ul class="steps" style="margin-top:var(--space-4)">
      <li class="done">${ICON.check}CSV or Excel parsed in your browser, large JSON columns dropped</li>
      <li class="done">${ICON.check}Checked that every row belongs to this customer</li>
      <li class="done">${ICON.check}Deduplicated by log key, so overlapping exports are safe</li>
      <li class="done">${ICON.check}Mirrored DQ rows and machine-speed bursts flagged</li>
      <li class="done">${ICON.check}Daily rollups rebuilt per user and day</li>
      <li class="done">${ICON.check}Baselines recalibrated, health history rescored</li>
    </ul>
    <p class="small muted" style="margin-top:var(--space-4)">Required columns: ${REQUIRED.map((c) => `<code>${c}</code>`).join(' ')}</p>
  </div>`;

function dropZone(sub) {
  return `<label class="drop" id="drop" tabindex="0">
      ${ICON.file}
      <h2>Drop a CSV or Excel file here, or browse</h2>
      <p>${sub}</p>
      <input type="file" id="file" accept="${ACCEPT}" hidden />
    </label>`;
}

function wireDrop(onFile) {
  const drop = document.getElementById('drop'), input = document.getElementById('file');
  drop.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
}

// Upload more data for an existing customer.
export async function renderUpload(view, accountId) {
  const c = (state.customers || []).find((x) => x.account_id === accountId);
  crumbs(`<a href="#/">Customers</a><span class="faint">/</span><a href="#/c/${c.account_id}">${esc(c.name)}</a><span class="faint">/</span><b>Upload</b>`);
  view.innerHTML = `
    <div class="page-head"><div><h1>Upload data for ${esc(c.name)}</h1>
      <div class="sub">Account #${c.account_id} · ${c.data_through ? `data from ${fmt.date(c.data_from)} to ${fmt.date(c.data_through)}` : 'no data yet'} · ${fmt.n(c.uploads)} upload${c.uploads == 1 ? '' : 's'}</div></div>
      <div class="actions"><a class="btn" href="#/c/${c.account_id}">${ICON.back}Back to dashboard</a></div></div>
    <div class="grid cols-2">
      <div>
        ${dropZone(`Export for ${esc(c.name)} only. New rows are added to its history, rows already stored are skipped.`)}
        <div class="card section" id="job" hidden></div>
      </div>
      ${STEPS_HTML}
    </div>
    <div class="card section">
      <div class="card-head"><div><h2>Upload history</h2><div class="sub">Files uploaded for ${esc(c.name)}</div></div></div>
      <div class="table-wrap"><table id="hist"></table></div>
    </div>`;
  wireDrop((f) => start(f, { accountId: c.account_id, name: c.name }));
  loadHistory(c.account_id);
}

// Add a new customer: name + first CSV or Excel file.
export async function renderNewCustomer(view) {
  crumbs('<a href="#/">Customers</a><span class="faint">/</span><b>Add customer</b>');
  const first = !(state.customers || []).length;
  view.innerHTML = `
    <div class="page-head"><div><h1>${first ? 'Add your first customer' : 'Add customer'}</h1>
      <div class="sub">Give the customer a name and upload its activity export. The account ID is read from the file.</div></div></div>
    <div class="grid cols-2">
      <div>
        <div class="card" style="margin-bottom:var(--space-4)">
          <div class="field" style="margin:0"><label for="cust-name">Customer name</label>
            <input id="cust-name" placeholder="For example, Brown and Caldwell" autocomplete="off" />
            <span class="hint">Leave empty to use the file name. You can rename it later in Settings.</span></div>
        </div>
        ${dropZone('One customer per file, same format as the platform activity export.')}
        <div class="card section" id="job" hidden></div>
      </div>
      ${STEPS_HTML}
    </div>`;
  wireDrop((f) => start(f, { accountId: null, name: document.getElementById('cust-name').value.trim() }));
}

async function loadHistory(accountId) {
  const rows = await api(`/api/uploads?account_id=${accountId}`);
  const el = document.getElementById('hist');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<tbody><tr><td class="muted">No uploads yet</td></tr></tbody>'; return; }
  const st = { complete: 'healthy', failed: 'at_risk', processing: 'watch', receiving: 'watch' };
  el.innerHTML = `<thead><tr><th>When</th><th>File</th><th>By</th><th>Status</th><th class="n">Rows</th><th class="n">New</th><th class="n">Already stored</th><th class="n">Rejected</th><th>Covers</th></tr></thead>
    <tbody>${rows.map((u) => `<tr><td class="nw">${fmt.time(u.created_at)}</td><td>${esc(u.filename || '–')}</td><td class="nw small">${esc(u.uploaded_by || '')}</td>
      <td><span class="badge ${st[u.status] || 'info'}">${esc(u.status)}</span></td>
      <td class="n num">${fmt.n(u.rows_received)}</td><td class="n num">${fmt.n(u.rows_inserted)}</td><td class="n num">${fmt.n(u.rows_duplicate)}</td><td class="n num">${fmt.n(u.rows_rejected)}</td>
      <td class="small nw">${u.min_ts ? `${fmt.short(u.min_ts)} to ${fmt.short(u.max_ts)}` : '–'}</td></tr>`).join('')}</tbody>`;
}

const EXCEL_EXT = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;
const ACCEPT = '.csv,text/csv,.xlsx,.xlsm,.xlsb,.xls,.ods,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    window.Papa.parse(file, {
      header: true, skipEmptyLines: true, worker: false,
      complete: (r) => resolve(r), error: reject,
    });
  });
}

let xlsxLoading;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/xlsx.full.min.js';
    sc.onload = () => resolve(window.XLSX);
    sc.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the Excel reader. Check your connection and try again.')); };
    document.head.appendChild(sc);
  });
  return xlsxLoading;
}

// Excel cells come back typed. Turn them back into the same strings the CSV export has,
// keeping long ids and epoch-ms timestamps exact and writing real date cells as ISO text.
const pad = (n, w = 2) => String(n).padStart(w, '0');
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}.${pad(v.getMilliseconds(), 3)}`;
  }
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

async function parseExcel(file) {
  const XLSX = await loadXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, dense: true });
  // Use the first sheet that has the required columns, so a cover or notes sheet does not get in the way.
  let best = null;
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    const hi = aoa.findIndex((r, i) => i < 20 && r.some((c) => String(c ?? '').trim() === 'account_id'));
    if (hi < 0) { if (!best) best = { name, aoa, hi: 0 }; continue; }
    best = { name, aoa, hi }; break;
  }
  if (!best || !best.aoa.length) throw new Error('The workbook has no rows.');
  const fields = best.aoa[best.hi].map((c) => String(c ?? '').trim());
  const data = [];
  for (const r of best.aoa.slice(best.hi + 1)) {
    const o = {}; let any = false;
    fields.forEach((f, i) => { if (!f) return; const t = cellText(r[i]); o[f] = t; if (t !== '') any = true; });
    if (any) data.push(o);
  }
  return { data, meta: { fields: fields.filter(Boolean), sheet: best.name } };
}

function parse(file) {
  return EXCEL_EXT.test(file.name || '') ? parseExcel(file) : parseCsv(file);
}

async function start(file, target) {
  const job = document.getElementById('job');
  job.hidden = false;
  const steps = [
    ['read', `Reading ${esc(file.name)} (${fmt.n(file.size / 1048576, 1)} MB)`],
    ['check', 'Checking columns and customer'], ['send', 'Uploading rows'], ['score', 'Rebuilding rollups and scores'],
  ];
  job.innerHTML = `<h2>Processing ${esc(file.name)}</h2>
    <ul class="steps" id="steps">${steps.map(([k, l]) => `<li id="st-${k}">${ICON.dotc}<span>${l}</span></li>`).join('')}</ul>
    <div class="progress"><i id="bar"></i></div><div id="result"></div>`;
  const mark = (k, cls = 'done', text) => {
    const li = document.getElementById(`st-${k}`);
    li.className = cls; li.querySelector('svg').outerHTML = cls === 'err' ? ICON.x : ICON.check;
    if (text) li.querySelector('span').textContent = text;
  };
  const stop = (html) => {
    document.getElementById('result').innerHTML = html;
    document.querySelectorAll('#steps li').forEach((li) => { if (!li.className) { li.className = 'skip'; li.querySelector('span').textContent += ' · skipped'; } });
  };
  const bar = document.getElementById('bar');
  try {
    const parsed = await parse(file);
    const cols = parsed.meta.fields || [];
    mark('read', 'done', `Read ${fmt.n(parsed.data.length)} rows${parsed.meta.sheet ? ` from sheet "${parsed.meta.sheet}"` : ''}`);
    const missing = REQUIRED.filter((c) => !cols.includes(c));
    if (missing.length) { mark('check', 'err', `Missing columns: ${missing.join(', ')}`); stop(''); return; }
    const emails = emailMap(parsed.data);
    const people = new Map();
    for (const r of parsed.data) {
      const id = String(r.user_id || '').trim().replace(/^'+/, '');
      if (!id || id === '-1' || id === '0' || String(r.user_name || '').toUpperCase() === 'SYSTEM' || people.has(id)) continue;
      people.set(id, { user_id: id, user_name: r.user_name || null, email: emails.lookup(r.user_id, r.user_name) });
    }
    const userEmails = [...people.values()];
    const rows = parsed.data.map((r) => {
      const o = {};
      for (const k of KEEP) if (r[k] !== undefined && r[k] !== '') o[k] = r[k];
      const em = emails.lookup(r.user_id, r.user_name);
      if (em) o.user_email = em;
      const isAlarm = r.entity_type === 'ALM' || r.source_table === 'saws_alarms';
      if (!isAlarm) delete o.after_image;
      if (o.changed_fields) o.changed_fields = String((o.changed_fields.match(/field_name/g) || []).length);
      return o;
    });

    // customer checks: one account per file, and it must match the selected customer
    const counts = new Map();
    for (const r of rows) { const id = String(r.account_id || '').trim(); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
    const ids = [...counts.keys()];
    const known = (id) => (state.customers || []).find((c) => String(c.account_id) === String(id));
    if (!ids.length) { mark('check', 'err', 'No account_id values found in the file'); stop(''); return; }
    if (ids.length > 1) {
      mark('check', 'err', `This file has ${ids.length} accounts. Upload one customer per file.`);
      stop(`<div class="alert err" style="margin-top:var(--space-4)">${ICON.at_risk}<div>Accounts in this file: ${ids.map((id) => `${esc(known(id)?.name || 'new')} #${esc(id)} (${fmt.n(counts.get(id))} rows)`).join(', ')}</div></div>`);
      return;
    }
    const fileAcct = ids[0];
    if (target.accountId && String(target.accountId) !== fileAcct) {
      const other = known(fileAcct);
      mark('check', 'err', `This file is for account #${fileAcct}, not ${target.name} (#${target.accountId})`);
      stop(`<div class="alert err" style="margin-top:var(--space-4)">${ICON.at_risk}<div>Nothing was uploaded.
        ${other ? `This export belongs to <b>${esc(other.name)}</b>. <a href="#/c/${other.account_id}/upload">Upload it there</a>.` : 'It belongs to a customer that is not set up yet. <a href="#/new">Add it as a new customer</a>.'}</div></div>`);
      return;
    }
    if (!target.accountId) {
      const existing = known(fileAcct);
      if (existing) {
        mark('check', 'err', `Account #${fileAcct} is already set up as ${existing.name}`);
        stop(`<div class="alert info" style="margin-top:var(--space-4)">${ICON.info}<div>Nothing was uploaded yet. This export belongs to an existing customer.</div></div>
          <div style="display:flex;gap:var(--space-2);margin-top:var(--space-4);flex-wrap:wrap">
            <button class="btn primary" id="add-existing">Add to ${esc(existing.name)}</button>
            <a class="btn" href="#/c/${existing.account_id}">Open ${esc(existing.name)}</a></div>`);
        document.getElementById('add-existing').onclick = () => {
          location.hash = `#/c/${existing.account_id}/upload`;
          setTimeout(() => start(file, { accountId: existing.account_id, name: existing.name }), 150);
        };
        return;
      }
    }
    mark('check', 'done', target.accountId ? `Columns OK · all rows belong to ${target.name}` : `Columns OK · new customer, account #${fileAcct}`);

    const up = await api('/api/uploads', { json: target.accountId
      ? { filename: file.name, account_id: target.accountId }
      : { filename: file.name, customer_name: target.name || null } });
    const tot = { inserted: 0, duplicates: 0, rejected: 0, errors: [] };
    for (let i = 0; i < rows.length; i += CHUNK) {
      const r = await api(`/api/uploads/${up.upload_id}/rows`, { json: { rows: rows.slice(i, i + CHUNK), user_emails: i === 0 ? userEmails.filter((u) => u.email) : [] } });
      tot.inserted += r.inserted; tot.duplicates += r.duplicates; tot.rejected += r.rejected; tot.errors.push(...r.errors);
      bar.style.width = `${Math.min(85, ((i + CHUNK) / rows.length) * 85)}%`;
    }
    mark('send', 'done', `Uploaded ${fmt.n(rows.length)} rows`);
    const done = await api(`/api/uploads/${up.upload_id}/complete`, { json: {} });
    bar.style.width = '100%';
    await refreshShell();
    const cust = known(fileAcct);
    mark('score', 'done', `Scored ${cust?.name || 'customer'} through ${fmt.date(cust?.data_through)}`);
    stop(`
      <div class="stat-row">
        <div><b>${fmt.n(tot.inserted)}</b><span>New events</span></div>
        <div><b>${fmt.n(tot.duplicates)}</b><span>Already stored</span></div>
        <div><b>${fmt.n(tot.rejected)}</b><span>Rejected</span></div>
        <div><b>${done.upload.min_ts ? `${fmt.short(done.upload.min_ts)} to ${fmt.short(done.upload.max_ts)}` : '–'}</b><span>Date range</span></div>
      </div>
      <div class="small" style="margin-top:var(--space-4)"><b>Emails matched: ${userEmails.filter((u) => u.email).length} of ${userEmails.length} users</b>
        ${userEmails.length ? `<div class="faint">${userEmails.map((u) => `${esc(u.user_name || u.user_id)}: ${u.email ? esc(u.email) : 'not found in this file'}`).join('<br>')}</div>` : ''}</div>
      ${tot.errors.length ? `<div class="alert err" style="margin-top:var(--space-4)">${ICON.at_risk}<div>${tot.errors.map(esc).join('<br>')}</div></div>` : ''}
      <div style="display:flex;gap:var(--space-2);margin-top:var(--space-5);flex-wrap:wrap">
        <a class="btn primary" href="#/c/${fileAcct}">Open ${esc(cust?.name || 'dashboard')}</a>
        <a class="btn" href="#/">All customers</a>
      </div>`);
    toast('Upload complete');
    if (target.accountId) loadHistory(target.accountId);
  } catch (e) {
    console.error(e);
    const open = [...document.querySelectorAll('#steps li')].find((li) => !li.className);
    if (open) { open.className = 'err'; open.querySelector('span').textContent += ` · ${e.message}`; }
    toast('Upload failed');
  }
}

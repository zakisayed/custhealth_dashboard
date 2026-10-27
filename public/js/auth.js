// Sign in, first-login password change, profile settings and user management (admin).
import { api, setSession, setCurrentUser, currentUser, esc, ICON, toast } from './lib.js';
import { crumbs } from './app.js';

const TEMP = 'ChangeMe';
const BRAND = `<div class="auth-brand">
  <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="M7 18h5l3-7 3 12 3-5h4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <div><b>Customer Health</b><span>Usage engine</span></div></div>`;

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// password rules, mirrored from the backend (app/auth.py)
const RULES = [
  { id: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'mix', label: 'Letters and a number or symbol', test: (p) => /[A-Za-z]/.test(p) && /[^A-Za-z]/.test(p) },
  { id: 'temp', label: 'Not the temporary password', test: (p) => p.length > 0 && p.toLowerCase() !== 'changeme' },
];

function pwInput(id, label, autocomplete, extra = '') {
  return `<div class="field">
    <label for="${id}">${label}</label>
    <div class="pw-wrap">
      <input id="${id}" type="password" autocomplete="${autocomplete}" required ${extra} />
      <button type="button" class="pw-toggle" data-for="${id}" aria-label="Show password" title="Show password">${ICON.eye}</button>
    </div>
  </div>`;
}

function wireToggles(root) {
  root.querySelectorAll('.pw-toggle').forEach((b) => b.addEventListener('click', () => {
    const inp = root.querySelector(`#${b.dataset.for}`);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.classList.toggle('on', show);
  }));
}

// Shared new-password form. Returns nothing; calls onDone(user) after success.
function passwordForm(root, { askCurrent, currentValue, submitLabel, onDone }) {
  root.innerHTML = `
    <form class="stack" id="pw-form" novalidate>
      ${askCurrent ? pwInput('pw-cur', currentValue === undefined ? 'Current password' : 'Temporary password', 'current-password') : ''}
      ${pwInput('pw-new', 'New password', 'new-password')}
      <ul class="pw-rules" id="pw-rules">${RULES.map((r) => `<li data-rule="${r.id}">${ICON.healthy}<span>${r.label}</span></li>`).join('')}
        <li data-rule="match">${ICON.healthy}<span>Both entries match</span></li></ul>
      ${pwInput('pw-confirm', 'Confirm new password', 'new-password')}
      <div class="alert err" id="pw-err" hidden></div>
      <button class="btn primary block" id="pw-submit" disabled>${submitLabel}</button>
    </form>`;
  wireToggles(root);
  const nw = root.querySelector('#pw-new'), cf = root.querySelector('#pw-confirm'), cur = root.querySelector('#pw-cur');
  const btn = root.querySelector('#pw-submit'), err = root.querySelector('#pw-err');
  const check = () => {
    const p = nw.value;
    let ok = true;
    for (const r of RULES) {
      const pass = r.test(p);
      ok = ok && pass;
      root.querySelector(`[data-rule="${r.id}"]`).classList.toggle('ok', pass);
    }
    const match = p.length > 0 && p === cf.value;
    root.querySelector('[data-rule="match"]').classList.toggle('ok', match);
    btn.disabled = !(ok && match && (!cur || cur.value.length > 0));
  };
  [nw, cf, cur].forEach((el) => el && el.addEventListener('input', check));
  root.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    err.hidden = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Saving...';
    try {
      const r = await api('/api/auth/change-password', { json: { current_password: cur ? cur.value : currentValue, new_password: nw.value } });
      setSession(r.token, r.user);
      onDone(r.user);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.textContent = label; check();
    }
  });
  (cur || nw).focus();
}

// ----------------------------------------------------------------------------- full-screen views
export function renderLogin(screen, { message, onSignedIn }) {
  screen.innerHTML = `<div class="auth-card card">
    ${BRAND}
    <h1>Sign in</h1>
    <p class="muted small">Use the email and password your admin gave you.</p>
    ${message ? `<div class="alert info">${esc(message)}</div>` : ''}
    <form class="stack" id="login-form" novalidate>
      <div class="field"><label for="login-email">Email</label>
        <input id="login-email" type="email" autocomplete="username" inputmode="email" required /></div>
      ${pwInput('login-pw', 'Password', 'current-password')}
      <div class="alert err" id="login-err" hidden></div>
      <button class="btn primary block" id="login-btn">Sign in</button>
    </form>
    <p class="muted small auth-foot">Forgot your password? Ask your admin to reset it.</p>
  </div>`;
  wireToggles(screen);
  const email = screen.querySelector('#login-email'), pw = screen.querySelector('#login-pw');
  const err = screen.querySelector('#login-err'), btn = screen.querySelector('#login-btn');
  email.focus();
  screen.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!email.value.trim() || !pw.value) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Signing in...';
    try {
      const r = await api('/api/auth/login', { json: { email: email.value.trim(), password: pw.value } });
      setSession(r.token, r.user);
      onSignedIn(r.user, pw.value);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Sign in';
      pw.select();
    }
  });
}

export function renderSetPassword(screen, { user, tempPassword, onDone, onSignOut }) {
  screen.innerHTML = `<div class="auth-card card">
    ${BRAND}
    <h1>Create a new password</h1>
    <p class="muted small">You signed in with a temporary password. Choose your own password to continue as <b>${esc(user.email)}</b>.</p>
    <div id="pw-slot"></div>
    <p class="small auth-foot"><a href="#" id="pw-signout">Sign out</a></p>
  </div>`;
  passwordForm(screen.querySelector('#pw-slot'), {
    askCurrent: !tempPassword, currentValue: tempPassword || null, submitLabel: 'Save and continue', onDone,
  });
  screen.querySelector('#pw-signout').addEventListener('click', (e) => { e.preventDefault(); onSignOut(); });
}

// ----------------------------------------------------------------------------- profile
export async function renderProfile(view) {
  const u = await api('/api/auth/me');
  setCurrentUser(u);
  crumbs('<b>Profile settings</b>');
  view.innerHTML = `
    <div class="page-head"><div><h1>Profile settings</h1><p class="muted">Your sign-in details.</p></div></div>
    <div class="grid-2 profile-grid">
      <section class="card">
        <div class="card-head"><h2>Account</h2></div>
        <dl class="kv">
          <dt>Email</dt><dd>${esc(u.email)}</dd>
          <dt>Role</dt><dd><span class="badge ${u.role === 'admin' ? 'info' : 'calibrated'}">${u.role === 'admin' ? 'Admin' : 'User'}</span></dd>
          <dt>Password last changed</dt><dd>${u.password_changed_at ? esc(when(u.password_changed_at)) : 'Never'}</dd>
          <dt>Last sign in</dt><dd>${u.last_login_at ? esc(when(u.last_login_at)) : ''}</dd>
        </dl>
        <p class="muted small">${u.role === 'admin' ? 'You can add and remove users on the <a href="#/users">Users</a> page.' : 'You can view every customer dashboard and upload CSV files. Ask your admin for other changes.'}</p>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Change password</h2><div class="sub">Changing it signs you out on other devices.</div></div></div>
        <div id="pw-slot"></div>
      </section>
    </div>`;
  passwordForm(view.querySelector('#pw-slot'), {
    askCurrent: true, submitLabel: 'Update password',
    onDone: () => { toast('Password updated'); renderProfile(view); },
  });
}

// ----------------------------------------------------------------------------- users (admin)
export async function renderUsers(view) {
  crumbs('<b>Users</b>');
  if (currentUser && currentUser.role !== 'admin') {
    view.innerHTML = '<div class="card"><h2>Admins only</h2><p class="muted">Ask your admin to add or remove users.</p></div>';
    return;
  }
  const users = await api('/api/users');
  const me = currentUser?.user_id;
  view.innerHTML = `
    <div class="page-head"><div><h1>Users</h1><p class="muted">People who can sign in, view every customer dashboard and upload CSV files.</p></div></div>
    <section class="card">
      <div class="card-head"><div><h2>Add user</h2><div class="sub">They sign in with the temporary password and must create their own right away.</div></div></div>
      <form class="add-user" id="add-user" novalidate>
        <div class="field"><label for="nu-email">Email</label><input id="nu-email" type="email" autocomplete="off" placeholder="name@company.com" required /></div>
        <div class="field"><label for="nu-pw">Temporary password</label><input id="nu-pw" type="text" autocomplete="off" value="${TEMP}" required /></div>
        <button class="btn primary" id="nu-btn">${ICON.plus}Add user</button>
      </form>
      <div class="alert err" id="nu-err" hidden></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>All users <span class="muted">(${users.length})</span></h2></div>
      <div class="table-wrap"><table class="tbl users-tbl">
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last sign in</th><th>Added</th><th class="n">Actions</th></tr></thead>
        <tbody>${users.map((u) => `<tr data-id="${u.user_id}" data-email="${esc(u.email)}">
          <td class="nw"><b>${esc(u.email)}</b>${u.user_id === me ? ' <span class="muted small">(you)</span>' : ''}</td>
          <td><span class="badge ${u.role === 'admin' ? 'info' : 'calibrated'}">${u.role === 'admin' ? 'Admin' : 'User'}</span></td>
          <td>${u.must_change_password ? '<span class="badge watch">Must set password</span>' : '<span class="badge healthy">Active</span>'}</td>
          <td class="nw small">${u.last_login_at ? esc(when(u.last_login_at)) : '<span class="muted">Never</span>'}</td>
          <td class="nw small">${esc(when(u.created_at))}${u.created_by && u.created_by !== 'system' ? `<div class="muted">by ${esc(u.created_by)}</div>` : ''}</td>
          <td class="n nw">${u.user_id === me ? '<span class="muted small">Use Profile settings</span>' : `
            <button class="btn sm" data-act="reset">${ICON.key}Reset password</button>
            ${u.is_primary_admin ? '' : `<button class="btn sm danger" data-act="delete">${ICON.trash}Delete</button>`}`}
          </td></tr>`).join('')}</tbody>
      </table></div>
    </section>`;

  const form = view.querySelector('#add-user'), err = view.querySelector('#nu-err'), btn = view.querySelector('#nu-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const email = view.querySelector('#nu-email').value.trim();
    const pw = view.querySelector('#nu-pw').value.trim() || TEMP;
    if (!email) { err.textContent = 'Enter the user\'s email.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      const u = await api('/api/users', { json: { email, temp_password: pw } });
      toast(`${u.email} added. Temporary password: ${pw}`, 5000);
      renderUsers(view);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false;
    }
  });

  view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    const id = +tr.dataset.id, email = tr.dataset.email;
    if (b.dataset.act === 'delete') confirmDialog({
      title: `Delete ${email}?`,
      body: 'They are signed out right away and can no longer sign in. Customer data and uploads are kept.',
      confirm: 'Delete user', danger: true,
      run: async () => { await api(`/api/users/${id}`, { method: 'DELETE' }); toast(`${email} deleted`); renderUsers(view); },
    });
    else confirmDialog({
      title: `Reset password for ${email}?`,
      body: 'They are signed out and must create a new password the next time they sign in.',
      input: { label: 'Temporary password', value: TEMP },
      confirm: 'Reset password',
      run: async (val) => { await api(`/api/users/${id}/reset-password`, { json: { temp_password: val || TEMP } }); toast(`Password reset. Temporary password: ${val || TEMP}`, 5000); renderUsers(view); },
    });
  }));
}

function confirmDialog({ title, body, input, confirm, danger, run }) {
  const d = document.createElement('div');
  d.className = 'modal-bg';
  d.innerHTML = `<div class="modal card" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <h2 id="m-title">${esc(title)}</h2>
    <p class="muted small">${esc(body)}</p>
    ${input ? `<div class="field"><label for="m-input">${esc(input.label)}</label><input id="m-input" type="text" value="${esc(input.value)}" autocomplete="off" /></div>` : ''}
    <div class="alert err" id="m-err" hidden></div>
    <div class="modal-actions"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="m-ok">${esc(confirm)}</button></div>
  </div>`;
  document.body.appendChild(d);
  const close = () => { d.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  d.addEventListener('click', (e) => { if (e.target === d || e.target.hasAttribute('data-x')) close(); });
  const ok = d.querySelector('#m-ok');
  (d.querySelector('#m-input') || ok).focus();
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { await run(d.querySelector('#m-input')?.value.trim()); close(); }
    catch (ex) { const er = d.querySelector('#m-err'); er.textContent = ex.message; er.hidden = false; ok.disabled = false; }
  });
}

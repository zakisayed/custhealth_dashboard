import { api, AuthError, PasswordChangeError, setSession, setCurrentUser, currentUser, hasToken, esc, fmt, ICON, destroyCharts, chartDefaults } from './lib.js';
import { renderLogin, renderSetPassword, renderProfile, renderUsers } from './auth.js';
import { renderPortfolio } from './portfolio.js';
import { renderAccount } from './account.js';
import { renderUpload, renderNewCustomer } from './upload.js';
import { renderModel } from './model.js';

const view = document.getElementById('view');
export const state = { status: null, portfolio: null, customers: null };

export async function refreshShell() {
  const [status, portfolio, customers] = await Promise.all([api('/api/status'), api('/api/portfolio'), api('/api/customers')]);
  state.status = status;
  state.portfolio = portfolio;
  state.customers = customers;
  renderNav();
}

// Remember the last opened customer so the app reopens on it.
const LAST = 'lastCustomer';
export function rememberCustomer(id) {
  try { document.cookie = `${LAST}=${id}; path=/; max-age=31536000; SameSite=Lax`; } catch { /* ignore */ }
}
function lastCustomer() {
  try { return +(document.cookie.match(/(?:^|; )lastCustomer=(\d+)/) || [])[1] || null; } catch { return null; }
}

// Parse the hash into { page, id }.
export function currentRoute() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'c' && parts[1]) return { page: parts[2] === 'upload' ? 'upload' : 'dashboard', id: +parts[1] };
  if (parts[0] === 'account' && parts[1]) return { page: 'dashboard', id: +parts[1] }; // old links
  if (parts[0] === 'new') return { page: 'new' };
  if (parts[0] === 'upload') return { page: 'new' };
  if (parts[0] === 'model') return { page: 'model' };
  if (parts[0] === 'profile') return { page: 'profile' };
  if (parts[0] === 'users') return { page: 'users' };
  return { page: 'overview' };
}

let customerFilter = '';
function renderNav() {
  const r = currentRoute();
  const list = state.customers || [];
  const link = (href, icon, label, active) => `<a href="${href}" class="${active ? 'active' : ''}">${icon}${label}</a>`;
  const shown = list.filter((c) => !customerFilter || c.name.toLowerCase().includes(customerFilter.toLowerCase()) || String(c.account_id).includes(customerFilter));
  const stale = (c) => c.stale_days != null && c.stale_days > 14;
  document.getElementById('nav').innerHTML = `
    ${link('#/', ICON.grid, 'All customers', r.page === 'overview')}
    ${link('#/model', ICON.model, 'Scoring model', r.page === 'model')}
    ${currentUser?.role === 'admin' ? link('#/users', ICON.users, 'Users', r.page === 'users') : ''}
    <div class="nav-label nav-label-row"><span>Customers${list.length ? ` (${list.length})` : ''}</span>
      <a href="#/new" class="icon-link" title="Add customer" aria-label="Add customer">${ICON.plus}</a></div>
    ${list.length > 5 ? `<input class="nav-search" id="nav-search" type="search" placeholder="Find customer" value="${esc(customerFilter)}" aria-label="Find customer" />` : ''}
    <div class="cust-list" id="cust-list">
      ${shown.map((c) => {
        const active = r.id === c.account_id;
        return `<div class="cust ${active ? 'open' : ''}">
          <a href="#/c/${c.account_id}" class="acct-link ${active && r.page === 'dashboard' ? 'active' : ''}" title="${esc(c.name)} · account ${c.account_id}">
            <span class="cust-name">${esc(c.name)}</span>
            ${c.status ? `<span class="cust-score num">${fmt.n(c.score)}</span><i class="dot ${c.status}" aria-label="${c.status}"></i>` : '<i class="dot" aria-label="no score"></i>'}
          </a>
          ${active ? `<div class="cust-sub">
            <a href="#/c/${c.account_id}" class="${r.page === 'dashboard' ? 'active' : ''}">Dashboard</a>
            <a href="#/c/${c.account_id}/upload" class="${r.page === 'upload' ? 'active' : ''}">Upload data</a>
            ${stale(c) ? `<span class="cust-warn">Data is ${c.stale_days} days old</span>` : ''}
          </div>` : ''}
        </div>`;
      }).join('') || (list.length ? '<div class="nav-empty">No match</div>' : '<div class="nav-empty">No customers yet</div>')}
    </div>
    <a href="#/new" class="btn add-cust ${r.page === 'new' ? 'active' : ''}">${ICON.plus}Add customer</a>`;
  const search = document.getElementById('nav-search');
  if (search) {
    search.addEventListener('input', () => {
      customerFilter = search.value;
      const pos = search.selectionStart;
      renderNav();
      const s2 = document.getElementById('nav-search'); s2.focus(); s2.setSelectionRange(pos, pos);
    });
  }
  const s = state.status;
  const u = currentUser;
  document.getElementById('sidebar-foot').innerHTML = (s
    ? `<div class="foot-stats">${fmt.n(list.length)} customer${list.length == 1 ? '' : 's'} · ${fmt.n(s.events)} events<br>${fmt.n(s.uploads)} upload${s.uploads == 1 ? '' : 's'} processed</div>`
    : '') + (u ? `<div class="user-box">
      <span class="avatar" aria-hidden="true">${esc(u.email.slice(0, 2))}</span>
      <a class="who" href="#/profile" title="Profile settings"><b>${esc(u.email)}</b><span>${u.role === 'admin' ? 'Admin' : 'User'}</span></a>
      <button class="icon-btn" id="sign-out" title="Sign out" aria-label="Sign out">${ICON.logout}</button>
    </div>` : '');
  document.getElementById('sign-out')?.addEventListener('click', signOut);

  // top bar: context-aware primary action and data date
  const cur = r.id ? list.find((c) => c.account_id === r.id) : null;
  const cta = document.getElementById('upload-cta');
  if (cur) {
    cta.href = `#/c/${cur.account_id}/upload`;
    cta.innerHTML = `${ICON.upload}<span>Upload data</span>`;
    cta.hidden = r.page === 'upload';
  } else {
    cta.href = '#/new';
    cta.innerHTML = `${ICON.plus}<span>Add customer</span>`;
    cta.hidden = r.page === 'new';
  }
  document.getElementById('through').textContent = cur?.data_through ? `${cur.name} data through ${fmt.date(cur.data_through)}` : '';
}

export function crumbs(html) {
  document.getElementById('crumbs').innerHTML = html;
}

const authScreen = document.getElementById('auth-screen');
let tempPassword = null;   // kept in memory only, to skip retyping it on the forced change screen

function showApp() {
  document.body.classList.remove('signed-out');
  authScreen.hidden = true;
  authScreen.innerHTML = '';
}

function showLogin(message) {
  destroyCharts();
  state.status = null;
  setCurrentUser(null);
  document.body.classList.add('signed-out');
  authScreen.hidden = false;
  document.title = 'Sign in · Customer Health Console';
  renderLogin(authScreen, {
    message,
    onSignedIn: (user, pw) => {
      tempPassword = user.must_change_password ? pw : null;
      route();
    },
  });
}

function showSetPassword(user) {
  document.body.classList.add('signed-out');
  authScreen.hidden = false;
  document.title = 'Create a new password · Customer Health Console';
  renderSetPassword(authScreen, {
    user, tempPassword,
    onDone: () => { tempPassword = null; route(); },
    onSignOut: signOut,
  });
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* stateless */ }
  setSession(null);
  tempPassword = null;
  if (location.hash && location.hash !== '#/') history.replaceState(null, '', location.pathname + location.search);
  showLogin('You are signed out.');
}

function showError(e) {
  let hint;
  if (e.status === 404 && (e.message === 'Not Found' || !e.message)) {
    hint = `The API has no route for <code>${esc(e.path || '')}</code>. The backend is either an older version than this page (redeploy the whole project, not only <code>public/</code>), or Vercel is not routing <code>/api/*</code> to <code>api/index.py</code> (check that <code>vercel.json</code> is in the project root).`;
  } else if (e.status === 503 || /database/i.test(e.message)) {
    hint = 'Check that <code>DATABASE_URL</code> points to your Supabase pooler connection string (port 6543) and that the password is URL-encoded.';
  } else if (!e.status) {
    hint = 'The API could not be reached. Check that the backend is running and that the page and API are on the same domain.';
  } else {
    hint = 'Check the function logs on Vercel for the full error.';
  }
  view.innerHTML = `<div class="card"><div class="alert err">${ICON.at_risk}<div><b>Could not load data.</b><br>${esc(e.message)}${e.path ? ` <span class="muted">(${esc(e.path)})</span>` : ''}</div></div>
    <p class="muted small" style="margin-top:var(--space-4)">${hint}</p></div>`;
}

export async function route() {
  destroyCharts();
  chartDefaults();
  document.getElementById('sidebar').classList.remove('open');
  try {
    if (!hasToken()) { showLogin(); return; }
    if (!currentUser) setCurrentUser(await api('/api/auth/me'));
    if (currentUser.must_change_password) { showSetPassword(currentUser); return; }
    showApp();
    document.title = 'Customer Health Console';
    if (!state.status) await refreshShell();
    // first open: go to the last customer, or to onboarding when there are none
    if (!location.hash || location.hash === '#') {
      const last = lastCustomer();
      const list = state.customers || [];
      if (!list.length) { location.replace('#/new'); return; }
      if (last && list.some((c) => c.account_id === last)) { location.replace(`#/c/${last}`); return; }
      if (list.length === 1) { location.replace(`#/c/${list[0].account_id}`); return; }
    }
    renderNav();
    view.scrollTop = 0;
    window.scrollTo(0, 0);
    const r = currentRoute();
    if (r.id && !(state.customers || []).some((c) => c.account_id === r.id)) {
      view.innerHTML = `<div class="card"><h2>Customer not found</h2><p class="muted">It may have been removed. <a href="#/">See all customers</a>.</p></div>`;
      crumbs('<b>Not found</b>');
      return;
    }
    if (r.id) rememberCustomer(r.id);
    if (r.page === 'dashboard') await renderAccount(view, r.id);
    else if (r.page === 'upload') await renderUpload(view, r.id);
    else if (r.page === 'new') await renderNewCustomer(view);
    else if (r.page === 'model') await renderModel(view);
    else if (r.page === 'profile') await renderProfile(view);
    else if (r.page === 'users') await renderUsers(view);
    else await renderPortfolio(view);
  } catch (e) {
    console.error(e);
    if (e instanceof AuthError) showLogin(e.message);
    else if (e instanceof PasswordChangeError) { setCurrentUser(null); route(); }
    else showError(e);
  }
}

function closeDrawer() {
  document.getElementById('drawer')?.classList.remove('open');
  document.getElementById('drawer-bg')?.classList.remove('open');
  document.getElementById('drawer')?.setAttribute('aria-hidden', 'true');
}
window.addEventListener('hashchange', () => { closeDrawer(); route(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
document.getElementById('menu-btn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

function boot() {
  if (!window.Chart) return setTimeout(boot, 30);
  route();
}
boot();

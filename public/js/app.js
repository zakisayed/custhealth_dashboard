import { api, AuthError, setKey, esc, fmt, ICON, destroyCharts, chartDefaults } from './lib.js';
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
  document.getElementById('sidebar-foot').innerHTML = s
    ? `${fmt.n(list.length)} customer${list.length == 1 ? '' : 's'} · ${fmt.n(s.events)} events<br>${fmt.n(s.uploads)} upload${s.uploads == 1 ? '' : 's'} processed`
    : '';

  // top bar: context-aware primary action and data date
  const cur = r.id ? list.find((c) => c.account_id === r.id) : null;
  const cta = document.getElementById('upload-cta');
  if (cur) {
    cta.href = `#/c/${cur.account_id}/upload`;
    cta.innerHTML = `${ICON.upload}<span>Upload CSV</span>`;
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

function askKey(message) {
  crumbs('<b>Sign in</b>');
  view.innerHTML = `
    <div class="card" style="max-width:420px;margin:var(--space-12) auto">
      <h2>Enter dashboard key</h2>
      <p class="muted small">${esc(message || 'This dashboard is protected.')}</p>
      <form id="key-form" class="field" style="margin-top:var(--space-4)">
        <label for="key">Key</label>
        <input id="key" type="password" autocomplete="current-password" required />
        <button class="btn primary" style="margin-top:var(--space-3);justify-content:center">Continue</button>
      </form>
    </div>`;
  document.getElementById('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    setKey(document.getElementById('key').value.trim());
    route();
  });
}

function showError(e) {
  view.innerHTML = `<div class="card"><div class="alert err">${ICON.at_risk}<div><b>Could not load data.</b><br>${esc(e.message)}</div></div>
    <p class="muted small" style="margin-top:var(--space-4)">Check that <code>DATABASE_URL</code> points to your Supabase pooler connection string.</p></div>`;
}

export async function route() {
  destroyCharts();
  chartDefaults();
  document.getElementById('sidebar').classList.remove('open');
  try {
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
    else await renderPortfolio(view);
  } catch (e) {
    console.error(e);
    if (e instanceof AuthError) askKey();
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

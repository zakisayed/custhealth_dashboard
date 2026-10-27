import { api, AuthError, setKey, esc, fmt, ICON, destroyCharts, chartDefaults } from './lib.js';
import { renderPortfolio } from './portfolio.js';
import { renderAccount } from './account.js';
import { renderUpload } from './upload.js';
import { renderModel } from './model.js';

const view = document.getElementById('view');
export const state = { status: null, portfolio: null };

export async function refreshShell() {
  try {
    const [status, portfolio] = await Promise.all([api('/api/status'), api('/api/portfolio')]);
    state.status = status;
    state.portfolio = portfolio;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    state.status = null;
    state.portfolio = null;
    throw e;
  }
  renderNav();
}

function renderNav() {
  const route = location.hash || '#/';
  const accts = state.portfolio?.accounts || [];
  const link = (href, icon, label, extra = '') =>
    `<a href="${href}" class="${route === href || (href !== '#/' && route.startsWith(href)) ? 'active' : ''} ${extra}">${icon}${label}</a>`;
  document.getElementById('nav').innerHTML = `
    ${link('#/', ICON.grid, 'Portfolio')}
    ${link('#/upload', ICON.upload, 'Upload data')}
    ${link('#/model', ICON.model, 'Scoring model')}
    ${accts.length ? `<div class="nav-label">Accounts</div>` : ''}
    ${[...accts].sort((a, b) => a.name.localeCompare(b.name)).map((a) =>
      `<a href="#/account/${a.account_id}" class="acct-link ${route === `#/account/${a.account_id}` ? 'active' : ''}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span><i class="dot ${a.status}" aria-label="${a.status}"></i></a>`).join('')}`;
  const s = state.status;
  document.getElementById('sidebar-foot').innerHTML = s
    ? `${fmt.n(s.events)} events stored<br>${fmt.n(s.uploads)} upload${s.uploads == 1 ? '' : 's'} processed`
    : '';
  document.getElementById('through').textContent = s?.data_through ? `Data through ${fmt.date(s.data_through)}` : '';
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
  const hash = location.hash || '#/';
  try {
    if (!state.status) await refreshShell();
    else renderNav();
    view.scrollTop = 0;
    window.scrollTo(0, 0);
    if (hash.startsWith('#/account/')) await renderAccount(view, +hash.split('/')[2]);
    else if (hash.startsWith('#/upload')) await renderUpload(view);
    else if (hash.startsWith('#/model')) await renderModel(view);
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

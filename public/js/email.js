// Email matching shared by the upload page and the background Excel reader.
// Owner, steward and similar records pair a user with an email, for example
// system_owner_id + system_owner_name + system_owner_email. Collect every pair so each user
// can be matched by id first, then by name.

export const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const normName = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();

// after_image / before_image arrive double-encoded with CSV-doubled quotes. Peel until it parses.
export function loose(text) {
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

const EM_KEY = /"*([A-Za-z_]*?)email"*\s*:\s*"*([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function emailCollector() {
  const byId = new Map(), byName = new Map();
  const vote = (map, key, em, n = 1) => {
    if (!key) return;
    const m = map.get(key) || new Map(); m.set(em, (m.get(em) || 0) + n); map.set(key, m);
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
  // Text fallback for payloads that do not parse as JSON (for example cut at Excel's 32,767-character
  // cell limit): look inside the {...} around each email.
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
  return {
    addText(s) {
      if (!s || typeof s !== 'string' || !s.includes('@')) return;
      const o = s.length < 32000 ? loose(s) : null;
      if (o) walk(o); else scan(s);
    },
    // Plain, cloneable votes so a worker can hand them to the page.
    votes() {
      const plain = (m) => [...m].map(([k, v]) => [k, [...v]]);
      return { byId: plain(byId), byName: plain(byName) };
    },
    merge(v) {
      for (const [k, list] of v.byId || []) for (const [em, n] of list) vote(byId, k, em, n);
      for (const [k, list] of v.byName || []) for (const [em, n] of list) vote(byName, k, em, n);
    },
    result() { return emailLookup({ byId: this.votes().byId, byName: this.votes().byName }); },
  };
}

export function emailLookup(v) {
  const top = (list) => [...list].sort((x, y) => y[1] - x[1])[0][0];
  const ids = new Map((v.byId || []).map(([k, list]) => [k, top(list)]));
  const names = new Map((v.byName || []).map(([k, list]) => [k, top(list)]));
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

export function emailMap(data, extraVotes) {
  const c = emailCollector();
  for (const r of data) for (const k of ['after_image', 'before_image', 'changed_fields', 'description']) c.addText(r[k]);
  if (extraVotes) c.merge(extraVotes);
  return c.result();
}

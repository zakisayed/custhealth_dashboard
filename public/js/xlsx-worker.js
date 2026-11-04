// Streaming .xlsx / .xlsm reader for very large activity exports.
//
// A full in-memory reader has to hold the whole shared-strings table as one string. Exports with
// big JSON columns (after_image, before_image) can expand to close to 1 GB of text, which is past
// what a browser string can hold, so the reader silently returns nothing. This worker reads the
// zip entries in slices, inflates them as a stream and parses the XML incrementally. Big JSON cells
// are reduced on the fly to the email pairs they contain, so memory stays small.
import { Inflate } from '../vendor/fflate.mjs';
import { emailCollector } from './email.js';

// Columns whose full text the upload needs. Anything else is dropped while reading.
const KEEP = new Set([
  'PK', 'SK', 'account_id', 'timestamp', 'user_id', 'user_name', 'event_type', 'event_type_name',
  'entity_type', 'entity_type_name', 'entity_sub_type', 'entity_id', 'entity_name', 'entity_status',
  'source_table', 'transaction_id', 'node_alert_status', 'description', 'changed_fields', 'after_image',
]);
const IMAGE_COLS = new Set(['after_image', 'before_image']);
const IMAGE_KEEP_MAX = 20000; // only alarm after_image values are kept whole (they hold severity and status)

let file, progressTotal = 0, progressDone = 0, lastPost = 0;
const progress = (stage, force) => {
  const now = Date.now();
  if (!force && now - lastPost < 200) return;
  lastPost = now;
  postMessage({ type: 'progress', stage, pct: progressTotal ? Math.min(99, Math.round((progressDone / progressTotal) * 100)) : 0 });
};

// ---------- zip
async function bytes(start, end) { return new Uint8Array(await file.slice(start, end).arrayBuffer()); }
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

async function listEntries() {
  const tailLen = Math.min(file.size, 66000);
  const tail = await bytes(file.size - tailLen, file.size);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('This file is not a valid .xlsx workbook.');
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = e - 20; // zip64 end of central directory locator
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z64 = await bytes(u64(tail, loc + 8), u64(tail, loc + 8) + 56);
      count = u64(z64, 32); cdSize = u64(z64, 40); cdOff = u64(z64, 48);
    }
  }
  const cd = await bytes(cdOff, cdOff + cdSize);
  const out = new Map();
  const dec = new TextDecoder();
  for (let p = 0, i = 0; i < count && p < cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24);
    const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
    let off = u32(cd, p + 42);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    // zip64 extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = u16(cd, x), sz = u16(cd, x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (off === 0xffffffff) { off = u64(cd, q); }
      }
      x += 4 + sz;
    }
    out.set(name.replace(/^\/+/, ''), { name, method, csize, usize, off });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// Stream one entry's text to onText(chunk). Reads 8 MB slices so memory stays flat.
async function streamEntry(ent, onText) {
  const lh = await bytes(ent.off, ent.off + 30);
  if (u32(lh, 0) !== 0x04034b50) throw new Error(`Damaged workbook entry ${ent.name}`);
  const start = ent.off + 30 + u16(lh, 26) + u16(lh, 28);
  const dec = new TextDecoder('utf-8');
  const SLICE = 8 * 1024 * 1024;
  if (ent.method === 0) {
    for (let p = 0; p < ent.csize; p += SLICE) {
      const b = await bytes(start + p, start + Math.min(ent.csize, p + SLICE));
      progressDone += b.length;
      onText(dec.decode(b, { stream: true }));
    }
    onText(dec.decode());
    return;
  }
  if (ent.method !== 8) throw new Error(`Unsupported compression in ${ent.name}`);
  const inf = new Inflate((chunk) => onText(dec.decode(chunk, { stream: true })));
  for (let p = 0; p < ent.csize; p += SLICE) {
    const end = Math.min(ent.csize, p + SLICE);
    const b = await bytes(start + p, start + end);
    progressDone += b.length;
    inf.push(b, end >= ent.csize);
  }
  onText(dec.decode());
}

async function readText(entries, path) {
  const ent = entries.get(path);
  if (!ent) return null;
  let s = '';
  await streamEntry(ent, (t) => { s += t; });
  return s;
}

// Split a text stream into complete elements that end with closeTag.
function splitter(closeTag, onItem) {
  let buf = '';
  return (t) => {
    buf += t;
    let from = 0, i;
    while ((i = buf.indexOf(closeTag, from)) >= 0) {
      onItem(buf.slice(from, i + closeTag.length));
      from = i + closeTag.length;
    }
    buf = buf.slice(from);
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s) {
  if (s.indexOf('&') >= 0) {
    s = s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e]);
  }
  if (s.indexOf('_x') >= 0) s = s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return s;
}
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
function richText(xml) {
  const noPh = xml.indexOf('<rPh') >= 0 ? xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : xml;
  let out = '';
  for (const m of noPh.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return unxml(out);
}
const colIndex = (ref) => {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

// ---------- styles: which style ids are dates
function dateStyles(xml) {
  const out = new Set();
  if (!xml) return out;
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) custom.set(+attr(m[0], 'numFmtId'), unxml(attr(m[0], 'formatCode') || ''));
  const xfs = xml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/);
  if (!xfs) return out;
  let i = 0;
  for (const m of xfs[0].matchAll(/<xf\b[^>]*>/g)) {
    const id = +attr(m[0], 'numFmtId');
    const code = custom.get(id);
    const isDate = (id >= 14 && id <= 22) || (id >= 45 && id <= 47) ||
      (code && /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')));
    if (isDate) out.add(i);
    i++;
  }
  return out;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function serialToIso(v) {
  const ms = Math.round((v - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d)) return String(v);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}
function numText(v) {
  const n = Number(v);
  if (!isFinite(n)) return v;
  return Number.isInteger(n) ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : String(n);
}

// ---------- main
async function run(f) {
  file = f;
  const entries = await listEntries();
  const wb = await readText(entries, 'xl/workbook.xml');
  if (!wb) throw new Error('This file is not an Excel workbook.');
  const rels = (await readText(entries, 'xl/_rels/workbook.xml.rels')) || '';
  const relMap = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    let t = relMap.get(attr(m[0], 'r:id')) || '';
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    return { name: unxml(attr(m[0], 'name') || ''), path: t };
  }).filter((s) => entries.has(s.path));
  if (!sheets.length) throw new Error('The workbook has no sheets.');
  const dates = dateStyles(await readText(entries, 'xl/styles.xml'));
  const sst = entries.get('xl/sharedStrings.xml');
  progressTotal = sheets.reduce((n, s) => n + entries.get(s.path).csize, 0) + (sst ? sst.csize : 0);

  // Pass 1: sheets. Keep cells as [col, kind, value]; shared strings stay as indexes for now.
  const parsed = [];
  for (const sh of sheets) {
    const rows = [];
    await streamEntry(entries.get(sh.path), splitter('</row>', (rowXml) => {
      const cells = [];
      for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = m[1], inner = m[2] || '';
        const r = attr(a, 'r'), t = attr(a, 't'), s = attr(a, 's');
        const col = r ? colIndex(r) : cells.length;
        if (t === 'inlineStr') { cells.push([col, 'v', richText(inner)]); continue; }
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (!vm) continue;
        const v = vm[1];
        if (t === 's') cells.push([col, 's', +v]);
        else if (t === 'str' || t === 'e') cells.push([col, 'v', unxml(v)]);
        else if (t === 'b') cells.push([col, 'v', v === '1' ? 'true' : 'false']);
        else if (s !== null && dates.has(+s)) cells.push([col, 'v', serialToIso(+v)]);
        else cells.push([col, 'v', numText(v)]);
      }
      if (cells.length) rows.push(cells);
      progress('read');
    }));
    parsed.push({ name: sh.name, rows });
  }

  // Which columns each shared string is used in, from every sheet's header row.
  const headerIdx = new Set();
  for (const sh of parsed) for (const c of (sh.rows.find((r) => r.length) || [])) if (c[1] === 's') headerIdx.add(c[2]);

  // Pass 2: shared strings. Resolve headers first (they are written early), then keep only what is needed.
  const strings = sst ? [] : null;
  const emails = emailCollector();
  if (sst) {
    // usage: string index -> column names, built once header text is known
    let usage = null;
    const headerText = new Map();
    const buildUsage = () => {
      usage = new Map();
      for (const sh of parsed) {
        const hdr = sh.rows[0] || [];
        const names = new Map(hdr.map((c) => [c[0], c[1] === 's' ? headerText.get(c[2]) : c[2]]));
        for (let i = 1; i < sh.rows.length; i++) {
          for (const c of sh.rows[i]) {
            if (c[1] !== 's') continue;
            const n = String(names.get(c[0]) ?? '').trim();
            let u = usage.get(c[2]);
            if (!u) usage.set(c[2], (u = new Set()));
            u.add(n);
          }
        }
      }
    };
    let idx = 0;
    const maxHeader = Math.max(-1, ...headerIdx);
    await streamEntry(sst, splitter('</si>', (si) => {
      const i = idx++;
      if (headerIdx.has(i)) headerText.set(i, richText(si));
      if (!usage && i >= maxHeader) buildUsage();
      if (!usage) { strings[i] = richText(si); return; } // only header strings come before usage is ready
      const u = usage.get(i);
      if (!u || headerIdx.has(i)) { strings[i] = headerIdx.has(i) ? headerText.get(i) : undefined; return; }
      let keepFull = false, image = false, changed = false;
      for (const n of u) {
        if (IMAGE_COLS.has(n)) image = true;
        else if (n === 'changed_fields') changed = true;
        else if (KEEP.has(n)) keepFull = true;
      }
      if (!keepFull && !image && !changed) { strings[i] = undefined; return; }
      const text = richText(si);
      if (image) emails.addText(text);
      if (keepFull) strings[i] = text;
      else if (image && u.has('after_image') && text.length <= IMAGE_KEEP_MAX && text.includes('alarm_')) strings[i] = text;
      else if (changed) strings[i] = { changed: (text.match(/field_name/g) || []).length };
      else strings[i] = '';
      progress('read');
    }));
    if (!usage) buildUsage();
  }

  // Pick the first sheet with an account_id header.
  const cellText = (c, colName) => {
    if (c[1] !== 's') return c[2];
    const v = strings ? strings[c[2]] : '';
    if (v && typeof v === 'object') return colName === 'changed_fields' ? String(v.changed) : '';
    return v ?? '';
  };
  let pick = null;
  for (const sh of parsed) {
    const hi = sh.rows.findIndex((r, i) => i < 20 && r.some((c) => String(cellText(c)).trim() === 'account_id'));
    if (hi >= 0) { pick = { ...sh, hi }; break; }
  }
  if (!pick) pick = parsed.find((s) => s.rows.length) && { ...parsed.find((s) => s.rows.length), hi: 0 };
  if (!pick) throw new Error('The workbook has no rows.');
  const header = new Map(pick.rows[pick.hi].map((c) => [c[0], String(cellText(c)).trim()]));
  const fields = [...header.values()].filter(Boolean);
  const data = [];
  for (let i = pick.hi + 1; i < pick.rows.length; i++) {
    const o = {}; let any = false;
    for (const c of pick.rows[i]) {
      const f = header.get(c[0]);
      if (!f || !KEEP.has(f)) continue;
      const t = cellText(c, f);
      if (t === '' || t === undefined) continue;
      o[f] = t; any = true;
    }
    if (any) data.push(o);
    pick.rows[i] = null; // free as we go
  }
  progress('read', true);
  return { data, meta: { fields, sheet: pick.name }, emailVotes: emails.votes() };
}

self.onmessage = async (e) => {
  try {
    const out = await run(e.data.file);
    postMessage({ type: 'done', ...out });
  } catch (err) {
    postMessage({ type: 'error', message: err?.message || String(err) });
  }
};

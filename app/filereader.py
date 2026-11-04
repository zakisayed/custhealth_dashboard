"""Read activity exports (.csv, .xlsx, .xlsm) on the server, for SharePoint imports.

Mirrors what the browser does on a manual upload (public/js/upload.js and xlsx-worker.js):
- only the columns the pipeline needs are kept,
- after_image / before_image are reduced to the email pairs they contain while reading
  (an alarm's after_image is kept, it holds severity and status),
- changed_fields is reduced to a count of changed fields.

Excel files are streamed straight out of the zip, so a 100 MB workbook whose text expands to
about 900 MB is read with flat memory.
"""
from __future__ import annotations

import codecs
import csv
import html
import re
import sys
import zipfile
from datetime import datetime, timedelta, timezone

from .emails import EmailCollector

KEEP = [
    "PK", "SK", "account_id", "timestamp", "user_id", "user_name", "event_type", "event_type_name",
    "entity_type", "entity_type_name", "entity_sub_type", "entity_id", "entity_name", "entity_status",
    "source_table", "transaction_id", "node_alert_status", "description", "changed_fields", "after_image",
]
KEEP_SET = set(KEEP)
IMAGE_COLS = {"after_image", "before_image"}
EMAIL_SOURCES = ("after_image", "before_image", "changed_fields", "description")
IMAGE_KEEP_MAX = 20000
SUPPORTED = (".csv", ".xlsx", ".xlsm")
SLICE = 8 * 1024 * 1024


class FileFormatError(ValueError):
    pass


def supported(name: str) -> bool:
    return (name or "").lower().endswith(SUPPORTED)


def _slim(raw: dict, emails: EmailCollector) -> dict | None:
    """One raw row -> the slim row the upload pipeline takes (same as the browser)."""
    for k in EMAIL_SOURCES:
        v = raw.get(k)
        if v:
            emails.add_text(v)
    o = {}
    for k in KEEP:
        v = raw.get(k)
        if v is None:
            continue
        v = v if isinstance(v, str) else str(v)
        if v == "":
            continue
        o[k] = v
    if not o:
        return None
    is_alarm = o.get("entity_type") == "ALM" or o.get("source_table") == "saws_alarms"
    if not is_alarm:
        o.pop("after_image", None)
    elif len(o.get("after_image", "")) > IMAGE_KEEP_MAX:
        o.pop("after_image", None)
    if "changed_fields" in o and not o["changed_fields"].isdigit():
        o["changed_fields"] = str(o["changed_fields"].count("field_name"))
    return o


# ----------------------------------------------------------------------------- csv
def read_csv(path: str, progress=None) -> dict:
    csv.field_size_limit(sys.maxsize)
    emails = EmailCollector()
    data = []
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        fields = [f.strip() for f in (reader.fieldnames or [])]
        reader.fieldnames = fields
        for i, r in enumerate(reader):
            o = _slim(r, emails)
            if o:
                data.append(o)
            if progress and i % 5000 == 0:
                progress(i)
    return {"data": data, "fields": [f for f in fields if f], "sheet": None, "emails": emails}


# ----------------------------------------------------------------------------- xlsx
_CELL = re.compile(r"<c\b([^>]*?)(?:/>|>(.*?)</c>)", re.S)
_V = re.compile(r"<v>(.*?)</v>", re.S)
_T = re.compile(r"<t(?:\s[^>]*)?>(.*?)</t>", re.S)
_RPH = re.compile(r"<rPh\b.*?</rPh>", re.S)
_XESC = re.compile(r"_x([0-9A-Fa-f]{4})_")


def _attr(tag: str, name: str):
    m = re.search(r"\s" + name + r'="([^"]*)"', tag)
    return m.group(1) if m else None


def _unxml(s: str) -> str:
    if "&" in s:
        s = html.unescape(s)
    if "_x" in s:
        s = _XESC.sub(lambda m: chr(int(m.group(1), 16)), s)
    return s


def _rich(xml: str) -> str:
    if "<rPh" in xml:
        xml = _RPH.sub("", xml)
    return _unxml("".join(_T.findall(xml)))


def _col(ref: str) -> int:
    n = 0
    for ch in ref:
        o = ord(ch)
        if o < 65 or o > 90:
            break
        n = n * 26 + (o - 64)
    return n - 1


def _date_styles(xml: str | None) -> set[int]:
    out: set[int] = set()
    if not xml:
        return out
    custom = {}
    for m in re.finditer(r"<numFmt\b[^>]*>", xml):
        try:
            custom[int(_attr(m.group(0), "numFmtId") or -1)] = _unxml(_attr(m.group(0), "formatCode") or "")
        except ValueError:
            pass
    xfs = re.search(r"<cellXfs\b.*?</cellXfs>", xml, re.S)
    if not xfs:
        return out
    for i, m in enumerate(re.finditer(r"<xf\b[^>]*>", xfs.group(0))):
        try:
            fid = int(_attr(m.group(0), "numFmtId") or 0)
        except ValueError:
            fid = 0
        code = custom.get(fid)
        stripped = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", code or "")
        if 14 <= fid <= 22 or 45 <= fid <= 47 or (code and re.search(r"[dmyhs]", stripped, re.I)):
            out.add(i)
    return out


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _serial_iso(v: str) -> str:
    try:
        ms = round((float(v) - 25569) * 86400000)
        d = _EPOCH + timedelta(milliseconds=ms)
        return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}"
    except (ValueError, OverflowError):
        return v


def _num(v: str) -> str:
    if v.lstrip("-").isdigit():
        return v
    try:
        n = float(v)
    except ValueError:
        return v
    if n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


def _stream(zf: zipfile.ZipFile, name: str, on_text, on_bytes=None):
    dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    with zf.open(name) as fh:
        while True:
            b = fh.read(SLICE)
            if not b:
                break
            if on_bytes:
                on_bytes(len(b))
            on_text(dec.decode(b))
    on_text(dec.decode(b"", final=True))


def _splitter(close: str, on_item):
    buf = [""]

    def feed(t: str):
        s = buf[0] + t
        start = 0
        while True:
            i = s.find(close, start)
            if i < 0:
                break
            j = i + len(close)
            on_item(s[start:j])
            start = j
        buf[0] = s[start:]
    return feed


def read_xlsx(path: str, progress=None) -> dict:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise FileFormatError("This file is not a valid .xlsx workbook.") from exc
    with zf:
        names = {n.lstrip("/"): n for n in zf.namelist()}

        def text(p):
            n = names.get(p)
            if not n:
                return None
            parts = []
            _stream(zf, n, parts.append)
            return "".join(parts)

        wb = text("xl/workbook.xml")
        if not wb:
            raise FileFormatError("This file is not an Excel workbook.")
        rels = text("xl/_rels/workbook.xml.rels") or ""
        rel = {_attr(m.group(0), "Id"): _attr(m.group(0), "Target") for m in re.finditer(r"<Relationship\b[^>]*>", rels)}
        sheets = []
        for m in re.finditer(r"<sheet\b[^>]*>", wb):
            t = rel.get(_attr(m.group(0), "r:id")) or ""
            t = t[1:] if t.startswith("/") else "xl/" + re.sub(r"^\./", "", t)
            if t in names:
                sheets.append({"name": _unxml(_attr(m.group(0), "name") or ""), "path": t})
        if not sheets:
            raise FileFormatError("The workbook has no sheets.")
        dates = _date_styles(text("xl/styles.xml"))

        # Pass 1: sheets. Cells are (col, is_shared, value); shared strings stay as indexes for now.
        parsed = []
        for sh in sheets:
            rows = []

            def on_row(xml, rows=rows):
                cells = []
                for m in _CELL.finditer(xml):
                    a, inner = m.group(1), m.group(2) or ""
                    r, t, s = _attr(a, "r"), _attr(a, "t"), _attr(a, "s")
                    col = _col(r) if r else len(cells)
                    if t == "inlineStr":
                        cells.append((col, False, _rich(inner)))
                        continue
                    vm = _V.search(inner)
                    if not vm:
                        continue
                    v = vm.group(1)
                    if t == "s":
                        cells.append((col, True, int(v)))
                    elif t in ("str", "e"):
                        cells.append((col, False, _unxml(v)))
                    elif t == "b":
                        cells.append((col, False, "true" if v == "1" else "false"))
                    elif s is not None and s.isdigit() and int(s) in dates:
                        cells.append((col, False, _serial_iso(v)))
                    else:
                        cells.append((col, False, _num(v)))
                if cells:
                    rows.append(cells)
            _stream(zf, names[sh["path"]], _splitter("</row>", on_row))
            parsed.append({"name": sh["name"], "rows": rows})

        header_idx = set()
        for sh in parsed:
            first = next((r for r in sh["rows"] if r), [])
            header_idx.update(v for _, shared, v in first if shared)

        emails = EmailCollector()
        strings: dict[int, object] = {}
        sst = names.get("xl/sharedStrings.xml")
        if sst:
            header_text: dict[int, str] = {}
            usage: dict[int, set] | None = None
            max_header = max(header_idx) if header_idx else -1
            state = {"i": 0, "usage": None}

            def build_usage():
                u: dict[int, set] = {}
                for sh in parsed:
                    hdr = sh["rows"][0] if sh["rows"] else []
                    cols = {c: (header_text.get(v) if shared else v) for c, shared, v in hdr}
                    for row in sh["rows"][1:]:
                        for c, shared, v in row:
                            if shared:
                                u.setdefault(v, set()).add(str(cols.get(c) or "").strip())
                state["usage"] = u

            def on_si(si: str):
                i = state["i"]
                state["i"] += 1
                if i in header_idx:
                    header_text[i] = _rich(si)
                if state["usage"] is None and i >= max_header:
                    build_usage()
                u = state["usage"]
                if u is None:
                    strings[i] = _rich(si)
                    return
                if i in header_idx:
                    strings[i] = header_text[i]
                    return
                cols = u.get(i)
                if not cols:
                    return
                keep_full = image = changed = False
                for n in cols:
                    if n in IMAGE_COLS:
                        image = True
                    elif n == "changed_fields":
                        changed = True
                    elif n in KEEP_SET:
                        keep_full = True
                if not (keep_full or image or changed):
                    return
                t = _rich(si)
                if image:
                    emails.add_text(t)
                if keep_full:
                    strings[i] = t
                elif image and "after_image" in cols and len(t) <= IMAGE_KEEP_MAX and "alarm_" in t:
                    strings[i] = t
                elif changed:
                    strings[i] = ("changed", t.count("field_name"))
                else:
                    strings[i] = ""

            done = [0]

            def on_bytes(n):
                done[0] += n
                if progress:
                    progress(done[0])
            _stream(zf, sst, _splitter("</si>", on_si), on_bytes)
            if state["usage"] is None:
                build_usage()

    def cell_text(shared, v, col_name=None):
        if not shared:
            return v
        s = strings.get(v, "")
        if isinstance(s, tuple):
            return str(s[1]) if col_name == "changed_fields" else ""
        return s

    pick = None
    for sh in parsed:
        for hi, r in enumerate(sh["rows"][:20]):
            if any(str(cell_text(sh_, v)).strip() == "account_id" for _, sh_, v in r):
                pick = (sh, hi)
                break
        if pick:
            break
    if not pick:
        sh = next((s for s in parsed if s["rows"]), None)
        if not sh:
            raise FileFormatError("The workbook has no rows.")
        pick = (sh, 0)
    sh, hi = pick
    header = {c: str(cell_text(shared, v)).strip() for c, shared, v in sh["rows"][hi]}
    data = []
    no_votes = EmailCollector()  # votes are added below, once per cell
    for row in sh["rows"][hi + 1:]:
        raw = {}
        for c, shared, v in row:
            f = header.get(c)
            if not f:
                continue
            if not shared and f in EMAIL_SOURCES:
                emails.add_text(v)  # inline text; shared strings were scanned while reading
            elif shared and f == "description":
                emails.add_text(cell_text(shared, v, f))
            if f not in KEEP_SET:
                continue
            t = cell_text(shared, v, f)
            if t not in ("", None):
                raw[f] = t
        if raw:
            o = _slim(raw, no_votes)
            if o:
                data.append(o)
    return {"data": data, "fields": [f for f in header.values() if f], "sheet": sh["name"], "emails": emails}


def read_file(path: str, filename: str, progress=None) -> dict:
    low = (filename or path).lower()
    if low.endswith(".csv"):
        return read_csv(path, progress)
    if low.endswith((".xlsx", ".xlsm")):
        return read_xlsx(path, progress)
    raise FileFormatError("Automatic import reads .csv, .xlsx and .xlsm files. Save this file in one of those formats.")

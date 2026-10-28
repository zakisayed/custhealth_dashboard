"""Turn raw CDC log rows (exactly as exported) into clean event records.

Accepts either the full CSV columns or the slimmed rows the browser sends.
Anything unknown is kept with a readable fallback instead of being dropped.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

ACTION_MAP = {"CRT": "created", "UPD": "updated", "DEL": "deleted", "EXE": "executed"}
ACTION_NAME_MAP = {"created": "created", "updated": "updated", "deleted": "deleted", "executed": "executed"}

OBJECT_MAP = {
    "COL": "columns",
    "PLO": "etl_programs",
    "ETL": "etl_programs",
    "BIT": "bi_tables",
    "RLS": "dq_rules",
    "DMN": "data_domains",
    "UCS": "use_cases",
    "USC": "use_cases",
    "UC": "use_cases",
    "TBL": "db_tables",
    "JOB": "jobs",
    "ALM": "alarms",
}
OBJECT_NAME_HINTS = [
    ("use case", "use_cases"),
    ("etl", "etl_programs"),
    ("bi table", "bi_tables"),
    ("dq rule", "dq_rules"),
    ("data domain", "data_domains"),
    ("database column", "columns"),
    ("database table", "db_tables"),
    ("alarm", "alarms"),
    ("job", "jobs"),
]
CORE_OBJECTS = ["columns", "etl_programs", "bi_tables", "dq_rules", "data_domains", "use_cases"]
ALL_OBJECT_COLUMNS = CORE_OBJECTS + ["db_tables", "jobs"]

STATUS_MAP = {
    "PUB": "published", "PUBLISHED": "published",
    "DFT": "draft", "DRAFT": "draft",
    "NEW": "new",
    "CRT": "created", "CREATED": "created",
    "EXE": "executed", "EXECUTED": "executed",
    "DEL": "deleted", "DELETED": "deleted",
}
SEVERITY_MAP = {"CRC": "critical", "CRT": "critical", "CRITICAL": "critical",
                "WNG": "warning", "WRN": "warning", "WARNING": "warning",
                "INF": "info", "INFO": "info"}

REQUIRED = ["account_id", "timestamp", "event_type", "entity_type", "user_id"]
# Columns the browser keeps before upload (everything else is index keys or large images).
KEEP_COLUMNS = [
    "PK", "SK", "account_id", "timestamp", "user_id", "user_name", "event_type", "event_type_name",
    "entity_type", "entity_type_name", "entity_sub_type", "entity_id", "entity_name", "entity_status",
    "source_table", "transaction_id", "node_alert_status", "description", "changed_fields", "after_image",
    "user_email",
]

_EMAIL = re.compile(r"[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}")
_DQ_EXC = re.compile(r"Exception records:\s*([\d,]+)", re.I)
_DQ_TOT = re.compile(r"Total records:\s*([\d,]+)", re.I)


def _s(v) -> str | None:
    if v is None:
        return None
    v = str(v).strip()
    if v == "" or v.lower() in ("nan", "null", "none"):
        return None
    return v


def _slug(v: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", v.lower()).strip("_") or "other"


def parse_ts(v) -> datetime:
    s = _s(v)
    if s is None:
        raise ValueError("missing timestamp")
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        n = float(s)
        if n > 1e14:      # microseconds
            n /= 1e6
        elif n > 1e11:    # milliseconds
            n /= 1e3
        return datetime.fromtimestamp(n, tz=timezone.utc)
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _loads_loose(text: str):
    """after_image arrives double-encoded and with CSV-doubled quotes. Peel it."""
    t = text
    for _ in range(4):
        if isinstance(t, (dict, list)):
            return t
        try:
            t = json.loads(t)
            continue
        except Exception:
            pass
        t2 = t.strip()
        if t2.startswith('"') and t2.endswith('"'):
            t2 = t2[1:-1]
        t2 = t2.replace('""', '"')
        if t2 == t:
            return None
        t = t2
    return t if isinstance(t, (dict, list)) else None


def object_type(entity_type: str | None, entity_type_name: str | None) -> str:
    code = (entity_type or "").upper()
    if code in OBJECT_MAP:
        return OBJECT_MAP[code]
    name = (entity_type_name or "").lower()
    for hint, obj in OBJECT_NAME_HINTS:
        if hint in name:
            return obj
    return _slug(entity_type_name or entity_type or "other")


def normalize_row(raw: dict) -> dict:
    missing = [c for c in REQUIRED if _s(raw.get(c)) is None]
    if missing:
        raise ValueError(f"missing {', '.join(missing)}")

    account_id = int(float(str(raw["account_id"]).strip().strip("'")))
    ts = parse_ts(raw["timestamp"])
    user_id = str(raw["user_id"]).strip().strip("'\"")
    user_name = _s(raw.get("user_name"))
    is_system = user_id in ("-1", "0") or (user_name or "").upper() == "SYSTEM"
    user_email = (_s(raw.get("user_email")) or "").lower()
    if not _EMAIL.fullmatch(user_email):
        user_email = user_name.lower() if user_name and _EMAIL.fullmatch(user_name.lower()) else None

    event_type = str(raw["event_type"]).strip().upper()
    action = ACTION_MAP.get(event_type) or ACTION_NAME_MAP.get((_s(raw.get("event_type_name")) or "").lower()) \
        or _slug(_s(raw.get("event_type_name")) or event_type)

    entity_type = str(raw["entity_type"]).strip().upper()
    obj = object_type(entity_type, _s(raw.get("entity_type_name")))

    status_raw = (_s(raw.get("entity_status")) or "").upper()
    status = STATUS_MAP.get(status_raw, status_raw.lower() or None)

    source_table = _s(raw.get("source_table"))
    key = _s(raw.get("SK"))
    if key is None:
        basis = "|".join(str(raw.get(c, "")) for c in ("PK", "timestamp", "entity_id", "event_type", "transaction_id"))
        key = "h#" + hashlib.sha1(basis.encode()).hexdigest()

    cf = _s(raw.get("changed_fields"))
    if cf is None:
        changed = 0
    elif re.fullmatch(r"\d+", cf):
        changed = int(cf)
    else:
        changed = cf.count("field_name")

    alarm_sev = alarm_type = alarm_status = None
    if obj == "alarms" or source_table == "saws_alarms":
        img = _loads_loose(_s(raw.get("after_image")) or "")
        if isinstance(img, dict):
            alarm_sev = SEVERITY_MAP.get(str(img.get("alarm_severity", "")).upper(), _s(img.get("alarm_severity")))
            alarm_type = _s(img.get("alarm_type"))
            alarm_status = _s(img.get("alarm_status"))

    dq_exc = dq_tot = None
    desc = _s(raw.get("description")) or ""
    m1, m2 = _DQ_EXC.search(desc), _DQ_TOT.search(desc)
    if m1:
        dq_exc = int(m1.group(1).replace(",", ""))
    if m2:
        dq_tot = int(m2.group(1).replace(",", ""))

    return {
        "account_id": account_id,
        "event_key": key,
        "ts": ts,
        "user_id": user_id,
        "user_name": "SYSTEM" if is_system and not user_name else user_name,
        "user_email": None if is_system else user_email,
        "actor_type": "system" if is_system else "user",
        "event_type": event_type,
        "action": action,
        "entity_type": entity_type,
        "object_type": obj,
        "entity_sub_type": _s(raw.get("entity_sub_type")),
        "entity_id": _s(raw.get("entity_id")),
        "entity_name": _s(raw.get("entity_name")),
        "entity_status": status,
        "source_table": source_table,
        "transaction_id": _s(raw.get("transaction_id")),
        "changed_fields": changed,
        "alarm_severity": alarm_sev,
        "alarm_type": alarm_type,
        "alarm_status": alarm_status,
        "dq_exceptions": dq_exc,
        "dq_total": dq_tot,
        "dq_alert": (_s(raw.get("node_alert_status")) or "").upper() == "ALE",
    }


def account_name_from_filename(filename: str | None, account_id: int) -> str:
    if not filename:
        return f"Account {account_id}"
    base = re.sub(r"\.(csv|xlsx?|txt)$", "", filename.split("/")[-1], flags=re.I)
    base = re.sub(r"[_\-]+", " ", base)
    base = re.sub(r"\b(\d{4}[-_ ]?\d{2}[-_ ]?\d{2}|export|logs?|events?|activity)\b", "", base, flags=re.I)
    base = re.sub(r"\s+", " ", base).strip()
    if not base:
        return f"Account {account_id}"
    small = {"and", "of", "the", "for", "&"}
    words = [w if (w.lower() in small and i) else w[:1].upper() + w[1:] for i, w in enumerate(base.split())]
    return " ".join(w.lower() if w.lower() in small and i else w for i, w in enumerate(words))

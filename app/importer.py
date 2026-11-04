"""Server-side import: the same checks and steps the upload page runs in the browser."""
from __future__ import annotations

from .db import connect
from .ingest import add_rows, complete_upload, create_upload, set_user_emails
from .normalize import REQUIRED

CHUNK = 5000


class ImportRejected(ValueError):
    """The file was read but cannot go into this customer (wrong account, missing columns...)."""


def import_parsed(parsed: dict, filename: str, account_id: int, uploaded_by: str) -> dict:
    data = parsed["data"]
    fields = parsed.get("fields") or []
    missing = [c for c in REQUIRED if c not in fields]
    if missing:
        raise ImportRejected(f"Missing columns: {', '.join(missing)}")
    if not data:
        raise ImportRejected("The file has no rows.")

    counts: dict[str, int] = {}
    for r in data:
        a = str(r.get("account_id") or "").strip()
        if a:
            counts[a] = counts.get(a, 0) + 1
    if not counts:
        raise ImportRejected("No account_id values found in the file.")
    if len(counts) > 1:
        detail = ", ".join(f"#{k} ({v} rows)" for k, v in counts.items())
        raise ImportRejected(f"This file has {len(counts)} accounts ({detail}). Use one customer per file.")
    file_acct = next(iter(counts))
    if str(account_id) != file_acct:
        raise ImportRejected(f"This file is for account #{file_acct}, not this customer (#{account_id}).")

    lookup = parsed["emails"].lookup_fn()
    people: dict[str, dict] = {}
    for r in data:
        uid = str(r.get("user_id") or "").strip().lstrip("'")
        if not uid or uid in ("-1", "0") or str(r.get("user_name") or "").upper() == "SYSTEM" or uid in people:
            continue
        people[uid] = {"user_id": uid, "user_name": r.get("user_name"), "email": lookup(r.get("user_id"), r.get("user_name"))}
    for r in data:
        em = lookup(r.get("user_id"), r.get("user_name"))
        if em:
            r["user_email"] = em

    up = create_upload(filename, account_id)
    with connect() as conn:
        conn.execute("update uploads set uploaded_by=%s where upload_id=%s", [uploaded_by, up["upload_id"]])
    tot = {"received": 0, "inserted": 0, "duplicates": 0, "rejected": 0, "errors": []}
    for i in range(0, len(data), CHUNK):
        s = add_rows(up["upload_id"], data[i:i + CHUNK])
        for k in ("received", "inserted", "duplicates", "rejected"):
            tot[k] += s[k]
        tot["errors"] += s["errors"][: 5 - len(tot["errors"])]
    matched = [p for p in people.values() if p["email"]]
    if matched:
        set_user_emails(up["upload_id"], matched)
    done = complete_upload(up["upload_id"])
    u = done["upload"]
    return {"upload_id": up["upload_id"], "rows": tot, "min_ts": u.get("min_ts"), "max_ts": u.get("max_ts"),
            "emails_matched": len(matched), "users": len(people)}

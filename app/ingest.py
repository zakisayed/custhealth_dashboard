"""Upload lifecycle: create -> add row chunks -> complete (recompute everything)."""
from __future__ import annotations

from datetime import datetime, timezone

from .db import connect
from .normalize import account_name_from_filename, normalize_row

EVENT_COLS = [
    "account_id", "event_key", "upload_id", "ts", "user_id", "user_name", "actor_type", "event_type", "action",
    "entity_type", "object_type", "entity_sub_type", "entity_id", "entity_name", "entity_status", "source_table",
    "transaction_id", "changed_fields", "alarm_severity", "alarm_type", "alarm_status", "dq_exceptions",
    "dq_total", "dq_alert",
]


def create_upload(filename: str | None) -> dict:
    with connect() as conn:
        row = conn.execute(
            "insert into uploads (filename) values (%s) returning upload_id, filename, status, created_at",
            [filename],
        ).fetchone()
    return row


def add_rows(upload_id: int, rows: list[dict]) -> dict:
    events, rejected, errors = [], 0, []
    for i, raw in enumerate(rows):
        try:
            ev = normalize_row(raw)
            ev["upload_id"] = upload_id
            events.append(ev)
        except Exception as exc:  # keep going, report a sample
            rejected += 1
            if len(errors) < 5:
                errors.append(f"row {i}: {exc}")

    with connect() as conn:
        up = conn.execute("select filename, status from uploads where upload_id=%s for update", [upload_id]).fetchone()
        if not up:
            raise ValueError("upload not found")
        if up["status"] not in ("receiving",):
            raise ValueError(f"upload is {up['status']}")

        inserted = 0
        if events:
            # accounts + users first (FK)
            acct_ids = sorted({e["account_id"] for e in events})
            for aid in acct_ids:
                conn.execute(
                    "insert into accounts (account_id, name) values (%s, %s) on conflict (account_id) do nothing",
                    [aid, account_name_from_filename(up["filename"], aid)],
                )
            users: dict[tuple, dict] = {}
            for e in events:
                k = (e["account_id"], e["user_id"])
                u = users.setdefault(k, {"name": e["user_name"], "sys": e["actor_type"] == "system",
                                         "first": e["ts"], "last": e["ts"]})
                u["first"] = min(u["first"], e["ts"])
                u["last"] = max(u["last"], e["ts"])
                if e["user_name"]:
                    u["name"] = e["user_name"]
            with conn.cursor() as cur:
                cur.executemany(
                    """insert into account_users (account_id, user_id, user_name, is_system, first_seen, last_seen)
                       values (%s,%s,%s,%s,%s,%s)
                       on conflict (account_id, user_id) do update set
                         user_name = coalesce(excluded.user_name, account_users.user_name),
                         first_seen = least(account_users.first_seen, excluded.first_seen),
                         last_seen  = greatest(account_users.last_seen, excluded.last_seen)""",
                    [(a, uid, u["name"], u["sys"], u["first"], u["last"]) for (a, uid), u in users.items()],
                )
                cur.execute(
                    "create temp table stage_events (like events including defaults) on commit drop"
                )
                with cur.copy(f"copy stage_events ({', '.join(EVENT_COLS)}) from stdin") as cp:
                    for e in events:
                        cp.write_row([e[c] for c in EVENT_COLS])
                cur.execute(
                    f"""with ins as (
                          insert into events ({', '.join(EVENT_COLS)})
                          select distinct on (account_id, event_key) {', '.join(EVENT_COLS)} from stage_events
                          on conflict (account_id, event_key) do nothing
                          returning 1)
                        select count(*) as n from ins"""
                )
                inserted = cur.fetchone()["n"]

            min_ts = min(e["ts"] for e in events)
            max_ts = max(e["ts"] for e in events)
        else:
            acct_ids, min_ts, max_ts = [], None, None

        conn.execute(
            """update uploads set
                 rows_received = rows_received + %s,
                 rows_inserted = rows_inserted + %s,
                 rows_duplicate = rows_duplicate + %s,
                 rows_rejected = rows_rejected + %s,
                 account_ids = (select array(select distinct unnest(account_ids || %s::bigint[]) order by 1)),
                 min_ts = least(min_ts, %s), max_ts = greatest(max_ts, %s)
               where upload_id = %s""",
            [len(rows), inserted, len(events) - inserted, rejected, acct_ids, min_ts, max_ts, upload_id],
        )
    return {"received": len(rows), "inserted": inserted, "duplicates": len(events) - inserted,
            "rejected": rejected, "errors": errors}


def complete_upload(upload_id: int) -> dict:
    from .engine import recompute

    with connect() as conn:
        up = conn.execute("select * from uploads where upload_id=%s", [upload_id]).fetchone()
        if not up:
            raise ValueError("upload not found")
        conn.execute("update uploads set status='processing' where upload_id=%s", [upload_id])
    try:
        result = recompute(up["account_ids"] or None)
    except Exception as exc:
        with connect() as conn:
            conn.execute("update uploads set status='failed', error=%s where upload_id=%s", [str(exc)[:500], upload_id])
        raise
    with connect() as conn:
        conn.execute("update uploads set status='complete', completed_at=%s where upload_id=%s",
                     [datetime.now(timezone.utc), upload_id])
        up = conn.execute("select * from uploads where upload_id=%s", [upload_id]).fetchone()
    return {"upload": up, "recompute": result}

"""Check each customer's SharePoint folder and import new files.

Called by the scheduler (GET /api/sync/run with the CRON_SECRET) about once an hour, and
by "Check now" in the app. Each customer is checked when its last check is older than the
interval set in Settings. Files are imported oldest first. When time runs short the rest
are left for the next run (the customer stays due until its backlog is cleared).
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone

from . import sharepoint as sp
from .db import connect
from .filereader import FileFormatError, read_file, supported
from .importer import ImportRejected, import_parsed

DEFAULT_INTERVAL_HOURS = 6.0
MIN_INTERVAL, MAX_INTERVAL = 1.0, 168.0
MAX_ATTEMPTS = 3
STALE_PROCESSING = timedelta(minutes=20)
UPLOADER = "SharePoint (automatic)"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def get_settings(conn) -> dict:
    r = conn.execute("select value from app_settings where key='sharepoint_sync'").fetchone()
    s = {"interval_hours": DEFAULT_INTERVAL_HOURS}
    if r:
        try:
            s.update(json.loads(r["value"]))
        except ValueError:
            pass
    return s


def save_settings(conn, interval_hours: float, user: str) -> dict:
    h = float(interval_hours)
    if not (MIN_INTERVAL <= h <= MAX_INTERVAL):
        raise ValueError(f"Check interval must be between {MIN_INTERVAL:g} and {MAX_INTERVAL:g} hours.")
    val = {"interval_hours": round(h, 2), "updated_by": user, "updated_at": _now().isoformat()}
    conn.execute("""insert into app_settings (key, value) values ('sharepoint_sync', %s)
                    on conflict (key) do update set value = excluded.value""", [json.dumps(val)])
    return val


# ----------------------------------------------------------------------------- lock
def _lock(owner: str, seconds: int) -> bool:
    until = (_now() + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")
    now = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    with connect() as conn:
        r = conn.execute(
            """insert into app_settings (key, value) values ('sharepoint_lock', %s)
               on conflict (key) do update set value = excluded.value
               where split_part(app_settings.value, '|', 1) < %s
               returning key""", [f"{until}|{owner}", now]).fetchone()
    return bool(r)


def _unlock(owner: str) -> None:
    with connect() as conn:
        conn.execute("delete from app_settings where key='sharepoint_lock' and split_part(value, '|', 2)=%s", [owner])


# ----------------------------------------------------------------------------- folder scan
def _scan(conn, src: dict) -> dict:
    """List the folder and record new or changed files. Returns counts."""
    if not src["drive_id"] or not src["item_id"]:
        it = sp.resolve(src["folder_url"])
        conn.execute("update sharepoint_sources set drive_id=%s, item_id=%s, folder_name=%s where account_id=%s",
                     [it["drive_id"], it["item_id"], it["name"], src["account_id"]])
        src.update(drive_id=it["drive_id"], item_id=it["item_id"])
    try:
        files = sp.list_files(src["drive_id"], src["item_id"])
    except sp.GraphError as exc:
        if exc.status != 404:
            raise
        it = sp.resolve(src["folder_url"])  # folder moved or ids changed
        conn.execute("update sharepoint_sources set drive_id=%s, item_id=%s, folder_name=%s where account_id=%s",
                     [it["drive_id"], it["item_id"], it["name"], src["account_id"]])
        src.update(drive_id=it["drive_id"], item_id=it["item_id"])
        files = sp.list_files(src["drive_id"], src["item_id"])

    known = {r["item_id"]: r for r in conn.execute(
        "select item_id, ctag, status from sharepoint_files where account_id=%s", [src["account_id"]])}
    baseline = not src["baseline_done"] and not src["include_existing"]
    new = changed = 0
    for f in files:
        ok = supported(f["name"])
        k = known.get(f["item_id"])
        if k is None:
            status = "baseline" if baseline else ("pending" if ok else "skipped")
            msg = ("Already in the folder when watching started" if baseline else
                   None if ok else "Not a .csv, .xlsx or .xlsm file")
            conn.execute(
                """insert into sharepoint_files (account_id, item_id, name, size, modified_at, ctag, status, message, web_url)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing""",
                [src["account_id"], f["item_id"], f["name"], f["size"], f["modified_at"], f["ctag"], status, msg, f["web_url"]])
            new += status == "pending"
        elif k["ctag"] != f["ctag"] and k["status"] != "processing":
            status = "pending" if ok else "skipped"
            conn.execute(
                """update sharepoint_files set name=%s, size=%s, modified_at=%s, ctag=%s, status=%s, attempts=0,
                     message=%s, web_url=%s where account_id=%s and item_id=%s""",
                [f["name"], f["size"], f["modified_at"], f["ctag"], status,
                 "New version" if ok else "Not a .csv, .xlsx or .xlsm file", f["web_url"], src["account_id"], f["item_id"]])
            changed += status == "pending"
    if not src["baseline_done"]:
        conn.execute("update sharepoint_sources set baseline_done=true where account_id=%s", [src["account_id"]])
    return {"folder_files": len(files), "new": new, "changed": changed}


def _queue(conn, account_id: int) -> list[dict]:
    return conn.execute(
        """select * from sharepoint_files where account_id=%s and (
             status='pending'
             or (status='failed' and attempts < %s)
             or (status='processing' and started_at < %s))
           order by modified_at nulls first, name""",
        [account_id, MAX_ATTEMPTS, _now() - STALE_PROCESSING]).fetchall()


def _process_file(src: dict, f: dict) -> dict:
    """Download, read and import one file. Returns the stored result."""
    aid = src["account_id"]
    with connect() as conn:
        conn.execute("""update sharepoint_files set status='processing', attempts=attempts+1, started_at=now(), message=null
                        where account_id=%s and item_id=%s""", [aid, f["item_id"]])
    suffix = os.path.splitext(f["name"])[1].lower()
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="sp_")
    os.close(fd)
    status, msg, upload_id, new_rows, dup_rows, retry = "failed", None, None, None, None, True
    try:
        sp.download(src["drive_id"], f["item_id"], path)
        parsed = read_file(path, f["name"])
        res = import_parsed(parsed, f["name"], aid, UPLOADER)
        upload_id, new_rows, dup_rows = res["upload_id"], res["rows"]["inserted"], res["rows"]["duplicates"]
        status = "complete"
        msg = (f"{res['rows']['received']:,} rows, {new_rows:,} new"
               + (f", {dup_rows:,} already stored" if dup_rows else "")
               + (f", {res['rows']['rejected']:,} rejected" if res["rows"]["rejected"] else "")
               + f". Emails matched {res['emails_matched']} of {res['users']}.")
    except (ImportRejected, FileFormatError) as exc:
        msg, retry = str(exc), False
    except Exception as exc:  # network, database: retried on the next run
        msg = f"{type(exc).__name__}: {exc}"[:500]
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    with connect() as conn:
        conn.execute(
            """update sharepoint_files set status=%s, message=%s, upload_id=%s, rows_new=%s, rows_duplicate=%s,
                 processed_at=now(), attempts=case when %s then attempts else %s end
               where account_id=%s and item_id=%s""",
            [status, msg, upload_id, new_rows, dup_rows, retry, MAX_ATTEMPTS, aid, f["item_id"]])
    return {"name": f["name"], "status": status, "message": msg}


def _time_needed(size: int | None) -> float:
    mb = (size or 0) / 1048576
    return 20 + mb * 1.5   # download + read + store, measured on a 101 MB workbook with headroom


def run_sync(trigger: str = "cron", account_id: int | None = None, force: bool = False,
             budget_seconds: float | None = None) -> dict:
    budget = budget_seconds or float(os.environ.get("SYNC_BUDGET_SECONDS", "270"))
    t0 = time.monotonic()
    deadline = t0 + budget
    if not sp.configured():
        return {"ok": False, "message": "SharePoint is not set up yet. Add the tenant id, client id and "
                "client secret in the Vercel environment variables.", "customers": []}
    owner = f"{trigger}-{os.getpid()}-{time.time_ns()}"
    if not _lock(owner, int(budget) + 60):
        return {"ok": False, "busy": True, "message": "Another check is already running. Try again in a few minutes.",
                "customers": []}
    summary = {"ok": True, "customers": [], "imported": 0, "failed": 0, "checked": 0}
    with connect() as conn:
        run = conn.execute("insert into sharepoint_runs (trigger) values (%s) returning run_id", [trigger]).fetchone()
    try:
        with connect() as conn:
            interval = get_settings(conn)["interval_hours"]
            q = """select s.*, a.name from sharepoint_sources s join accounts a using (account_id) where s.enabled"""
            args: list = []
            if account_id is not None:
                q += " and s.account_id=%s"
                args.append(account_id)
            if not force:
                q += " and (s.last_checked_at is null or s.backlog or s.last_checked_at <= %s)"
                args.append(_now() - timedelta(hours=interval) + timedelta(minutes=5))  # cron jitter
            q += " order by s.last_checked_at nulls first"
            sources = conn.execute(q, args).fetchall()
        for src in sources:
            if time.monotonic() > deadline - 15:
                break
            res = {"account_id": src["account_id"], "name": src["name"], "files": []}
            status, message, backlog = "ok", None, False
            try:
                with connect() as conn:
                    scan = _scan(conn, src)
                    queue = _queue(conn, src["account_id"])
                res.update(scan)
                for f in queue:
                    first = summary["imported"] + summary["failed"] == 0
                    if time.monotonic() + _time_needed(f["size"]) > deadline and not first:
                        backlog = True
                        break
                    out = _process_file(src, f)
                    res["files"].append(out)
                    summary["imported" if out["status"] == "complete" else "failed"] += 1
                done = [x for x in res["files"] if x["status"] == "complete"]
                bad = [x for x in res["files"] if x["status"] != "complete"]
                if bad:
                    status = "partial" if done else "error"
                    message = f"{len(bad)} file{'s' if len(bad) != 1 else ''} failed: {bad[0]['name']}: {bad[0]['message']}"
                elif done:
                    message = f"Imported {len(done)} file{'s' if len(done) != 1 else ''}"
                else:
                    message = f"No new files ({scan['folder_files']} in folder)"
                if backlog:
                    message += ". More files waiting, they continue on the next check"
            except Exception as exc:
                status, message = "error", str(exc)[:500]
            res.update(status=status, message=message)
            with connect() as conn:
                conn.execute("""update sharepoint_sources set last_checked_at=now(), last_status=%s, last_message=%s, backlog=%s
                                where account_id=%s""", [status, message, backlog, src["account_id"]])
            summary["customers"].append(res)
            summary["checked"] += 1
        summary["message"] = (f"Checked {summary['checked']} customer{'s' if summary['checked'] != 1 else ''}, "
                              f"imported {summary['imported']} file{'s' if summary['imported'] != 1 else ''}"
                              + (f", {summary['failed']} failed" if summary["failed"] else ""))
    finally:
        with connect() as conn:
            conn.execute("""update sharepoint_runs set finished_at=now(), checked=%s, imported=%s, failed=%s, message=%s
                            where run_id=%s""", [summary["checked"], summary["imported"], summary["failed"],
                                                  summary.get("message"), run["run_id"]])
        _unlock(owner)
    summary["seconds"] = round(time.monotonic() - t0, 1)
    return summary

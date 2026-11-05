"""Check each customer's SharePoint folder and import new files.

Called by the scheduler (GET /api/sync/run with the CRON_SECRET) about once an hour, and
by "Check now" in the app. Folders and the execution log are checked once a day, on the first
scheduler call after the daily check time (for example 13:00 PKT). Files are imported oldest first. When time runs short the rest
are left for the next run (the customer stays due until its backlog is cleared).
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import sharepoint as sp
from .db import connect
from .filereader import FileFormatError, read_file, supported
from .importer import ImportRejected, import_parsed

MAX_ATTEMPTS = 3
STALE_PROCESSING = timedelta(minutes=20)
UPLOADER = "SharePoint (automatic)"
TIMEZONES = {"UTC": timezone.utc, "PKT": ZoneInfo("Asia/Karachi")}
TZ_LABEL = {"UTC": "UTC", "PKT": "PKT (UTC+5)"}
DEFAULT_SETTINGS = {"run_hour": 13, "run_minute": 0, "run_tz": "PKT"}
LOG_SUFFIXES = (".log", ".txt")
RUN_STALE = timedelta(hours=2)
LOG_RETRY = timedelta(hours=6)    # after the check time, look for a fresh log every hour for this long   # a run with no "run finished" line after this long did not finish


def _now() -> datetime:
    return datetime.now(timezone.utc)


def get_settings(conn) -> dict:
    r = conn.execute("select value from app_settings where key='sharepoint_sync'").fetchone()
    s = dict(DEFAULT_SETTINGS)
    if r:
        try:
            saved = json.loads(r["value"])
            s.update({k: v for k, v in saved.items() if k != "interval_hours"})
        except ValueError:
            pass
    if s.get("run_tz") not in TIMEZONES:
        s["run_tz"] = DEFAULT_SETTINGS["run_tz"]
    s["run_hour"] = int(s.get("run_hour", 13)) % 24
    s["run_minute"] = int(s.get("run_minute", 0)) % 60
    s["last_slot"] = last_slot(s).isoformat()
    s["next_run_at"] = (last_slot(s) + timedelta(days=1)).isoformat()
    s["label"] = f"{s['run_hour']:02d}:{s['run_minute']:02d} {TZ_LABEL[s['run_tz']]}"
    return s


def save_settings(conn, run_hour: int, run_tz: str, user: str, run_minute: int = 0) -> dict:
    h, m = int(run_hour), int(run_minute)
    if not (0 <= h <= 23) or not (0 <= m <= 59):
        raise ValueError("Pick a time between 00:00 and 23:59.")
    if run_tz not in TIMEZONES:
        raise ValueError("Timezone must be UTC or PKT.")
    val = {"run_hour": h, "run_minute": m, "run_tz": run_tz, "updated_by": user, "updated_at": _now().isoformat()}
    conn.execute("""insert into app_settings (key, value) values ('sharepoint_sync', %s)
                    on conflict (key) do update set value = excluded.value""", [json.dumps(val)])
    return get_settings(conn)


def slot_now() -> datetime:
    with connect() as conn:
        return last_slot(get_settings(conn))


def last_slot(settings: dict, now: datetime | None = None) -> datetime:
    """The most recent daily check time at or before now, in UTC."""
    tz = TIMEZONES[settings.get("run_tz", "PKT")]
    local = (now or _now()).astimezone(tz)
    slot = local.replace(hour=int(settings.get("run_hour", 13)), minute=int(settings.get("run_minute", 0)),
                         second=0, microsecond=0)
    if slot > local:
        slot -= timedelta(days=1)
    return slot.astimezone(timezone.utc)


# ----------------------------------------------------------------------------- execution log settings
def get_log_source(conn) -> dict | None:
    r = conn.execute("select value from app_settings where key='execution_log'").fetchone()
    if not r:
        return None
    try:
        return json.loads(r["value"])
    except ValueError:
        return None


def _save_log_source(conn, val: dict | None) -> None:
    if val is None:
        conn.execute("delete from app_settings where key='execution_log'")
        return
    conn.execute("""insert into app_settings (key, value) values ('execution_log', %s)
                    on conflict (key) do update set value = excluded.value""", [json.dumps(val, default=str)])


def _pick_log(files: list[dict]) -> dict | None:
    logs = [f for f in files if f["name"].lower().endswith(LOG_SUFFIXES)]
    return max(logs, key=lambda f: f.get("modified_at") or "", default=None)


def set_log_folder(url: str, user: str) -> dict:
    it = sp.resolve(url)
    files = sp.list_files(it["drive_id"], it["item_id"])
    log = _pick_log(files)
    val = {"folder_url": url, "drive_id": it["drive_id"], "item_id": it["item_id"], "folder_name": it["name"],
           "log_name": log["name"] if log else None, "ctag": None, "last_read_at": None, "last_status": None,
           "last_message": None, "updated_by": user, "updated_at": _now().isoformat()}
    with connect() as conn:
        _save_log_source(conn, val)
    return {"folder_name": it["name"], "log_name": val["log_name"], "files": len(files)}


def read_execution_log(force: bool = False) -> dict:
    """Download the newest log in the execution log folder and store its runs.
    Returns {status, message, runs, no_activity_marked, accounts_rescored}."""
    from . import execlog
    with connect() as conn:
        src = get_log_source(conn)
    if not src:
        return {"status": "off", "message": "No execution log folder set"}
    out = {"status": "ok", "message": None, "runs": 0, "no_activity_marked": 0, "accounts_rescored": []}
    try:
        try:
            files = sp.list_files(src["drive_id"], src["item_id"])
        except sp.GraphError as exc:
            if exc.status != 404:
                raise
            it = sp.resolve(src["folder_url"])
            src.update(drive_id=it["drive_id"], item_id=it["item_id"], folder_name=it["name"])
            files = sp.list_files(src["drive_id"], src["item_id"])
        log = _pick_log(files)
        if not log:
            out.update(status="error", message="No .log file in the execution log folder")
        elif not force and log["ctag"] and log["ctag"] == src.get("ctag"):
            out["message"] = f"{log['name']} has not changed since the last read"
            out["status"] = "unchanged"
        else:
            fd, path = tempfile.mkstemp(suffix=".log", prefix="exec_")
            os.close(fd)
            try:
                sp.download(src["drive_id"], log["item_id"], path)
                with open(path, "rb") as fh:
                    text = fh.read().decode("utf-8", errors="replace")
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
            stored = store_runs(execlog.parse(text), log["name"])
            out.update(stored)
            src.update(log_name=log["name"], ctag=log["ctag"], log_modified_at=log.get("modified_at"))
            out["message"] = (f"Read {log['name']}: {stored['runs']} run{'s' if stored['runs'] != 1 else ''}"
                              + (f", export date {stored['export_date']}" if stored.get("export_date") else ""))
    except Exception as exc:
        out.update(status="error", message=str(exc)[:500])
    src.update(last_read_at=_now().isoformat(), last_status=out["status"], last_message=out["message"])
    with connect() as conn:
        _save_log_source(conn, src)
    return out


def store_runs(runs: list[dict], log_name: str | None) -> dict:
    """Save parsed runs. Days with 0 records are marked as no activity and those customers are rescored."""
    marked: set[int] = set()
    n_marked = 0
    latest = None
    with connect() as conn:
        known = {r["account_id"] for r in conn.execute("select account_id from accounts")}
        for r in runs:
            key = (r["started_at"] or _now()).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            status = r["status"]
            if status == "running" and r["started_at"] and _now() - r["started_at"] > RUN_STALE:
                status = "incomplete"
            conn.execute(
                """insert into execution_runs (run_key, started_at, finished_at, export_date, status, customers_expected,
                                                message, log_name, read_at)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,now())
                   on conflict (run_key) do update set finished_at=excluded.finished_at, export_date=excluded.export_date,
                     status=excluded.status, customers_expected=excluded.customers_expected, message=excluded.message,
                     log_name=excluded.log_name, read_at=now()""",
                [key, r["started_at"], r["finished_at"], r["export_date"], status, r["customers_expected"],
                 r["message"], log_name])
            before = {x["account_id"] for x in conn.execute(
                "select account_id from execution_results where run_key=%s and status='no_activity'", [key])}
            conn.execute("delete from execution_results where run_key=%s", [key])
            for b in r["results"]:
                conn.execute(
                    """insert into execution_results (run_key, account_id, customer_name, export_date, status, records,
                                                       file_name, file_url, message)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict (run_key, account_id) do update set
                         status=excluded.status, records=excluded.records, file_name=excluded.file_name,
                         file_url=excluded.file_url, message=excluded.message, export_date=excluded.export_date""",
                    [key, b["account_id"], b["customer_name"], b["export_date"], b["status"], b["records"],
                     b["file_name"], b["file_url"], b["message"]])
                if b["status"] == "no_activity" and b["export_date"] and b["account_id"] in known \
                        and b["account_id"] not in before:
                    marked.add(b["account_id"])
                    n_marked += 1
            if latest is None or (r["started_at"] and r["started_at"] > (latest["started_at"] or r["started_at"])):
                latest = r
    if marked:
        from .engine import recompute
        recompute(sorted(marked), trigger="execution log")
    return {"runs": len(runs), "no_activity_marked": n_marked, "accounts_rescored": sorted(marked),
            "export_date": (latest or {}).get("export_date")}


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
            log_src = get_log_source(conn)
        if log_src and account_id is None:
            today = slot_now()
            # read once a day; if the log has not been rewritten yet, keep looking each hour for a while
            log_due = (force or not log_src.get("last_read_at")
                       or datetime.fromisoformat(log_src["last_read_at"]) < today
                       or (log_src.get("last_status") in ("error", "unchanged") and _now() < today + LOG_RETRY))
            if log_due:
                summary["log"] = read_execution_log(force=force)
        with connect() as conn:
            slot = last_slot(get_settings(conn))
            q = """select s.*, a.name from sharepoint_sources s join accounts a using (account_id) where s.enabled"""
            args: list = []
            if account_id is not None:
                q += " and s.account_id=%s"
                args.append(account_id)
            if not force:
                # once a day: due when the last check was before today's check time
                # a folder that was never checked is picked up on the next scheduler call
                q += " and (s.backlog or s.last_checked_at is null or s.last_checked_at < %s)"
                args.append(slot)
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
                              + (f", {summary['failed']} failed" if summary["failed"] else "")
                              + (f". Execution log: {summary['log']['message']}" if summary.get("log", {}).get("message") else ""))
    finally:
        with connect() as conn:
            conn.execute("""update sharepoint_runs set finished_at=now(), checked=%s, imported=%s, failed=%s, message=%s
                            where run_id=%s""", [summary["checked"], summary["imported"], summary["failed"],
                                                  summary.get("message"), run["run_id"]])
        _unlock(owner)
    summary["seconds"] = round(time.monotonic() - t0, 1)
    return summary

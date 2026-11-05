"""Built-in scheduler: a Supabase pg_cron job that calls GET /api/sync/run every few minutes
through pg_net. It replaces GitHub Actions schedules, which GitHub can delay or drop.

The job lives in the database, so it keeps running with no external service. Calls that find
nothing due return straight away, so frequent calls cost almost nothing.
"""
from __future__ import annotations

JOB = "cs-sharepoint-sync"
EVERY = "*/5 * * * *"


def _lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def _has(conn, ext: str) -> bool:
    return bool(conn.execute("select 1 from pg_extension where extname=%s", [ext]).fetchone())


def _available(conn, ext: str) -> bool:
    return bool(conn.execute("select 1 from pg_available_extensions where name=%s", [ext]).fetchone())


def status(conn) -> dict:
    out = {"available": _available(conn, "pg_cron") and _available(conn, "pg_net"), "enabled": False,
           "every_minutes": 5, "url": None, "last_runs": [], "last_response": None}
    if not (_has(conn, "pg_cron") and _has(conn, "pg_net")):
        return out
    try:
        job = conn.execute("select jobid, schedule, command, active from cron.job where jobname=%s", [JOB]).fetchone()
    except Exception:
        return out
    if not job:
        return out
    out["enabled"] = bool(job["active"])
    cmd = job["command"] or ""
    if "url:='" in cmd:
        out["url"] = cmd.split("url:='", 1)[1].split("'", 1)[0]
    try:
        out["last_runs"] = conn.execute(
            """select status, start_time, end_time, left(return_message, 200) message from cron.job_run_details
               where jobid=%s order by start_time desc limit 3""", [job["jobid"]]).fetchall()
    except Exception:
        pass
    try:
        out["last_response"] = conn.execute(
            """select status_code, created, left(coalesce(error_msg, content::text), 200) message
               from net._http_response order by created desc limit 1""").fetchone()
    except Exception:
        pass
    return out


def enable(conn, base_url: str, secret: str) -> dict:
    for ext in ("pg_cron", "pg_net"):
        if not _has(conn, ext):
            conn.execute(f"create extension if not exists {ext}")
    url = base_url.rstrip("/") + "/api/sync/run"
    cmd = (f"select net.http_get(url:={_lit(url)}, "
           f"headers:=jsonb_build_object('Authorization', {_lit('Bearer ' + secret)}), "
           f"timeout_milliseconds:=300000) as request_id")
    # cron.schedule with an existing name replaces that job
    conn.execute("select cron.schedule(%s, %s, %s)", [JOB, EVERY, cmd])
    return status(conn)


def disable(conn) -> dict:
    if _has(conn, "pg_cron") and conn.execute("select 1 from cron.job where jobname=%s", [JOB]).fetchone():
        conn.execute("select cron.unschedule(%s)", [JOB])
    return status(conn)

"""FastAPI app. Runs on Vercel (api/index.py) and locally (uvicorn app.main:app)."""
from __future__ import annotations

import csv
import io
import os
import secrets
from collections import defaultdict
from datetime import timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import config as C
from .db import connect, ensure_schema
from .engine import recompute
from .ingest import add_rows, complete_upload, create_upload
from .normalize import ALL_OBJECT_COLUMNS, KEEP_COLUMNS

app = FastAPI(title="Customer Health Engine", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_schema_ready = False
API_VERSION = 2  # 2 = multi-customer (adds /api/customers, per-customer uploads)


@app.middleware("http")
async def guard(request: Request, call_next):
    global _schema_ready
    path = request.url.path
    if path.startswith("/api/") and path != "/api/ping":
        key = os.environ.get("DASHBOARD_KEY")
        if key and not secrets.compare_digest(request.headers.get("x-dashboard-key", ""), key):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        if not _schema_ready and os.environ.get("AUTO_MIGRATE", "1") == "1":
            try:
                ensure_schema()
                _schema_ready = True
            except Exception as exc:  # surface config problems clearly
                return JSONResponse({"detail": f"Database not reachable: {exc}"}, status_code=503)
    return await call_next(request)


def _err(exc: Exception, code: int = 400):
    raise HTTPException(status_code=code, detail=str(exc))


# ----------------------------------------------------------------------------- meta
@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.get("/api/status")
def status():
    with connect() as conn:
        r = conn.execute(
            """select (select count(*) from accounts) accounts, (select count(*) from events) events,
                      (select max(activity_date) from daily_activity) data_through,
                      (select min(activity_date) from daily_activity) data_from,
                      (select count(*) from uploads where status='complete') uploads""").fetchone()
    return {**r, "api_version": API_VERSION, "auth_required": bool(os.environ.get("DASHBOARD_KEY")), "keep_columns": KEEP_COLUMNS}


def _customer_meta(conn) -> dict[int, dict]:
    """Per customer: data range, event count and last upload, used for freshness."""
    rows = conn.execute(
        """select a.account_id,
                  (select min(activity_date) from daily_activity d where d.account_id=a.account_id) data_from,
                  (select max(activity_date) from daily_activity d where d.account_id=a.account_id) data_through,
                  (select count(*) from events e where e.account_id=a.account_id) events,
                  (select max(coalesce(u.completed_at, u.created_at)) from uploads u
                    where u.status='complete' and (a.account_id = any(u.account_ids) or u.target_account_id=a.account_id)) last_upload,
                  (select count(*) from uploads u
                    where u.status='complete' and (a.account_id = any(u.account_ids) or u.target_account_id=a.account_id)) uploads
           from accounts a""").fetchall()
    return {r["account_id"]: r for r in rows}


# ----------------------------------------------------------------------------- uploads
class NewUpload(BaseModel):
    filename: str | None = None
    account_id: int | None = None       # upload into this customer; rows for other accounts are rejected
    customer_name: str | None = None    # name for a new customer created by this upload


class RowChunk(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list)


@app.post("/api/uploads")
def api_create_upload(body: NewUpload):
    try:
        return create_upload(body.filename, body.account_id, body.customer_name)
    except ValueError as exc:
        _err(exc, 404)


@app.post("/api/uploads/{upload_id}/rows")
def api_add_rows(upload_id: int, body: RowChunk):
    if len(body.rows) > 5000:
        _err(ValueError("max 5000 rows per chunk"))
    try:
        return add_rows(upload_id, body.rows)
    except ValueError as exc:
        _err(exc)


@app.post("/api/uploads/{upload_id}/complete")
def api_complete(upload_id: int):
    try:
        return complete_upload(upload_id)
    except ValueError as exc:
        _err(exc)


@app.post("/api/uploads/csv")
async def api_upload_csv(file: UploadFile = File(...), account_id: int | None = None, customer_name: str | None = None):
    """One-shot upload for scripts and files under the host's request limit."""
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    keep = set(KEEP_COLUMNS)
    rows = [{k: v for k, v in r.items() if k in keep} for r in reader]
    try:
        up = create_upload(file.filename, account_id, customer_name)
    except ValueError as exc:
        _err(exc, 404)
    stats = {"received": 0, "inserted": 0, "duplicates": 0, "rejected": 0, "errors": []}
    for i in range(0, len(rows), 2000):
        s = add_rows(up["upload_id"], rows[i:i + 2000])
        for k in ("received", "inserted", "duplicates", "rejected"):
            stats[k] += s[k]
        stats["errors"] += s["errors"][: 5 - len(stats["errors"])]
    return {**complete_upload(up["upload_id"]), "rows": stats}


@app.get("/api/uploads")
def api_uploads(account_id: int | None = None):
    with connect() as conn:
        if account_id is None:
            return conn.execute("select * from uploads order by upload_id desc limit 100").fetchall()
        return conn.execute(
            """select * from uploads where %s = any(account_ids) or target_account_id = %s
               order by upload_id desc limit 100""", [account_id, account_id]).fetchall()


@app.post("/api/recompute")
def api_recompute():
    return recompute(None)


# ----------------------------------------------------------------------------- portfolio
def _latest_snapshots(conn) -> dict[int, dict]:
    rows = conn.execute(
        """select distinct on (account_id) * from health_snapshots order by account_id, as_of_date desc""").fetchall()
    return {r["account_id"]: r for r in rows}


@app.get("/api/portfolio")
def portfolio():
    with connect() as conn:
        accts = conn.execute("select * from accounts order by name").fetchall()
        latest = _latest_snapshots(conn)
        spark = defaultdict(list)
        for r in conn.execute(
            """select h.account_id, h.as_of_date, h.score, h.status from health_snapshots h
               where h.as_of_date > (select max(as_of_date) from health_snapshots x where x.account_id=h.account_id) - 30
               order by h.account_id, h.as_of_date"""):
            spark[r["account_id"]].append({"d": r["as_of_date"], "score": float(r["score"])})
        act = defaultdict(list)
        for r in conn.execute(
            """select account_id, activity_date d, sum(actions) actions, sum(total_events) events,
                      sum(automated_events) automated, count(distinct user_id) filter (where actor_type='user') users
               from daily_activity da
               where activity_date > (select max(activity_date) from daily_activity x where x.account_id=da.account_id) - 30
               group by 1, 2 order by 1, 2"""):
            act[r["account_id"]].append(r)
        through = conn.execute("select max(activity_date) d from daily_activity").fetchone()["d"]
        meta = _customer_meta(conn)

    out = []
    counts = {"healthy": 0, "watch": 0, "at_risk": 0}
    tot = {"actions_14d": 0, "actions_prev_14d": 0, "active_users_14d": 0, "events_14d": 0,
           "alarms_critical_14d": 0, "alarms_warning_14d": 0}
    for a in accts:
        s = latest.get(a["account_id"])
        if not s:
            continue
        counts[s["status"]] += 1
        for k in tot:
            tot[k] += s["metrics"].get(k) or 0
        prev = spark[a["account_id"]][-8]["score"] if len(spark[a["account_id"]]) >= 8 else None
        out.append({
            "account_id": a["account_id"], "name": a["name"], "timezone": a["timezone"],
            "score": float(s["score"]), "status": s["status"], "confidence": s["confidence"],
            "score_change_7d": round(float(s["score"]) - prev, 1) if prev is not None else None,
            "components": s["components"], "reasons": s["reasons"], "metrics": s["metrics"],
            "sparkline": spark[a["account_id"]], "activity": act[a["account_id"]],
            "as_of_date": s["as_of_date"], **_freshness(meta.get(a["account_id"])),
        })
    out.sort(key=lambda x: x["score"])
    return {"data_through": through, "counts": counts, "totals": tot, "accounts": out,
            "thresholds": {"healthy": C.HEALTHY_AT, "watch": C.WATCH_AT}}


def _freshness(m: dict | None) -> dict:
    if not m:
        return {"data_from": None, "data_through": None, "last_upload": None, "uploads": 0, "events": 0, "stale_days": None}
    from datetime import date as _date
    stale = (_date.today() - m["data_through"]).days if m["data_through"] else None
    return {"data_from": m["data_from"], "data_through": m["data_through"], "last_upload": m["last_upload"],
            "uploads": m["uploads"], "events": m["events"], "stale_days": stale}


@app.get("/api/customers")
def customers():
    """Lightweight list for the sidebar customer picker."""
    with connect() as conn:
        accts = conn.execute("select account_id, name from accounts order by lower(name)").fetchall()
        latest = _latest_snapshots(conn)
        meta = _customer_meta(conn)
    out = []
    for a in accts:
        s = latest.get(a["account_id"])
        out.append({"account_id": a["account_id"], "name": a["name"],
                    "score": float(s["score"]) if s else None, "status": s["status"] if s else None,
                    "confidence": s["confidence"] if s else None, **_freshness(meta.get(a["account_id"]))})
    return out


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: int):
    """Remove a customer and all of its stored history, then rescore the rest (peer benchmarks change)."""
    with connect() as conn:
        a = conn.execute("delete from accounts where account_id=%s returning name", [account_id]).fetchone()
        if not a:
            _err(ValueError("customer not found"), 404)
        # drop upload records that only ever held this customer's data
        conn.execute("""delete from uploads where account_ids <@ array[%s]::bigint[]
                        and (account_ids <> '{}' or target_account_id = %s)""", [account_id, account_id])
    recompute(None)
    return {"ok": True, "deleted": a["name"]}


# ----------------------------------------------------------------------------- account
@app.get("/api/accounts/{account_id}")
def account(account_id: int):
    with connect() as conn:
        a = conn.execute("select * from accounts where account_id=%s", [account_id]).fetchone()
        if not a:
            _err(ValueError("account not found"), 404)
        history = conn.execute(
            "select as_of_date d, score, status, confidence, components from health_snapshots where account_id=%s order by 1",
            [account_id]).fetchall()
        latest = conn.execute(
            "select * from health_snapshots where account_id=%s order by as_of_date desc limit 1", [account_id]).fetchone()
        daily = conn.execute(
            f"""select activity_date d,
                  sum(total_events) filter (where actor_type='user') events,
                  sum(manual_events) filter (where actor_type='user') manual,
                  sum(automated_events) filter (where actor_type='user') automated,
                  sum(actions) actions,
                  sum(created) filter (where actor_type='user') created, sum(updated) filter (where actor_type='user') updated,
                  sum(deleted) filter (where actor_type='user') deleted, sum(executed) filter (where actor_type='user') executed,
                  {', '.join(f"sum(obj_{o}) filter (where actor_type='user') {o}" for o in ALL_OBJECT_COLUMNS)},
                  sum(obj_other) filter (where actor_type='user') other,
                  count(distinct user_id) filter (where actor_type='user') active_users,
                  sum(est_sessions) sessions,
                  sum(alarms_total) alarms, sum(alarms_critical) alarms_critical, sum(alarms_warning) alarms_warning,
                  sum(dq_runs) dq_runs
                from daily_activity where account_id=%s group by 1 order by 1""", [account_id]).fetchall()
        matrix = conn.execute(
            """select d.action, d.object_type, sum(d.events) events, sum(d.manual_events) manual
               from daily_activity_detail d join account_users u
                 on u.account_id=d.account_id and u.user_id=d.user_id and not u.is_system
               where d.account_id=%s group by 1, 2""", [account_id]).fetchall()
        users = conn.execute(
            """select da.user_id, max(da.user_name) user_name, max(da.actor_type) actor_type,
                      min(da.activity_date) first_day, max(da.activity_date) last_day,
                      count(*) active_days, sum(da.total_events) events, sum(da.manual_events) manual,
                      sum(da.automated_events) automated, sum(da.actions) actions, sum(da.est_sessions) sessions,
                      sum(da.created) created, sum(da.updated) updated, sum(da.deleted) deleted, sum(da.executed) executed,
                      max(da.last_activity) last_activity
               from daily_activity da where da.account_id=%s group by 1 order by sum(da.actions) desc nulls last""",
            [account_id]).fetchall()
        user_daily = conn.execute(
            "select user_id, activity_date d, actions, total_events events from daily_activity where account_id=%s and actor_type='user'",
            [account_id]).fetchall()
        hours = conn.execute(
            """select extract(isodow from (ts at time zone %s))::int dow, extract(hour from (ts at time zone %s))::int hr,
                      count(*) events, count(distinct transaction_id) filter (where not is_automated) actions
               from events where account_id=%s and actor_type='user' and not is_duplicate group by 1, 2""",
            [a["timezone"], a["timezone"], account_id]).fetchall()
        alarms = conn.execute(
            """select ts, entity_name, alarm_severity, alarm_type, alarm_status from events
               where account_id=%s and object_type='alarms' and not is_duplicate order by ts desc limit 50""",
            [account_id]).fetchall()
        dq = conn.execute(
            """select ts, entity_name, user_name, dq_exceptions, dq_total, dq_alert from events
               where account_id=%s and object_type='dq_rules' and action='executed' and not is_duplicate
               order by ts desc limit 50""", [account_id]).fetchall()
        top_objects = conn.execute(
            """select entity_name, object_type, count(*) events, max(ts) last_ts from events
               where account_id=%s and actor_type='user' and not is_duplicate and not is_automated and entity_name is not null
               group by 1, 2 order by 3 desc limit 10""", [account_id]).fetchall()
        meta = _customer_meta(conn).get(account_id)
        quality = conn.execute(
            """select count(*) total, count(*) filter (where is_duplicate) duplicates,
                      count(*) filter (where is_automated) automated, min(ts) min_ts, max(ts) max_ts
               from events where account_id=%s""", [account_id]).fetchone()

    ud = defaultdict(list)
    for r in user_daily:
        ud[r["user_id"]].append({"d": r["d"], "actions": r["actions"], "events": r["events"]})
    for u in users:
        u["daily"] = sorted(ud.get(u["user_id"], []), key=lambda x: x["d"])
    return {"account": a, "latest": latest, "history": history, "daily": daily, "matrix": matrix, "users": users,
            "hours": hours, "alarms": alarms, "dq_runs": dq, "top_objects": top_objects, "quality": quality,
            "freshness": _freshness(meta),
            "thresholds": {"healthy": C.HEALTHY_AT, "watch": C.WATCH_AT}}


class AccountPatch(BaseModel):
    name: str | None = None
    timezone: str | None = None
    licensed_seats: int | None = None


@app.patch("/api/accounts/{account_id}")
def patch_account(account_id: int, body: AccountPatch):
    if body.timezone:
        try:
            ZoneInfo(body.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            _err(ValueError("unknown timezone"))
    sets, vals = [], []
    for k in ("name", "timezone", "licensed_seats"):
        v = getattr(body, k)
        if v is not None:
            sets.append(f"{k}=%s")
            vals.append(v if not (k == "licensed_seats" and v <= 0) else None)
    if not sets:
        _err(ValueError("nothing to update"))
    with connect() as conn:
        conn.execute(f"update accounts set {', '.join(sets)}, updated_at=now() where account_id=%s", vals + [account_id])
    if body.timezone is not None or body.licensed_seats is not None:
        recompute([account_id])
    return {"ok": True}


SUMMARY_COLS = [
    "account_id", "account_name", "activity_date", "actor_type", "user_id", "user_name", "total_events",
    "manual_events", "automated_events", "actions", "created", "updated", "deleted", "executed",
    *[f"obj_{o}" for o in ALL_OBJECT_COLUMNS], "obj_other", "alarms_total", "alarms_critical", "alarms_warning",
    "alarms_open", "dq_runs", "dq_runs_with_exceptions", "distinct_objects", "transactions", "first_activity", "last_activity",
    "active_minutes", "est_sessions", "max_events_per_minute",
]


def _daily_rows(account_id: int | None):
    q = """select da.*, a.name account_name from daily_activity da join accounts a using (account_id)"""
    with connect() as conn:
        if account_id is None:
            return conn.execute(q + " order by account_id, activity_date, actor_type, user_id").fetchall()
        return conn.execute(q + " where account_id=%s order by activity_date, actor_type, user_id", [account_id]).fetchall()


@app.get("/api/accounts/{account_id}/daily")
def account_daily(account_id: int):
    return _daily_rows(account_id)


@app.get("/api/export/daily.csv")
def export_daily(account_id: int | None = None):
    rows = _daily_rows(account_id)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=SUMMARY_COLS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    name = f"daily_activity_{account_id or 'all'}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/model")
def model():
    with connect() as conn:
        run = conn.execute("select * from calibration_runs order by run_id desc limit 1").fetchone()
    return {"weights": C.WEIGHTS, "healthy_at": C.HEALTHY_AT, "watch_at": C.WATCH_AT,
            "auto_tx_per_minute": C.AUTO_TX_PER_MINUTE, "auto_sustained_per_minute": C.AUTO_SUSTAINED_PER_MINUTE,
            "session_gap_minutes": C.SESSION_GAP_MINUTES, "current_window": C.CURRENT_WINDOW, "baseline_windows": C.BASELINE_WINDOWS,
            "calibrating_days": C.CALIBRATING_DAYS, "calibrated_days": C.CALIBRATED_DAYS,
            "latest_run": run}


# ----------------------------------------------------------------------------- static (local dev only)
PUBLIC = Path(__file__).resolve().parent.parent / "public"
if not os.environ.get("VERCEL") and PUBLIC.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")

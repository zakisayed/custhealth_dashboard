"""FastAPI app. Runs on Vercel (api/index.py) and locally (uvicorn app.main:app)."""
from __future__ import annotations

import csv
import io
import os
from collections import defaultdict
from datetime import timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from urllib.parse import parse_qsl, urlencode
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import auth
from . import config as C
from .db import connect, ensure_schema
from .engine import recompute
from .ingest import add_rows, complete_upload, create_upload, set_user_emails
from .normalize import ALL_OBJECT_COLUMNS, KEEP_COLUMNS

class VercelPathFix:
    """Restore the original /api/... path when Vercel hands the request over as /api/index.

    Vercel may run this app through api/index.py (legacy functions + vercel.json rewrite to
    /api/index?__path=...) or detect app/main.py directly (FastAPI preset). Either way the
    rewrite can leave FastAPI seeing /api/index, so put the real path back before routing.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path", "").rstrip("/") in ("/api/index", "/api/index.py", "/api"):
            pairs = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
            forced = next((v for k, v in pairs if k == "__path"), None)
            path = "/api/" + forced.lstrip("/") if forced else "/api/status"
            rest = urlencode([(k, v) for k, v in pairs if k != "__path"])
            scope = {**scope, "path": path, "raw_path": path.encode(), "query_string": rest.encode("latin-1")}
        elif scope["type"] == "http" and b"__path=" in scope.get("query_string", b""):
            pairs = parse_qsl(scope["query_string"].decode("latin-1"), keep_blank_values=True)
            scope = {**scope, "query_string": urlencode([(k, v) for k, v in pairs if k != "__path"]).encode("latin-1")}
        await self.app(scope, receive, send)


app = FastAPI(title="Customer Health Engine", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_schema_ready = False
API_VERSION = 5  # 4 = SharePoint folder watch; 3 = login and users; 2 = multi-customer (adds /api/customers, per-customer uploads)


PUBLIC_PATHS = {"/api/ping", "/api/auth/login", "/api/sync/run"}  # sync/run checks CRON_SECRET itself
# reachable while the user still has to replace a temporary password
PASSWORD_CHANGE_PATHS = {"/api/auth/me", "/api/auth/change-password", "/api/auth/logout"}


def _admin_only(method: str, path: str) -> bool:
    if path.startswith("/api/users"):
        return True
    if path.startswith("/api/model") and method != "GET":
        return True
    if "/sharepoint" in path and method != "GET":
        return True
    # removing a customer or editing its settings
    return method in ("DELETE", "PATCH") and path.startswith("/api/accounts/")


@app.middleware("http")
async def guard(request: Request, call_next):
    global _schema_ready
    path = request.url.path
    if not path.startswith("/api/") or path == "/api/ping" or request.method == "OPTIONS":
        return await call_next(request)
    if not _schema_ready and os.environ.get("AUTO_MIGRATE", "1") == "1":
        try:
            ensure_schema()
            with connect() as conn:
                auth.ensure_admin(conn)
            _schema_ready = True
        except Exception as exc:  # surface config problems clearly
            return JSONResponse({"detail": f"Database not reachable: {exc}"}, status_code=503)
    if path in PUBLIC_PATHS:
        return await call_next(request)
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else None
    try:
        with connect() as conn:
            user = auth.user_from_token(conn, token)
            C.load_model(conn)
    except auth.AuthFailure as exc:
        return JSONResponse({"detail": str(exc), "code": "auth_required"}, status_code=401)
    except Exception as exc:
        return JSONResponse({"detail": f"Database not reachable: {exc}"}, status_code=503)
    if user["must_change_password"] and path not in PASSWORD_CHANGE_PATHS:
        return JSONResponse({"detail": "Set a new password to continue.", "code": "password_change_required"},
                            status_code=403)
    if _admin_only(request.method, path) and user["role"] != "admin":
        return JSONResponse({"detail": "Only the admin can do this.", "code": "admin_only"}, status_code=403)
    request.state.user = user
    return await call_next(request)


# Must be registered after guard: the last middleware added is the outermost, so the real
# /api/... path is restored before guard checks PUBLIC_PATHS (Vercel sends /api/index?__path=...).
app.add_middleware(VercelPathFix)


def _err(exc: Exception, code: int = 400):
    raise HTTPException(status_code=code, detail=str(exc))


# ----------------------------------------------------------------------------- meta
@app.get("/api/ping")
def ping():
    return {"ok": True}

# ----------------------------------------------------------------------------- login and users
class LoginBody(BaseModel):
    email: str
    password: str


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


class NewUserBody(BaseModel):
    email: str
    temp_password: str | None = None


class ResetBody(BaseModel):
    temp_password: str | None = None


def _auth_call(fn, *args):
    try:
        return fn(*args)
    except auth.AuthFailure as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


@app.post("/api/auth/login")
def api_login(body: LoginBody):
    with connect() as conn:
        user, token = _auth_call(auth.login, conn, body.email, body.password)
        return {"token": token, "user": auth.public_user(user)}


@app.get("/api/auth/me")
def api_me(request: Request):
    return auth.public_user(request.state.user)


@app.post("/api/auth/change-password")
def api_change_password(body: ChangePasswordBody, request: Request):
    with connect() as conn:
        user, token = _auth_call(auth.change_password, conn, request.state.user, body.current_password, body.new_password)
        return {"token": token, "user": auth.public_user(user)}


@app.post("/api/auth/logout")
def api_logout():
    return {"ok": True}   # tokens are stateless; the browser drops its copy


@app.get("/api/users")
def api_users():
    with connect() as conn:
        rows = conn.execute("select * from app_users order by role, lower(email)").fetchall()
    return [auth.public_user(u) for u in rows]


@app.post("/api/users")
def api_create_user(body: NewUserBody, request: Request):
    with connect() as conn:
        u = _auth_call(auth.create_user, conn, request.state.user, body.email, body.temp_password)
        return auth.public_user(u)


@app.post("/api/users/{user_id}/reset-password")
def api_reset_password(user_id: int, body: ResetBody):
    with connect() as conn:
        return auth.public_user(_auth_call(auth.reset_password, conn, user_id, body.temp_password))


@app.delete("/api/users/{user_id}")
def api_delete_user(user_id: int, request: Request):
    with connect() as conn:
        u = _auth_call(auth.delete_user, conn, request.state.user, user_id)
        return {"ok": True, "deleted": u["email"]}



@app.get("/api/status")
def status():
    with connect() as conn:
        r = conn.execute(
            """select (select count(*) from accounts) accounts, (select count(*) from events) events,
                      (select max(activity_date) from daily_activity) data_through,
                      (select min(activity_date) from daily_activity) data_from,
                      (select count(*) from uploads where status='complete') uploads""").fetchone()
    return {**r, "api_version": API_VERSION, "keep_columns": KEEP_COLUMNS}


def _customer_meta(conn) -> dict[int, dict]:
    """Per customer: data range, event count and last upload, used for freshness."""
    rows = conn.execute(
        """select a.account_id,
                  (select min(activity_date) from daily_activity d where d.account_id=a.account_id) data_from,
                  greatest((select max(activity_date) from daily_activity d where d.account_id=a.account_id),
                           (select max(n.activity_date) from no_activity_days n where n.account_id=a.account_id
                              and n.activity_date >= (select min(activity_date) from daily_activity d where d.account_id=a.account_id))) data_through,
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
    user_emails: list[dict[str, Any]] = Field(default_factory=list)


def _mark_uploader(up: dict, request: Request) -> None:
    user = getattr(request.state, "user", None)
    if user and up.get("upload_id"):
        with connect() as conn:
            conn.execute("update uploads set uploaded_by=%s where upload_id=%s", [user["email"], up["upload_id"]])


@app.post("/api/uploads")
def api_create_upload(body: NewUpload, request: Request):
    try:
        up = create_upload(body.filename, body.account_id, body.customer_name)
    except ValueError as exc:
        _err(exc, 404)
    _mark_uploader(up, request)
    return up


@app.post("/api/uploads/{upload_id}/rows")
def api_add_rows(upload_id: int, body: RowChunk):
    if len(body.rows) > 5000:
        _err(ValueError("max 5000 rows per chunk"))
    try:
        out = add_rows(upload_id, body.rows)
        if body.user_emails:
            out["emails_set"] = set_user_emails(upload_id, body.user_emails)
        return out
    except ValueError as exc:
        _err(exc)


@app.post("/api/uploads/{upload_id}/complete")
def api_complete(upload_id: int):
    try:
        return complete_upload(upload_id)
    except ValueError as exc:
        _err(exc)


@app.post("/api/uploads/csv")
async def api_upload_csv(request: Request, file: UploadFile = File(...), account_id: int | None = None,
                         customer_name: str | None = None):
    """One-shot upload for scripts and files under the host's request limit."""
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    keep = set(KEEP_COLUMNS)
    rows = [{k: v for k, v in r.items() if k in keep} for r in reader]
    try:
        up = create_upload(file.filename, account_id, customer_name)
    except ValueError as exc:
        _err(exc, 404)
    _mark_uploader(up, request)
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


# ----------------------------------------------------------------------------- SharePoint folder watch
from . import sharepoint as SP  # noqa: E402
from . import sync as SYNC  # noqa: E402


def _cron_ok(request: Request) -> bool:
    import hmac
    secret = (os.environ.get("CRON_SECRET") or "").strip()
    if not secret:
        return False
    header = request.headers.get("authorization", "")
    given = header[7:].strip() if header.lower().startswith("bearer ") else ""
    return hmac.compare_digest(given.encode(), secret.encode())


@app.api_route("/api/sync/run", methods=["GET", "POST"])
def api_sync_run(request: Request):
    """Scheduler entry point (Vercel Cron or GitHub Actions). Needs Authorization: Bearer <CRON_SECRET>."""
    if not (os.environ.get("CRON_SECRET") or "").strip():
        raise HTTPException(status_code=503, detail="CRON_SECRET is not set in the environment.")
    if not _cron_ok(request):
        raise HTTPException(status_code=401, detail="Bad or missing CRON_SECRET.")
    return SYNC.run_sync("cron")


def _source_row(r: dict, settings: dict) -> dict:
    nxt = None
    if r.get("enabled"):
        nxt = "next run" if r.get("backlog") or not r.get("last_checked_at") else settings["next_run_at"]
    return {**r, "next_check_at": nxt}


def _execution(conn, run_key: str | None = None) -> dict | None:
    """One export run with its per-customer results, linked to what the dashboard did with each file."""
    run = conn.execute(
        "select * from execution_runs where (%s::text is null or run_key=%s) order by started_at desc nulls last limit 1",
        [run_key, run_key]).fetchone()
    if not run:
        return None
    results = conn.execute(
        """select r.*, a.name dashboard_name, (s.account_id is not null) watched, s.enabled watch_enabled,
                  f.status file_status, f.message file_message, f.processed_at file_processed_at,
                  exists (select 1 from no_activity_days n where n.account_id=r.account_id
                          and n.activity_date=r.export_date) marked_no_activity
           from execution_results r
           left join accounts a on a.account_id=r.account_id
           left join sharepoint_sources s on s.account_id=r.account_id
           left join lateral (select status, message, processed_at from sharepoint_files f
                              where f.account_id=r.account_id and f.name=r.file_name
                              order by first_seen_at desc limit 1) f on true
           where r.run_key=%s order by lower(r.customer_name)""", [run["run_key"]]).fetchall()
    counts = {k: sum(1 for x in results if x["status"] == k) for k in ("success", "no_activity", "failed")}
    return {**run, "results": results, "counts": counts,
            "records": sum(x["records"] or 0 for x in results)}


@app.get("/api/sharepoint")
def api_sharepoint():
    with connect() as conn:
        settings = SYNC.get_settings(conn)
        rows = conn.execute(
            """select s.*, a.name,
                      (select count(*) from sharepoint_files f where f.account_id=s.account_id and f.status='complete') files_imported,
                      (select count(*) from sharepoint_files f where f.account_id=s.account_id and f.status='failed') files_failed,
                      (select count(*) from sharepoint_files f where f.account_id=s.account_id and f.status in ('pending','processing')) files_waiting
               from sharepoint_sources s join accounts a using (account_id) order by lower(a.name)""").fetchall()
        runs = conn.execute("select * from sharepoint_runs order by run_id desc limit 10").fetchall()
        log = SYNC.get_log_source(conn)
        execution = _execution(conn)
        history = conn.execute(
            """select r.run_key, r.started_at, r.export_date, r.status,
                      (select count(*) from execution_results x where x.run_key=r.run_key and x.status='failed') failed
               from execution_runs r order by r.started_at desc nulls last limit 60""").fetchall()
    return {"credentials": SP.config_status(), "configured": SP.configured(),
            "cron_secret_set": bool((os.environ.get("CRON_SECRET") or "").strip()),
            "settings": settings, "timezones": SYNC.TZ_LABEL,
            "sources": [_source_row(r, settings) for r in rows], "runs": runs,
            "log": log, "execution": execution, "execution_history": history}


@app.get("/api/sharepoint/executions")
def api_sharepoint_execution(run_key: str):
    with connect() as conn:
        ex = _execution(conn, run_key)
    if not ex:
        _err(ValueError("run not found"), 404)
    return ex


class SyncSettingsBody(BaseModel):
    run_hour: int
    run_minute: int = 0
    run_tz: str = "PKT"


@app.put("/api/sharepoint/settings")
def api_sharepoint_settings(body: SyncSettingsBody, request: Request):
    try:
        with connect() as conn:
            return SYNC.save_settings(conn, body.run_hour, body.run_tz, request.state.user["email"], body.run_minute)
    except ValueError as exc:
        _err(exc)


class LogBody(BaseModel):
    folder_url: str


@app.put("/api/sharepoint/log")
def api_sharepoint_log(body: LogBody, request: Request):
    url = body.folder_url.strip()
    if not url:
        _err(ValueError("Paste the execution log folder link."))
    try:
        res = SYNC.set_log_folder(url, request.state.user["email"])
    except SP.GraphError as exc:
        _err(exc)
    read = SYNC.read_execution_log(force=True) if res["log_name"] else None
    return {"ok": True, **res, "read": read}


@app.delete("/api/sharepoint/log")
def api_sharepoint_log_delete():
    with connect() as conn:
        SYNC._save_log_source(conn, None)
    return {"ok": True}


@app.post("/api/sharepoint/log/read")
def api_sharepoint_log_read():
    out = SYNC.read_execution_log(force=True)
    if out["status"] == "off":
        _err(ValueError("Set the execution log folder first."))
    return out


@app.post("/api/sharepoint/test")
def api_sharepoint_test():
    try:
        SP.token()
    except SP.GraphError as exc:
        _err(exc)
    return {"ok": True, "message": "Signed in to Microsoft Graph."}


@app.post("/api/sharepoint/run")
def api_sharepoint_run():
    return SYNC.run_sync("manual", force=True)


@app.get("/api/accounts/{account_id}/sharepoint")
def api_account_sharepoint(account_id: int):
    with connect() as conn:
        settings = SYNC.get_settings(conn)
        src = conn.execute("select * from sharepoint_sources where account_id=%s", [account_id]).fetchone()
        files = conn.execute(
            """select item_id, name, size, modified_at, status, message, upload_id, rows_new, rows_duplicate, attempts,
                      web_url, first_seen_at, processed_at
               from sharepoint_files where account_id=%s order by coalesce(processed_at, first_seen_at) desc limit 100""",
            [account_id]).fetchall()
    return {"configured": SP.configured(), "settings": settings,
            "source": _source_row(src, settings) if src else None, "files": files}


class SourceBody(BaseModel):
    folder_url: str
    enabled: bool = True
    include_existing: bool = True


@app.put("/api/accounts/{account_id}/sharepoint")
def api_account_sharepoint_save(account_id: int, body: SourceBody, request: Request):
    url = body.folder_url.strip()
    with connect() as conn:
        if not conn.execute("select 1 from accounts where account_id=%s", [account_id]).fetchone():
            _err(ValueError("customer not found"), 404)
        old = conn.execute("select * from sharepoint_sources where account_id=%s", [account_id]).fetchone()
    try:
        it = SP.resolve(url)
        files = SP.list_files(it["drive_id"], it["item_id"])
    except SP.GraphError as exc:
        _err(exc)
    same = bool(old) and old["folder_url"] == url
    with connect() as conn:
        if old and not same:
            conn.execute("delete from sharepoint_files where account_id=%s and status in ('baseline','skipped','pending')",
                         [account_id])
        conn.execute(
            """insert into sharepoint_sources (account_id, folder_url, drive_id, item_id, folder_name, enabled,
                                                 include_existing, baseline_done, created_by)
               values (%s,%s,%s,%s,%s,%s,%s,false,%s)
               on conflict (account_id) do update set folder_url=excluded.folder_url, drive_id=excluded.drive_id,
                 item_id=excluded.item_id, folder_name=excluded.folder_name, enabled=excluded.enabled,
                 include_existing=excluded.include_existing,
                 baseline_done = case when sharepoint_sources.folder_url = excluded.folder_url
                                      then sharepoint_sources.baseline_done else false end,
                 last_checked_at = case when sharepoint_sources.folder_url = excluded.folder_url
                                        then sharepoint_sources.last_checked_at else null end""",
            [account_id, url, it["drive_id"], it["item_id"], it["name"], body.enabled, body.include_existing,
             request.state.user["email"]])
    ok = [f for f in files if SYNC.supported(f["name"])]
    return {"ok": True, "folder_name": it["name"], "web_url": it["web_url"], "files": len(files),
            "supported_files": len(ok), "sample": [f["name"] for f in ok[:5]]}


@app.delete("/api/accounts/{account_id}/sharepoint")
def api_account_sharepoint_delete(account_id: int):
    with connect() as conn:
        conn.execute("delete from sharepoint_files where account_id=%s and status <> 'complete'", [account_id])
        conn.execute("delete from sharepoint_sources where account_id=%s", [account_id])
    return {"ok": True}


@app.post("/api/accounts/{account_id}/sharepoint/check")
def api_account_sharepoint_check(account_id: int):
    with connect() as conn:
        src = conn.execute("select enabled from sharepoint_sources where account_id=%s", [account_id]).fetchone()
    if not src:
        _err(ValueError("No SharePoint folder is set for this customer."))
    if not src["enabled"]:
        _err(ValueError("Watching is turned off for this customer. Turn it on in Settings first."))
    return SYNC.run_sync("manual", account_id=account_id, force=True)


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
        through = conn.execute("""select greatest((select max(activity_date) from daily_activity),
                                                  (select max(activity_date) from no_activity_days)) d""").fetchone()["d"]
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
                      max(da.last_activity) last_activity,
                      (select u.email from account_users u where u.account_id=da.account_id and u.user_id=da.user_id) email
               from daily_activity da where da.account_id=%s group by da.account_id, da.user_id order by sum(da.actions) desc nulls last""",
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
        quiet = conn.execute(
            """select n.activity_date d from no_activity_days n
               where n.account_id=%s and n.activity_date >= (select min(activity_date) from daily_activity where account_id=%s)
                 and not exists (select 1 from daily_activity x where x.account_id=n.account_id
                                 and x.activity_date=n.activity_date and x.actor_type='user')
               order by 1""", [account_id, account_id]).fetchall()
        executions = conn.execute(
            """select r.export_date, r.status, r.records, r.message, r.file_name, e.started_at, e.run_key
               from execution_results r join execution_runs e using (run_key)
               where r.account_id=%s order by r.export_date desc nulls last, e.started_at desc limit 14""",
            [account_id]).fetchall()
        quality = conn.execute(
            """select count(*) total, count(*) filter (where is_duplicate) duplicates,
                      count(*) filter (where is_automated) automated, min(ts) min_ts, max(ts) max_ts
               from events where account_id=%s""", [account_id]).fetchone()

    ud = defaultdict(list)
    for r in user_daily:
        ud[r["user_id"]].append({"d": r["d"], "actions": r["actions"], "events": r["events"]})
    for u in users:
        u["daily"] = sorted(ud.get(u["user_id"], []), key=lambda x: x["d"])
    # Always send plain YYYY-MM-DD for day fields so charts get the same shape on every database driver.
    for r in history:
        r["d"] = _day(r["d"])
    for r in daily:
        r["d"] = _day(r["d"])
    if latest:
        latest["as_of_date"] = _day(latest["as_of_date"])
    return {"account": a, "latest": latest, "history": history, "daily": daily, "matrix": matrix, "users": users,
            "hours": hours, "alarms": alarms, "dq_runs": dq, "top_objects": top_objects, "quality": quality,
            "freshness": _freshness(meta), "no_activity_days": [_day(r["d"]) for r in quiet],
            "executions": [{**e, "export_date": _day(e["export_date"])} for e in executions],
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


def _day(v):
    if v is None:
        return None
    return v.isoformat()[:10] if hasattr(v, "isoformat") else str(v)[:10]


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


def _latest_scores(conn) -> dict[int, dict]:
    rows = conn.execute(
        """select distinct on (h.account_id) h.account_id, a.name, h.as_of_date, h.score, h.status, h.confidence, h.components
           from health_snapshots h join accounts a using (account_id)
           order by h.account_id, h.as_of_date desc""").fetchall()
    return {r["account_id"]: r for r in rows}


def _impact(before: dict, after: dict) -> list[dict]:
    out = []
    for aid, a in after.items():
        b = before.get(aid)
        out.append({"account_id": aid, "name": a["name"],
                    "score_before": float(b["score"]) if b else None, "status_before": b["status"] if b else None,
                    "score_after": float(a["score"]), "status_after": a["status"], "confidence": a["confidence"],
                    "components": a["components"]})
    return sorted(out, key=lambda r: r["name"].lower())


def _model_payload(conn) -> dict:
    rec = C.load_model(conn)
    run = conn.execute("select run_id, computed_at, data_through, params from calibration_runs order by run_id desc limit 1").fetchone()
    versions = conn.execute(
        "select version_id, changed_by, changed_at, note from scoring_model_versions order by version_id desc limit 10").fetchall()
    return {
        "model": C.current_model(), "defaults": C.DEFAULT_MODEL, "is_default": rec is None,
        "updated_by": rec.get("updated_by") if rec else None, "updated_at": rec.get("updated_at") if rec else None,
        "fields": {k: {"group": v[0], "label": v[1], "min": v[2], "max": v[3], "step": v[4], "unit": v[5], "help": v[6]}
                   for k, v in C.EDITABLE.items()},
        "fixed": {"current_window": C.CURRENT_WINDOW, "baseline_windows": C.BASELINE_WINDOWS,
                  "adoption_window": C.ADOPTION_WINDOW, "min_peers": C.MIN_PEERS},
        # kept for older clients
        "weights": C.WEIGHTS, "healthy_at": C.HEALTHY_AT, "watch_at": C.WATCH_AT,
        "auto_tx_per_minute": C.AUTO_TX_PER_MINUTE, "auto_sustained_per_minute": C.AUTO_SUSTAINED_PER_MINUTE,
        "session_gap_minutes": C.SESSION_GAP_MINUTES, "current_window": C.CURRENT_WINDOW,
        "baseline_windows": C.BASELINE_WINDOWS, "calibrating_days": C.CALIBRATING_DAYS, "calibrated_days": C.CALIBRATED_DAYS,
        "latest_run": run, "versions": versions,
    }


@app.get("/api/model")
def model():
    with connect() as conn:
        return _model_payload(conn)


class ModelBody(BaseModel):
    model: dict[str, Any]
    note: str | None = None


def _needs_rollup(old: dict, new: dict) -> bool:
    return any(abs(float(old[k]) - float(new[k])) > 1e-9 for k in C.CLASSIFICATION_KEYS)


@app.post("/api/model/preview")
def model_preview(body: ModelBody):
    """Score every customer with a draft model inside a transaction that is rolled back."""
    from .engine import _health, _rollup
    try:
        draft = C.validate_model(body.model)
    except ValueError as exc:
        _err(exc)
    with connect() as conn:
        C.load_model(conn)
        saved = C.current_model()
        before = _latest_scores(conn)
        try:
            C.apply_model(draft)
            if _needs_rollup(saved, draft):
                ids = [r["account_id"] for r in conn.execute("select account_id from accounts")]
                if ids:
                    _rollup(conn, ids)
            _health(conn, "preview")
            after = _latest_scores(conn)
        finally:
            conn.rollback()
            C.apply_model(saved)
    return {"model": draft, "customers": _impact(before, after)}


def _save_model(conn, m: dict | None, user: dict, note: str | None) -> None:
    from datetime import datetime, timezone
    import json
    if m is None:
        conn.execute("delete from app_settings where key='scoring_model'")
        snapshot = C.DEFAULT_MODEL
    else:
        rec = {"model": m, "updated_by": user["email"], "updated_at": datetime.now(timezone.utc).isoformat()}
        conn.execute("""insert into app_settings (key, value) values ('scoring_model', %s)
                        on conflict (key) do update set value = excluded.value""", [json.dumps(rec)])
        snapshot = m
    conn.execute("insert into scoring_model_versions (model, changed_by, note) values (%s, %s, %s)",
                 [json.dumps(snapshot), user["email"], note or ("Reset to defaults" if m is None else None)])


@app.put("/api/model")
def model_save(body: ModelBody, request: Request):
    """Save the model, then rescore every customer's full history and recalibrate."""
    try:
        m = C.validate_model(body.model)
    except ValueError as exc:
        _err(exc)
    with connect() as conn:
        before = _latest_scores(conn)
        _save_model(conn, m, request.state.user, (body.note or "").strip()[:200] or None)
    result = recompute(None, f"model change by {request.state.user['email']}")
    with connect() as conn:
        return {**_model_payload(conn), "result": result, "customers": _impact(before, _latest_scores(conn))}


@app.post("/api/model/reset")
def model_reset(request: Request):
    with connect() as conn:
        before = _latest_scores(conn)
        _save_model(conn, None, request.state.user, None)
    result = recompute(None, f"reset to defaults by {request.state.user['email']}")
    with connect() as conn:
        return {**_model_payload(conn), "result": result, "customers": _impact(before, _latest_scores(conn))}


# ----------------------------------------------------------------------------- static (local dev only)
PUBLIC = Path(__file__).resolve().parent.parent / "public"
if not os.environ.get("VERCEL") and PUBLIC.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")

"""SharePoint folder watch with Microsoft Graph faked: new files, versions, rejects, baseline, lock, auth.

Run: DATABASE_URL=... python tests/test_sharepoint.py brown_and_caldwell.csv [brown_and_caldwell.xlsx]
"""
import csv
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
sys.path.insert(0, os.path.dirname(__file__))
os.environ["CRON_SECRET"] = "test-cron-secret"
from fastapi.testclient import TestClient  # noqa: E402

from app import sharepoint as sp  # noqa: E402
from app import sync  # noqa: E402
from app.db import connect, ensure_schema  # noqa: E402
from app.main import app  # noqa: E402
from _auth import sign_in  # noqa: E402

CSV = sys.argv[1]
XLSX = sys.argv[2] if len(sys.argv) > 2 else None
tmp = tempfile.mkdtemp()

# ---- fake Graph: folders are dicts of item_id -> file record + local path
FOLDERS: dict[str, dict] = {"F1": {}, "F2": {}}


def add_file(folder, item_id, name, path, ctag="c1", modified="2026-11-01T00:00:00Z"):
    FOLDERS[folder][item_id] = {"item_id": item_id, "name": name, "size": os.path.getsize(path), "modified_at": modified,
                                "ctag": ctag, "web_url": f"https://x.sharepoint.com/{name}", "path": path}


sp.configured = lambda: True
sp.resolve = lambda url: {"drive_id": "D", "item_id": url.rsplit("/", 1)[-1], "name": url.rsplit("/", 1)[-1],
                          "web_url": url, "is_folder": True}
sp.list_files = lambda d, i: [{k: v for k, v in f.items() if k != "path"} for f in FOLDERS[i].values()]


def fake_download(d, item_id, dest):
    for f in FOLDERS.values():
        if item_id in f:
            shutil.copy(f[item_id]["path"], dest)
            return os.path.getsize(dest)
    raise sp.GraphError("missing", 404)


sp.download = fake_download

ensure_schema()
with connect() as conn:
    conn.execute("truncate sharepoint_files, sharepoint_sources, sharepoint_runs")
    conn.execute("delete from app_settings where key in ('sharepoint_lock','sharepoint_sync')")
    conn.execute("delete from accounts where account_id in (46593239, 777)")
    conn.execute("insert into accounts (account_id, name) values (46593239, 'Brown and Caldwell'), (777, 'Other Co')")

c = TestClient(app)
sign_in(c)

# wrong-account copy of the CSV, and a non-export file
wrong = os.path.join(tmp, "wrong.csv")
with open(CSV, encoding="utf-8-sig", newline="") as fi, open(wrong, "w", newline="") as fo:
    rd = csv.DictReader(fi)
    w = csv.DictWriter(fo, fieldnames=rd.fieldnames)
    w.writeheader()
    for r in rd:
        r["account_id"] = "999"
        w.writerow(r)
notes = os.path.join(tmp, "notes.txt")
open(notes, "w").write("hello")

# 1. save a folder for B&C through the API (validates through resolve/list_files)
add_file("F1", "i1", "bc_week1.csv", CSV, modified="2026-10-01T00:00:00Z")
add_file("F1", "i2", "readme.txt", notes)
r = c.put("/api/accounts/46593239/sharepoint", json={"folder_url": "https://x.sharepoint.com/sites/a/Docs/F1"})
assert r.status_code == 200, r.text
assert r.json()["supported_files"] == 1, r.json()

# 2. scheduler: bad secret, then good secret
assert c.get("/api/sync/run").status_code == 401
assert c.get("/api/sync/run", headers={"Authorization": "Bearer nope"}).status_code == 401
r = TestClient(app).get("/api/sync/run", headers={"Authorization": "Bearer test-cron-secret"})
assert r.status_code == 200, r.text
out = r.json()
print("first run:", out["message"])
assert out["imported"] == 1 and out["failed"] == 0, out
with connect() as conn:
    n = conn.execute("select count(*) n from events where account_id=46593239").fetchone()["n"]
    up = conn.execute("select uploaded_by, status from uploads order by upload_id desc limit 1").fetchone()
    emails = conn.execute("select count(*) n from account_users where account_id=46593239 and email is not null").fetchone()["n"]
    st = {r["name"]: r["status"] for r in conn.execute("select name, status from sharepoint_files")}
assert n == 2700, n
assert up == {"uploaded_by": sync.UPLOADER, "status": "complete"}, up
assert emails == 2, emails
assert st == {"bc_week1.csv": "complete", "readme.txt": "skipped"}, st

# 3. not due again until the next daily check time
out = c.get("/api/sync/run", headers={"Authorization": "Bearer test-cron-secret"}).json()
assert out["checked"] == 0, out

# 4. new file (xlsx copy, all rows already stored) + wrong account + new version of the first file
if XLSX:
    add_file("F1", "i3", "bc_week1.xlsx", XLSX, modified="2026-10-02T00:00:00Z")
add_file("F1", "i4", "other_customer.csv", wrong, modified="2026-10-03T00:00:00Z")
FOLDERS["F1"]["i1"]["ctag"] = "c2"
r = c.post("/api/accounts/46593239/sharepoint/check")
assert r.status_code == 200, r.text
out = r.json()
print("manual check:", out["message"], [(f["name"], f["status"]) for f in out["customers"][0]["files"]])
with connect() as conn:
    rows = {r["name"]: r for r in conn.execute("select * from sharepoint_files where account_id=46593239")}
    n = conn.execute("select count(*) n from events where account_id=46593239").fetchone()["n"]
assert n == 2700, n
assert rows["bc_week1.csv"]["status"] == "complete" and rows["bc_week1.csv"]["rows_duplicate"] == 2700
if XLSX:
    assert rows["bc_week1.xlsx"]["status"] == "complete" and rows["bc_week1.xlsx"]["rows_new"] == 0, rows["bc_week1.xlsx"]
assert rows["other_customer.csv"]["status"] == "failed" and "not this customer" in rows["other_customer.csv"]["message"]
assert rows["other_customer.csv"]["attempts"] >= sync.MAX_ATTEMPTS  # a reject is not retried

# 5. a rejected file is not retried
out = c.post("/api/accounts/46593239/sharepoint/check").json()
assert out["imported"] == 0 and out["failed"] == 0, out

# 6. baseline: "only new files" ignores what is already in the folder
add_file("F2", "j1", "old.csv", wrong)
r = c.put("/api/accounts/777/sharepoint", json={"folder_url": "https://x.sharepoint.com/sites/a/Docs/F2",
                                                 "include_existing": False})
assert r.status_code == 200, r.text
out = c.post("/api/accounts/777/sharepoint/check").json()
with connect() as conn:
    s = conn.execute("select status from sharepoint_files where account_id=777 and item_id='j1'").fetchone()["status"]
assert s == "baseline" and out["imported"] == 0, (s, out)

# 7. lock: a second run while one is going is refused
assert sync._lock("someone", 120)
out = c.post("/api/sharepoint/run").json()
assert out.get("busy"), out
sync._unlock("someone")

# 8. settings: daily time and timezone
assert c.put("/api/sharepoint/settings", json={"run_hour": 24, "run_tz": "PKT"}).status_code == 400
assert c.put("/api/sharepoint/settings", json={"run_hour": 9, "run_tz": "EST"}).status_code == 400
r = c.put("/api/sharepoint/settings", json={"run_hour": 13, "run_tz": "PKT"})
assert r.status_code == 200, r.text
info = c.get("/api/sharepoint").json()
assert info["settings"]["run_hour"] == 13 and info["settings"]["run_tz"] == "PKT" and len(info["sources"]) == 2, info
assert info["cron_secret_set"] is True
from datetime import datetime, timezone as _tz
st = {"run_hour": 13, "run_minute": 0, "run_tz": "PKT"}
assert sync.last_slot(st, datetime(2026, 11, 5, 9, 0, tzinfo=_tz.utc)) == datetime(2026, 11, 5, 8, 0, tzinfo=_tz.utc)
assert sync.last_slot(st, datetime(2026, 11, 5, 7, 59, tzinfo=_tz.utc)) == datetime(2026, 11, 4, 8, 0, tzinfo=_tz.utc)
st = {"run_hour": 2, "run_minute": 0, "run_tz": "UTC"}
assert sync.last_slot(st, datetime(2026, 11, 5, 1, 0, tzinfo=_tz.utc)) == datetime(2026, 11, 4, 2, 0, tzinfo=_tz.utc)

# 9. due logic: checked before today's check time = due; checked after it = not due
with connect() as conn:
    slot = sync.last_slot(sync.get_settings(conn))
    conn.execute("update sharepoint_sources set last_checked_at = %s - interval '1 minute' where account_id=46593239", [slot])
    conn.execute("update sharepoint_sources set last_checked_at = %s + interval '1 minute' where account_id=777", [slot])
out = c.get("/api/sync/run", headers={"Authorization": "Bearer test-cron-secret"}).json()
assert [x["account_id"] for x in out["customers"]] == [46593239], out

# 10. removing the folder keeps imported history
assert c.delete("/api/accounts/777/sharepoint").status_code == 200
assert c.get("/api/accounts/777/sharepoint").json()["source"] is None
print("SharePoint tests passed")

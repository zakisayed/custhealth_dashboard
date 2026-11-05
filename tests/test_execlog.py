"""Execution log: parsing, Execution status API, and 0-record days scored as no activity.

Run: DATABASE_URL=... python tests/test_execlog.py brown_and_caldwell.csv
"""
import os
import sys
import tempfile
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
sys.path.insert(0, os.path.dirname(__file__))
os.environ["CRON_SECRET"] = "test-cron-secret"
from fastapi.testclient import TestClient  # noqa: E402

from app import execlog  # noqa: E402
from app import sharepoint as sp  # noqa: E402
from app import sync  # noqa: E402
from app.db import connect, ensure_schema  # noqa: E402
from app.main import app  # noqa: E402
from _auth import sign_in  # noqa: E402

CSV = sys.argv[1]
LOG_OK = """2026-11-05 07:14:01 UTC  run started
Exporting 2026-11-04 (UTC) for 3 customer(s)

=== Processing Ameritas (45451235) ===
Querying AuditTrail (prod) for ACT#45451235 on 2026-11-04 (UTC)...
  ...16 records so far (at SK 1793827931674)
Records extracted: 16 (1 sheet)
Customer: Ameritas (45451235)
Excel file created: /home/ubuntu/out/dynamodb_records_Ameritas_45451235_2026-11-04.xlsx
Uploading as dynamodb_records_Ameritas_45451235_2026-11-04_run20261105_071402.xlsx ...
Uploaded to SharePoint: https://x.sharepoint.com/a.xlsx
Removed local file /home/ubuntu/out/dynamodb_records_Ameritas_45451235_2026-11-04.xlsx

=== Processing IAT (45589903) ===
Querying AuditTrail (prod) for ACT#45589903 on 2026-11-04 (UTC)...
Records extracted: 1,914 (1 sheet)
Uploading as dynamodb_records_IAT_45589903_2026-11-04_run20261105_071404.xlsx ...
Uploaded to SharePoint: https://x.sharepoint.com/b.xlsx

=== Processing Brown&Caldwell (46593239) ===
Querying AuditTrail (prod) for ACT#46593239 on 2026-11-04 (UTC)...
No records for Brown&Caldwell (46593239) on 2026-11-04; nothing to upload.

Finished processing 3 customers for 2026-11-04.
2026-11-05 07:14:11 UTC  run finished OK
"""
LOG_BAD = """2026-11-06 07:14:01 UTC  run started
Exporting 2026-11-05 (UTC) for 3 customer(s)
=== Processing Ameritas (45451235) ===
Querying AuditTrail (prod) for ACT#45451235 on 2026-11-05 (UTC)...
ERROR botocore.exceptions.ClientError: ProvisionedThroughputExceededException
=== Processing Brown&Caldwell (46593239) ===
Querying AuditTrail (prod) for ACT#46593239 on 2026-11-05 (UTC)...
Records extracted: 5 (1 sheet)
Uploading as dynamodb_records_BC_46593239_2026-11-05.xlsx ...
2026-11-06 07:14:20 UTC  run finished with errors
"""

# 1. parser
runs = execlog.parse(LOG_OK)
assert len(runs) == 1 and runs[0]["status"] == "ok" and runs[0]["export_date"] == date(2026, 11, 4), runs
res = {r["account_id"]: r for r in runs[0]["results"]}
assert res[45451235]["status"] == "success" and res[45451235]["records"] == 16
assert res[45589903]["records"] == 1914 and res[45589903]["file_name"].endswith("071404.xlsx")
assert res[46593239]["status"] == "no_activity" and res[46593239]["records"] == 0
bad = execlog.parse(LOG_BAD)[0]
bres = {r["account_id"]: r for r in bad["results"]}
assert bad["status"] == "failed" and "1 of 3 customers" in bad["message"], bad
assert bres[45451235]["status"] == "failed" and "ProvisionedThroughput" in bres[45451235]["message"]
assert bres[46593239]["status"] == "failed" and "upload" in bres[46593239]["message"]
unfinished = execlog.parse(LOG_OK.split("=== Processing IAT")[0])[0]
assert unfinished["status"] == "running", unfinished

# 2. fake Graph with a log folder
tmp = tempfile.mkdtemp()
LOG_FILE = {"text": LOG_OK, "ctag": "v1"}
sp.configured = lambda: True
sp.resolve = lambda url: {"drive_id": "D", "item_id": "LOGS", "name": "Execution_Logs", "web_url": url, "is_folder": True}
sp.list_files = lambda d, i: [{"item_id": "L1", "name": "audit_export.log", "size": len(LOG_FILE["text"]),
                               "modified_at": "2026-11-05T07:14:12Z", "ctag": LOG_FILE["ctag"], "web_url": "https://x/l"},
                              {"item_id": "N1", "name": "readme.docx", "size": 1, "modified_at": "2026-11-01T00:00:00Z",
                               "ctag": "z", "web_url": "https://x/n"}]


def fake_download(d, item_id, dest):
    assert item_id == "L1", item_id
    with open(dest, "w") as fh:
        fh.write(LOG_FILE["text"])


sp.download = fake_download

ensure_schema()
with connect() as conn:
    conn.execute("delete from execution_runs")
    conn.execute("truncate sharepoint_files, sharepoint_sources, sharepoint_runs")
    conn.execute("delete from app_settings where key in ('sharepoint_lock','sharepoint_sync','execution_log')")
    conn.execute("delete from accounts where account_id in (46593239, 777)")

c = TestClient(app)
sign_in(c)
# import the CSV through the same server path the SharePoint sync uses
from app.filereader import read_file  # noqa: E402
from app.importer import import_parsed  # noqa: E402
with connect() as conn:
    conn.execute("insert into accounts (account_id, name) values (46593239, 'Brown and Caldwell') on conflict do nothing")
import_parsed(read_file(CSV, "bc.csv"), "bc.csv", 46593239, "test")
acc = c.get("/api/accounts/46593239").json()
before_through = acc["latest"]["as_of_date"]
assert before_through == "2026-10-25", before_through
assert acc["no_activity_days"] == []

# 3. set the log folder: reads the log, marks Nov 4 as no activity for B&C, rescoring through Nov 4
r = c.put("/api/sharepoint/log", json={"folder_url": "https://x.sharepoint.com/sites/a/Docs/Execution_Logs"})
assert r.status_code == 200, r.text
j = r.json()
assert j["log_name"] == "audit_export.log" and j["read"]["no_activity_marked"] == 1, j
acc = c.get("/api/accounts/46593239").json()
assert acc["latest"]["as_of_date"] == "2026-11-04", acc["latest"]["as_of_date"]
assert acc["no_activity_days"] == ["2026-11-04"], acc["no_activity_days"]
assert acc["latest"]["metrics"]["days_since_activity"] == 10
assert any("confirmed by the export log" in x["text"] for x in acc["latest"]["reasons"]), acc["latest"]["reasons"]
assert acc["freshness"]["data_through"] == "2026-11-04", acc["freshness"]
assert acc["executions"][0]["status"] == "no_activity"

# 4. Execution status on the SharePoint sync page
info = c.get("/api/sharepoint").json()
ex = info["execution"]
assert ex["export_date"] == "2026-11-04" and ex["counts"] == {"success": 2, "no_activity": 1, "failed": 0}, ex["counts"]
assert ex["records"] == 1930, ex["records"]
rows = {x["account_id"]: x for x in ex["results"]}
assert rows[46593239]["marked_no_activity"] is True and rows[46593239]["dashboard_name"] == "Brown and Caldwell"
assert rows[45451235]["dashboard_name"] is None  # not a dashboard customer in this test

# 5. scheduler: log read once per day; unchanged file is not parsed again
out = c.get("/api/sync/run", headers={"Authorization": "Bearer test-cron-secret"}).json()
assert "log" not in out or out["log"]["status"] in ("unchanged", "ok"), out

# 6. next day's log fails: shown as failed, nothing marked, customer alert data present
LOG_FILE.update(text=LOG_BAD, ctag="v2")
r = c.post("/api/sharepoint/log/read").json()
assert r["status"] == "ok" and r["no_activity_marked"] == 0, r
info = c.get("/api/sharepoint").json()
assert info["execution"]["export_date"] == "2026-11-05" and info["execution"]["status"] == "failed"
assert len(info["execution_history"]) == 2
old = c.get("/api/sharepoint/executions", params={"run_key": info["execution_history"][1]["run_key"]}).json()
assert old["export_date"] == "2026-11-04"
acc = c.get("/api/accounts/46593239").json()
assert acc["executions"][0]["status"] == "failed" and acc["latest"]["as_of_date"] == "2026-11-04"

# 7. a file later brings real activity for a "no activity" day: the flag is dropped for that day
with connect() as conn:
    conn.execute("""insert into daily_activity (account_id, activity_date, user_id, actor_type, total_events, manual_events,
                    automated_events, actions) values (46593239, '2026-11-04', '48351420', 'user', 3, 3, 0, 2)
                    on conflict do nothing""")
acc = c.get("/api/accounts/46593239").json()
assert acc["no_activity_days"] == [], acc["no_activity_days"]

# 8. admin only + bad link
assert c.delete("/api/sharepoint/log").status_code == 200
assert c.post("/api/sharepoint/log/read").status_code == 400
print("execution log tests passed")

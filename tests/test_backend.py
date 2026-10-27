"""End-to-end check: upload the real CSV the way the browser does (slim rows, chunks)."""
import csv, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fastapi.testclient import TestClient
from app.main import app
from app.normalize import KEEP_COLUMNS

path = sys.argv[1]
c = TestClient(app)
rows = []
with open(path, encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        s = {k: r.get(k) for k in KEEP_COLUMNS}
        if not ((r.get("entity_type") == "ALM") or r.get("source_table") == "saws_alarms"):
            s.pop("after_image")
        rows.append(s)
t = time.time()
up = c.post("/api/uploads", json={"filename": os.path.basename(path)}).json()
for i in range(0, len(rows), 1000):
    r = c.post(f"/api/uploads/{up['upload_id']}/rows", json={"rows": rows[i:i+1000]}); r.raise_for_status()
    print(r.json())
r = c.post(f"/api/uploads/{up['upload_id']}/complete"); print(r.status_code, r.json()["recompute"]); print("secs", round(time.time()-t,1))
p = c.get("/api/portfolio").json()
for a in p["accounts"]:
    print(a["name"], a["score"], a["status"], a["confidence"], a["components"]); print(a["reasons"]); print({k: a["metrics"][k] for k in ["actions_14d","active_users_14d","user_pool","days_since_activity","object_types_30d","engagement_reference_source"]})

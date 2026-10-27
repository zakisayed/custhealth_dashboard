"""Synthetic history: re-upload idempotency, baselines, peers, decline detection."""
import csv, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from fastapi.testclient import TestClient
from app.main import app
from app.normalize import KEEP_COLUMNS
src = sys.argv[1]; c = TestClient(app); random.seed(1)
base = []
with open(src, encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        s = {k: r.get(k) for k in KEEP_COLUMNS}
        if r.get("entity_type") != "ALM": s.pop("after_image")
        base.append(s)
DAY = 86400000
def variant(acct, shift_days, keep, tag):
    out = []
    for r in base:
        if random.random() > keep: continue
        x = dict(r); x["account_id"] = str(acct)
        x["timestamp"] = str(int(r["timestamp"]) - shift_days * DAY)
        x["SK"] = f"{tag}{shift_days}#{r['SK']}"; x["transaction_id"] = f"{tag}{shift_days}-{r['transaction_id']}"
        out.append(x)
    return out
def upload(name, rows):
    up = c.post("/api/uploads", json={"filename": name}).json()
    for i in range(0, len(rows), 2000):
        c.post(f"/api/uploads/{up['upload_id']}/rows", json={"rows": rows[i:i+2000]}).raise_for_status()
    r = c.post(f"/api/uploads/{up['upload_id']}/complete").json()
    return r["upload"]["rows_inserted"], r["upload"]["rows_duplicate"]
# real file then same file again
print("first", upload("brown_and_caldwell.csv", base)); print("again", upload("brown_and_caldwell.csv", base))
# history for B&C: 10 prior weeks
for w in range(1, 11): upload("brown_and_caldwell.csv", variant(46593239, 7*w, 1.0, "h"))
# healthy peer, steady
for w in range(0, 11): upload("acme_water.csv", variant(111, 7*w, 0.8, "a"))
# declining peer: busy early, nothing in last 3 weeks
for w in range(3, 11): upload("delta_utilities.csv", variant(222, 7*w, 1.0, "d"))
# small peer
for w in range(0, 11, 2): upload("north_basin.csv", variant(333, 7*w + 2, 0.3, "n"))
p = c.get("/api/portfolio").json()
print("through", p["data_through"], p["counts"])
for a in p["accounts"]:
    print(f'{a["name"]:22} {a["score"]:5} {a["status"]:8} {a["confidence"]:11}', a["components"], [r["text"] for r in a["reasons"]], a["metrics"]["engagement_reference_source"])
d = c.get("/api/accounts/46593239").json(); print(len(d["history"]), len(d["daily"]), len(d["users"]), d["quality"])
print(c.get("/api/model").json()["latest_run"]["params"]["peers"])
print(c.patch("/api/accounts/46593239", json={"timezone": "America/Los_Angeles"}).json())
print(c.get("/api/export/daily.csv?account_id=46593239").text[:400])

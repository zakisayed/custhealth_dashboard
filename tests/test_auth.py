"""Login, first-login password change, admin user management and the editable scoring model.

Usage: DATABASE_URL=postgresql://localhost/cstest python3 tests/test_auth.py path/to/export.csv
Uses a throwaway database: it creates users and changes the scoring model.
"""
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, ".")
sys.path.insert(0, "tests")
from app.main import app  # noqa: E402
from _auth import sign_in  # noqa: E402

c = TestClient(app)
anon = TestClient(app)

assert anon.get("/api/customers").status_code == 401
assert anon.post("/api/auth/login", json={"email": "admin@dvsum.com", "password": "nope"}).status_code == 401
sign_in(c)
me = c.get("/api/auth/me").json()
assert me["role"] == "admin" and not me["must_change_password"]

# data for the model checks
if not c.get("/api/customers").json():
    with open(sys.argv[1], "rb") as f:
        r = c.post("/api/uploads/csv?customer_name=Brown%20and%20Caldwell", files={"file": ("bc.csv", f, "text/csv")})
    assert r.status_code == 200, r.text

# admin adds a user with the default temp password
email = "qa.user@example.com"
for u in c.get("/api/users").json():
    if u["email"] == email:
        c.delete(f"/api/users/{u['user_id']}")
u = c.post("/api/users", json={"email": email}).json()
assert u["must_change_password"] and u["role"] == "user"
assert c.post("/api/users", json={"email": email.upper()}).status_code == 409

user = TestClient(app)
r = user.post("/api/auth/login", json={"email": email, "password": "ChangeMe"}).json()
user.headers["Authorization"] = f"Bearer {r['token']}"
assert r["user"]["must_change_password"]
assert user.get("/api/customers").status_code == 403          # must set a password first
bad = user.post("/api/auth/change-password", json={"current_password": "ChangeMe", "new_password": "ChangeMe"})
assert bad.status_code == 400
r = user.post("/api/auth/change-password", json={"current_password": "ChangeMe", "new_password": "Quality123"})
assert r.status_code == 200
user.headers["Authorization"] = f"Bearer {r.json()['token']}"
assert user.get("/api/customers").status_code == 200
assert user.get("/api/users").status_code == 403              # admin only
assert user.put("/api/model", json={"model": {"healthy_at": 80}}).status_code == 403
assert user.get("/api/model").status_code == 200              # everyone can read the model

# scoring model: preview does not persist, save rescoring, reset
before = {x["account_id"]: x["score"] for x in c.get("/api/customers").json()}
pv = c.post("/api/model/preview", json={"model": {"w_platform": 60, "healthy_at": 95}}).json()
assert abs(sum(v for k, v in pv["model"].items() if k.startswith("w_")) - 100) < 0.1
assert {x["account_id"]: x["score"] for x in c.get("/api/customers").json()} == before
assert c.post("/api/model/preview", json={"model": {"watch_at": 90, "healthy_at": 80}}).status_code == 400
sv = c.put("/api/model", json={"model": {"healthy_at": 99}, "note": "qa"}).json()
assert not sv["is_default"] and sv["model"]["healthy_at"] == 99
assert all(x["status"] != "healthy" for x in c.get("/api/customers").json())
assert c.post("/api/model/reset").json()["is_default"]
assert {x["account_id"]: x["score"] for x in c.get("/api/customers").json()} == before

# delete ends the user's session; the primary admin and self cannot be deleted
assert c.delete(f"/api/users/{u['user_id']}").status_code == 200
assert user.get("/api/customers").status_code == 401
assert c.delete(f"/api/users/{me['user_id']}").status_code == 400
print("auth + model tests passed")

"""Regression: Vercel rewrites /api/x to /api/index?__path=x. Auth must see the real path."""
from fastapi.testclient import TestClient
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.main import app

c = TestClient(app)
r = c.post("/api/index?__path=auth/login", json={"email": "nobody@example.com", "password": "x"})
assert r.status_code == 401 and r.json()["detail"] == "Email or password is incorrect.", r.text
r = c.get("/api/index?__path=customers")
assert r.status_code == 401 and r.json().get("code") == "auth_required", r.text
print("vercel path tests ok")

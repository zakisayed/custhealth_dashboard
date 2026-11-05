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


# subfolders are listed (Graph faked)
from app import sharepoint as _sp  # noqa: E402
_TREE = {"root": [{"id": "a", "name": "jan.csv", "file": {}}, {"id": "s1", "name": "2026-11", "folder": {}},
                  {"id": "x", "name": "~$lock.xlsx", "file": {}}],
         "s1": [{"id": "b", "name": "nov4.xlsx", "file": {}}, {"id": "s2", "name": "deep", "folder": {}}],
         "s2": [{"id": "c", "name": "deep.csv", "file": {}}]}
_sp.graph = lambda url, params=None: {"value": _TREE[url.split("/items/")[1].split("/")[0]]}
_files = {f["name"]: f["folder"] for f in _sp.list_files("D", "root")}
assert _files == {"jan.csv": None, "nov4.xlsx": "2026-11", "deep.csv": "2026-11/deep"}, _files
print("subfolder listing ok")

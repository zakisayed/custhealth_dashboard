"""Vercel serverless entry point. All /api/* requests are routed here (see vercel.json).

vercel.json rewrites /api/<anything> to /api/index?__path=<anything>. Depending on the
runtime version, the function may see either the original path or /api/index, so this
wrapper restores the original path before FastAPI routes the request.
"""
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app as fastapi_app  # noqa: E402


async def app(scope, receive, send):
    if scope["type"] == "http":
        qs = scope.get("query_string", b"").decode("latin-1")
        pairs = parse_qsl(qs, keep_blank_values=True)
        forced = next((v for k, v in pairs if k == "__path"), None)
        if forced is not None:
            rest = urlencode([(k, v) for k, v in pairs if k != "__path"])
            path = "/api/" + forced.lstrip("/")
            scope = {**scope, "path": path, "raw_path": path.encode(), "query_string": rest.encode("latin-1")}
        elif scope.get("path") in ("/api/index", "/api/index.py"):
            scope = {**scope, "path": "/api/status", "raw_path": b"/api/status"}
    await fastapi_app(scope, receive, send)

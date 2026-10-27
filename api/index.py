"""Vercel serverless entry point. All /api/* requests are routed here (see vercel.json)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402,F401

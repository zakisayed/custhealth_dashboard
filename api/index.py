"""Vercel entry point when deployed as a legacy serverless function (api/ directory).

Vercel's FastAPI preset may instead detect app/main.py directly. Both paths work: the
VercelPathFix middleware in app/main.py restores the original /api/... path either way.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402,F401

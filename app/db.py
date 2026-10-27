"""Postgres (Supabase) connection helpers.

Use the Supabase *pooler* connection string in DATABASE_URL. Prepared statements
are disabled so it works with the transaction pooler (port 6543) on Vercel.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "001_schema.sql"


def database_url() -> str:
    url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set. Use the Supabase pooler connection string.")
    return url


@contextmanager
def connect():
    conn = psycopg.connect(database_url(), row_factory=dict_row, prepare_threshold=None, connect_timeout=10)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ensure_schema() -> None:
    """Apply the idempotent schema. Safe on every cold start when AUTO_MIGRATE=1."""
    sql = SCHEMA_FILE.read_text()
    with connect() as conn:
        conn.execute(sql)

"""Postgres (Supabase) connection helpers.

Use the Supabase *pooler* connection string in DATABASE_URL. Prepared statements
are disabled so it works with the transaction pooler (port 6543) on Vercel.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote, urlparse

import psycopg
from psycopg.rows import dict_row

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "001_schema.sql"


POOLER_HINT = (
    "In Supabase open Connect > Connection string, choose 'Transaction pooler', and copy the string whose host "
    "ends in pooler.supabase.com (port 6543, user postgres.<project-ref>). That shared pooler is free and IPv4."
)


def check_database_url(url: str) -> None:
    """Catch Supabase strings that cannot work from IPv4-only hosts such as Vercel.

    db.<ref>.supabase.co (direct connection on 5432, dedicated pooler on 6543) resolves to IPv6
    unless the paid IPv4 add-on is enabled. Set ALLOW_DIRECT_DB=1 to skip this check if you have it.
    """
    if os.environ.get("ALLOW_DIRECT_DB") == "1":
        return
    try:
        parsed = urlparse(url)
        host, user = (parsed.hostname or "").lower(), unquote(parsed.username or "")
    except ValueError as exc:
        raise RuntimeError(f"DATABASE_URL is not a valid URL ({exc}). URL-encode special characters in the password.") from exc
    if host.startswith("db.") and host.endswith(".supabase.co"):
        raise RuntimeError(
            f"DATABASE_URL uses {host}, which is IPv6 only (direct connection or dedicated pooler) and "
            f"cannot be reached from Vercel without the paid IPv4 add-on. {POOLER_HINT}"
        )
    if host.endswith("pooler.supabase.com") and not user.startswith("postgres."):
        raise RuntimeError(
            f"The shared pooler needs the user postgres.<project-ref>, but DATABASE_URL has '{user}'. {POOLER_HINT}"
        )


def database_url() -> str:
    url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        raise RuntimeError(f"DATABASE_URL is not set. {POOLER_HINT}")
    check_database_url(url)
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
    path = SCHEMA_FILE if SCHEMA_FILE.exists() else Path(__file__).resolve().parent / "schema.sql"
    sql = path.read_text()
    with connect() as conn:
        conn.execute(sql)

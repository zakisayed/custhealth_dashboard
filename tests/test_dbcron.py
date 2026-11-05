"""Built-in scheduler SQL, run against a stand-in cron/net schema (pg_cron is not installed locally)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import psycopg
from psycopg.rows import dict_row
from app import dbcron

url = os.environ["DATABASE_URL"]
with psycopg.connect(url, autocommit=True, row_factory=dict_row) as conn:
    conn.execute("""drop schema if exists cron cascade; drop schema if exists net cascade;
      create schema cron; create schema net;
      create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text, active bool default true);
      create table cron.job_run_details (jobid int, status text, start_time timestamptz, end_time timestamptz, return_message text);
      create table net._http_response (id serial, status_code int, content text, error_msg text, created timestamptz default now());
      create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
        insert into cron.job (jobname, schedule, command) values (n, s, c)
        on conflict (jobname) do update set schedule=excluded.schedule, command=excluded.command returning jobid $$;
      create function cron.unschedule(n text) returns bool language sql as $$ delete from cron.job where jobname=n returning true $$;""")
    dbcron._has = lambda c, e: True
    dbcron._available = lambda c, e: True
    st = dbcron.enable(conn, "https://dvsumhealth.vercel.app/", "s'ecret")
    assert st["enabled"] and st["url"] == "https://dvsumhealth.vercel.app/api/sync/run", st
    cmd = conn.execute("select command from cron.job").fetchone()["command"]
    assert "'Bearer s''ecret'" in cmd and "timeout_milliseconds:=300000" in cmd, cmd
    st = dbcron.enable(conn, "https://dvsumhealth.vercel.app", "x")   # replace, not duplicate
    assert conn.execute("select count(*) n from cron.job").fetchone()["n"] == 1
    conn.execute("insert into cron.job_run_details values (1,'succeeded',now(),now(),'1 row')")
    conn.execute("insert into net._http_response (status_code, content) values (200, '{\"ok\":true}')")
    st = dbcron.status(conn)
    assert st["last_runs"] and st["last_response"]["status_code"] == 200, st
    st = dbcron.disable(conn)
    assert not st["enabled"]
    conn.execute("drop schema cron cascade; drop schema net cascade")
print("dbcron tests passed")

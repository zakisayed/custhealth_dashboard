# Customer Health Console

Upload the platform activity export (CSV, same columns as `brown_and_caldwell.csv`) and the dashboard rolls it up per account, user and day, keeps every upload as history, and rescores account health after each upload.

Stack: FastAPI (Python) API, plain HTML/CSS/JS frontend, Supabase Postgres for storage, Vercel for hosting.

## What it shows

- Portfolio: every account with health score, status (Healthy, Needs attention, At risk), calibration state, 14-day actions and trend, active users, last activity, alarms. Filters, search, sorting, and a CSV export of the daily summary.
- Account page: score history, the components behind the score, daily activity (by action, by object type, manual vs automated), object type usage, a weekday by hour heatmap, a users table, system alarms, DQ rule runs, and the daily summary table.
- Upload page: drag and drop the CSV. The browser parses it and sends it in chunks, so files bigger than Vercel's 4.5 MB request limit work.
- Scoring model page: weights, thresholds and the baselines learned for each account.

## How the data is processed

1. Each row is mapped to an action (created, updated, deleted, executed) and an object type (columns, ETL programs, BI tables, DQ rules, data domains, use cases, DB tables, jobs). Alarm rows (`saws_alarms`) and the SYSTEM user (`-1`) are kept separate from real usage.
2. Rows are deduplicated by the `SK` key. Uploading overlapping files is safe: rows already stored are skipped.
3. Mirrored rows (the same change written to `nodes` and `node_dynamo_log`) are counted once.
4. Bulk or scripted activity is flagged as automated when one user saves 15 or more separate transactions in a minute, or keeps up 6 per minute over a 10-minute window. Automated events still show in the charts but do not count as engagement.
5. Daily rollups are built in each account's time zone (set it in Account settings). Sessions are estimated using a 30-minute inactivity gap, since the export has no login events.

## Health model

| Component | Weight | Measure |
|---|---|---|
| Engagement | 30% | User actions in the last 14 days compared with the account's own median 14-day baseline. Falls back to the peer median (3+ accounts), then to a default target. |
| Recency | 20% | Days since the last user activity, compared with the account's usual gap between active days. |
| User breadth | 15% | Share of users active in 14 days (licensed seats if set, otherwise users seen in 90 days). |
| Adoption | 15% | Distinct object types used in 30 days, target 4. |
| Consistency | 10% | Active days in 14 compared with the account's typical count. |
| Platform | 10% | Starts at 100. Critical alarms cost 30, warnings 10, auto-resolved ones half. |

Status: Healthy at 70 or above, Needs attention 50 to 69, At risk below 50. An account with no user activity for longer than max(30 days, 4 times its usual gap) is always At risk.

Calibration: under 28 days of history the score is marked Calibrating and leans on defaults. From 28 to 70 days it is Building. After 70 days it is Calibrated and the baselines come entirely from the account's own history. Every upload rescores all days for all accounts, so history and trends always reflect the latest baselines.

All weights and thresholds can be tuned with environment variables (see `app/config.py`), for example `HEALTHY_AT=75`, `W_ENGAGEMENT=0.35`, `AUTO_TX_PER_MINUTE=20`.

## Supabase setup

1. Create a Supabase project.
2. Create the tables: open SQL Editor and run `supabase/migrations/001_schema.sql`. Alternatively leave `AUTO_MIGRATE=1` and the API creates them on the first request. The script is idempotent.
3. Copy the connection string from Project Settings, Database, Connection string, Transaction pooler (port 6543). This is your `DATABASE_URL`.

Row Level Security is enabled on every table with no public policies, so the Supabase anon key cannot read the data. Only the API (direct Postgres connection) can.

## Deploy on Vercel

1. Push this folder to a GitHub repo and import it in Vercel (Framework preset: Other).
2. Add environment variables:
   - `DATABASE_URL`: the Supabase transaction pooler string
   - `DASHBOARD_KEY`: any secret phrase. The dashboard asks for it once and keeps it in a session cookie. Leave empty only for private networks.
   - `AUTO_MIGRATE`: `1` (optional)
3. Deploy. Static files are served from `public/`, and `/api/*` is routed to the FastAPI app in `api/index.py`.

Vercel Hobby limits functions to 60 seconds. Recompute takes about a second per 80k events, so this is fine for a long history. If one account grows to many millions of events, move the recompute to a Supabase scheduled function or a background worker.

## Local development

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env   # set DATABASE_URL (local Postgres or Supabase)
./scripts/dev.sh       # http://127.0.0.1:8000
```

Tests use whatever database `DATABASE_URL` points to, so use a throwaway one:

```bash
DATABASE_URL=postgresql://localhost/cstest python3 tests/test_backend.py path/to/export.csv
DATABASE_URL=postgresql://localhost/cstest python3 tests/test_history.py path/to/export.csv
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Row counts, data range, last upload |
| POST | `/api/uploads` | Start an upload, returns `upload_id` |
| POST | `/api/uploads/{id}/rows` | Send up to 5,000 rows |
| POST | `/api/uploads/{id}/complete` | Finish and recompute |
| POST | `/api/uploads/csv` | Single multipart upload (small files or scripts) |
| GET | `/api/uploads` | Upload history |
| POST | `/api/recompute` | Rebuild rollups and scores |
| GET | `/api/portfolio` | All accounts with latest health |
| GET / PATCH | `/api/accounts/{id}` | Account detail, or update name, time zone, seats |
| GET | `/api/accounts/{id}/daily` | Daily per-user rollup |
| GET | `/api/export/daily.csv` | Daily summary CSV (`?account_id=` optional) |
| GET | `/api/model` | Weights, thresholds and calibration state |

Send `X-Dashboard-Key` when `DASHBOARD_KEY` is set.

## Known limits

- The export has no login or session events, so sessions are estimated from activity gaps.
- No deletes and no use cases appear in the sample file. The engine handles them when they show up.
- With one account, the peer benchmark is off. It turns on at 3 accounts with 14+ days of history.

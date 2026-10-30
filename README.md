# Customer Health Console

Upload the platform activity export (CSV, same columns as `brown_and_caldwell.csv`) and the dashboard rolls it up per account, user and day, keeps every upload as history, and rescores account health after each upload.

Stack: FastAPI (Python) API, plain HTML/CSS/JS frontend, Supabase Postgres for storage, Vercel for hosting.

## Sign in and users

The dashboard requires a login.

- The admin account is `admin@dvsum.com`. On the first start it is created with the temporary password `ChangeMe`. Sign in with it and the app makes you create your own password before anything else loads. Change it later under Profile settings (click your email at the bottom of the sidebar).
- The admin opens Users to add people. Enter their email and a temporary password (prefilled with `ChangeMe`). On their first sign in they must create a new password before they can see any data.
- Users can view every customer dashboard, add customers and upload CSV files. Only the admin can manage users, edit the scoring model, change customer settings and remove customers.
- The admin can reset a user's password (back to a temporary one, forcing a new password at next sign in) or delete a user. Deleting or resetting signs that person out immediately. The primary admin cannot be deleted.
- Passwords need 8+ characters with letters and a number or symbol, and cannot be the temporary password. Five wrong passwords lock the account for 10 minutes.
- Passwords are stored as PBKDF2-SHA256 hashes. Sessions are signed tokens that last 7 days (`SESSION_HOURS`). Changing a password signs out other devices.
- Forgot the admin password? Run this SQL in Supabase to go back to `ChangeMe` with a forced change: `delete from app_users where lower(email)='admin@dvsum.com';` then reload the app (it recreates the admin).

## Customers

Each customer has its own dashboard. The sidebar lists every customer with its current score and status. Select one to open its dashboard, and use Upload data under it to add new exports.

- Add customer: enter a name and drop the customer's first export. The account ID is read from the file.
- Upload for a customer: the file must contain only that customer's account ID. A file for a different customer, or a file that mixes several accounts, is rejected before anything is stored. If you add a "new" customer whose account ID already exists, the app offers to add the file to the existing customer instead.
- Each customer is scored through the last day of its own data, so customers uploaded on different days are not penalized. A customer whose latest data is more than 14 days old is flagged as stale in the sidebar, the overview and its dashboard.
- Remove customer (Settings, type the name to confirm) deletes the customer and its history. The other customers are rescored because peer benchmarks change.

## What it shows

- All customers: every customer with health score, status (Healthy, Needs attention, At risk), calibration state, 14-day actions and trend, active users, last activity, alarms. Filters, search, sorting, and a CSV export of the daily summary.
- Account page: score history, the components behind the score, daily activity (by action, by object type, manual vs automated), object type usage, a weekday by hour heatmap, a users table, system alarms, DQ rule runs, and the daily summary table.
- Upload page: drag and drop the CSV. The browser parses it and sends it in chunks, so files bigger than Vercel's 4.5 MB request limit work.
- Scoring model page: weights, thresholds and the baselines learned for each account.

## How the data is processed

1. Each row is mapped to an action (created, updated, deleted, executed) and an object type (columns, ETL programs, BI tables, DQ rules, data domains, use cases, DB tables, jobs). Alarm rows (`saws_alarms`) and the SYSTEM user (`-1`) are kept separate from real usage.
2. Rows are deduplicated by the `SK` key. Uploading overlapping files is safe: rows already stored are skipped.
3. Mirrored rows (the same change written to `nodes` and `node_dynamo_log`) are counted once.
4. Bulk or scripted activity is flagged as automated when one user saves 15 or more separate transactions in a minute, or keeps up 6 per minute over a 10-minute window. Automated events still show in the charts but do not count as engagement.
5. User emails are read from the owner and steward records inside `after_image` and `before_image` (for example `system_owner_id`, `system_owner_name`, `system_owner_email`). Each user is matched by id first, then by name, and the upload result lists every match. Re-uploading a file refills emails for existing users. A user who never appears in such a record shows "Not found".
6. Daily rollups are built in each account's time zone (set it in Account settings). Sessions are estimated using a 30-minute inactivity gap, since the export has no login events.

### File formats

Uploads accept CSV and Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`). `.xlsx` and `.xlsm` files are read by a streaming reader in a background worker (`public/js/xlsx-worker.js`, using fflate), so very large exports work: a 101 MB workbook whose text expands to about 900 MB reads in under 30 seconds. Large JSON cells are reduced to the emails they contain while reading. Excel files are read in the browser with SheetJS (bundled in `public/vendor/`, loaded only when an Excel file is picked). The first sheet that has an `account_id` header is used, so cover or notes sheets are skipped. Long IDs and epoch-ms timestamps are kept exact, and real date cells are converted to ISO text. Excel limits a cell to 32,767 characters, so very long `after_image` values may be cut; emails already matched from earlier uploads are kept.

## Health model

| Component | Weight | Measure |
|---|---|---|
| Engagement | 30% | User actions in the last 14 days compared with the account's own median 14-day baseline. Falls back to the peer median (3+ accounts), then to a default target. |
| Recency | 20% | Days since the last user activity, compared with the account's usual gap between active days. |
| User breadth | 15% | Share of users active in 14 days (licensed seats if set, otherwise users seen in 90 days). |
| Adoption | 15% | Distinct object types used in 30 days, target 4. |
| Consistency | 10% | Active days in 14 compared with the account's typical count. |
| Platform | 10% | Starts at 100. Critical alarms cost 30, warnings 10, auto-resolved ones half. |

Status (defaults): Healthy at 70 or above, Needs attention 50 to 69, At risk below 50. An account with no user activity for longer than max(30 days, 4 times its usual gap) is always At risk.

Calibration: under 28 days of history the score is marked Calibrating and leans on defaults. From 28 to 70 days it is Building. After 70 days it is Calibrated and the baselines come entirely from the account's own history. Every upload rescores all days for all accounts, so history and trends always reflect the latest baselines.

### Editing the model

The admin can change the model on the Scoring model page (Edit model):

- Component weights (sliders, scaled to 100% on save)
- Status thresholds for Healthy and Needs attention
- Targets: starting actions and active-day targets, active user share and object types for full marks, alarm penalties
- Confidence: days of history for Calibrating and Calibrated
- Activity classification: automated burst and sustained rates, session gap

While editing, an impact preview scores every customer with the draft (nothing is saved) and highlights status changes. Save and recalibrate stores the model in Supabase, rescores every day of every customer's history, recalibrates baselines and peer benchmarks, and shows a before and after table. Every change is kept in a change log with who made it and why. Reset to defaults goes back to the values in `app/config.py`.

The model keeps calibrating on its own after that: each upload rescores all history with the saved model, and baselines move from default targets to peer medians to each customer's own history as data builds up.

The defaults can still be set with environment variables (see `app/config.py`), for example `HEALTHY_AT=75`, `W_ENGAGEMENT=0.35`. A model saved in the app takes priority.

## Supabase setup

1. Create a Supabase project.
2. Create the tables: open SQL Editor and run `supabase/migrations/001_schema.sql`. Alternatively leave `AUTO_MIGRATE=1` and the API creates them on the first request. The script is idempotent.
3. Click Connect, open Connection string, and set Method to Transaction pooler. Copy the string that looks like `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`. This is your `DATABASE_URL`.
   - This is the shared pooler (Supavisor). It is free and IPv4 on every plan, which Vercel needs.
   - Do not use a `db.<project-ref>.supabase.co` host (direct connection or dedicated pooler). It is IPv6 only unless you buy the IPv4 add-on, and Vercel is IPv4 only. The app refuses this host with a clear message; set `ALLOW_DIRECT_DB=1` if you do have the add-on.
   - URL-encode special characters in the password (`@` becomes `%40`, `#` becomes `%23`).
   - Keep Vercel functions in the same region as the database. `vercel.json` sets `"regions": ["icn1"]` (Seoul) to match a Supabase project in `ap-northeast-2`. Change it if your project is elsewhere (for example `iad1` for `us-east-1`).
   - No anon or service role key is needed. The browser only talks to FastAPI, and FastAPI talks to Postgres.

Row Level Security is enabled on every table with no public policies, so the Supabase anon key cannot read the data. Only the API (direct Postgres connection) can.

## Deploy on Vercel

1. Push this folder to a GitHub repo and import it in Vercel (Framework preset: Other).
2. Add environment variables:
   - `DATABASE_URL`: the Supabase shared transaction pooler string (host ends in `pooler.supabase.com`)
   - `SESSION_SECRET` (optional): a long random string used to sign sessions. If not set, one is generated and stored in the database on first start.
   - `ADMIN_EMAIL` (optional, default `admin@dvsum.com`) and `ADMIN_INITIAL_PASSWORD` (optional, default `ChangeMe`). These only apply when the admin is first created.
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
DATABASE_URL=postgresql://localhost/cstest python3 tests/test_auth.py path/to/export.csv
```

The tests sign in as the admin. On a fresh database they replace `ChangeMe` with `TestPass123!`, so never point them at production.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Row counts, data range, last upload |
| POST | `/api/uploads` | Start an upload (`account_id` for an existing customer, or `customer_name` for a new one), returns `upload_id` |
| POST | `/api/uploads/{id}/rows` | Send up to 5,000 rows |
| POST | `/api/uploads/{id}/complete` | Finish and recompute |
| POST | `/api/uploads/csv` | Single multipart upload (small files or scripts) |
| GET | `/api/uploads?account_id=` | Upload history, optionally for one customer |
| GET | `/api/customers` | Customer list with score, status and data freshness |
| DELETE | `/api/accounts/{id}` | Remove a customer and its history |
| POST | `/api/recompute` | Rebuild rollups and scores |
| GET | `/api/portfolio` | All accounts with latest health |
| GET / PATCH | `/api/accounts/{id}` | Account detail, or update name, time zone, seats |
| GET | `/api/accounts/{id}/daily` | Daily per-user rollup |
| GET | `/api/export/daily.csv` | Daily summary CSV (`?account_id=` optional) |
| GET | `/api/model` | Current model, defaults, field limits, calibration state and change log |
| POST | `/api/model/preview` | Admin. Score every customer with a draft model without saving |
| PUT | `/api/model` | Admin. Save the model, rescore all history and recalibrate |
| POST | `/api/model/reset` | Admin. Go back to the defaults and rescore |
| POST | `/api/auth/login` | Email and password, returns a session token |
| GET | `/api/auth/me` | The signed-in user |
| POST | `/api/auth/change-password` | Current and new password, returns a fresh token |
| GET / POST | `/api/users` | Admin. List users, or add one (`email`, `temp_password`, default `ChangeMe`) |
| POST | `/api/users/{id}/reset-password` | Admin. Set a temporary password and force a change |
| DELETE | `/api/users/{id}` | Admin. Delete a user |

Every endpoint except `/api/ping` and `/api/auth/login` needs `Authorization: Bearer <token>`. Users with a temporary password can only reach `/api/auth/*` until they set a new one.

## Known limits

- The export has no login or session events, so sessions are estimated from activity gaps.
- No deletes and no use cases appear in the sample file. The engine handles them when they show up.
- With one account, the peer benchmark is off. It turns on at 3 accounts with 14+ days of history.

## Troubleshooting

| Message on the dashboard | Cause and fix |
| --- | --- |
| Database not reachable: ... IPv6 only | `DATABASE_URL` points at `db.<ref>.supabase.co`. Use the shared pooler string (`aws-0-<region>.pooler.supabase.com:6543`). |
| Database not reachable: ... password authentication failed | Wrong password, or special characters not URL-encoded. Reset it under Project Settings, Database. |
| Not Found (path shown) | Usually an old backend. Redeploy the whole project root (the folder with `vercel.json`, `app/`, `api/` and `public/`), not only `public/`. Open `https://<your-app>.vercel.app/api/status` and confirm it returns `"api_version": 2`. Vercel may run the app from `api/index.py` or detect `app/main.py` as a FastAPI app; both work. |

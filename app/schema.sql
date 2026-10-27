-- Customer Success Health Dashboard: Supabase / Postgres schema
-- Run once in the Supabase SQL editor (or via `supabase db push`).
-- Safe to re-run: every statement is idempotent.

create table if not exists accounts (
  account_id   bigint primary key,
  name         text not null,
  timezone     text not null default 'UTC',          -- IANA tz used for day boundaries
  licensed_seats integer,                             -- optional, improves user-breadth score
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists account_users (
  account_id   bigint not null references accounts(account_id) on delete cascade,
  user_id      text   not null,
  user_name    text,
  is_system    boolean not null default false,
  first_seen   timestamptz,
  last_seen    timestamptz,
  primary key (account_id, user_id)
);
alter table account_users add column if not exists email text;

create table if not exists uploads (
  upload_id      bigserial primary key,
  filename       text,
  status         text not null default 'receiving',   -- receiving | processing | complete | failed
  rows_received  integer not null default 0,
  rows_inserted  integer not null default 0,
  rows_duplicate integer not null default 0,
  rows_rejected  integer not null default 0,
  account_ids    bigint[] not null default '{}',
  min_ts         timestamptz,
  max_ts         timestamptz,
  error          text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
-- Customer-scoped uploads: the customer the file was uploaded for, and the name given to a new customer.
alter table uploads add column if not exists target_account_id bigint;
alter table uploads add column if not exists customer_name text;

-- One row per CDC log row, normalized. (account_id, event_key) is the log's own SK,
-- so uploading an overlapping file never double counts.
create table if not exists events (
  account_id      bigint not null references accounts(account_id) on delete cascade,
  event_key       text   not null,
  upload_id       bigint references uploads(upload_id) on delete set null,
  ts              timestamptz not null,
  user_id         text not null,
  user_name       text,
  actor_type      text not null,                    -- user | system
  event_type      text not null,                    -- CRT UPD DEL EXE ...
  action          text not null,                    -- created updated deleted executed
  entity_type     text not null,                    -- PLO COL BIT RLS DMN ...
  object_type     text not null,                    -- etl_programs columns bi_tables ...
  entity_sub_type text,
  entity_id       text,
  entity_name     text,
  entity_status   text,                             -- normalized: new draft published created executed
  source_table    text,
  transaction_id  text,
  changed_fields  integer not null default 0,
  alarm_severity  text,                             -- critical warning info
  alarm_type      text,
  alarm_status    text,
  dq_exceptions   bigint,
  dq_total        bigint,
  dq_alert        boolean not null default false,
  is_duplicate    boolean not null default false,   -- mirrored copy (nodes + node_dynamo_log)
  is_automated    boolean not null default false,   -- machine-speed burst (scan / import)
  primary key (account_id, event_key)
);
create index if not exists events_acct_ts_idx   on events (account_id, ts);
create index if not exists events_acct_tx_idx   on events (account_id, transaction_id);
create index if not exists events_acct_user_idx on events (account_id, user_id, ts);

-- Daily rollup: one row per account, local day, user (system user kept as its own row).
create table if not exists daily_activity (
  account_id            bigint not null references accounts(account_id) on delete cascade,
  activity_date         date   not null,
  user_id               text   not null,
  user_name             text,
  actor_type            text   not null,
  total_events          integer not null default 0,
  manual_events         integer not null default 0,
  automated_events      integer not null default 0,
  actions               integer not null default 0,  -- distinct manual transactions = units of work
  created               integer not null default 0,
  updated               integer not null default 0,
  deleted               integer not null default 0,
  executed              integer not null default 0,
  obj_columns           integer not null default 0,
  obj_etl_programs      integer not null default 0,
  obj_bi_tables         integer not null default 0,
  obj_dq_rules          integer not null default 0,
  obj_data_domains      integer not null default 0,
  obj_use_cases         integer not null default 0,
  obj_db_tables         integer not null default 0,
  obj_jobs              integer not null default 0,
  obj_other             integer not null default 0,
  alarms_total          integer not null default 0,
  alarms_critical       integer not null default 0,
  alarms_warning        integer not null default 0,
  alarms_open           integer not null default 0,     -- not yet resolved
  dq_runs               integer not null default 0,
  dq_runs_with_exceptions integer not null default 0,
  distinct_objects      integer not null default 0,
  transactions          integer not null default 0,
  first_activity        timestamptz,
  last_activity         timestamptz,
  active_minutes        numeric(10,1) not null default 0,
  est_sessions          integer,
  max_events_per_minute integer not null default 0,
  primary key (account_id, activity_date, user_id)
);

-- Long format for charts: account, day, user, action, object.
create table if not exists daily_activity_detail (
  account_id    bigint not null references accounts(account_id) on delete cascade,
  activity_date date   not null,
  user_id       text   not null,
  action        text   not null,
  object_type   text   not null,
  events        integer not null,
  manual_events integer not null,
  primary key (account_id, activity_date, user_id, action, object_type)
);

-- Health score per account per day (full history recomputed on every upload).
create table if not exists health_snapshots (
  account_id  bigint not null references accounts(account_id) on delete cascade,
  as_of_date  date   not null,
  score       numeric(5,1) not null,
  status      text   not null,                    -- healthy | watch | at_risk
  confidence  text   not null,                    -- calibrating | building | calibrated
  components  jsonb  not null,
  reasons     jsonb  not null,
  metrics     jsonb  not null,
  primary key (account_id, as_of_date)
);

-- Model calibration runs (thresholds + learned baselines).
create table if not exists calibration_runs (
  run_id      bigserial primary key,
  computed_at timestamptz not null default now(),
  data_through date,
  params      jsonb not null
);

-- forward-compatible column adds (keep for older installs)
alter table daily_activity add column if not exists alarms_open integer not null default 0;

-- Lock down PostgREST: the FastAPI backend connects with the database role,
-- which bypasses RLS. Anonymous/public API keys get nothing.
alter table accounts              enable row level security;
alter table account_users         enable row level security;
alter table uploads               enable row level security;
alter table events                enable row level security;
alter table daily_activity        enable row level security;
alter table daily_activity_detail enable row level security;
alter table health_snapshots      enable row level security;
alter table calibration_runs      enable row level security;

-- ---------------------------------------------------------------------------- login
-- Dashboard users. Passwords are PBKDF2-SHA256 hashes; the admin is seeded by the app.
create table if not exists app_users (
  user_id         bigserial primary key,
  email           text not null,
  password_hash   text not null,
  role            text not null default 'user' check (role in ('admin', 'user')),
  must_change_password boolean not null default true,
  password_version integer not null default 1,      -- bump to sign out every session of the user
  failed_logins   integer not null default 0,
  locked_until    timestamptz,
  created_by      text,
  created_at      timestamptz not null default now(),
  password_changed_at timestamptz,
  last_login_at   timestamptz
);
create unique index if not exists app_users_email_key on app_users (lower(email));

create table if not exists app_settings (
  key   text primary key,
  value text not null
);

alter table uploads add column if not exists uploaded_by text;

create table if not exists scoring_model_versions (
  version_id  bigserial primary key,
  model       jsonb not null,
  changed_by  text,
  changed_at  timestamptz not null default now(),
  note        text
);

alter table app_users    enable row level security;
alter table scoring_model_versions enable row level security;
alter table app_settings enable row level security;

"""Recompute pipeline: clean flags -> daily rollups -> health history -> calibration.

Runs after every upload over the *full* stored history, so trends and baselines
always reflect everything uploaded so far.
"""
from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from datetime import date, timedelta

from psycopg.types.json import Jsonb

from . import config as C
from .db import connect
from .normalize import ALL_OBJECT_COLUMNS, CORE_OBJECTS

OBJ_SQL_LIST = ", ".join(f"'{o}'" for o in ALL_OBJECT_COLUMNS + ["alarms"])


# ----------------------------------------------------------------------------- rollups
def _rollup(conn, ids: list[int]) -> None:
    p = {"ids": ids, "gap": C.SESSION_GAP_MINUTES, "auto": C.AUTO_TX_PER_MINUTE,
         "sustained": C.AUTO_SUSTAINED_PER_MINUTE}

    # 1) mirrored rows: node_dynamo_log copy of something already in nodes (same object, action, transaction)
    conn.execute(
        """update events e set is_duplicate = exists (
             select 1 from events n
             where n.account_id = e.account_id and n.source_table = 'nodes'
               and n.entity_id = e.entity_id and n.event_type = e.event_type
               and n.transaction_id = e.transaction_id)
           where e.account_id = any(%(ids)s) and e.source_table = 'node_dynamo_log'""", p)

    # 2) machine-speed bursts: many separate saves by one user inside one minute
    #    a) any minute with >= AUTO_TX_PER_MINUTE saves, or
    #    b) any 10-minute stretch averaging >= AUTO_SUSTAINED_PER_MINUTE saves (scans that run slower)
    conn.execute(
        """with mc as (
             select account_id, user_id, date_trunc('minute', ts) as mi, count(distinct transaction_id) as c
             from events
             where account_id = any(%(ids)s) and actor_type = 'user' and not is_duplicate
             group by 1, 2, 3),
           roll as (
             select *, sum(c) over (partition by account_id, user_id order by mi
                                    range between interval '9 minutes' preceding and current row) as s10
             from mc),
           cover as (
             -- a minute is automated if any 10-minute window that contains it is over the sustained rate
             select *, max(s10) over (partition by account_id, user_id order by mi
                                      range between current row and interval '9 minutes' following) as best
             from roll),
           m as (
             select account_id, user_id, mi from cover
             where c >= %(auto)s or best >= %(sustained)s * 10),
           want as (
             select e.account_id, e.event_key,
                    (m.mi is not null and e.actor_type = 'user' and not e.is_duplicate) as flag
             from events e
             left join m on m.account_id = e.account_id and m.user_id = e.user_id
                        and m.mi = date_trunc('minute', e.ts)
             where e.account_id = any(%(ids)s))
           update events e set is_automated = w.flag
           from want w
           where e.account_id = w.account_id and e.event_key = w.event_key
             and e.is_automated is distinct from w.flag""", p)

    # 3) daily rollup per account / local day / user
    conn.execute("delete from daily_activity where account_id = any(%(ids)s)", p)
    obj_cols = ",\n".join(f"count(*) filter (where ev.object_type = '{o}')" for o in ALL_OBJECT_COLUMNS)
    conn.execute(
        f"""
        with ev as (
          select e.*, (e.ts at time zone a.timezone)::date as d
          from events e join accounts a using (account_id)
          where e.account_id = any(%(ids)s) and not e.is_duplicate),
        g as (
          select account_id, d, user_id,
                 case when lag(ts) over w is null
                        or ts - lag(ts) over w > make_interval(mins => %(gap)s::int) then 1 else 0 end as ns
          from ev window w as (partition by account_id, d, user_id order by ts)),
        sess as (select account_id, d, user_id, sum(ns)::int as s from g group by 1, 2, 3),
        pm as (select account_id, d, user_id, max(c)::int as mx
               from (select account_id, d, user_id, date_trunc('minute', ts) m, count(*) c from ev group by 1,2,3,4) x
               group by 1, 2, 3)
        insert into daily_activity (
          account_id, activity_date, user_id, user_name, actor_type,
          total_events, manual_events, automated_events, actions,
          created, updated, deleted, executed,
          obj_columns, obj_etl_programs, obj_bi_tables, obj_dq_rules, obj_data_domains, obj_use_cases,
          obj_db_tables, obj_jobs, obj_other,
          alarms_total, alarms_critical, alarms_warning, alarms_open, dq_runs, dq_runs_with_exceptions,
          distinct_objects, transactions, first_activity, last_activity, active_minutes, est_sessions,
          max_events_per_minute)
        select ev.account_id, ev.d, ev.user_id, max(ev.user_name), max(ev.actor_type),
          count(*), count(*) filter (where not ev.is_automated), count(*) filter (where ev.is_automated),
          count(distinct ev.transaction_id) filter (where not ev.is_automated and ev.actor_type = 'user'),
          count(*) filter (where ev.action = 'created'), count(*) filter (where ev.action = 'updated'),
          count(*) filter (where ev.action = 'deleted'), count(*) filter (where ev.action = 'executed'),
          {obj_cols},
          count(*) filter (where ev.object_type not in ({OBJ_SQL_LIST})),
          count(*) filter (where ev.object_type = 'alarms'),
          count(*) filter (where ev.object_type = 'alarms' and ev.alarm_severity = 'critical'),
          count(*) filter (where ev.object_type = 'alarms' and ev.alarm_severity = 'warning'),
          count(*) filter (where ev.object_type = 'alarms' and coalesce(ev.alarm_status, '') not in ('RSL', 'CLS', 'RESOLVED', 'CLOSED')),
          count(*) filter (where ev.object_type = 'dq_rules' and ev.action = 'executed'),
          count(*) filter (where ev.object_type = 'dq_rules' and ev.action = 'executed' and coalesce(ev.dq_exceptions, 0) > 0),
          count(distinct ev.entity_id), count(distinct ev.transaction_id), min(ev.ts), max(ev.ts),
          round((extract(epoch from max(ev.ts) - min(ev.ts)) / 60)::numeric, 1),
          case when max(ev.actor_type) = 'user' then sess.s end,
          pm.mx
        from ev
        left join sess on sess.account_id = ev.account_id and sess.d = ev.d and sess.user_id = ev.user_id
        left join pm   on pm.account_id = ev.account_id and pm.d = ev.d and pm.user_id = ev.user_id
        group by ev.account_id, ev.d, ev.user_id, sess.s, pm.mx""", p)

    # 4) long format for charts
    conn.execute("delete from daily_activity_detail where account_id = any(%(ids)s)", p)
    conn.execute(
        """insert into daily_activity_detail (account_id, activity_date, user_id, action, object_type, events, manual_events)
           select e.account_id, (e.ts at time zone a.timezone)::date, e.user_id, e.action, e.object_type,
                  count(*), count(*) filter (where not e.is_automated)
           from events e join accounts a using (account_id)
           where e.account_id = any(%(ids)s) and not e.is_duplicate
           group by 1, 2, 3, 4, 5""", p)


# ----------------------------------------------------------------------------- health helpers
def _clamp(x: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, x))


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    v = sorted(values)
    k = (len(v) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    return v[f] if f == c else v[f] + (v[c] - v[f]) * (k - f)


def _delta(cur: float, prev: float) -> float | None:
    if prev == 0:
        return None if cur else 0.0
    return round((cur - prev) / prev * 100, 1)


class _AccountSeries:
    """Per-day aggregates for one account, held in memory for fast windowed math."""

    def __init__(self, acct: dict, rows: list[dict], objs: list[dict], pool_users: dict):
        self.acct = acct
        self.actions = defaultdict(int)
        self.events = defaultdict(int)
        self.manual = defaultdict(int)
        self.auto = defaultdict(int)
        self.users = defaultdict(set)
        self.objects = defaultdict(set)
        self.crit = defaultdict(int)
        self.warn = defaultdict(int)
        self.open = defaultdict(int)
        self.dq_runs = defaultdict(int)
        self.dq_exc = defaultdict(int)
        self.user_first = pool_users
        dates = []
        for r in rows:
            d = r["activity_date"]
            if r["actor_type"] == "user":
                self.actions[d] += r["actions"]
                self.events[d] += r["total_events"]
                self.manual[d] += r["manual_events"]
                self.auto[d] += r["automated_events"]
                self.users[d].add(r["user_id"])
                self.dq_runs[d] += r["dq_runs"]
                self.dq_exc[d] += r["dq_runs_with_exceptions"]
                dates.append(d)
            self.crit[d] += r["alarms_critical"]
            self.warn[d] += r["alarms_warning"]
            self.open[d] += r["alarms_open"]
        for o in objs:
            if o["object_type"] != "alarms":
                self.objects[o["activity_date"]].add(o["object_type"])
        self.active_dates = sorted(set(dates))
        self.first = min([r["activity_date"] for r in rows], default=None)
        # Each customer is scored through the end of its own data, so customers uploaded on
        # different days are not penalized for days their export does not cover yet.
        self.through = max([r["activity_date"] for r in rows], default=None)

    def window_sum(self, series: dict, end: date, days: int) -> int:
        return sum(series.get(end - timedelta(i), 0) for i in range(days))

    def window_set(self, series: dict, end: date, days: int) -> set:
        out = set()
        for i in range(days):
            out |= series.get(end - timedelta(i), set())
        return out

    def active_days(self, end: date, days: int) -> int:
        start = end - timedelta(days - 1)
        return sum(1 for d in self.active_dates if start <= d <= end)

    def last_active_on_or_before(self, d: date) -> date | None:
        last = None
        for x in self.active_dates:
            if x <= d:
                last = x
            else:
                break
        return last

    def gaps_before(self, d: date) -> list[int]:
        ds = [x for x in self.active_dates if x <= d]
        return [(b - a).days for a, b in zip(ds, ds[1:])]

    def baseline_windows(self, d: date) -> list[dict]:
        """Full prior 14-day windows that sit entirely after the account's first activity."""
        out = []
        W = C.CURRENT_WINDOW
        for k in range(1, C.BASELINE_WINDOWS + 1):
            end = d - timedelta(W * k)
            start = end - timedelta(W - 1)
            if self.first is None or start < self.first:
                break
            out.append({"actions": self.window_sum(self.actions, end, W), "active_days": self.active_days(end, W)})
        return out


def _peer_benchmarks(series: dict[int, _AccountSeries]) -> dict:
    """Typical account: median 14-day actions and active days across accounts with real history,
    each measured at the end of its own data."""
    acts, days = [], []
    for s in series.values():
        if s.first is None or (s.through - s.first).days + 1 < C.CURRENT_WINDOW:
            continue
        acts.append(s.window_sum(s.actions, s.through, C.CURRENT_WINDOW))
        days.append(s.active_days(s.through, C.CURRENT_WINDOW))
    return {
        "accounts": len(acts),
        "median_actions_14d": statistics.median(acts) if acts else None,
        "median_active_days_14d": statistics.median(days) if days else None,
    }


def _score_day(s: _AccountSeries, d: date, peers: dict, peer_ok: bool) -> dict:
    W = C.CURRENT_WINDOW
    history_days = (d - s.first).days + 1 if s.first else 0
    cur_actions = s.window_sum(s.actions, d, W)
    prev_actions = s.window_sum(s.actions, d - timedelta(W), W)
    cur_events = s.window_sum(s.events, d, W)
    cur_auto = s.window_sum(s.auto, d, W)
    a7, p7 = s.window_sum(s.actions, d, 7), s.window_sum(s.actions, d - timedelta(7), 7)
    users_cur = s.window_set(s.users, d, W)
    users_7, users_p7 = s.window_set(s.users, d, 7), s.window_set(s.users, d - timedelta(7), 7)
    pool_cut = d - timedelta(C.USER_POOL_WINDOW - 1)
    pool = {u for u, (first, last) in s.user_first.items() if first <= d and last >= pool_cut}
    pool |= users_cur
    seats = s.acct.get("licensed_seats") or 0
    denom = max(seats, len(pool), 1)
    objs_30 = s.window_set(s.objects, d, C.ADOPTION_WINDOW)
    core_30 = sorted(o for o in objs_30 if o in CORE_OBJECTS or o == "db_tables")
    active_days = s.active_days(d, W)
    crit, warn = s.window_sum(s.crit, d, W), s.window_sum(s.warn, d, W)
    open_alarms = s.window_sum(s.open, d, W)
    dq_runs = s.window_sum(s.dq_runs, d, C.ADOPTION_WINDOW)
    dq_exc = s.window_sum(s.dq_exc, d, C.ADOPTION_WINDOW)

    base = s.baseline_windows(d)
    reasons: list[dict] = []

    # engagement vs. own baseline (or peers, or fallback target)
    if len(base) >= 2:
        ref = max(statistics.median(b["actions"] for b in base), 3)
        ref_src = "own baseline"
    elif peer_ok and peers.get("median_actions_14d"):
        ref = max(peers["median_actions_14d"], 3)
        ref_src = "peer median"
    else:
        ref = C.FALLBACK_ACTIONS_14D
        ref_src = "default target"
    ratio = cur_actions / ref if ref else 0
    engagement = _clamp(100 * ratio / 1.2)

    # recency vs. the account's own usual gap
    last = s.last_active_on_or_before(d)
    days_since = (d - last).days if last else None
    gaps = s.gaps_before(d)
    expected_gap = _clamp(_pct(gaps, 0.75) if len(gaps) >= 4 else 7, 2, 14)
    if days_since is None:
        recency = 0
    elif days_since <= expected_gap:
        recency = 100
    else:
        recency = _clamp(100 * (1 - (days_since - expected_gap) / (3 * expected_gap)))

    share = len(users_cur) / denom
    breadth = _clamp(100 * share / C.TARGET_ACTIVE_USER_SHARE)
    adoption = _clamp(100 * len(core_30) / C.TARGET_OBJECT_TYPES)

    if len(base) >= 2:
        day_target = max(statistics.median(b["active_days"] for b in base), 2)
    elif peer_ok and peers.get("median_active_days_14d"):
        day_target = max(peers["median_active_days_14d"], 2)
    else:
        day_target = C.FALLBACK_ACTIVE_DAYS_14D
    consistency = _clamp(100 * active_days / day_target)
    # auto-resolved alarms weigh half as much as open ones
    open_share = min(1.0, open_alarms / (crit + warn)) if (crit + warn) else 0
    platform = _clamp(100 - (30 * crit + 10 * warn) * (0.5 + 0.5 * open_share))

    comps = {"engagement": engagement, "recency": recency, "breadth": breadth,
             "adoption": adoption, "consistency": consistency, "platform": platform}
    score = round(sum(comps[k] * C.WEIGHTS[k] for k in comps) / sum(C.WEIGHTS.values()), 1)

    status = "healthy" if score >= C.HEALTHY_AT else "watch" if score >= C.WATCH_AT else "at_risk"
    hard_stop = max(30, 4 * expected_gap)
    if days_since is None or days_since > hard_stop:
        status = "at_risk"
        reasons.append({"level": "risk", "text": "No user activity in " + (f"{days_since} days" if days_since else "the data")})
    elif len(base) >= 2 and ratio < 0.5 and status == "healthy":
        status = "watch"

    # human reasons, most important first
    if days_since is not None and days_since > expected_gap and days_since <= hard_stop:
        reasons.append({"level": "risk" if recency < 50 else "watch",
                        "text": f"Last user activity {days_since} days ago (usual gap {expected_gap:.0f})"})
    if ref_src == "own baseline":
        chg = round((ratio - 1) * 100)
        if chg <= -25:
            reasons.append({"level": "risk" if chg <= -50 else "watch", "text": f"Actions down {abs(chg)}% vs own baseline"})
        elif chg >= 25:
            reasons.append({"level": "good", "text": f"Actions up {chg}% vs own baseline"})
    elif engagement < 60:
        reasons.append({"level": "watch", "text": f"{cur_actions} actions in {W} days, below {ref_src} ({ref:.0f})"})
    if share < 0.5 and denom > 1:
        reasons.append({"level": "watch", "text": f"{len(users_cur)} of {denom} users active in {W} days"})
    if len(core_30) <= 1:
        reasons.append({"level": "watch", "text": f"Using {len(core_30)} object type in {C.ADOPTION_WINDOW} days"})
    if crit:
        reasons.append({"level": "risk", "text": f"{crit} critical alarm{'s' if crit > 1 else ''} in {W} days"})
    if warn:
        reasons.append({"level": "watch", "text": f"{warn} warning alarm{'s' if warn > 1 else ''} in {W} days"})
    if cur_events and cur_auto / cur_events > 0.5:
        reasons.append({"level": "info", "text": f"{cur_auto:,} automated events excluded from engagement"})
    if not reasons and status == "healthy":
        reasons.append({"level": "good", "text": "Steady engagement across users and features"})

    confidence = ("calibrating" if history_days < C.CALIBRATING_DAYS
                  else "building" if history_days < C.CALIBRATED_DAYS else "calibrated")

    metrics = {
        "history_days": history_days,
        "actions_14d": cur_actions, "actions_prev_14d": prev_actions, "actions_delta_14d": _delta(cur_actions, prev_actions),
        "actions_7d": a7, "actions_prev_7d": p7, "actions_wow": _delta(a7, p7),
        "events_14d": cur_events, "automated_events_14d": cur_auto,
        "active_users_14d": len(users_cur), "user_pool": denom,
        "active_users_7d": len(users_7), "active_users_prev_7d": len(users_p7),
        "active_days_14d": active_days, "active_day_target": day_target,
        "days_since_activity": days_since, "last_activity_date": last.isoformat() if last else None,
        "expected_gap_days": expected_gap,
        "object_types_30d": core_30,
        "alarms_critical_14d": crit, "alarms_warning_14d": warn, "alarms_open_14d": open_alarms,
        "dq_runs_30d": dq_runs, "dq_runs_with_exceptions_30d": dq_exc,
        "engagement_reference": round(ref, 1), "engagement_reference_source": ref_src,
        "baseline_windows": len(base),
    }
    return {"score": score, "status": status, "confidence": confidence,
            "components": {k: round(v, 1) for k, v in comps.items()}, "reasons": reasons, "metrics": metrics}


def _health(conn) -> dict:
    accts = conn.execute("select account_id, name, timezone, licensed_seats from accounts").fetchall()
    if not accts:
        return {"accounts": 0}
    through = conn.execute("select max(activity_date) as d from daily_activity").fetchone()["d"]
    if through is None:
        return {"accounts": 0}

    rows = defaultdict(list)
    for r in conn.execute(
        """select account_id, activity_date, user_id, actor_type, total_events, manual_events, automated_events,
                  actions, alarms_critical, alarms_warning, alarms_open, dq_runs, dq_runs_with_exceptions
           from daily_activity"""):
        rows[r["account_id"]].append(r)
    objs = defaultdict(list)
    for r in conn.execute(
        """select distinct d.account_id, d.activity_date, d.object_type
           from daily_activity_detail d join account_users u
             on u.account_id = d.account_id and u.user_id = d.user_id and not u.is_system"""):
        objs[r["account_id"]].append(r)
    users = defaultdict(dict)
    for r in conn.execute(
        """select account_id, user_id, min(activity_date) f, max(activity_date) l
           from daily_activity where actor_type = 'user' group by 1, 2"""):
        users[r["account_id"]][r["user_id"]] = (r["f"], r["l"])

    series = {a["account_id"]: _AccountSeries(a, rows[a["account_id"]], objs[a["account_id"]], users[a["account_id"]])
              for a in accts}
    peers = _peer_benchmarks(series)

    conn.execute("delete from health_snapshots")
    out_rows = []
    for aid, s in series.items():
        if s.first is None:
            continue
        peer_ok = peers["accounts"] - (1 if (s.through - s.first).days + 1 >= C.CURRENT_WINDOW else 0) >= C.MIN_PEERS
        d = s.first
        while d <= s.through:
            res = _score_day(s, d, peers, peer_ok)
            out_rows.append((aid, d, res["score"], res["status"], res["confidence"],
                             Jsonb(res["components"]), Jsonb(res["reasons"]), Jsonb(res["metrics"])))
            d += timedelta(1)
    with conn.cursor() as cur:
        cur.executemany(
            """insert into health_snapshots (account_id, as_of_date, score, status, confidence, components, reasons, metrics)
               values (%s,%s,%s,%s,%s,%s,%s,%s)""", out_rows)

    params = {
        "weights": C.WEIGHTS, "healthy_at": C.HEALTHY_AT, "watch_at": C.WATCH_AT,
        "auto_tx_per_minute": C.AUTO_TX_PER_MINUTE, "session_gap_minutes": C.SESSION_GAP_MINUTES,
        "current_window": C.CURRENT_WINDOW, "baseline_windows": C.BASELINE_WINDOWS,
        "peers": peers, "accounts_scored": len(series),
        "per_account": {
            str(aid): {
                "first_activity": s.first.isoformat() if s.first else None,
                "data_through": s.through.isoformat() if s.through else None,
                "active_days": len(s.active_dates),
                "expected_gap_days": _clamp(_pct(s.gaps_before(s.through), 0.75) if len(s.gaps_before(s.through)) >= 4 else 7, 2, 14),
                "baseline_windows": len(s.baseline_windows(s.through)),
            } for aid, s in series.items() if s.through
        },
    }
    conn.execute("insert into calibration_runs (data_through, params) values (%s, %s)", [through, Jsonb(params)])
    return {"accounts": len(series), "data_through": through.isoformat(), "snapshots": len(out_rows), "peers": peers}


def recompute(account_ids: list[int] | None = None) -> dict:
    with connect() as conn:
        if not account_ids:
            account_ids = [r["account_id"] for r in conn.execute("select account_id from accounts")]
        if account_ids:
            _rollup(conn, list(account_ids))
        health = _health(conn)
    return {"accounts_rolled_up": len(account_ids or []), **health}

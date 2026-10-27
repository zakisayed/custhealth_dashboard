"""Tunable model settings. Override any value with an env var of the same name."""
import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


# Activity classification
AUTO_TX_PER_MINUTE = _f("AUTO_TX_PER_MINUTE", 15)       # >= this many separate saves in one minute = machine speed
AUTO_SUSTAINED_PER_MINUTE = _f("AUTO_SUSTAINED_PER_MINUTE", 6)  # ...or this rate held for 10 minutes
SESSION_GAP_MINUTES = _f("SESSION_GAP_MINUTES", 30)     # inactivity gap that starts a new estimated session

# Health windows (days)
CURRENT_WINDOW = int(_f("CURRENT_WINDOW", 14))
BASELINE_WINDOWS = int(_f("BASELINE_WINDOWS", 6))       # prior 14-day windows used as the account's own baseline
ADOPTION_WINDOW = int(_f("ADOPTION_WINDOW", 30))
USER_POOL_WINDOW = int(_f("USER_POOL_WINDOW", 90))

# Component weights (sum to 1)
WEIGHTS = {
    "engagement": _f("W_ENGAGEMENT", 0.30),
    "recency": _f("W_RECENCY", 0.20),
    "breadth": _f("W_BREADTH", 0.15),
    "adoption": _f("W_ADOPTION", 0.15),
    "consistency": _f("W_CONSISTENCY", 0.10),
    "platform": _f("W_PLATFORM", 0.10),
}

# Status thresholds
HEALTHY_AT = _f("HEALTHY_AT", 70)
WATCH_AT = _f("WATCH_AT", 50)

# Targets used before an account has its own baseline
FALLBACK_ACTIONS_14D = _f("FALLBACK_ACTIONS_14D", 40)
FALLBACK_ACTIVE_DAYS_14D = _f("FALLBACK_ACTIVE_DAYS_14D", 4)
TARGET_ACTIVE_USER_SHARE = _f("TARGET_ACTIVE_USER_SHARE", 0.6)
TARGET_OBJECT_TYPES = _f("TARGET_OBJECT_TYPES", 4)
MIN_PEERS = int(_f("MIN_PEERS", 3))

CALIBRATING_DAYS = int(_f("CALIBRATING_DAYS", 28))
CALIBRATED_DAYS = int(_f("CALIBRATED_DAYS", 70))

# Alarm penalties on the platform component (points per alarm in the window)
ALARM_CRITICAL_PENALTY = _f("ALARM_CRITICAL_PENALTY", 30)
ALARM_WARNING_PENALTY = _f("ALARM_WARNING_PENALTY", 10)


# ----------------------------------------------------------------------------- admin-editable model
# The admin can change these from the Scoring model page. Values are stored in app_settings
# ('scoring_model') and loaded on every request, so all serverless instances agree.
# Env vars above stay the defaults; "Reset to defaults" goes back to them.
EDITABLE = {
    # key: (group, label, min, max, step, unit, help)
    "w_engagement": ("weights", "Engagement", 0, 100, 1, "%", "Actions in the last 14 days vs the customer's own baseline"),
    "w_recency": ("weights", "Recency", 0, 100, 1, "%", "Days since the last user action vs the usual gap"),
    "w_breadth": ("weights", "Breadth", 0, 100, 1, "%", "Share of known users active in 14 days"),
    "w_adoption": ("weights", "Adoption", 0, 100, 1, "%", "Object types used in 30 days"),
    "w_consistency": ("weights", "Consistency", 0, 100, 1, "%", "Active days in 14 days vs the usual pattern"),
    "w_platform": ("weights", "Platform", 0, 100, 1, "%", "Penalty for critical and warning alarms"),
    "healthy_at": ("status", "Healthy at or above", 1, 100, 1, "pts", "Scores at or above this are Healthy"),
    "watch_at": ("status", "Needs attention at or above", 0, 99, 1, "pts", "Scores from here up to Healthy need attention; below is At risk"),
    "fallback_actions_14d": ("targets", "Starting actions target (14 days)", 1, 10000, 1, "actions",
                             "Used until a customer has its own baseline or peers exist"),
    "fallback_active_days_14d": ("targets", "Starting active days target (14 days)", 1, 14, 1, "days",
                                 "Used until a customer has its own baseline or peers exist"),
    "target_active_user_share": ("targets", "Active user share for full Breadth", 5, 100, 1, "%",
                                 "Breadth reaches 100 when this share of users is active"),
    "target_object_types": ("targets", "Object types for full Adoption", 1, 10, 1, "types",
                            "Adoption reaches 100 at this many object types in 30 days"),
    "alarm_critical_penalty": ("targets", "Points lost per critical alarm", 0, 100, 1, "pts", "Platform component"),
    "alarm_warning_penalty": ("targets", "Points lost per warning alarm", 0, 100, 1, "pts", "Platform component"),
    "calibrating_days": ("calibration", "Calibrating until", 7, 365, 1, "days", "Confidence is Calibrating below this much history"),
    "calibrated_days": ("calibration", "Calibrated from", 14, 730, 1, "days", "Confidence is Calibrated from this much history"),
    "auto_tx_per_minute": ("classification", "Automated burst", 3, 200, 1, "saves/min",
                           "Saves in one minute at or above this count as automated (machine speed)"),
    "auto_sustained_per_minute": ("classification", "Automated sustained rate", 1, 100, 1, "saves/min",
                                  "This rate held for 10 minutes also counts as automated"),
    "session_gap_minutes": ("classification", "Session gap", 5, 240, 1, "min", "Inactivity that starts a new estimated session"),
}
WEIGHT_KEYS = [k for k, v in EDITABLE.items() if v[0] == "weights"]


def current_model() -> dict:
    g = globals()
    m = {f"w_{k}": round(v * 100, 2) for k, v in WEIGHTS.items()}
    m.update(healthy_at=HEALTHY_AT, watch_at=WATCH_AT,
             fallback_actions_14d=FALLBACK_ACTIONS_14D, fallback_active_days_14d=FALLBACK_ACTIVE_DAYS_14D,
             target_active_user_share=round(TARGET_ACTIVE_USER_SHARE * 100, 2), target_object_types=TARGET_OBJECT_TYPES,
             alarm_critical_penalty=g["ALARM_CRITICAL_PENALTY"], alarm_warning_penalty=g["ALARM_WARNING_PENALTY"],
             calibrating_days=CALIBRATING_DAYS, calibrated_days=CALIBRATED_DAYS,
             auto_tx_per_minute=AUTO_TX_PER_MINUTE, auto_sustained_per_minute=AUTO_SUSTAINED_PER_MINUTE,
             session_gap_minutes=SESSION_GAP_MINUTES)
    return m


DEFAULT_MODEL = None  # filled at import end


def validate_model(raw: dict) -> dict:
    """Merge onto defaults, clamp, and check relationships. Weights are normalized to 100%."""
    m = dict(DEFAULT_MODEL)
    for k, v in (raw or {}).items():
        if k not in EDITABLE:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{EDITABLE[k][1]}: enter a number") from exc
        lo, hi = EDITABLE[k][2], EDITABLE[k][3]
        if not lo <= v <= hi:
            raise ValueError(f"{EDITABLE[k][1]} must be between {lo:g} and {hi:g}")
        m[k] = v
    total = sum(m[k] for k in WEIGHT_KEYS)
    if total <= 0:
        raise ValueError("At least one weight must be above 0")
    for k in WEIGHT_KEYS:
        m[k] = round(m[k] * 100 / total, 2)
    if m["watch_at"] >= m["healthy_at"]:
        raise ValueError("Needs attention must start below Healthy")
    if m["calibrating_days"] >= m["calibrated_days"]:
        raise ValueError("Calibrated must start after Calibrating ends")
    for k in ("fallback_active_days_14d", "target_object_types", "calibrating_days", "calibrated_days"):
        m[k] = int(round(m[k]))
    return m


def apply_model(m: dict) -> None:
    g = globals()
    for k in WEIGHT_KEYS:
        WEIGHTS[k[2:]] = m[k] / 100
    g["HEALTHY_AT"], g["WATCH_AT"] = m["healthy_at"], m["watch_at"]
    g["FALLBACK_ACTIONS_14D"] = m["fallback_actions_14d"]
    g["FALLBACK_ACTIVE_DAYS_14D"] = m["fallback_active_days_14d"]
    g["TARGET_ACTIVE_USER_SHARE"] = m["target_active_user_share"] / 100
    g["TARGET_OBJECT_TYPES"] = m["target_object_types"]
    g["ALARM_CRITICAL_PENALTY"], g["ALARM_WARNING_PENALTY"] = m["alarm_critical_penalty"], m["alarm_warning_penalty"]
    g["CALIBRATING_DAYS"], g["CALIBRATED_DAYS"] = int(m["calibrating_days"]), int(m["calibrated_days"])
    g["AUTO_TX_PER_MINUTE"] = m["auto_tx_per_minute"]
    g["AUTO_SUSTAINED_PER_MINUTE"] = m["auto_sustained_per_minute"]
    g["SESSION_GAP_MINUTES"] = m["session_gap_minutes"]


CLASSIFICATION_KEYS = [k for k, v in EDITABLE.items() if v[0] == "classification"]


def load_model(conn) -> dict | None:
    """Apply the saved model (or the defaults). Returns the saved record, if any."""
    row = conn.execute("select value from app_settings where key='scoring_model'").fetchone()
    if not row:
        apply_model(DEFAULT_MODEL)
        return None
    import json
    rec = json.loads(row["value"])
    try:
        apply_model(validate_model(rec.get("model", {})))
    except ValueError:
        apply_model(DEFAULT_MODEL)
    return rec


DEFAULT_MODEL = current_model()

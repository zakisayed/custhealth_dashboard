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

"""Email + password login for the dashboard.

- Passwords: PBKDF2-SHA256 (stdlib), per-user salt.
- Sessions: signed bearer tokens (HMAC-SHA256). The signing secret comes from SESSION_SECRET,
  or is generated once and stored in app_settings, so no extra setup is needed.
  A token carries the user's password_version; changing or resetting a password, or deleting
  the user, invalidates every existing session of that user.
- The admin (ADMIN_EMAIL, default admin@dvsum.com) is created on first start with the
  temporary password ChangeMe (or ADMIN_INITIAL_PASSWORD) and must change it at first login.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@dvsum.com").strip().lower()
DEFAULT_TEMP_PASSWORD = "ChangeMe"
TOKEN_TTL_SECONDS = int(os.environ.get("SESSION_HOURS", "168")) * 3600   # 7 days
MAX_FAILED_LOGINS = 5
LOCK_MINUTES = 10
PBKDF2_ITERATIONS = 240_000
MIN_PASSWORD_LENGTH = 8
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_secret_cache: bytes | None = None


class AuthFailure(Exception):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


# ----------------------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def validate_new_password(new: str, *, email: str, old: str | None = None) -> None:
    if len(new) < MIN_PASSWORD_LENGTH:
        raise AuthFailure(f"Use at least {MIN_PASSWORD_LENGTH} characters.", 400)
    if new == DEFAULT_TEMP_PASSWORD or new.lower() == "changeme":
        raise AuthFailure("Choose a password other than the temporary one.", 400)
    if old is not None and new == old:
        raise AuthFailure("The new password must be different from the current one.", 400)
    if new.strip().lower() == email.lower():
        raise AuthFailure("Do not use your email address as the password.", 400)
    if not (re.search(r"[A-Za-z]", new) and re.search(r"[^A-Za-z]", new)):
        raise AuthFailure("Use letters and at least one number or symbol.", 400)


def normalize_email(email: str) -> str:
    e = (email or "").strip().lower()
    if not EMAIL_RE.match(e):
        raise AuthFailure("Enter a valid email address.", 400)
    return e


# ----------------------------------------------------------------------------- tokens
def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _secret(conn) -> bytes:
    global _secret_cache
    if _secret_cache:
        return _secret_cache
    env = os.environ.get("SESSION_SECRET")
    if env:
        _secret_cache = env.encode()
        return _secret_cache
    conn.execute("insert into app_settings (key, value) values ('session_secret', %s) on conflict (key) do nothing",
                 [secrets.token_hex(32)])
    row = conn.execute("select value from app_settings where key='session_secret'").fetchone()
    _secret_cache = row["value"].encode()
    return _secret_cache


def issue_token(conn, user: dict) -> str:
    payload = _b64(json.dumps({"uid": user["user_id"], "v": user["password_version"],
                               "exp": int(time.time()) + TOKEN_TTL_SECONDS}, separators=(",", ":")).encode())
    sig = _b64(hmac.new(_secret(conn), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def user_from_token(conn, token: str | None) -> dict:
    if not token or "." not in token:
        raise AuthFailure("Sign in to continue.")
    payload, sig = token.rsplit(".", 1)
    good = _b64(hmac.new(_secret(conn), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, good):
        raise AuthFailure("Your session is not valid. Sign in again.")
    try:
        data = json.loads(_unb64(payload))
    except ValueError as exc:
        raise AuthFailure("Your session is not valid. Sign in again.") from exc
    if data.get("exp", 0) < time.time():
        raise AuthFailure("Your session expired. Sign in again.")
    user = conn.execute("select * from app_users where user_id=%s", [data.get("uid")]).fetchone()
    if not user or user["password_version"] != data.get("v"):
        raise AuthFailure("Your session ended. Sign in again.")
    return user


# ----------------------------------------------------------------------------- users
def public_user(u: dict) -> dict:
    return {"user_id": u["user_id"], "email": u["email"], "role": u["role"],
            "must_change_password": u["must_change_password"],
            "created_at": u["created_at"], "created_by": u["created_by"],
            "last_login_at": u["last_login_at"], "password_changed_at": u["password_changed_at"],
            "is_primary_admin": u["email"].lower() == ADMIN_EMAIL}


def ensure_admin(conn) -> None:
    pw = os.environ.get("ADMIN_INITIAL_PASSWORD") or DEFAULT_TEMP_PASSWORD
    conn.execute(
        """insert into app_users (email, password_hash, role, must_change_password, created_by)
           select %s, %s, 'admin', true, 'system'
           where not exists (select 1 from app_users where lower(email)=%s)""",
        [ADMIN_EMAIL, hash_password(pw), ADMIN_EMAIL])
    conn.execute("update app_users set role='admin' where lower(email)=%s and role<>'admin'", [ADMIN_EMAIL])


def login(conn, email: str, password: str) -> tuple[dict, str]:
    e = (email or "").strip().lower()
    user = conn.execute("select * from app_users where lower(email)=%s", [e]).fetchone()
    generic = AuthFailure("Email or password is incorrect.")
    if not user:
        verify_password(password, hash_password("timing-equalizer"))
        raise generic
    locked = conn.execute("select locked_until > now() l from app_users where user_id=%s", [user["user_id"]]).fetchone()["l"]
    if locked:
        raise AuthFailure(f"Too many failed attempts. Try again in {LOCK_MINUTES} minutes.", 429)
    if not verify_password(password, user["password_hash"]):
        conn.execute(
            """update app_users set failed_logins = failed_logins + 1,
                   locked_until = case when failed_logins + 1 >= %s then now() + make_interval(mins => %s) end
               where user_id=%s""", [MAX_FAILED_LOGINS, LOCK_MINUTES, user["user_id"]])
        conn.commit()
        raise generic
    user = conn.execute("""update app_users set failed_logins=0, locked_until=null, last_login_at=now()
                           where user_id=%s returning *""", [user["user_id"]]).fetchone()
    return user, issue_token(conn, user)


def change_password(conn, user: dict, current: str, new: str) -> tuple[dict, str]:
    if not verify_password(current, user["password_hash"]):
        raise AuthFailure("Your current password is incorrect.", 400)
    validate_new_password(new, email=user["email"], old=current)
    user = conn.execute(
        """update app_users set password_hash=%s, must_change_password=false, password_version=password_version+1,
               password_changed_at=now() where user_id=%s returning *""",
        [hash_password(new), user["user_id"]]).fetchone()
    return user, issue_token(conn, user)   # old sessions end, this one continues


def create_user(conn, admin: dict, email: str, temp_password: str | None) -> dict:
    e = normalize_email(email)
    temp = (temp_password or "").strip() or DEFAULT_TEMP_PASSWORD
    if len(temp) < 6:
        raise AuthFailure("The temporary password needs at least 6 characters.", 400)
    if conn.execute("select 1 from app_users where lower(email)=%s", [e]).fetchone():
        raise AuthFailure("A user with this email already exists.", 409)
    return conn.execute(
        """insert into app_users (email, password_hash, role, must_change_password, created_by)
           values (%s, %s, 'user', true, %s) returning *""", [e, hash_password(temp), admin["email"]]).fetchone()


def reset_password(conn, user_id: int, temp_password: str | None) -> dict:
    temp = (temp_password or "").strip() or DEFAULT_TEMP_PASSWORD
    if len(temp) < 6:
        raise AuthFailure("The temporary password needs at least 6 characters.", 400)
    u = conn.execute(
        """update app_users set password_hash=%s, must_change_password=true, password_version=password_version+1,
               failed_logins=0, locked_until=null where user_id=%s returning *""",
        [hash_password(temp), user_id]).fetchone()
    if not u:
        raise AuthFailure("User not found.", 404)
    return u


def delete_user(conn, admin: dict, user_id: int) -> dict:
    u = conn.execute("select * from app_users where user_id=%s", [user_id]).fetchone()
    if not u:
        raise AuthFailure("User not found.", 404)
    if u["user_id"] == admin["user_id"]:
        raise AuthFailure("You cannot delete your own account.", 400)
    if u["email"].lower() == ADMIN_EMAIL:
        raise AuthFailure("The primary admin cannot be deleted.", 400)
    conn.execute("delete from app_users where user_id=%s", [user_id])
    return u

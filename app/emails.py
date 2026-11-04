"""Email matching for server-side imports (same rules as public/js/email.js).

Owner, steward and similar records inside after_image / before_image pair a user with an
email, for example system_owner_id + system_owner_name + system_owner_email. Every pair is
collected so each user can be matched by id first, then by name.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict

EMAIL_RE = re.compile(r"^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$", re.I)
EM_KEY = re.compile(r"\"*([A-Za-z_]*?)email\"*\s*:\s*\"*([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")


def norm_name(n) -> str:
    return " ".join(str(n or "").split()).lower()


def loose(text):
    """after_image arrives double-encoded with CSV-doubled quotes. Peel until it parses."""
    t = text
    for _ in range(4):
        if isinstance(t, (dict, list)):
            return t
        if not isinstance(t, str):
            return None
        try:
            t = json.loads(t)
            continue
        except ValueError:
            pass
        t2 = t.strip()
        if t2.startswith('"') and t2.endswith('"'):
            t2 = t2[1:-1]
        t2 = t2.replace('""', '"')
        if t2 == t:
            return None
        t = t2
    return t if isinstance(t, (dict, list)) else None


class EmailCollector:
    def __init__(self):
        self.by_id: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.by_name: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def _add(self, uid, name, em):
        em = str(em or "").strip().lower()
        if not EMAIL_RE.match(em):
            return
        if uid is not None and str(uid).strip() != "":
            self.by_id[str(uid).strip().lstrip("'")][em] += 1
        n = norm_name(name)
        if n:
            self.by_name[n][em] += 1

    def _walk(self, o):
        if isinstance(o, list):
            for x in o:
                self._walk(x)
            return
        if not isinstance(o, dict):
            return
        for k, v in o.items():
            if isinstance(k, str) and k.lower().endswith("email") and isinstance(v, str):
                pre = k[:-5]

                def pick(keys):
                    for x in keys:
                        if o.get(x) not in (None, ""):
                            return o[x]
                    return None
                self._add(pick([pre + "id", pre + "user_id", "user_id", "id"]),
                          pick([pre + "name", pre + "user_name", "user_name", "name"]), v)
            elif isinstance(v, (dict, list)):
                self._walk(v)

    def _scan(self, t: str):
        # Text fallback for payloads that do not parse (for example cut at Excel's cell limit).
        for m in EM_KEY.finditer(t):
            lo, hi = t.rfind("{", 0, m.start()), t.find("}", m.start())
            seg = t[max(lo, 0): hi if hi >= 0 else None]
            pre = re.sub(r"[^A-Za-z_]", "", m.group(1))
            idm = (re.search(r'"*' + re.escape(pre) + r"(?:user_)?id\"*\s*:\s*\"*'?(\d+)", seg)
                   or re.search(r"\"*user_id\"*\s*:\s*\"*'?(\d+)", seg))
            nm = (re.search(r'"*' + re.escape(pre) + r'(?:user_)?name"*\s*:\s*"+([^"]+)"', seg)
                  or re.search(r'"*user_name"*\s*:\s*"+([^"]+)"', seg))
            self._add(idm and idm.group(1), nm and nm.group(1), m.group(2))

    def add_text(self, s):
        if not s or not isinstance(s, str) or "@" not in s:
            return
        o = loose(s) if len(s) < 32000 else None
        if o is not None:
            self._walk(o)
        else:
            self._scan(s)

    def lookup_fn(self):
        ids = {k: max(v.items(), key=lambda x: x[1])[0] for k, v in self.by_id.items() if v}
        names = {k: max(v.items(), key=lambda x: x[1])[0] for k, v in self.by_name.items() if v}

        def lookup(user_id, user_name):
            uid = str(user_id or "").strip().lstrip("'")
            if uid in ids:
                return ids[uid]
            n = norm_name(user_name)
            if n in names:
                return names[n]
            un = str(user_name or "").strip()
            return un.lower() if EMAIL_RE.match(un) else None
        return lookup

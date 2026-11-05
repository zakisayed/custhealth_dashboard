"""Microsoft Graph client for reading customer export folders in SharePoint.

App-only (client credentials) sign in. Set these in the Vercel project:
  SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET
The Entra app needs the Microsoft Graph *application* permission Sites.Read.All (or
Sites.Selected with read access granted on each site) with admin consent. Sharing links
(https://<tenant>.sharepoint.com/:f:/s/...) are resolved through the shares API, which needs
Files.Read.All or Files.ReadWrite.All; plain folder links only need Sites.Read.All.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request

GRAPH = "https://graph.microsoft.com/v1.0"
ENV = {
    "tenant": ("SHAREPOINT_TENANT_ID", "AZURE_TENANT_ID", "MS_TENANT_ID"),
    "client": ("SHAREPOINT_CLIENT_ID", "AZURE_CLIENT_ID", "MS_CLIENT_ID"),
    "secret": ("SHAREPOINT_CLIENT_SECRET", "AZURE_CLIENT_SECRET", "MS_CLIENT_SECRET"),
}
TIMEOUT = 60


class GraphError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _env(kind: str) -> str | None:
    for k in ENV[kind]:
        v = (os.environ.get(k) or "").strip()
        if v:
            return v
    return None


def config_status() -> dict:
    return {k: bool(_env(k)) for k in ENV}


def configured() -> bool:
    return all(config_status().values())


_token: dict = {"value": None, "exp": 0.0, "key": None}


def token() -> str:
    tenant, client, secret = _env("tenant"), _env("client"), _env("secret")
    if not (tenant and client and secret):
        missing = [ENV[k][0] for k, ok in config_status().items() if not ok]
        raise GraphError(f"SharePoint is not set up. Add {', '.join(missing)} in the Vercel project settings, then redeploy.")
    key = (tenant, client, secret)
    if _token["value"] and _token["key"] == key and time.time() < _token["exp"] - 120:
        return _token["value"]
    body = urllib.parse.urlencode({
        "client_id": client, "client_secret": secret, "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }).encode()
    req = urllib.request.Request(f"https://login.microsoftonline.com/{urllib.parse.quote(tenant)}/oauth2/v2.0/token",
                                 data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            j = json.load(r)
    except urllib.error.HTTPError as exc:
        try:
            d = json.load(exc)
            msg = d.get("error_description") or d.get("error") or str(exc)
        except Exception:
            msg = str(exc)
        msg = msg.split("\r\n")[0].split(" Trace ID")[0]
        raise GraphError(f"Microsoft sign in failed: {msg}. Check the tenant id, client id and client secret.", exc.code) from exc
    except urllib.error.URLError as exc:
        raise GraphError(f"Could not reach Microsoft sign in: {exc.reason}") from exc
    _token.update(value=j["access_token"], exp=time.time() + int(j.get("expires_in", 3600)), key=key)
    return _token["value"]


def _hint(status: int, msg: str) -> str:
    if status in (401, 403):
        return (f"{msg} The app registration needs the Microsoft Graph application permission Sites.Read.All "
                "(or Sites.Selected with read access to this site) and admin consent.")
    if status == 404:
        return f"{msg} Check the folder link and that the app has access to that site."
    return msg


def graph(path_or_url: str, params: dict | None = None) -> dict:
    url = path_or_url if path_or_url.startswith("https://") else GRAPH + path_or_url
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for attempt in range(4):
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503, 504) and attempt < 3:
                time.sleep(min(20, int(exc.headers.get("Retry-After") or 2 ** attempt)))
                continue
            try:
                d = json.load(exc)
                msg = (d.get("error") or {}).get("message") or str(exc)
            except Exception:
                msg = str(exc)
            raise GraphError(_hint(exc.code, f"SharePoint returned {exc.code}: {msg}"), exc.code) from exc
        except urllib.error.URLError as exc:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise GraphError(f"Could not reach Microsoft Graph: {exc.reason}") from exc
    raise GraphError("Microsoft Graph kept throttling the request. It will be retried on the next check.")


# ----------------------------------------------------------------------------- folder links
def _share_id(url: str) -> str:
    b = base64.urlsafe_b64encode(url.strip().encode()).decode().rstrip("=")
    return "u!" + b


def _item(d: dict) -> dict:
    ref = d.get("parentReference") or {}
    return {"drive_id": ref.get("driveId"), "item_id": d.get("id"), "name": d.get("name"),
            "web_url": d.get("webUrl"), "is_folder": "folder" in d, "child_count": (d.get("folder") or {}).get("childCount")}


def resolve(url: str) -> dict:
    """Folder link (browser address, library view, or sharing link) -> drive id + item id."""
    url = (url or "").strip()
    p = urllib.parse.urlparse(url)
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not host.endswith((".sharepoint.com", ".sharepoint.us", ".sharepoint.de", ".sharepoint.cn")):
        raise GraphError("Paste a SharePoint folder link that starts with https://<your-tenant>.sharepoint.com/")
    if p.path.startswith("/:"):
        it = _item(graph(f"/shares/{_share_id(url)}/driveItem"))
    else:
        qs = dict(urllib.parse.parse_qsl(p.query))
        full = urllib.parse.unquote(qs.get("id") or qs.get("RootFolder") or p.path).rstrip("/")
        low = full.lower()
        for tail in ("/forms/allitems.aspx", "/allitems.aspx"):
            if low.endswith(tail):
                full, low = full[: -len(tail)], low[: -len(tail)]
        if low.endswith(".aspx"):
            full = full.rsplit("/", 1)[0]
        parts = [x for x in full.split("/") if x]
        if len(parts) >= 2 and parts[0].lower() in ("sites", "teams"):
            site = graph(f"/sites/{host}:/{parts[0]}/{urllib.parse.quote(parts[1])}")
        else:
            site = graph(f"/sites/{host}")
        drives = graph(f"/sites/{site['id']}/drives", {"$select": "id,name,webUrl"}).get("value", [])
        best, best_len = None, -1
        for d in drives:
            dp = urllib.parse.unquote(urllib.parse.urlparse(d.get("webUrl") or "").path).rstrip("/").lower()
            if dp and (low == dp or low.startswith(dp + "/")) and len(dp) > best_len:
                best, best_len = d, len(dp)
        if not best:
            try:
                it = _item(graph(f"/shares/{_share_id(url)}/driveItem"))
            except GraphError:
                names = ", ".join(d.get("name", "") for d in drives) or "none"
                raise GraphError(f"Could not find a document library for that link. Libraries on this site: {names}.")
        else:
            rel = full[best_len:].strip("/")
            path = f"/drives/{best['id']}/root" + (f":/{urllib.parse.quote(rel)}" if rel else "")
            it = _item(graph(path))
            it["drive_id"] = it["drive_id"] or best["id"]
    if not it["is_folder"]:
        raise GraphError("That link opens a file. Paste the link to the folder the exports are saved in.")
    return it


MAX_DEPTH = 3   # subfolders read below the watched folder


def list_files(drive_id: str, item_id: str, depth: int = MAX_DEPTH, _prefix: str = "") -> list[dict]:
    """Files in the folder and its subfolders (up to MAX_DEPTH levels). Office lock files are skipped."""
    out, subfolders = [], []
    url = f"/drives/{drive_id}/items/{item_id}/children"
    params = {"$top": "200", "$select": "id,name,size,file,folder,lastModifiedDateTime,cTag,eTag,webUrl"}
    while url:
        page = graph(url, params)
        params = None
        for d in page.get("value", []):
            name = d.get("name", "")
            if "folder" in d:
                subfolders.append((d["id"], name))
                continue
            if "file" not in d or name.startswith("~$"):
                continue
            out.append({"item_id": d["id"], "name": name, "folder": _prefix or None, "size": d.get("size"),
                        "modified_at": d.get("lastModifiedDateTime"), "ctag": d.get("cTag") or d.get("eTag"),
                        "web_url": d.get("webUrl")})
        url = page.get("@odata.nextLink")
    if depth > 0:
        for fid, fname in subfolders:
            out += list_files(drive_id, fid, depth - 1, f"{_prefix}/{fname}" if _prefix else fname)
    return out


def download(drive_id: str, item_id: str, dest: str) -> int:
    """Download to dest. Uses the short-lived pre-authenticated URL (no bearer on the redirect)."""
    meta = graph(f"/drives/{drive_id}/items/{item_id}")
    link = meta.get("@microsoft.graph.downloadUrl")
    if not link:
        raise GraphError("SharePoint did not return a download link for this file.")
    req = urllib.request.Request(link)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r, open(dest, "wb") as fh:
            shutil.copyfileobj(r, fh, 8 * 1024 * 1024)
    except urllib.error.URLError as exc:
        raise GraphError(f"Download failed: {getattr(exc, 'reason', exc)}") from exc
    return os.path.getsize(dest)

"""Read the export job's execution log (audit_export.log).

The export job writes one log per run, for example:

    2026-11-05 07:14:01 UTC  run started
    Exporting 2026-11-04 (UTC) for 7 customer(s)
    === Processing Ameritas (45451235) ===
    Records extracted: 16 (1 sheet)
    Uploading as dynamodb_records_Ameritas_45451235_2026-11-04_run20261105_071402.xlsx ...
    Uploaded to SharePoint: https://...
    === Processing Brown&Caldwell (46593239) ===
    No records for Brown&Caldwell (46593239) on 2026-11-04; nothing to upload.
    Finished processing 7 customers for 2026-11-04.
    2026-11-05 07:14:11 UTC  run finished OK

Each customer block becomes one result:
  success      records were extracted and the file was uploaded
  no_activity  the job ran fine and found 0 records for that day
  failed       an error line, or the block ended before the upload finished
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone

RE_START = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:UTC|Z)?\s+run started", re.I)
RE_FINISH = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:UTC|Z)?\s+run finished\s*(.*)$", re.I)
RE_EXPORT = re.compile(r"^Exporting\s+(\d{4}-\d{2}-\d{2})(?:\s*\((\w+)\))?\s+for\s+(\d+)\s+customer", re.I)
RE_BLOCK = re.compile(r"^=+\s*Processing\s+(.+?)\s*\((\d+)\)\s*=+\s*$", re.I)
RE_QUERY_DATE = re.compile(r"\bon\s+(\d{4}-\d{2}-\d{2})\b")
RE_RECORDS = re.compile(r"^Records extracted:\s*([\d,]+)", re.I)
RE_NONE = re.compile(r"^No records for .*?(?:on\s+(\d{4}-\d{2}-\d{2}))?", re.I)
RE_UPLOADING = re.compile(r"^Uploading as\s+(.+?)\s*(?:\.\.\.|…)?\s*$", re.I)
RE_UPLOADED = re.compile(r"^Uploaded to SharePoint:\s*(\S+)", re.I)
RE_ERROR = re.compile(r"\b(error|exception|traceback|failed|failure|denied|timed? ?out|unable to|could not)\b", re.I)
RE_FINISHED_ALL = re.compile(r"^Finished processing\s+(\d+)\s+customers?", re.I)


def _ts(d: str, t: str) -> datetime:
    return datetime.fromisoformat(f"{d}T{t}").replace(tzinfo=timezone.utc)


def _day(s: str | None) -> date | None:
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


def _close(block: dict | None, run: dict) -> None:
    if not block:
        return
    if block["status"] is None:
        if block["error"]:
            block["status"], block["message"] = "failed", block["error"]
        elif block["records"] == 0:
            block["status"] = "no_activity"
            block["message"] = block["message"] or "No records for this day"
        elif block["records"] is not None and block["uploaded"]:
            block["status"] = "success"
        elif block["records"] is not None:
            block["status"] = "failed"
            block["message"] = "Records were extracted but the upload to SharePoint did not finish"
        else:
            block["status"] = "failed"
            block["message"] = block["last_line"] or "The export stopped before any records were read"
    block.pop("error", None)
    block.pop("last_line", None)
    block["export_date"] = block["export_date"] or run["export_date"]
    run["results"].append(block)


def _new_run(start: datetime | None) -> dict:
    return {"started_at": start, "finished_at": None, "export_date": None, "export_tz": None,
            "customers_expected": None, "customers_finished": None, "status": "running",
            "finish_note": None, "errors": [], "results": [], "lines": []}


def parse(text: str) -> list[dict]:
    """Parse a log into runs. A file normally holds one run; several are handled too."""
    runs: list[dict] = []
    run: dict | None = None
    block: dict | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = RE_START.match(line)
        if m:
            if run:
                _close(block, run)
                runs.append(run)
            run, block = _new_run(_ts(m[1], m[2])), None
            continue
        if run is None:
            run = _new_run(None)  # log without a start line
        run["lines"].append(line)
        m = RE_FINISH.match(line)
        if m:
            _close(block, run)
            block = None
            run["finished_at"] = _ts(m[1], m[2])
            note = m[3].strip()
            run["finish_note"] = note or None
            run["status"] = "ok" if re.match(r"^(ok|success|successfully)\b", note, re.I) else "failed"
            continue
        m = RE_EXPORT.match(line)
        if m:
            run["export_date"], run["export_tz"], run["customers_expected"] = _day(m[1]), m[2], int(m[3])
            continue
        m = RE_BLOCK.match(line)
        if m:
            _close(block, run)
            block = {"customer_name": m[1].strip(), "account_id": int(m[2]), "export_date": None, "status": None,
                     "records": None, "file_name": None, "file_url": None, "uploaded": False, "message": None,
                     "error": None, "last_line": None}
            continue
        m = RE_FINISHED_ALL.match(line)
        if m:
            _close(block, run)
            block = None
            run["customers_finished"] = int(m[1])
            continue
        if block is None:
            if RE_ERROR.search(line):
                run["errors"].append(line[:300])
            continue
        block["last_line"] = line[:300]
        if (m := RE_QUERY_DATE.search(line)) and line.lower().startswith("querying"):
            block["export_date"] = _day(m[1])
        if (m := RE_NONE.match(line)):
            block["records"] = 0
            block["status"] = "no_activity"
            block["message"] = "No records for this day, nothing to upload"
            if m[1]:
                block["export_date"] = _day(m[1])
        elif (m := RE_RECORDS.match(line)):
            block["records"] = int(m[1].replace(",", ""))
        elif (m := RE_UPLOADING.match(line)):
            block["file_name"] = m[1]
        elif (m := RE_UPLOADED.match(line)):
            block["uploaded"], block["file_url"] = True, m[1]
        elif RE_ERROR.search(line) and not block["error"]:
            block["error"] = line[:300]
    if run:
        _close(block, run)
        runs.append(run)
    for r in runs:
        r.pop("lines", None)
        for b in r["results"]:
            b.pop("uploaded", None)
        if r["status"] == "running" and r["results"] and r["customers_finished"] is not None:
            r["status"] = "ok"  # finished line missing but the job reported completion
        bad = sum(1 for b in r["results"] if b["status"] == "failed")
        if r["status"] == "ok" and bad:
            r["status"] = "partial"
        missing = (r["customers_expected"] or 0) - len(r["results"])
        notes = []
        if r["finish_note"] and r["status"] != "ok":
            notes.append(f"Run finished: {r['finish_note']}")
        if missing > 0:
            notes.append(f"{missing} of {r['customers_expected']} customers have no entry in the log")
        notes += r["errors"][:3]
        r["message"] = ". ".join(notes) or None
        r.pop("errors", None)
        r.pop("customers_finished", None)
    return [r for r in runs if r["started_at"] or r["results"]]

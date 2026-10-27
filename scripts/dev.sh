#!/usr/bin/env bash
# Local dev: serves the API and the static dashboard on http://127.0.0.1:8000
set -e
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --reload

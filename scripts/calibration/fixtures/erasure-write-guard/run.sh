#!/usr/bin/env bash
# Erasure write guard fixture runner — spins an EPHEMERAL local Postgres, applies the stub
# schema + the REAL migration 166 + the assertions, reports PASS/FAIL. Non-mutating to PROD
# (own cluster). Requirements: local Postgres tools on PATH (initdb / pg_ctl / psql). Run:
#   bash scripts/calibration/fixtures/erasure-write-guard/run.sh
# (CI wiring — a postgres service step — is the G4 follow-up obligation.)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
MIG="$REPO/supabase/migrations/166_erasure_write_guard.sql"
PGDATA="${TMPDIR:-/tmp}/pg_t166_fixture"
PORT="${PG_FIXTURE_PORT:-54402}"
LOG="${TMPDIR:-/tmp}/pg_t166_fixture.log"

[ -f "$MIG" ] || { echo "FAIL: migration not found at $MIG"; exit 1; }

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1

P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -f "$HERE/schema-stub.sql"
P -f "$MIG"
P -f "$HERE/assert.sql"

echo ">>> ERASURE-WRITE-GUARD (mig 166) FIXTURE: PASS <<<"

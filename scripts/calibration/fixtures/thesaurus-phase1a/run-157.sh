#!/usr/bin/env bash
# Phase 1a mig-157 fixture runner — spins an EPHEMERAL local Postgres, applies the stub schema +
# the REAL migration 157 + the assertions, reports PASS/FAIL. Non-mutating to PROD (own cluster).
# Requirements: local Postgres tools on PATH (initdb / pg_ctl / psql). Manually runnable:
#   bash scripts/calibration/fixtures/thesaurus-phase1a/run-157.sh
# (CI wiring — a postgres service step — is the G4 follow-up obligation.)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
MIG="$REPO/supabase/migrations/157_thesaurus_phase1a_plan_covered_4col_rekey.sql"
PGDATA="${TMPDIR:-/tmp}/pg_t157_fixture"
PORT="${PG_FIXTURE_PORT:-54402}"
LOG="${TMPDIR:-/tmp}/pg_t157_fixture.log"

[ -f "$MIG" ] || { echo "FAIL: migration not found at $MIG"; exit 1; }

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1

P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -f "$HERE/schema-stub-157.sql"
P -f "$MIG"
P -f "$HERE/assert-157.sql"

echo ">>> THESAURUS PHASE-1A MIG-157 FIXTURE: PASS <<<"

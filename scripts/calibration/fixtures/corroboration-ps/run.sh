#!/usr/bin/env bash
# S205 Corroboration-PS gate (a) — ephemeral-PG evaluator fixture.
# Spins an EPHEMERAL local Postgres, applies the (shared) stub schema + the REAL migration 156
# (evaluate_pattern1_corroboration, UNCHANGED by F) + the F assertions. Non-mutating to PROD.
# Requirements: local Postgres tools on PATH (initdb / pg_ctl / psql). Manually runnable:
#   bash scripts/calibration/fixtures/corroboration-ps/run.sh
# (CI wiring — a postgres service step — is the G4 follow-up obligation, shared with the
#  thesaurus-phase1a fixture.)
#
# What it proves: per-service corroboration FIRES once the candidate fieldName == the stored
# provenance key == the plan_covered_services COLUMN name (the S205 name-align), with `value`
# present (the S205 value-wiring) — AND that the pre-S205 canonical-style alias (e.g. `copay`)
# counts ZERO (the exact bug). Reuses the thesaurus-phase1a schema-stub (one source of truth).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STUB="$REPO/scripts/calibration/fixtures/thesaurus-phase1a/schema-stub.sql"
MIG="$REPO/supabase/migrations/156_thesaurus_phase1a_pos_component_corroboration.sql"
PGDATA="${TMPDIR:-/tmp}/pg_corroboration_ps_fixture"
PORT="${PG_FIXTURE_PORT:-54402}"
LOG="${TMPDIR:-/tmp}/pg_corroboration_ps_fixture.log"

[ -f "$STUB" ] || { echo "FAIL: schema-stub not found at $STUB"; exit 1; }
[ -f "$MIG" ] || { echo "FAIL: migration not found at $MIG"; exit 1; }

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1

P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Supabase-derived roles the mig's PART B2 GRANT targets — absent on bare ephemeral PG.
P -c "CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;"
P -f "$STUB"
P -f "$MIG"
P -f "$HERE/assert.sql"

echo ">>> CORROBORATION-PS GATE (a) FIXTURE: PASS <<<"

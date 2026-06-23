#!/usr/bin/env bash
# S213 Corroboration-PS Part 2 gate (e) — ephemeral-PG fixture.
# Spins an EPHEMERAL local Postgres, applies the (shared) stub schema + the REAL migration 156
# (evaluate_pattern1_corroboration, UNCHANGED by F) + the Part-2 assertions. Non-mutating to PROD.
# Manually runnable:
#   bash scripts/calibration/fixtures/corroboration-ps/run-part2.sh
# (CI wiring — a postgres service step — is the G4 follow-up obligation, shared with the gate-(a) fixture.)
#
# What it proves: tagging a null-canonical (Case-3 / inactive) plan with canonical_plan_id flips it
# from invisible → corroborating (count 2 → 3, should_promote) AND writes ZERO canonical_plan_services
# (Rule #10). Reuses the thesaurus-phase1a schema-stub (one source of truth) + the gate-(a) idiom.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STUB="$REPO/scripts/calibration/fixtures/thesaurus-phase1a/schema-stub.sql"
MIG="$REPO/supabase/migrations/156_thesaurus_phase1a_pos_component_corroboration.sql"
PGDATA="${TMPDIR:-/tmp}/pg_corroboration_ps_part2_fixture"
PORT="${PG_FIXTURE_PORT:-54403}"
LOG="${TMPDIR:-/tmp}/pg_corroboration_ps_part2_fixture.log"

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
P -f "$HERE/assert-part2.sql"

echo ">>> CORROBORATION-PS GATE (e) PART-2 FIXTURE: PASS <<<"

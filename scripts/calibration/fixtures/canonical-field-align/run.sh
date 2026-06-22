#!/usr/bin/env bash
# F.0 Phase-1 gate — ephemeral-PG fixture for mig 165 + backfill (canonical_plan_services align).
# Spins an EPHEMERAL local Postgres, models the real table + mig-056 confidence trigger,
# seeds "existing" rows PRE-mig, applies mig 165, runs the REAL backfill.sql TWICE (idempotency),
# asserts correctness + trigger dual-write + confidence-safety, then TIMES the backfill on a
# ~48,552-row PROD-scale synthetic set. Non-mutating to PROD. Requires local Postgres tools.
#   bash scripts/calibration/fixtures/canonical-field-align/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
MIG="$REPO/supabase/migrations/165_canonical_field_align_p1_cps.sql"
STUB="$HERE/schema-stub.sql"; SEED="$HERE/seed.sql"; BACKFILL="$HERE/backfill.sql"; ASSERT="$HERE/assert.sql"
PGDATA="${TMPDIR:-/tmp}/pg_cfa_fixture"; PORT="${PG_FIXTURE_PORT:-54403}"; LOG="${TMPDIR:-/tmp}/pg_cfa_fixture.log"

for f in "$MIG" "$STUB" "$SEED" "$BACKFILL" "$ASSERT"; do [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }; done

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1
P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -f "$STUB"
P -f "$SEED"                                                                   # existing rows (pre-mig) + _pre_conf
P -f "$MIG"                                                                    # ADD aligned cols + align trigger
P -f "$BACKFILL"                                                              # backfill run 1
P -c "CREATE TABLE _after1 AS SELECT id, field_provenance, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, confidence FROM canonical_plan_services;"
P -f "$BACKFILL"                                                              # backfill run 2 (idempotency)
P -f "$ASSERT"

echo ">>> CANONICAL-FIELD-ALIGN PHASE-1 FIXTURE: PASS (correctness) <<<"

# ── perf: PROD-scale backfill timing (~48,552 rows) ──
P -c "INSERT INTO canonical_plan_services (service_slug, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth, field_provenance)
      SELECT 'perf_'||g, (g%50)::numeric, 0.2, true, true, (g%7=0),
        jsonb_build_object('copay', jsonb_build_object('value',(g%50),'confidence',0.9),
                           'is_covered', jsonb_build_object('value',true,'confidence',0.9))
      FROM generate_series(1,48552) g;" >/dev/null
ROWS=$(P -t -A -c "SELECT count(*) FROM canonical_plan_services;")
echo "--- backfill timing on ${ROWS} rows (PROD canonical_plan_services = 48,552) ---"
psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -c '\timing on' -f "$BACKFILL"

#!/usr/bin/env bash
# F.0 Phase-2 gate — ephemeral-PG fixture for mig 169 (canonical_plan_services alignment Phase 2).
# Spins an EPHEMERAL local Postgres, models the table at its post-mig-165 state by applying the REAL
# mig 165 on the stub, then applies the REAL mig 169 and asserts: the symmetric mirror (legacy<->aligned,
# aligned precedence, no clobber incl. the canonical-match boolean case), dropped aligned-bool defaults,
# bidirectional provenance twin, confidence safety, and the apply_promotion_event per-service flip
# (aligned column + provenance written + legacy mirror + ON-CONFLICT no-clobber + coinsurance normalize).
# Non-mutating to PROD. Requires local Postgres tools on PATH (initdb / pg_ctl / psql). Runnable:
#   bash scripts/calibration/fixtures/canonical-field-align-p2/run.sh
# (CI wiring — a postgres service step — is the shared G4 follow-up obligation.)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STUB="$HERE/schema-stub.sql"; ASSERT="$HERE/assert.sql"
MIG165="$REPO/supabase/migrations/165_canonical_field_align_p1_cps.sql"
MIG169="$REPO/supabase/migrations/169_canonical_field_align_p2_cps.sql"
PGDATA="${TMPDIR:-/tmp}/pg_cfa_p2_fixture"; PORT="${PG_FIXTURE_PORT:-54404}"; LOG="${TMPDIR:-/tmp}/pg_cfa_p2_fixture.log"

for f in "$STUB" "$MIG165" "$MIG169" "$ASSERT"; do [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }; done

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1
P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -f "$STUB"      # canonical_plan_services (legacy cols + DEFAULTs) + confidence trigger + event log + flags
P -f "$MIG165"    # ADD aligned cols + Phase-1 one-directional mirror
P -f "$MIG169"    # symmetric mirror + drop aligned-bool defaults + per-service flip
P -f "$ASSERT"    # T0..T14

echo ">>> CANONICAL-FIELD-ALIGN PHASE-2 FIXTURE: PASS <<<"

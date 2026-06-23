#!/usr/bin/env bash
# F.0 Phase-3 gate — ephemeral-PG fixture for mig 173 (canonical_plan_services FREEZE).
# Models the post-mig-169 state (P2 schema-stub + real mig 165 + real mig 169), then applies the
# REAL mig 173 and asserts the DORMANT one-directional legacy->aligned net:
#   aligned writes FREEZE legacy (no aligned->legacy mirror); legacy-only writes still mirror UP to
#   aligned; the IS-DISTINCT-FROM-OLD guard blocks a stale legacy provenance key from clobbering a
#   fresh aligned write; apply_promotion_event writes aligned with legacy now frozen; confidence
#   recompute intact. Non-mutating to PROD. Requires local Postgres tools (initdb / pg_ctl / psql).
#   bash scripts/calibration/fixtures/canonical-field-align-p3/run.sh
# (CI wiring — a postgres service step — is the shared G4 follow-up obligation.)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STUB="$HERE/../canonical-field-align-p2/schema-stub.sql"   # reuse the P2 table model (post-mig-165 base)
ASSERT="$HERE/assert.sql"
MIG165="$REPO/supabase/migrations/165_canonical_field_align_p1_cps.sql"
MIG169="$REPO/supabase/migrations/169_canonical_field_align_p2_cps.sql"
MIG173="$REPO/supabase/migrations/173_canonical_field_align_p3_cps.sql"
PGDATA="${TMPDIR:-/tmp}/pg_cfa_p3_fixture"; PORT="${PG_FIXTURE_PORT:-54405}"; LOG="${TMPDIR:-/tmp}/pg_cfa_p3_fixture.log"

for f in "$STUB" "$MIG165" "$MIG169" "$MIG173" "$ASSERT"; do [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }; done

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1
P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -f "$STUB"      # canonical_plan_services (legacy cols + DEFAULTs) + confidence trigger + event log + flags
P -f "$MIG165"    # ADD aligned cols + Phase-1 one-directional mirror
P -f "$MIG169"    # symmetric mirror + drop aligned-bool defaults + per-service flip (the Phase-2 base)
P -f "$MIG173"    # Phase-3: downgrade to dormant one-directional net + deprecate comments
P -f "$ASSERT"    # A1..A7

echo ">>> CANONICAL-FIELD-ALIGN PHASE-3 FIXTURE: PASS <<<"

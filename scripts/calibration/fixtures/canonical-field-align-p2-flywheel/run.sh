#!/usr/bin/env bash
# F.0 Phase-2 FLYWHEEL A/B gate (plan §5 gate #2) — the controlled before/after that shows the
# per-service corroboration DECISION improve with data, on the REAL evaluator + REAL migrations.
# Ephemeral local Postgres. Non-mutating to PROD. Sequence:
#   stub -> mig 156 (evaluator) -> seed + MEASURE A (pre-alignment: canonical keyed legacy 'copay')
#        -> mig 165 + backfill (twin) + mig 169 -> MEASURE B (post-alignment) -> print the A/B.
# The decision flips should_promote TRUE->FALSE / value_matches FALSE->TRUE because F.0 makes the
# 0.9 cold-start reference readable under the same in_copay candidate name Part 1 emits.
#   bash scripts/calibration/fixtures/canonical-field-align-p2-flywheel/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
STUB="$HERE/flywheel-stub.sql"; PRE="$HERE/scenario-pre.sql"; POST="$HERE/scenario-post.sql"
MIG156="$REPO/supabase/migrations/156_thesaurus_phase1a_pos_component_corroboration.sql"
MIG165="$REPO/supabase/migrations/165_canonical_field_align_p1_cps.sql"
MIG169="$REPO/supabase/migrations/169_canonical_field_align_p2_cps.sql"
BACKFILL="$REPO/scripts/calibration/fixtures/canonical-field-align/backfill.sql"
PGDATA="${TMPDIR:-/tmp}/pg_cfa_p2_flywheel"; PORT="${PG_FIXTURE_PORT:-54405}"; LOG="${TMPDIR:-/tmp}/pg_cfa_p2_flywheel.log"

for f in "$STUB" "$PRE" "$POST" "$MIG156" "$MIG165" "$MIG169" "$BACKFILL"; do [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }; done

pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$PGDATA"
trap 'pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$PGDATA" -o "-k ${TMPDIR:-/tmp} -p $PORT -c listen_addresses=''" -l "$LOG" start >/dev/null 2>&1
sleep 1
P() { psql -h "${TMPDIR:-/tmp}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

P -c "CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;"  # mig 156 PART B GRANT targets
P -f "$STUB"
P -f "$MIG156"     # the evaluator (UNCHANGED by F.0)
P -f "$PRE"        # seed + MEASURE A (pre-alignment)
P -f "$MIG165"     # ADD aligned cols + Phase-1 mirror
P -f "$BACKFILL"   # the REAL twin mechanism (copay -> in_copay provenance + typed)
P -f "$MIG169"     # symmetric mirror + per-service flip
P -f "$POST"       # MEASURE B (post-alignment) + print the A/B table

echo ">>> CANONICAL-FIELD-ALIGN PHASE-2 FLYWHEEL A/B: PASS <<<"

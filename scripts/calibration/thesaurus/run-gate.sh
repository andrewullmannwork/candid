#!/usr/bin/env bash
# Service Thesaurus — N-run majority GATE run (committed; supersedes the /tmp throwaway).
# Produces the frozen snapshot (N temp-0 forward passes -> per-gtId majority) -> deterministic score
# -> reroute audit. Detail -> $OUT/run.log; a grepped headline -> stdout on completion.
#
# Usage:
#   scripts/calibration/thesaurus/run-gate.sh <out-dir> [baseline-forward.json]
#     <out-dir>          must already contain gt.json (+ b5-baseline.json/catalog.json seeds for the ledger).
#     [baseline-forward] optional ledger/reroute baseline (DIAGNOSTIC; not the gate).
#   Env:
#     N_RUNS         number of forward passes (default 9 = the gate)
#     CALIB_USER_ID  Haiku spend attribution (default = calib system user)
#     COHORTS        cohorts.json path (default <out-dir>/cohorts.json)
#     GATE_B2/GATE_B1  set to ENFORCE (run.ts exits 3 on miss); omit for report-only (Step 4)
#     PHASE_LABEL/GT_VERSION  scorecard labels (read by run.ts)
#
# S170 hardening B: there is deliberately NO `unset ANTHROPIC_API_KEY` here. resolve-snapshot.ts now calls
# loadCalibEnv() (override:true), which injects the real key from .env.local OVER Claude Code's pre-set
# empty var. The only unsets kept are the snapshot-replay vars, which would otherwise collapse the N runs
# to one cached response (a falsely-unanimous gate).
set -uo pipefail
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"   # scripts/calibration/thesaurus -> repo root
S="scripts/calibration/thesaurus"
OUT="${1:?usage: run-gate.sh <out-dir> [baseline-forward.json]}"
BASELINE="${2:-}"
COHORTS="${COHORTS:-$OUT/cohorts.json}"
LOG="$OUT/run.log"
cd "$WT" || { echo "cd to repo root failed"; exit 9; }
unset HAIKU_SNAPSHOT_REPLAY HAIKU_SNAPSHOT_RECORD
export CALIB_USER_ID="${CALIB_USER_ID:-2ce55772-bdf1-4edd-bd16-215aa239990e}"
export N_RUNS="${N_RUNS:-9}"
# Clear prior GENERATED artifacts (keep the seeds gt.json/cohorts.json/b5-baseline.json/catalog.json) so a
# partial failure can't leave stale outputs that score/audit would silently consume.
rm -f "$OUT"/forward.json "$OUT"/forward.runs.json "$OUT"/convergence.json "$OUT"/stored.json \
      "$OUT"/cohorts-snapshot.json "$OUT"/b5-current.json "$OUT"/rename-map.json \
      "$OUT"/scorecard.json "$OUT"/scorecard.md
{
  echo "=== START $(date) · N_RUNS=$N_RUNS · cwd=$(pwd) ==="
  echo "=== [1/3] resolve-snapshot (N=$N_RUNS forward passes; loadCalibEnv + strict + output-validity gate) ==="
  npx tsx "$S/resolve-snapshot.ts" "$OUT/gt.json" "$COHORTS" "$OUT"; rc1=$?
  echo "resolve-snapshot rc=$rc1"
  if [ "$rc1" -eq 0 ]; then
    echo "=== [2/3] run.ts (deterministic score${GATE_B2:+ + GATE ENFORCE}) ==="
    npx tsx "$S/run.ts" "$OUT" ${BASELINE:+"$BASELINE"}; rc2=$?
    echo "run.ts rc=$rc2"
    echo "=== [3/3] reroute-audit ==="
    if [ -n "$BASELINE" ]; then
      npx tsx "$S/reroute-audit.ts" "$BASELINE" "$OUT/forward.json" "$OUT/gt.json"; rc3=$?
    else echo "(skipped — no baseline)"; rc3=0; fi
    echo "reroute-audit rc=$rc3"
  else
    echo "ABORT — resolve-snapshot failed (fail-fast precondition OR output-validity gate); skipping score + audit"
  fi
  echo "=== END $(date) rc1=$rc1 rc2=${rc2:-NA} rc3=${rc3:-NA} ==="
} > "$LOG" 2>&1
echo "===== GATE RUN SUMMARY ($(date)) ====="
grep -E "FATAL|output-validity|Aborting|hospital_outpatient still|SCORECARD INVALID|forward.json: [0-9]|B1 recall|B2 precision|^  B[12]|GATE|andrew mean-agreement|now scoring correct|END " "$LOG" 2>/dev/null | tail -30
echo "(full log: $LOG)"

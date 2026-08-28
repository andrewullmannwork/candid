/**
 * plan-provenance-gate — S326: the honesty-gate plan veto, PINNED.
 *
 * ⚠ DO NOT REVERT (Andrew ruling, S326 — the THIRD occurrence of this class):
 * a search-picked library plan (`source: manual` + canonical_plan_id linked)
 * passes the honesty gate with the same confidence as an uploaded document —
 * its terms are Candid's cite-grade extraction of that plan's own SBC. The
 * class recurred because no fixture pinned it: S291 keyed the veto on
 * verification_status + source (search picks degraded); S294 removed
 * verification_status but kept bare `source === "manual"` (search picks STILL
 * degraded); each fix landed one link short. This file is the lock — a change
 * that re-degrades linked library plans fails CI, by name.
 *
 * What stays distrusted, deliberately:
 *   - insurance_card plans (S291: a card scan can invent a $0 copay and ground
 *     a false "no issues" — the case the gate exists for), linked or not;
 *   - manual plans with NO canonical link (unmatched hand entry — the values
 *     the member typed still ground per-service via `user` costProvenance).
 * The upgrade path stays open: a member's own upload still stamps
 * document_verified, corroborates, and overrides (more data is better).
 *
 * Run: npx tsx scripts/calibration/fixtures/claims/plan-provenance-gate.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { planProvenanceUnverified } from "../../../../src/lib/claims/cost-share-loader";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const CANON = "9b2f1c2e-0000-4000-8000-000000000001";

// 1 — THE RULING CASE: search-picked library plan (manual + linked) → TRUSTED.
check(
  "manual + canonical link PASSES the gate (search-picked library plan — the S326 ruling; DO NOT REVERT)",
  planProvenanceUnverified("manual", CANON) === false,
);

// 2 — What stays distrusted.
check("insurance_card (unlinked) stays distrusted (S291)", planProvenanceUnverified("insurance_card", null) === true);
check(
  "insurance_card stays distrusted EVEN WITH a canonical link (a card can invent values)",
  planProvenanceUnverified("insurance_card", CANON) === true,
);
check("manual with NO link stays distrusted (unmatched hand entry)", planProvenanceUnverified("manual", null) === true);

// 3 — Document paths + legacy fail open (S291's rule: absence is never evidence).
for (const src of ["document_upload", "sbc_parser", "eoc_parser", null]) {
  check(`source=${JSON.stringify(src)} passes (document / legacy fails open)`, planProvenanceUnverified(src, null) === false);
}

// 4 — WIRING: the loader actually uses the pinned function (a pure function
// nobody calls is a lock on nothing — the un-wired-fixture rot class, S308).
{
  const src = readFileSync(
    join(__dirname, "../../../../src/lib/claims/cost-share-loader.ts"),
    "utf8",
  );
  const usage = src.match(/provenanceUnverified:\s*planProvenanceUnverified\(/);
  check("loadPlanCostShareParams derives the veto via planProvenanceUnverified()", usage != null);
  const bareManual = src.match(/provenanceUnverified:\s*\n?\s*\(d\.source[^;]*"manual"/);
  check("the bare source===manual veto expression is gone", bareManual == null);
}

console.log(`\nplan-provenance-gate: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");

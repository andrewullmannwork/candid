/**
 * S154 — Ship Gate G4 fixture for the secondary-coverage confidence gate.
 * Pure, re-runnable, no network / no DB / no Haiku:
 *   npx tsx scripts/calibration/fixtures/secondary-coverage-gate.ts
 *
 * Covers the BLOCK GOAL (the gate semantics + the two S154 decisions), not just
 * callability:
 *   - homogeneous category → confident (annual_physical → a $0 preventive sibling)
 *   - heterogeneous + weak trigram → ESTIMATE, never silently confident (the old
 *     "always take candidates[0]" is now gated) — and still "covered", never Unknown
 *   - strong trigram identity in a heterogeneous category → confident, picks the
 *     RIGHT sibling (dropped copay-bias: identity, not cheapest)
 *   - ACA-preventive backstop fires ONLY when is_aca_compliant === true; null
 *     (unknown) and false hard-exclude it (Andrew S154)
 *   - pediatric siblings are not borrowed by an adult line
 *   - gate thresholds are honored when passed (tunability — Ship Gate G6)
 */

import {
  resolveSecondaryCoverage,
  DEFAULT_SECONDARY_GATE,
  type CoveredSlugMeta,
} from "../../../src/lib/audit/coverage-loader";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

// preventive category, all $0 (homogeneous; mirrors Blue Shield Bronze 60)
const PREVENTIVE_HOMOG: CoveredSlugMeta[] = [
  { slug: "preventive_care", category: "preventive", coverage: { covered: true, copay: 0, coinsurance: 0 } },
  { slug: "immunizations", category: "preventive", coverage: { covered: true, copay: 0, coinsurance: 0 } },
  { slug: "childrens_eye_exam", category: "preventive", coverage: { covered: true, copay: 0, coinsurance: 0 } },
];
// office_visit category, mixed copays (heterogeneous)
const OFFICE_HETERO: CoveredSlugMeta[] = [
  { slug: "pcp_visit", category: "office_visit", coverage: { covered: true, copay: 20, coinsurance: null } },
  { slug: "specialist_visit", category: "office_visit", coverage: { covered: true, copay: 50, coinsurance: null } },
];
// rehab category, heterogeneous, but one is a strong textual match
const REHAB_HETERO: CoveredSlugMeta[] = [
  { slug: "physical_therapy", category: "rehab", coverage: { covered: true, copay: 40, coinsurance: null } },
  { slug: "speech_therapy", category: "rehab", coverage: { covered: true, copay: 60, coinsurance: null } },
];

function main() {
  console.log("S154 secondary-coverage gate fixture\n");

  // 1 — homogeneous preventive → confident (which sibling is moot; all $0).
  const r1 = resolveSecondaryCoverage(
    "annual_physical",
    { category: "preventive", isPreventiveEligible: true },
    PREVENTIVE_HOMOG,
    null,
  );
  check("homogeneous category → confident secondary_match", r1?.confidence === "confident" && r1?.source === "secondary_match");
  check("homogeneous → borrows a $0 sibling", r1?.coverage.copay === 0);
  check("homogeneous → pediatric sibling excluded", r1?.matchedSlug !== "childrens_eye_exam");

  // 2 — heterogeneous + weak trigram → estimate (gated; old code asserted blindly).
  const r2 = resolveSecondaryCoverage(
    "office_consultation",
    { category: "office_visit", isPreventiveEligible: false },
    OFFICE_HETERO,
    true,
  );
  check("heterogeneous + weak trigram → estimate", r2?.confidence === "estimate");
  check("estimate still returns covered (never Unknown)", r2 != null && r2.coverage.covered === true);

  // 3 — strong trigram identity in a heterogeneous category → confident + right sibling.
  const r3 = resolveSecondaryCoverage(
    "physical_therapy_session",
    { category: "rehab", isPreventiveEligible: false },
    REHAB_HETERO,
    true,
  );
  check("strong trigram → confident", r3?.confidence === "confident");
  check("strong trigram → matched physical_therapy ($40), NOT cheapest", r3?.matchedSlug === "physical_therapy" && r3?.coverage.copay === 40);

  // 4 — ACA-preventive backstop, confirmed-ACA → confident $0.
  const r4 = resolveSecondaryCoverage(
    "screening_colonoscopy",
    { category: "gastro", isPreventiveEligible: true },
    [],
    true,
  );
  check("ACA backstop (aca=true) → aca_preventive confident $0", r4?.source === "aca_preventive" && r4?.confidence === "confident" && r4?.coverage.copay === 0);

  // 5 — ACA-preventive, UNKNOWN aca (null) → hard-excluded → null.
  const r5 = resolveSecondaryCoverage(
    "screening_colonoscopy",
    { category: "gastro", isPreventiveEligible: true },
    [],
    null,
  );
  check("ACA backstop (aca=null/unknown) → hard-excluded (null)", r5 === null);

  // 6 — ACA-preventive, explicit non-ACA (false) → null.
  const r6 = resolveSecondaryCoverage(
    "screening_colonoscopy",
    { category: "gastro", isPreventiveEligible: true },
    [],
    false,
  );
  check("ACA backstop (aca=false) → null", r6 === null);

  // 7 — no same-category candidates + not preventive → null (genuine Unknown).
  const r7 = resolveSecondaryCoverage(
    "mystery_service",
    { category: "unmapped", isPreventiveEligible: false },
    OFFICE_HETERO,
    true,
  );
  check("no same-category candidates + not preventive → null", r7 === null);

  // 8 — pediatric-only sibling not borrowed by an adult line.
  const PEDS_ONLY: CoveredSlugMeta[] = [
    { slug: "childrens_eye_exam", category: "vision", coverage: { covered: true, copay: 0, coinsurance: 0 } },
  ];
  const r8 = resolveSecondaryCoverage(
    "adult_eye_exam",
    { category: "vision", isPreventiveEligible: false },
    PEDS_ONLY,
    true,
  );
  check("pediatric-only sibling excluded from adult line → null", r8 === null);

  // 9 — gate tunability (G6): a custom gate is honored; homogeneity is independent
  // of trigramFloor so an all-$0 category stays confident even at floor 0.99.
  const r9 = resolveSecondaryCoverage(
    "annual_physical",
    { category: "preventive", isPreventiveEligible: true },
    PREVENTIVE_HOMOG,
    null,
    { ...DEFAULT_SECONDARY_GATE, trigramFloor: 0.99 },
  );
  check("custom gate honored (homogeneous still confident at trigramFloor 0.99)", r9?.confidence === "confident");

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

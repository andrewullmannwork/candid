/**
 * S73.5 D5 — Per-doc-type coverage config tests.
 *
 * Validates Subplan §2.4(c) hardcoded baselines + median-adaptive growth +
 * coverage scoring + canonical-level Verified rule.
 *
 * Run: `npx tsx scripts/test-doctype-expected-counts.ts`
 */

import {
  DOC_TYPE_COVERAGE_CONFIG,
  PLAN_IDENTITY_SCALARS_FULL,
  PLAN_IDENTITY_SCALARS_EDUCATION,
  SERVICES_SBC_CORE,
  SERVICES_FULL_CORE,
  SERVICES_EDUCATION_CORE,
  toPlanDocType,
  expectedServiceCount,
  computeCoverageScore,
  passesCoverageGate,
  isCanonicalVerified,
  type PlanDocType,
} from "@/lib/parser/doctype-expected-counts";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

function approxEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

console.log("\n=== S73.5 D5: Per-doc-type coverage config ===\n");

// ── 1. Constant cardinalities match Subplan §2.4(c) table ────────────────────
console.log("[1] Constant cardinalities");
assert(
  PLAN_IDENTITY_SCALARS_FULL.length === 12,
  "PLAN_IDENTITY_SCALARS_FULL has 12 entries (Subplan §2.4(c))",
);
assert(
  PLAN_IDENTITY_SCALARS_EDUCATION.length === 6,
  "PLAN_IDENTITY_SCALARS_EDUCATION has 6 entries (Subplan §2.4(c))",
);
assert(SERVICES_SBC_CORE.length === 8, "SERVICES_SBC_CORE has 8 entries");
assert(SERVICES_FULL_CORE.length === 15, "SERVICES_FULL_CORE has 15 entries");
assert(
  SERVICES_EDUCATION_CORE.length === 6,
  "SERVICES_EDUCATION_CORE has 6 entries (within 5-8 range)",
);

// ── 2. Per-doc-type config thresholds ────────────────────────────────────────
console.log("\n[2] Doc-type coverage thresholds");
assert(DOC_TYPE_COVERAGE_CONFIG.sbc.coverageThreshold === 0.80, "SBC threshold 0.80");
assert(DOC_TYPE_COVERAGE_CONFIG.eoc.coverageThreshold === 0.75, "EOC threshold 0.75");
assert(
  DOC_TYPE_COVERAGE_CONFIG.plan_document.coverageThreshold === 0.65,
  "plan_document threshold 0.65",
);
assert(
  DOC_TYPE_COVERAGE_CONFIG.education_doc.coverageThreshold === 0.60,
  "education_doc threshold 0.60",
);

// ── 3. Canonical verification participation ──────────────────────────────────
console.log("\n[3] Canonical verification participation");
assert(
  DOC_TYPE_COVERAGE_CONFIG.sbc.participatesInCanonicalVerification === true,
  "SBC participates in canonical verification",
);
assert(
  DOC_TYPE_COVERAGE_CONFIG.eoc.participatesInCanonicalVerification === true,
  "EOC participates in canonical verification",
);
assert(
  DOC_TYPE_COVERAGE_CONFIG.plan_document.participatesInCanonicalVerification === true,
  "plan_document participates in canonical verification",
);
assert(
  DOC_TYPE_COVERAGE_CONFIG.education_doc.participatesInCanonicalVerification === false,
  "education_doc does NOT gate canonical verification (Phase 2 bonus)",
);

// ── 4. toPlanDocType ─────────────────────────────────────────────────────────
console.log("\n[4] toPlanDocType()");
assert(toPlanDocType("sbc") === "sbc", "toPlanDocType('sbc') === 'sbc'");
assert(toPlanDocType("eoc") === "eoc", "toPlanDocType('eoc') === 'eoc'");
assert(
  toPlanDocType("plan_document") === "plan_document",
  "toPlanDocType('plan_document') === 'plan_document'",
);
assert(
  toPlanDocType("education_doc") === "education_doc",
  "toPlanDocType('education_doc') === 'education_doc'",
);
assert(toPlanDocType("eob") === null, "toPlanDocType('eob') === null");
assert(toPlanDocType(null) === null, "toPlanDocType(null) === null");

// ── 5. expectedServiceCount: median-adaptive ─────────────────────────────────
console.log("\n[5] expectedServiceCount() median-adaptive");
// Cold start (< 2 parses) → baseline floor
assert(expectedServiceCount("sbc", []) === 8, "SBC, 0 parses → baseline 8");
assert(expectedServiceCount("sbc", [10]) === 8, "SBC, 1 parse → baseline 8 (cold start)");
assert(expectedServiceCount("eoc", []) === 15, "EOC, 0 parses → baseline 15");
assert(expectedServiceCount("plan_document", []) === 15, "plan_document, 0 parses → baseline 15");

// ≥ 2 parses, median * 0.85 ≤ baseline → baseline floor wins
assert(
  expectedServiceCount("sbc", [5, 6]) === 8,
  "SBC, [5,6] median 5.5 * 0.85 = 4 → baseline floor 8 wins",
);
// ≥ 2 parses, median * 0.85 > baseline → adaptive wins
assert(
  expectedServiceCount("sbc", [20, 22]) === Math.floor(21 * 0.85),
  "SBC, [20,22] median 21 * 0.85 = 17 → adaptive wins",
);
assert(
  expectedServiceCount("eoc", [50, 60, 70]) === Math.floor(60 * 0.85),
  "EOC, [50,60,70] median 60 * 0.85 = 51 → adaptive wins (above floor 15)",
);

// ── 6. computeCoverageScore ──────────────────────────────────────────────────
console.log("\n[6] computeCoverageScore()");
// SBC: 12 expected scalars, 8 expected services (cold start)
// 12/12 + 8/8 = 0.5 * 1 + 0.5 * 1 = 1.0
assert(
  approxEq(computeCoverageScore("sbc", 12, 8, []), 1.0),
  "SBC full coverage → 1.0",
);
// 6/12 + 4/8 = 0.5 * 0.5 + 0.5 * 0.5 = 0.5
assert(
  approxEq(computeCoverageScore("sbc", 6, 4, []), 0.5),
  "SBC half coverage → 0.5",
);
// 0/12 + 0/8 = 0
assert(
  approxEq(computeCoverageScore("sbc", 0, 0, []), 0),
  "SBC zero coverage → 0",
);
// EOC: 12 expected scalars, 15 expected services (cold start)
// 12/12 + 15/15 = 1.0
assert(
  approxEq(computeCoverageScore("eoc", 12, 15, []), 1.0),
  "EOC full coverage → 1.0",
);
// Cap at 1 — over-extraction shouldn't push score above 1
assert(
  approxEq(computeCoverageScore("sbc", 24, 16, []), 1.0),
  "SBC over-extraction caps at 1.0",
);

// ── 7. passesCoverageGate ────────────────────────────────────────────────────
console.log("\n[7] passesCoverageGate()");
// SBC threshold 0.80
assert(passesCoverageGate("sbc", 12, 8, []) === true, "SBC 1.0 ≥ 0.80 → pass");
// Edge case: 10/12 + 6/8 = 0.4167 + 0.375 = 0.7917 — just BELOW 0.80 → fail
const sbcEdge = computeCoverageScore("sbc", 10, 6, []);
console.log(`    (sbc(10,6) = ${sbcEdge.toFixed(4)} — just below 0.80 threshold)`);
assert(
  passesCoverageGate("sbc", 10, 6, []) === false,
  "SBC 10/12 + 6/8 = 0.7917 → below 0.80 → fail",
);

assert(passesCoverageGate("sbc", 6, 4, []) === false, "SBC 0.5 < 0.80 → fail");

// EOC threshold 0.75
assert(passesCoverageGate("eoc", 9, 12, []) === true, "EOC 0.5*0.75 + 0.5*0.8 = 0.775 → pass");
assert(passesCoverageGate("eoc", 6, 10, []) === false, "EOC 0.5833 → fail");

// plan_document threshold 0.65
assert(
  passesCoverageGate("plan_document", 8, 10, []) === true,
  "plan_document 0.667 ≥ 0.65 → pass",
);

// education_doc threshold 0.60
assert(
  passesCoverageGate("education_doc", 4, 4, []) === true,
  "education_doc 0.667 ≥ 0.60 → pass",
);

// ── 8. isCanonicalVerified ───────────────────────────────────────────────────
console.log("\n[8] isCanonicalVerified()");
// Subplan §2.5: canonical_verified = sbc_promoted AND (eoc_promoted OR plan_doc_promoted)
assert(
  isCanonicalVerified(new Set<PlanDocType>(["sbc", "eoc"])) === true,
  "{sbc, eoc} → verified",
);
assert(
  isCanonicalVerified(new Set<PlanDocType>(["sbc", "plan_document"])) === true,
  "{sbc, plan_document} → verified",
);
assert(
  isCanonicalVerified(new Set<PlanDocType>(["sbc", "eoc", "plan_document"])) === true,
  "{sbc, eoc, plan_document} → verified",
);
assert(isCanonicalVerified(new Set<PlanDocType>(["sbc"])) === false, "{sbc} alone → NOT verified");
assert(isCanonicalVerified(new Set<PlanDocType>(["eoc"])) === false, "{eoc} alone → NOT verified");
assert(
  isCanonicalVerified(new Set<PlanDocType>(["plan_document"])) === false,
  "{plan_document} alone → NOT verified",
);
assert(
  isCanonicalVerified(new Set<PlanDocType>(["sbc", "education_doc"])) === false,
  "{sbc, education_doc} → NOT verified (education_doc doesn't gate)",
);
assert(isCanonicalVerified(new Set<PlanDocType>([])) === false, "empty set → NOT verified");

// Summary
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);

/**
 * S161 (#1/#3) — fixture for the /compare preventive secondary backstop.
 * Pure, re-runnable, no network / no DB / no Haiku:
 *   npx tsx scripts/calibration/fixtures/compare-preventive-backstop.ts
 *
 * Asserts the BLOCK GOAL — a plan that covers a preventive service under a
 * sibling name (or is ACA-mandated $0) stops rendering "Not listed yet" on the
 * compare grid — AND the tight scope that keeps it honest:
 *   - same-plan preventive sibling → synthesized covered $0, flagged inferred
 *   - ACA plan (metal→aca proxy), no sibling → ACA $0 floor, flagged inferred
 *   - non-ACA plan, no sibling → NOT synthesized (cell stays "unk", honest)
 *   - NON-preventive target slug → NOT synthesized (scope guard; no pcp→specialist)
 *   - slug already enumerated by the plan → untouched (no duplicate)
 *   - OON is never inferred (stays empty); synthesized cell carries `inferred`
 */
import {
  computeCompareBackstop,
  type ComparePlanPayload,
  type CompareBenefit,
} from "../../../src/lib/plan/compare";
import {
  DEFAULT_SECONDARY_GATE,
  type BillSlugMeta,
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

type CoverageByRef = Map<
  string,
  { coveredMeta: CoveredSlugMeta[]; acaCompliant: boolean | null }
>;

// Minimal builders — computeCompareBackstop only reads ref.id + benefits[].serviceSlug.
function benefit(slug: string, category: string, covered: boolean | null = true): CompareBenefit {
  return {
    serviceSlug: slug,
    category,
    title: slug,
    costInNetworkDescription: "",
    costOutOfNetworkDescription: "",
    costSharing: {
      inNetwork: { copay: 0, coinsurance: 0, deductibleApplies: null },
      outOfNetwork: { copay: null, coinsurance: null, deductibleApplies: null },
      annualLimit: null,
      priorAuthRequired: null,
    },
    covered,
  };
}
function plan(
  refId: string,
  kind: "canonical" | "user_plan",
  benefits: CompareBenefit[],
): ComparePlanPayload {
  return {
    ref: { kind, id: refId },
    canonicalPlanId: kind === "canonical" ? refId : null,
    planName: refId,
    insurerName: "",
    planSummary: {
      premiumMonthly: null,
      inDeductible: null,
      outDeductible: null,
      inOopMax: null,
      outOopMax: null,
      planType: null,
      metalLevel: null,
      state: null,
      year: null,
      premiumEmployee: null,
      premiumSubsidy: null,
      premiumFrequency: null,
      inDeductibleFamily: null,
      inOopMaxFamily: null,
    },
    benefits,
    coveredServiceCount: benefits.filter((b) => b.covered !== false).length,
    sourceLabel: kind,
    isOwnedByUser: kind === "user_plan",
    corroborationCount: null,
  };
}
function covered(slug: string, category: string, copay: number, coinsurance: number | null = null): CoveredSlugMeta {
  return { slug, category, coverage: { covered: true, copay, coinsurance } };
}

const BILL_META = new Map<string, BillSlugMeta>([
  ["annual_physical", { category: "preventive", isPreventiveEligible: true }],
  ["immunizations", { category: "preventive", isPreventiveEligible: true }],
  ["preventive_care", { category: "preventive", isPreventiveEligible: true }],
  ["specialist_visit", { category: "office_visit", isPreventiveEligible: false }],
  ["pcp_visit", { category: "office_visit", isPreventiveEligible: false }],
]);

function inferredFor(p: ComparePlanPayload, slug: string): CompareBenefit | undefined {
  return p.benefits.find((b) => b.serviceSlug === slug && b.inferred);
}

function main() {
  console.log("S161 compare preventive backstop fixture\n");

  // 1 — sibling match: Plan B lists preventive_care ($0) but not annual_physical
  // (a row because Plan A enumerates it) → Plan B gets annual_physical $0, inferred.
  {
    const A = plan("A", "canonical", [
      benefit("annual_physical", "preventive"),
      benefit("specialist_visit", "office_visit"),
    ]);
    const B = plan("B", "canonical", [
      benefit("preventive_care", "preventive"),
      benefit("pcp_visit", "office_visit"),
    ]);
    const cov: CoverageByRef = new Map([
      ["A", { coveredMeta: [covered("annual_physical", "preventive", 0, 0)], acaCompliant: true }],
      ["B", { coveredMeta: [covered("preventive_care", "preventive", 0, 0)], acaCompliant: true }],
    ]);
    computeCompareBackstop([A, B], { billMetaBySlug: BILL_META, coverageByRefId: cov, gate: DEFAULT_SECONDARY_GATE });
    const inf = inferredFor(B, "annual_physical");
    check("sibling — Plan B annual_physical synthesized", !!inf);
    check("sibling — covered $0", inf?.covered === true && inf?.costSharing.inNetwork.copay === 0);
    check(
      "sibling — flagged inferred secondary_match → preventive_care",
      inf?.inferred?.source === "secondary_match" && inf?.inferred?.matchedSlug === "preventive_care",
    );
    check(
      "sibling — OON never inferred (stays empty)",
      inf?.costSharing.outOfNetwork.copay === null && inf?.costSharing.outOfNetwork.coinsurance === null,
    );
    check(
      "scope guard — specialist_visit NOT borrowed for Plan B (non-preventive)",
      !inferredFor(B, "specialist_visit"),
    );
  }

  // 2 — ACA $0 floor: ACA plan, immunizations is a shown row, plan has no sibling.
  {
    const A = plan("A", "canonical", [benefit("immunizations", "preventive")]);
    const B = plan("B", "canonical", [benefit("pcp_visit", "office_visit")]);
    const cov: CoverageByRef = new Map([
      ["A", { coveredMeta: [covered("immunizations", "preventive", 0, 0)], acaCompliant: true }],
      ["B", { coveredMeta: [covered("pcp_visit", "office_visit", 20)], acaCompliant: true }],
    ]);
    computeCompareBackstop([A, B], { billMetaBySlug: BILL_META, coverageByRefId: cov, gate: DEFAULT_SECONDARY_GATE });
    const inf = inferredFor(B, "immunizations");
    check(
      "ACA floor — immunizations synthesized on ACA plan w/ no sibling",
      inf?.inferred?.source === "aca_preventive" && inf?.inferred?.matchedSlug === null,
    );
    check("ACA floor — covered $0", inf?.costSharing.inNetwork.copay === 0);
  }

  // 3 — non-ACA (acaCompliant null), no preventive sibling → stays unk (honest).
  {
    const A = plan("A", "canonical", [benefit("immunizations", "preventive")]);
    const C = plan("C", "user_plan", [benefit("pcp_visit", "office_visit")]);
    const cov: CoverageByRef = new Map([
      ["A", { coveredMeta: [covered("immunizations", "preventive", 0, 0)], acaCompliant: true }],
      ["C", { coveredMeta: [covered("pcp_visit", "office_visit", 20)], acaCompliant: null }],
    ]);
    computeCompareBackstop([A, C], { billMetaBySlug: BILL_META, coverageByRefId: cov, gate: DEFAULT_SECONDARY_GATE });
    check("non-ACA + no sibling → immunizations NOT synthesized (stays unk)", !inferredFor(C, "immunizations"));
  }

  // 4 — already enumerated → untouched (no duplicate, no spurious growth).
  {
    const A = plan("A", "canonical", [benefit("annual_physical", "preventive")]);
    const B = plan("B", "canonical", [
      benefit("annual_physical", "preventive"),
      benefit("preventive_care", "preventive"),
    ]);
    const cov: CoverageByRef = new Map([
      ["A", { coveredMeta: [covered("annual_physical", "preventive", 0, 0)], acaCompliant: true }],
      [
        "B",
        {
          coveredMeta: [covered("annual_physical", "preventive", 0, 0), covered("preventive_care", "preventive", 0, 0)],
          acaCompliant: true,
        },
      ],
    ]);
    const before = B.benefits.length;
    computeCompareBackstop([A, B], { billMetaBySlug: BILL_META, coverageByRefId: cov, gate: DEFAULT_SECONDARY_GATE });
    check(
      "already-enumerated annual_physical not duplicated on Plan B",
      B.benefits.filter((b) => b.serviceSlug === "annual_physical").length === 1,
    );
    check("no spurious synth when nothing is missing on Plan B", B.benefits.length === before);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

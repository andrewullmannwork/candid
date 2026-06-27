/**
 * R3 step 1 — catalog-projection-parity: proves DISPUTE_GROUND_CATALOG reproduces TODAY's
 * scattered hardcoded taxonomy EXACTLY (the byte-identical refactor gate). Two kinds of check:
 *   (a) inline-oracle deep-equal — catalog order / scoringClass / requestBucket / scope vs the
 *       values captured from the PRE-refactor code (the removed TYPE_ORDER, the templates.ts
 *       buildRequestSection buckets, plan §3 recovery scope).
 *   (b) live-tie — `deriveFindingToLetter()` reproduces the OLD FINDING_TO_LETTER at the consumer
 *       (`map[f] || "overcharge"`) for ALL FindingType, AND `classifyDisputeType` (the live, still
 *       byte-identical scorer) returns each ground's catalog `scoringClass` for a line dominated
 *       by that ground.
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/catalog-projection-parity.ts
 */
import {
  DISPUTE_GROUND_CATALOG,
  deriveFindingToLetter,
} from "../../../../src/lib/disputes/dispute-ground-catalog";
import { classifyDisputeType } from "../../../../src/lib/disputes/strength-scoring";
import type { DisputeTypeClass } from "../../../../src/lib/disputes/strength-scoring";
import type { DisputeGroundType } from "../../../../src/lib/disputes/dispute-grounds";
import type { FindingType, DisputeLetterType } from "../../../../src/lib/billing/types";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

// ── ORACLES: the EXACT pre-refactor hardcoded values ─────────────────────────
// dispute-grounds.ts TYPE_ORDER (removed with buildDisputeGrounds in R3 step 1).
const ORIGINAL_TYPE_ORDER: DisputeGroundType[] = [
  "service_not_rendered",
  "balance_billing",
  "duplicate",
  "unbundling",
  "coverage_contradiction",
  "cost_share_misapplication",
  "benchmark",
  "unallocated_balance",
  "coding_peer",
];
// disputes/index.ts FINDING_TO_LETTER (now projected via deriveFindingToLetter()).
const ORIGINAL_FINDING_TO_LETTER: Partial<Record<FindingType, DisputeLetterType>> = {
  overcharge: "overcharge",
  duplicate: "duplicate_charge",
  unbundling: "overcharge",
  upcoding: "overcharge",
  balance_billing: "balance_billing",
  missing_adjustment: "overcharge",
  stale_claim: "overcharge",
};
// Every FindingType (billing/types.ts) — the consumer-parity domain.
const ALL_FINDING_TYPES: FindingType[] = [
  "overcharge",
  "duplicate",
  "unbundling",
  "upcoding",
  "balance_billing",
  "missing_adjustment",
  "stale_claim",
  "zero_cost_share_overcharge",
  "unallocated_balance",
  "insurance_underpayment",
  "code_uncategorized_description_match",
  "uncategorized_service",
];
// templates.ts buildRequestSection bucket per ground (null = falls to the fallback ask).
const EXPECTED_BUCKET: Record<DisputeGroundType, string | null> = {
  service_not_rendered: "attested",
  balance_billing: "balanceBilling",
  duplicate: null,
  unbundling: null,
  coverage_contradiction: "coverage",
  cost_share_misapplication: "costShare",
  benchmark: null,
  unallocated_balance: null,
  coding_peer: "coding",
};
// plan §3 — the recovery aggregation scope per ground.
const EXPECTED_SCOPE: Record<DisputeGroundType, string> = {
  service_not_rendered: "line",
  balance_billing: "line",
  duplicate: "line_set",
  unbundling: "line_set",
  coverage_contradiction: "line",
  cost_share_misapplication: "line",
  benchmark: "line",
  unallocated_balance: "claim",
  coding_peer: "line_set",
};
// scorer class per ground (service_not_rendered = the resolver's attestation OVERRIDE).
const EXPECTED_CLASS: Record<DisputeGroundType, DisputeTypeClass> = {
  service_not_rendered: "service_not_rendered",
  balance_billing: "balance_billing",
  duplicate: "other",
  unbundling: "benchmark",
  coverage_contradiction: "coverage_contradiction",
  cost_share_misapplication: "cost_share_misapplication",
  benchmark: "benchmark",
  unallocated_balance: "other",
  coding_peer: "coding_peer",
};

const ALL_GROUNDS = Object.keys(EXPECTED_CLASS) as DisputeGroundType[];

// ── P1 — completeness: every ground has one entry; orders are 0..8 unique. ────
{
  const keys = Object.keys(DISPUTE_GROUND_CATALOG) as DisputeGroundType[];
  check(
    "P1 catalog has all 9 grounds",
    keys.length === 9 && ALL_GROUNDS.every((g) => g in DISPUTE_GROUND_CATALOG),
    keys,
  );
  const orders = ALL_GROUNDS.map((g) => DISPUTE_GROUND_CATALOG[g].order).sort((a, b) => a - b);
  check("P1 orders are 0..8 unique", orders.join() === "0,1,2,3,4,5,6,7,8", orders);
}

// ── P2 — order parity: grounds sorted by catalog.order == original TYPE_ORDER. ────
{
  const byOrder = [...ALL_GROUNDS].sort(
    (a, b) => DISPUTE_GROUND_CATALOG[a].order - DISPUTE_GROUND_CATALOG[b].order,
  );
  check("P2 catalog order == original TYPE_ORDER", byOrder.join() === ORIGINAL_TYPE_ORDER.join(), byOrder);
}

// ── P3 — FINDING_TO_LETTER consumer parity for ALL FindingType:
//         deriveFindingToLetter()[f] || "overcharge" == ORIGINAL[f] || "overcharge". ────
{
  const derived = deriveFindingToLetter();
  for (const f of ALL_FINDING_TYPES) {
    const got = derived[f] ?? "overcharge";
    const want = ORIGINAL_FINDING_TO_LETTER[f] ?? "overcharge";
    check(`P3 letter[${f}] == ${want}`, got === want, got);
  }
}

// ── P4 — scoringClass / requestBucket / scope deep-equal the oracle + obligationElements are
//         well-formed (R3 step 3 seeded them; the deep per-element × per-recipient voice matrix
//         lives in obligation-registry-parity, not here). ──────────
const VALID_PREDICATES = new Set(["nsa_applicable", "contract_exists", "statute_verified", "rate_known"]);
const VALID_VOICE_MET = new Set(["demand", "raise", "request"]);
const VALID_VOICE_NOT = new Set(["omit", "fall_to_facts"]);
for (const g of ALL_GROUNDS) {
  const spec = DISPUTE_GROUND_CATALOG[g];
  check(`P4 ${g} scoringClass == ${EXPECTED_CLASS[g]}`, spec.scoringClass === EXPECTED_CLASS[g], spec.scoringClass);
  check(`P4 ${g} requestBucket == ${EXPECTED_BUCKET[g]}`, spec.requestBucket === EXPECTED_BUCKET[g], spec.requestBucket);
  check(`P4 ${g} scope == ${EXPECTED_SCOPE[g]}`, spec.scope === EXPECTED_SCOPE[g], spec.scope);
  check(
    `P4 ${g} obligationElements well-formed`,
    spec.obligationElements.every(
      (oe) =>
        (oe.party === "insurer" || oe.party === "provider") &&
        (oe.condition === null || VALID_PREDICATES.has(oe.condition)) &&
        VALID_VOICE_MET.has(oe.voiceIfMet) &&
        VALID_VOICE_NOT.has(oe.voiceIfNot) &&
        oe.element.length > 0 &&
        oe.authority.length > 0,
    ),
  );
}

// ── P5 — scoringClass LIVE-TIE: classifyDisputeType returns the catalog's class for a line
//         dominated by each ground. service_not_rendered is EXCLUDED — its class is the
//         evidence-resolver attestation override, not a classifyDisputeType branch. ────
type ClassifyInput = Parameters<typeof classifyDisputeType>[0];
type AuditFindingLike = NonNullable<ClassifyInput["auditFindings"]>[number];
function mkInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    planBenefit: null,
    peerCodes: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: null,
    discrepancyAmount: null,
    ...over,
  };
}
const af = (...types: FindingType[]): AuditFindingLike[] =>
  types.map((t): AuditFindingLike => ({
    type: t,
    severity: "high",
    title: "probe",
    description: "probe",
    estimatedOvercharge: 0,
    benchmarkAmount: 0,
    benchmarkSource: "probe",
  }));
type PeerCodeLike = NonNullable<ClassifyInput["peerCodes"]>[number];
const peer = (code: string): PeerCodeLike => ({
  code,
  codeType: "CPT",
  confidence: 0.9,
  promotionState: "corroborated",
});
const PROBES: Array<[DisputeGroundType, ClassifyInput]> = [
  ["balance_billing", mkInput({ auditFindings: af("balance_billing") })],
  ["coverage_contradiction", mkInput({ auditFindings: af("insurance_underpayment") })],
  ["cost_share_misapplication", mkInput({ auditFindings: af("zero_cost_share_overcharge") })],
  ["benchmark", mkInput({ auditFindings: af("overcharge") })],
  ["unbundling", mkInput({ auditFindings: af("unbundling") })],
  ["duplicate", mkInput({ auditFindings: af("duplicate") })],
  ["unallocated_balance", mkInput({ auditFindings: af("unallocated_balance") })],
  ["coding_peer", mkInput({ peerCodes: [peer("99213"), peer("99214")] })],
];
for (const [ground, input] of PROBES) {
  const got = classifyDisputeType(input);
  check(
    `P5 classifyDisputeType(${ground}-dominated) == catalog.scoringClass (${DISPUTE_GROUND_CATALOG[ground].scoringClass})`,
    got === DISPUTE_GROUND_CATALOG[ground].scoringClass,
    got,
  );
}

console.log(`\ncatalog-projection-parity: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

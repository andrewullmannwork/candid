/**
 * Classifier parity — the structural anti-drift lock for the two dispute-type classifiers.
 *
 * `classifyDisputeType` (strength-scoring.ts) is single-winner → writes `li.disputeType` → drives the
 * letter BODY bucketing. `groundsForLine` (dispute-grounds.ts) is multi-ground → drives the RECOVERY
 * math (`amount_disputed`). They independently encode the coverage-vs-cost-share spine ordering and
 * had drifted: a `planBenefit + discrepancy>0 + insurance_underpayment` line bucketed as
 * `coverage_contradiction` (body) but counted `cost_share_misapplication` dollars (recovery) →
 * incoherent letter (`amount_disputed != body`).
 *
 * This fixture enumerates the coverage/cost-share signal space and asserts: whenever
 * `classifyDisputeType` returns the coverage/cost-share spine, `groundsForLine`'s mutually-exclusive
 * spine ground MATCHES it. Any future re-divergence (edit one classifier, not the other) → CI red.
 *
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/classifier-parity.ts
 */
import { classifyDisputeType } from "../../../../src/lib/disputes/strength-scoring";
import { groundsForLine } from "../../../../src/lib/disputes/dispute-grounds";
import type { LineItemEvidence } from "../../../../src/lib/disputes/evidence-resolver";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

type Aud = NonNullable<LineItemEvidence["auditFindings"]>[number];
const aud = (type: string, estimatedOvercharge = 100): Aud => ({
  type, severity: "medium", title: type, estimatedOvercharge, benchmarkAmount: null,
  benchmarkSource: "Internal", findingId: type, removed: false,
} as Aud);

function makeLine(over: Partial<LineItemEvidence> = {}): LineItemEvidence {
  return {
    lineItemId: "li", billingCode: { value: "99214", type: "CPT" }, serviceSlug: "svc", serviceName: "Service",
    billedAmount: 300, insurancePaid: null, patientOwes: 300, patientPaid: null, planBenefit: null,
    expectedPatientCost: null, actualPatientCost: null, discrepancyAmount: null, discrepancyReason: null,
    communityOutcome: null, siblingCodes: null, pricingBenchmark: null, auditFindings: null, auditRan: false,
    peerCodes: null, disputeType: "other", citeGradeTier: "header", dollarAtStake: 0,
    serviceNotRenderedAttested: false, secondaryCoverageVerify: null, allowedAmount: null, networkStatus: null,
    ...over,
  } as LineItemEvidence;
}

// Both classifiers only check `!!planBenefit` (truthiness) — a minimal truthy marker suffices.
const PLAN_BENEFIT = { serviceSlug: "svc", serviceName: "Service", copay: 20, coinsurance: null, covered: true, source: "sbc" } as unknown as LineItemEvidence["planBenefit"];

const verdictOf = (c: string): "coverage" | "cost_share" | "n/a" =>
  c === "coverage_contradiction" ? "coverage" : c === "cost_share_misapplication" ? "cost_share" : "n/a";
const spineOf = (g: ReturnType<typeof groundsForLine>): "coverage" | "cost_share" | "none" => {
  const s = g.find((x) => x.type === "coverage_contradiction" || x.type === "cost_share_misapplication");
  return !s ? "none" : s.type === "coverage_contradiction" ? "coverage" : "cost_share";
};

// Enumerate the coverage/cost-share signal space × the higher-priority / benchmark interleavers.
const bools = [false, true];
let combos = 0;
for (const balanceBilling of bools)
  for (const coverageContra of bools) // insurance_underpayment finding
    for (const zeroCs of bools) // zero_cost_share_overcharge finding
      for (const overcharge of bools) // benchmark interleaver
        for (const planBenefit of bools)
          for (const discrepancyPos of bools) {
            combos++;
            const findings: Aud[] = [];
            if (balanceBilling) findings.push(aud("balance_billing"));
            if (coverageContra) findings.push(aud("insurance_underpayment", 250));
            if (zeroCs) findings.push(aud("zero_cost_share_overcharge", 40));
            if (overcharge) findings.push(aud("overcharge", 120));
            const line = makeLine({
              auditFindings: findings.length ? findings : null,
              planBenefit: planBenefit ? PLAN_BENEFIT : null,
              discrepancyAmount: discrepancyPos ? 50 : 0,
            });
            const verdict = verdictOf(classifyDisputeType(line));
            const spine = spineOf(groundsForLine(line, "claim-1"));
            // The invariant: whenever the BODY's winner is a coverage/cost-share spine, the RECOVERY's
            // spine ground must match it (so amount_disputed argues the same wrong the body does).
            if (verdict !== "n/a") {
              check(
                `parity [bb=${+balanceBilling} cc=${+coverageContra} zc=${+zeroCs} oc=${+overcharge} pb=${+planBenefit} dp=${+discrepancyPos}] body=${verdict} → recovery spine`,
                spine === verdict,
                { body: verdict, recovery: spine },
              );
            }
          }

// The canonical divergent case — regression-lock the FIX + the DOLLAR (coverage underpayment, not the
// cost-share sliver). planBenefit + discrepancy>0 + insurance_underpayment(estimatedOvercharge=300).
{
  const line = makeLine({
    planBenefit: PLAN_BENEFIT,
    discrepancyAmount: 50,
    auditFindings: [aud("insurance_underpayment", 300)],
  });
  check("DIVERGENT case: body classifies coverage_contradiction", classifyDisputeType(line) === "coverage_contradiction", classifyDisputeType(line));
  const g = groundsForLine(line, "claim-1");
  const spine = g.find((x) => x.type === "coverage_contradiction" || x.type === "cost_share_misapplication");
  check("DIVERGENT case: recovery spine is coverage_contradiction (was cost_share — the fix)", spine?.type === "coverage_contradiction", spine?.type);
  check("DIVERGENT case: dollar = coverage underpayment 300 (not the cost-share sliver 50)", spine?.dollarAtStake === 300, spine?.dollarAtStake);
}

console.log(`\nclassifier-parity: ${pass} passed, ${fails.length} failed  (${combos} combos enumerated)`);
if (fails.length) {
  console.log(fails.slice(0, 20).join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

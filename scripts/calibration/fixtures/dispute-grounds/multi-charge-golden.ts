/**
 * R3 step 5 — multi-charge recovery model (PII-free synthetic). Locks the 3-tier aggregation over
 * the catalog `scope`: LINE (per-line cap), LINE_SET (duplicate/unbundling, once), CLAIM
 * (unallocated_balance, a disjoint pool). Grows per sub-step:
 *   5.1 = CLAIM tier (this file's CL* cases);
 *   5.2 = SET tier + removal-dominates (dollar);
 *   5.3 = total fold + letter coherence + grand-total clamps.
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/multi-charge-golden.ts
 */
import { resolveLetterRecovery } from "../../../../src/lib/disputes/dispute-grounds";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";
import type { CostShareV2Result } from "../../../../src/lib/claims/recovery-math";
import type { ClaimLevelFindingMeta } from "../../../../src/lib/billing/types";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

function makeLine(over: Partial<LineItemEvidence> = {}): LineItemEvidence {
  return {
    lineItemId: "li-1",
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 300,
    insurancePaid: null,
    patientOwes: null,
    patientPaid: null,
    planBenefit: null,
    expectedPatientCost: null,
    actualPatientCost: null,
    discrepancyAmount: null,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: null,
    auditRan: false,
    peerCodes: null,
    disputeType: "other",
    citeGradeTier: "header",
    dollarAtStake: 0,
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
    ...over,
  };
}

function claimFinding(over: Partial<ClaimLevelFindingMeta> = {}): ClaimLevelFindingMeta {
  return {
    id: "clf-1",
    type: "unallocated_balance",
    severity: "high",
    estimatedOvercharge: 146,
    title: "Unallocated balance: $146.00",
    actionable: true,
    ...over,
  };
}

function makeEvidence(
  opts: { lines?: LineItemEvidence[]; claimFindings?: ClaimLevelFindingMeta[] } = {},
): DisputeEvidence {
  const claim = {
    claimId: "claim-1",
    dateOfService: "2024-03-15",
    providerName: "Sample Medical Center",
    totalBilled: 500,
    planYear: 2024,
    lineItemEvidence: opts.lines ?? [],
    effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
    claimFindings: opts.claimFindings ?? [],
  } satisfies ClaimEvidence;
  return {
    claims: [claim],
    totals: {
      claimCount: 1,
      lineItemCount: claim.lineItemEvidence.length,
      totalBilled: 500,
      totalDiscrepancy: 0,
    },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: [],
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
}

const EMPTY_BASIS = new Map<string, CostShareV2Result>();
// A not-rendered line is ALWAYS assertable (attestation IS the basis) → gives a non-zero line
// baseline WITHOUT constructing a CostShareV2Result, so we can prove the CLAIM tier does NOT fold
// into `total` (5.1 sequencing: claim recovery is recorded as data; the headline is unchanged
// until 5.3).
const notRenderedLine = makeLine({
  lineItemId: "li-nr",
  serviceNotRenderedAttested: true,
  billedAmount: 420,
  patientPaid: 420,
  patientOwes: 0,
});

// ── 5.1 CLAIM tier ───────────────────────────────────────────────────────────
// CL1 — an unallocated claim finding is recorded as a DISJOINT claim recovery; total stays line-only.
{
  const r = resolveLetterRecovery(
    makeEvidence({ lines: [notRenderedLine], claimFindings: [claimFinding()] }),
    EMPTY_BASIS,
  );
  check("CL1 total = line tier only (420); claim NOT folded into headline", near(r.total, 420), r.total);
  check("CL1 one claim recovery recorded", r.claimRecoveries.length === 1, r.claimRecoveries.length);
  check(
    "CL1 claim recovery = unallocated $146 (forgiveness: writeOff 146, refund 0)",
    r.claimRecoveries[0]?.type === "unallocated_balance" &&
      near(r.claimRecoveries[0]?.recovery, 146) &&
      near(r.claimRecoveries[0]?.writeOff, 146) &&
      near(r.claimRecoveries[0]?.refund, 0),
    r.claimRecoveries[0],
  );
}

// CL2 — a DISMISSED claim finding is excluded (the user said "not an issue").
{
  const r = resolveLetterRecovery(
    makeEvidence({ lines: [notRenderedLine], claimFindings: [claimFinding({ dismissed: true })] }),
    EMPTY_BASIS,
  );
  check("CL2 dismissed → no claim recovery", r.claimRecoveries.length === 0, r.claimRecoveries.length);
  check("CL2 total still line-only (420)", near(r.total, 420), r.total);
}

// CL3 — a non-actionable claim finding is excluded.
{
  const r = resolveLetterRecovery(
    makeEvidence({ claimFindings: [claimFinding({ actionable: false })] }),
    EMPTY_BASIS,
  );
  check("CL3 non-actionable → no claim recovery", r.claimRecoveries.length === 0, r.claimRecoveries.length);
}

// CL4 — catalog-scope routing: a NON-claim-scope finding type in claimFindings is ignored
//       (duplicate is line_set scope, not claim).
{
  const r = resolveLetterRecovery(
    makeEvidence({ claimFindings: [claimFinding({ type: "duplicate" })] }),
    EMPTY_BASIS,
  );
  check("CL4 line_set-scope finding not routed to claim tier", r.claimRecoveries.length === 0, r.claimRecoveries.length);
}

// CL5 — a zero-dollar claim finding is skipped.
{
  const r = resolveLetterRecovery(
    makeEvidence({ claimFindings: [claimFinding({ estimatedOvercharge: 0 })] }),
    EMPTY_BASIS,
  );
  check("CL5 zero-dollar claim finding skipped", r.claimRecoveries.length === 0, r.claimRecoveries.length);
}

// CL6 — no claim findings → empty claim tier (the byte-identical baseline golden-48 exercises).
{
  const r = resolveLetterRecovery(makeEvidence({}), EMPTY_BASIS);
  check(
    "CL6 no claim findings → empty tier, total 0",
    r.claimRecoveries.length === 0 && near(r.total, 0),
    { n: r.claimRecoveries.length, total: r.total },
  );
}

console.log(`\nmulti-charge-golden fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

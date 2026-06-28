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
import { checkDuplicates } from "../../../../src/lib/audit/rules";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";
import type { CostShareV2Result } from "../../../../src/lib/claims/recovery-math";
import type { ClaimLevelFindingMeta, ParsedBill } from "../../../../src/lib/billing/types";

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

type Aud = NonNullable<LineItemEvidence["auditFindings"]>[number];
const aud = (over: Partial<Aud> = {}): Aud => ({
  type: "duplicate",
  severity: "medium",
  title: "Possible duplicate charge",
  estimatedOvercharge: 200,
  benchmarkAmount: null,
  benchmarkSource: "Internal",
  findingId: "F",
  removed: false,
  ...over,
});

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

// ── 5.2 SET tier (genuine multi-line duplicate / unbundling) ──────────────────
// S1 — a 2-line duplicate: recovery counted ONCE (no N× double-count); the redundant copy is
//      dropped from the line tier; the SURVIVOR keeps its own (balance_billing) ground.
{
  const survivor = makeLine({
    lineItemId: "li-d0",
    billedAmount: 200,
    patientPaid: 0,
    patientOwes: 200,
    auditFindings: [
      aud({ findingId: "F", type: "duplicate", removed: false, estimatedOvercharge: 200 }),
      aud({ findingId: "F2", type: "balance_billing", removed: false, estimatedOvercharge: 50, title: "Balance billing" }),
    ],
  });
  const copy = makeLine({
    lineItemId: "li-d1",
    billedAmount: 200,
    patientPaid: 0,
    patientOwes: 200,
    auditFindings: [aud({ findingId: "F", type: "duplicate", removed: true, estimatedOvercharge: 200 })],
  });
  const r = resolveLetterRecovery(makeEvidence({ lines: [survivor, copy] }), EMPTY_BASIS);
  check("S1 one set recovery", r.setRecoveries.length === 1, r.setRecoveries.length);
  check("S1 duplicate counted ONCE (200, not 400 — no double-count)", near(r.setRecoveries[0]?.recovery ?? -1, 200), r.setRecoveries[0]?.recovery);
  check("S1 removed copy = li-d1", r.setRecoveries[0]?.removedLineItemIds.join() === "li-d1", r.setRecoveries[0]?.removedLineItemIds);
  check("S1 forgiveness split (owed → writeOff 200, refund 0)", near(r.setRecoveries[0]?.writeOff ?? -1, 200) && near(r.setRecoveries[0]?.refund ?? -1, 0), r.setRecoveries[0]);
  check("S1 survivor KEEPS its balance_billing in the line tier (50)", near(r.byLine.get("li-d0")?.capped ?? -1, 50), r.byLine.get("li-d0"));
  check("S1 removed copy dropped from line tier (no byLine entry)", !r.byLine.has("li-d1"), Array.from(r.byLine.keys()));
}

// S2 — removal is by the `removed` flag, NOT line-id order (immune to deduplicateFindings' in-place
//      lineItems.sort()): the survivor is the HIGHER id, the removed copy the LOWER id.
{
  const survivor = makeLine({ lineItemId: "li-z", billedAmount: 100, patientPaid: 0, patientOwes: 100, auditFindings: [aud({ findingId: "G", removed: false, estimatedOvercharge: 100 })] });
  const copy = makeLine({ lineItemId: "li-a", billedAmount: 100, patientPaid: 0, patientOwes: 100, auditFindings: [aud({ findingId: "G", removed: true, estimatedOvercharge: 100 })] });
  const r = resolveLetterRecovery(makeEvidence({ lines: [survivor, copy] }), EMPTY_BASIS);
  check("S2 removed = the flagged line (li-a), not the numeric-min", r.setRecoveries[0]?.removedLineItemIds.join() === "li-a", r.setRecoveries[0]?.removedLineItemIds);
  check("S2 recovery once (100)", near(r.setRecoveries[0]?.recovery ?? -1, 100), r.setRecoveries[0]?.recovery);
}

// S3 — a SINGLE-line duplicate is NOT a set: it stays in the line tier (byte-identical to today —
//      this is the shape golden-48 carries; proves the set tier never disturbs it).
{
  const solo = makeLine({ lineItemId: "li-s", billedAmount: 80, patientPaid: 0, patientOwes: 80, auditFindings: [aud({ findingId: "H", removed: false, estimatedOvercharge: 80 })] });
  const r = resolveLetterRecovery(makeEvidence({ lines: [solo] }), EMPTY_BASIS);
  check("S3 single-line duplicate → no set recovery", r.setRecoveries.length === 0, r.setRecoveries.length);
  check("S3 single-line duplicate STAYS in the line tier (80)", near(r.byLine.get("li-s")?.capped ?? -1, 80), r.byLine.get("li-s"));
}

// S4 — refund split: a removed copy already PAID → refund (not write-off).
{
  const survivor = makeLine({ lineItemId: "li-p0", billedAmount: 150, patientPaid: 150, patientOwes: 0, auditFindings: [aud({ findingId: "F4", removed: false, estimatedOvercharge: 150 })] });
  const copy = makeLine({ lineItemId: "li-p1", billedAmount: 150, patientPaid: 150, patientOwes: 0, auditFindings: [aud({ findingId: "F4", removed: true, estimatedOvercharge: 150 })] });
  const r = resolveLetterRecovery(makeEvidence({ lines: [survivor, copy] }), EMPTY_BASIS);
  check("S4 paid copy → refund 150, writeOff 0", near(r.setRecoveries[0]?.refund ?? -1, 150) && near(r.setRecoveries[0]?.writeOff ?? -1, 0), r.setRecoveries[0]);
}

// ── 5.2 DETECTOR — removedLineNumbers correctness + .sort() immunity (Risk A) ──
// D1 — checkDuplicates marks the redundant copies (survivor = FIRST in bill order, even when that's
//      the HIGHER line number), as a CONCRETE array that survives deduplicateFindings' in-place
//      lineItems.sort(). Guards against anyone later deriving "removed" from lineItems order.
{
  const bill = {
    lineItems: [
      { lineNumber: 5, procedureCode: "80053", serviceDate: "2024-03-15", billedAmount: 100, category: "Lab" },
      { lineNumber: 2, procedureCode: "80053", serviceDate: "2024-03-15", billedAmount: 100, category: "Lab" },
    ],
  } as unknown as ParsedBill;
  const findings = checkDuplicates(bill, new Map(), null, null); // last 3 args ignored by checkDuplicates
  check("D1 one duplicate finding", findings.length === 1, findings.length);
  check("D1 removed = redundant copy (line 2); survivor = line 5 (first in bill order)", findings[0]?.removedLineNumbers?.join() === "2", findings[0]?.removedLineNumbers);
  findings[0].lineItems.sort(); // simulate deduplicateFindings' in-place mutation
  check("D1 removedLineNumbers UNCHANGED after lineItems.sort() (sort-immune)", findings[0]?.removedLineNumbers?.join() === "2", findings[0]?.removedLineNumbers);
  check("D1 lineItems WAS reordered by sort → [2,5] (confirms the hazard is real)", findings[0].lineItems.join() === "2,5", findings[0].lineItems);
}

console.log(`\nmulti-charge-golden fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

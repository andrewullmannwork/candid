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
import { buildRequestSection } from "../../../../src/lib/disputes/templates";
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

// R3 step 5.3 — the clamp reads effectiveTotals (patientPaid / patientResponsibility). In PROD these
// are always populated by resolveEvidence; the synthetic fixture computes a faithful default (paid =
// Σ line paid; responsibility = Σ line owes + actionable unallocated) so the clamp has real bases.
// A case can override (e.g. an under-extracted header) to exercise a binding clamp.
function effTotals(
  lines: LineItemEvidence[],
  claimFindings: ClaimLevelFindingMeta[],
  over: Partial<ClaimEvidence["effectiveTotals"]> = {},
): ClaimEvidence["effectiveTotals"] {
  const patientPaid = lines.reduce((s, l) => s + (l.patientPaid ?? 0), 0);
  const owes = lines.reduce((s, l) => s + (l.patientOwes ?? 0), 0);
  const unalloc = claimFindings
    .filter((f) => f.type === "unallocated_balance" && f.actionable && !f.dismissed)
    .reduce((s, f) => s + Math.max(0, f.estimatedOvercharge), 0);
  return {
    patientPaid,
    insurancePaid: 0,
    insuranceAdjusted: 0,
    patientResponsibility: owes + unalloc,
    provenance: {
      patientPaidSource: "claim_header",
      insurancePaidSource: "claim_header",
      insuranceAdjustedSource: "claim_header",
      patientResponsibilitySource: "claim_header",
    },
    ...over,
  };
}

function makeEvidence(
  opts: {
    lines?: LineItemEvidence[];
    claimFindings?: ClaimLevelFindingMeta[];
    effectiveTotals?: Partial<ClaimEvidence["effectiveTotals"]>;
  } = {},
): DisputeEvidence {
  const lines = opts.lines ?? [];
  const claimFindings = opts.claimFindings ?? [];
  const claim = {
    claimId: "claim-1",
    dateOfService: "2024-03-15",
    providerName: "Sample Medical Center",
    totalBilled: 500,
    planYear: 2024,
    lineItemEvidence: lines,
    effectiveTotals: effTotals(lines, claimFindings, opts.effectiveTotals),
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
    claimFindings,
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
// CL1 — R3 step 5.3: an unallocated claim finding is FOLDED into the headline (line 420 refund +
//       claim 146 write-off = 566), and still recorded as a disjoint claim recovery.
{
  const r = resolveLetterRecovery(
    makeEvidence({ lines: [notRenderedLine], claimFindings: [claimFinding()] }),
    EMPTY_BASIS,
  );
  check("CL1 total = line 420 + claim 146 folded = 566", near(r.total, 566), r.total);
  check("CL1 total === totalRefund + totalWriteOff", near(r.total, r.totalRefund + r.totalWriteOff), { total: r.total, refund: r.totalRefund, writeOff: r.totalWriteOff });
  check("CL1 refund 420 (paid not-rendered line) + writeOff 146 (unallocated)", near(r.totalRefund, 420) && near(r.totalWriteOff, 146), { refund: r.totalRefund, writeOff: r.totalWriteOff });
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

// ── 5.3 FOLD + TWO-POOL CLAMP (per claim) ─────────────────────────────────────
// F1 — full fold: one assertable line (not-rendered refund 100) + a 2-line duplicate set (write-off
//      80, counted once) + an unallocated claim finding (write-off 50) → total = 100 + 80 + 50 = 230.
{
  const lineA = makeLine({ lineItemId: "f1-nr", serviceNotRenderedAttested: true, billedAmount: 100, patientPaid: 100, patientOwes: 0 });
  const dSurv = makeLine({ lineItemId: "f1-d0", billedAmount: 80, patientPaid: 0, patientOwes: 80, auditFindings: [aud({ findingId: "FD", removed: false, estimatedOvercharge: 80 })] });
  const dCopy = makeLine({ lineItemId: "f1-d1", billedAmount: 80, patientPaid: 0, patientOwes: 80, auditFindings: [aud({ findingId: "FD", removed: true, estimatedOvercharge: 80 })] });
  const r = resolveLetterRecovery(makeEvidence({ lines: [lineA, dSurv, dCopy], claimFindings: [claimFinding({ estimatedOvercharge: 50 })] }), EMPTY_BASIS);
  check("F1 line+set+claim folded: total = 100 + 80 + 50 = 230", near(r.total, 230), r.total);
  check("F1 refund 100 (line), writeOff 130 (set 80 + claim 50)", near(r.totalRefund, 100) && near(r.totalWriteOff, 130), { refund: r.totalRefund, writeOff: r.totalWriteOff });
  check("F1 total === totalRefund + totalWriteOff", near(r.total, r.totalRefund + r.totalWriteOff), r.total);
  check("F1 one set + one claim recovery", r.setRecoveries.length === 1 && r.claimRecoveries.length === 1, { sets: r.setRecoveries.length, claims: r.claimRecoveries.length });
}

// F2 — refund clamp binds: line refund 500, but the claim header under-reports patient-paid as 300
//      (Decision 3: trust the cite-grade header value → conservative). total clamps 500 → 300.
{
  const line = makeLine({ lineItemId: "f2-nr", serviceNotRenderedAttested: true, billedAmount: 500, patientPaid: 500, patientOwes: 0 });
  const r = resolveLetterRecovery(makeEvidence({ lines: [line], effectiveTotals: { patientPaid: 300 } }), EMPTY_BASIS);
  check("F2 refund clamp: 500 → 300 (header patient-paid cap)", near(r.total, 300) && near(r.totalRefund, 300), { total: r.total, refund: r.totalRefund });
}

// F3 — Risk E: the header under-reports patient-responsibility (0), but the line still owes 400. The
//      write-off cap = max(header 0, Σ line owes 400) = 400 → the legit write-off is NOT clipped (a
//      naive header-only cap would have wrongly clipped it to 0).
{
  const line = makeLine({ lineItemId: "f3-nr", serviceNotRenderedAttested: true, billedAmount: 400, patientPaid: 0, patientOwes: 400 });
  const r = resolveLetterRecovery(makeEvidence({ lines: [line], effectiveTotals: { patientResponsibility: 0 } }), EMPTY_BASIS);
  check("F3 write-off NOT clipped by under-extracted header (max(0, Σowes 400) = 400)", near(r.total, 400) && near(r.totalWriteOff, 400), { total: r.total, writeOff: r.totalWriteOff });
}

// F4 — per-claim clamp (Decision 2): a 2-claim dispute (roadmap). Claim 1's refund over-reads vs its
//      OWN header (clamped 700→500); claim 2 has headroom. PER-CLAIM → 500 + 100 = 600. A dispute-wide
//      clamp would WRONGLY let claim 1 borrow claim 2's headroom (→ 800). Proves no cross-claim leak.
{
  const c1Line = makeLine({ lineItemId: "c1-nr", serviceNotRenderedAttested: true, billedAmount: 700, patientPaid: 700, patientOwes: 0 });
  const c2Line = makeLine({ lineItemId: "c2-nr", serviceNotRenderedAttested: true, billedAmount: 100, patientPaid: 100, patientOwes: 0 });
  const mkClaim = (id: string, line: LineItemEvidence, paidCap: number): ClaimEvidence => ({
    claimId: id, dateOfService: "2024-03-15", providerName: "P", totalBilled: line.billedAmount, planYear: 2024,
    lineItemEvidence: [line],
    effectiveTotals: effTotals([line], [], { patientPaid: paidCap }),
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
    claimFindings: [],
  });
  const ev: DisputeEvidence = {
    claims: [mkClaim("claim-1", c1Line, 500), mkClaim("claim-2", c2Line, 400)],
    totals: { claimCount: 2, lineItemCount: 2, totalBilled: 800, totalDiscrepancy: 0 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
  const r = resolveLetterRecovery(ev, EMPTY_BASIS);
  check("F4 per-claim clamp: claim1 700→500 + claim2 100 = 600 (NOT dispute-wide 800)", near(r.total, 600), r.total);
  check("F4 total === totalRefund + totalWriteOff", near(r.total, r.totalRefund + r.totalWriteOff), { total: r.total, refund: r.totalRefund, writeOff: r.totalWriteOff });
}

// F5 — Part 1a: a DISMISSED line-level duplicate is excluded from BOTH the set tier and the total
//      (it stays in metadata as dismissed:true; the recovery tiers skip it).
{
  const surv = makeLine({ lineItemId: "f5-d0", billedAmount: 90, patientPaid: 0, patientOwes: 90, auditFindings: [aud({ findingId: "FX", removed: false, estimatedOvercharge: 90, dismissed: true })] });
  const copy = makeLine({ lineItemId: "f5-d1", billedAmount: 90, patientPaid: 0, patientOwes: 90, auditFindings: [aud({ findingId: "FX", removed: true, estimatedOvercharge: 90, dismissed: true })] });
  const r = resolveLetterRecovery(makeEvidence({ lines: [surv, copy] }), EMPTY_BASIS);
  check("F5 dismissed line duplicate → no set recovery", r.setRecoveries.length === 0, r.setRecoveries.length);
  check("F5 dismissed line duplicate → not folded into total (0)", near(r.total, 0), r.total);
}

// ── 5.3 Part 3: letter coherence (buildRequestSection argues the set/claim grounds) ───────────
function letterFor(ev: DisputeEvidence, recipient: "insurer" | "provider"): string {
  const rec = resolveLetterRecovery(ev, EMPTY_BASIS);
  return buildRequestSection({ evidence: ev, planContext: null, recipient, letterRecovery: rec.byLine, recovery: rec, demandsEnabled: false });
}

// L1 — a patient-owed 2-line duplicate: the provider letter argues the removal ONCE (the removed
//      copy is dropped from the reprice buckets; removal dominates).
{
  const survivor = makeLine({ lineItemId: "L1-d0", billedAmount: 200, patientPaid: 0, patientOwes: 200, auditFindings: [aud({ findingId: "L1F", removed: false, estimatedOvercharge: 200 })] });
  const copy = makeLine({ lineItemId: "L1-d1", billedAmount: 200, patientPaid: 0, patientOwes: 200, auditFindings: [aud({ findingId: "L1F", removed: true, estimatedOvercharge: 200 })] });
  const prov = letterFor(makeEvidence({ lines: [survivor, copy] }), "provider");
  check("L1 provider letter argues the duplicate removal", /remove the duplicate charge for/i.test(prov), prov);
  check("L1 provider letter names the $200 write-off exactly once (no double-count)", (prov.match(/\$200\.00/g) ?? []).length === 1, prov);
}

// L2 — a $0-patient insurer-PAID duplicate: insurer letter raises the hedged review; the provider
//      letter does NOT argue it (no patient exposure).
{
  const survivor = makeLine({ lineItemId: "L2-d0", billedAmount: 150, patientPaid: 0, patientOwes: 0, insurancePaid: 150, auditFindings: [aud({ findingId: "L2F", removed: false, estimatedOvercharge: 150 })] });
  const copy = makeLine({ lineItemId: "L2-d1", billedAmount: 150, patientPaid: 0, patientOwes: 0, insurancePaid: 150, auditFindings: [aud({ findingId: "L2F", removed: true, estimatedOvercharge: 150 })] });
  const ev = makeEvidence({ lines: [survivor, copy] });
  check("L2 insurer letter raises the insurer-paid-duplicate review", /was paid more than once/i.test(letterFor(ev, "insurer")), letterFor(ev, "insurer"));
  check("L2 provider letter does NOT argue the $0 duplicate", !/duplicate charge/i.test(letterFor(ev, "provider")), letterFor(ev, "provider"));
}

// L3 — an unallocated claim finding: provider letter asks to itemize the gap.
{
  const prov = letterFor(makeEvidence({ lines: [notRenderedLine], claimFindings: [claimFinding()] }), "provider");
  check("L3 provider letter asks to itemize the $146 unallocated gap", /itemize the \$146\.00 by which the bill total exceeds/i.test(prov), prov);
}

// L5 — a clamp-bound claim drops precise dollars: the not-rendered ask renders WITHOUT a refund $.
{
  const line = makeLine({ lineItemId: "L5-nr", serviceNotRenderedAttested: true, billedAmount: 500, patientPaid: 500, patientOwes: 0 });
  const ev = makeEvidence({ lines: [line], effectiveTotals: { patientPaid: 300 } });
  check("L5 the claim is clamp-bound", resolveLetterRecovery(ev, EMPTY_BASIS).clampBoundClaimIds.length === 1, resolveLetterRecovery(ev, EMPTY_BASIS).clampBoundClaimIds);
  check("L5 clamp-bound: the ask renders without a precise refund $", !/refund the \$/i.test(letterFor(ev, "provider")), letterFor(ev, "provider"));
}

// L6 — a not-rendered survivor of a duplicate: the whole-charge not-rendered ask subsumes the removal
//      ask (no separate duplicate ask).
{
  const survivor = makeLine({ lineItemId: "L6-d0", serviceNotRenderedAttested: true, billedAmount: 90, patientPaid: 0, patientOwes: 90, auditFindings: [aud({ findingId: "L6F", removed: false, estimatedOvercharge: 90 })] });
  const copy = makeLine({ lineItemId: "L6-d1", billedAmount: 90, patientPaid: 0, patientOwes: 90, auditFindings: [aud({ findingId: "L6F", removed: true, estimatedOvercharge: 90 })] });
  const prov = letterFor(makeEvidence({ lines: [survivor, copy] }), "provider");
  check("L6 not-rendered survivor → no separate duplicate removal ask", !/duplicate charge/i.test(prov), prov);
}

console.log(`\nmulti-charge-golden fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

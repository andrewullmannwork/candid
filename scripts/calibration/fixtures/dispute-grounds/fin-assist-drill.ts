/**
 * R3 step 5.4 Phase 3 (Item D — financial-assistance structure). PII-free synthetic drill over the FA
 * render seam in buildRequestSection. It locks two properties:
 *   (1) INERT by default — no live generator passes `finAssistContext`, so a provider letter is
 *       byte-identical to the shipped Item A behavior (the foundation merge stays byte-safe);
 *   (2) CORRECT when the opt-in is forced true — the FA application ask renders, the ONE standing
 *       collections-hold cites BOTH bases (no redundant second hold), and the `faActive` coherence
 *       gate keeps the ask and the hold clause in lock-step (the hold can never reference an FA
 *       request the letter did not make).
 * The activation fast-follow (seed+flip `financial_assistance_request_v1`, the route-read that
 * composes finAssistContext = flag && dispute.metadata.finAssistOptIn, the set-fa-optin endpoint, the
 * frontend opt-in toggle, the counsel pass) wires the signal; this drill proves the structure so that
 * activation is purely additive.
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/fin-assist-drill.ts
 */
import { buildRequestSection } from "../../../../src/lib/disputes/templates";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

function makeLine(over: Partial<LineItemEvidence> = {}): LineItemEvidence {
  return {
    lineItemId: "li-1",
    billingCode: { value: "99214", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 300,
    insurancePaid: null,
    patientOwes: 200,
    patientPaid: null,
    planBenefit: null,
    expectedPatientCost: null,
    actualPatientCost: null,
    discrepancyAmount: 200,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: null,
    auditRan: false,
    peerCodes: null,
    disputeType: "balance_billing",
    citeGradeTier: "header",
    dollarAtStake: 200,
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
    ...over,
  };
}

function makeEvidence(lines: LineItemEvidence[]): DisputeEvidence {
  const claim = {
    claimId: "claim-1",
    dateOfService: "2024-03-15",
    providerName: "Sample Medical Center",
    totalBilled: 500,
    planYear: 2024,
    lineItemEvidence: lines,
    effectiveTotals: {
      patientPaid: lines.reduce((s, l) => s + (l.patientPaid ?? 0), 0),
      insurancePaid: 0,
      insuranceAdjusted: 0,
      patientResponsibility: lines.reduce((s, l) => s + (l.patientOwes ?? 0), 0),
      provenance: {
        patientPaidSource: "claim_header",
        insurancePaidSource: "claim_header",
        insuranceAdjustedSource: "claim_header",
        patientResponsibilitySource: "claim_header",
      },
    },
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
    claimFindings: [],
  } satisfies ClaimEvidence;
  return {
    compositionScope: null,
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: lines.length, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: [],
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
}

const FA_ASK = /apply for any financial assistance available for this balance/i;
const FA_HOLD_CLAUSE = /and my financial-assistance request is under review/i;
const HOLD = /place any collection activity for this balance on hold/g;
const holdCount = (s: string): number => (s.match(HOLD) ?? []).length;

// D1 — OFF (default): provider, no finAssistContext → byte-inert. No FA copy; the standing
//      collections-hold is the shipped Item A copy (no FA clause). Proves the structure is invisible
//      until activation (this is what keeps golden-corpus byte-identical).
{
  const letter = buildRequestSection({ evidence: makeEvidence([makeLine()]), planContext: null, recipient: "provider" });
  check("D1 OFF → no FA application ask", !FA_ASK.test(letter), letter);
  check("D1 OFF → standing hold has NO FA clause (Item A copy unchanged)", !FA_HOLD_CLAUSE.test(letter));
  check("D1 OFF → the standing hold still renders once (owed balance)", holdCount(letter) === 1, holdCount(letter));
}

// D2 — provider + opt-in (owed, non-attested): the FA application ask renders AND the ONE hold cites
//      both bases. Exactly one hold (the anti-bandaid the S254 review locked: no redundant second
//      hold; the FA basis is folded into the single Item A hold).
{
  const letter = buildRequestSection({ evidence: makeEvidence([makeLine()]), planContext: null, recipient: "provider", finAssistContext: true });
  check("D2 opt-in → FA application ask renders", FA_ASK.test(letter), letter);
  check("D2 opt-in → the standing hold cites BOTH bases (dispute + FA review)", FA_HOLD_CLAUSE.test(letter), letter);
  check("D2 opt-in → EXACTLY ONE hold (no redundant second hold)", holdCount(letter) === 1, holdCount(letter));
}

// D3 — insurer + opt-in: the provider-only guard makes it inert on an insurer letter.
{
  const letter = buildRequestSection({ evidence: makeEvidence([makeLine()]), planContext: null, recipient: "insurer", finAssistContext: true });
  check("D3 insurer + opt-in → no FA application ask (provider-only)", !FA_ASK.test(letter), letter);
  check("D3 insurer + opt-in → no FA hold clause", !FA_HOLD_CLAUSE.test(letter));
}

// D4 — $0 owed + opt-in: the patientOwes>0 gate suppresses the FA ask (no FA on a nothing-owed letter).
{
  const letter = buildRequestSection({ evidence: makeEvidence([makeLine({ patientOwes: 0, discrepancyAmount: 0 })]), planContext: null, recipient: "provider", finAssistContext: true });
  check("D4 $0 owed + opt-in → no FA application ask", !FA_ASK.test(letter), letter);
  check("D4 $0 owed + opt-in → no FA hold clause", !FA_HOLD_CLAUSE.test(letter));
}

// D5 — owed but ENTIRELY attested-not-rendered + opt-in: the coherence gate suppresses the FA ask (you
//      do not seek assistance for a balance you say you never incurred), AND the standing hold renders
//      WITHOUT the FA clause — the `faActive` coherence fix (no orphaned FA reference in the hold).
{
  const letter = buildRequestSection({ evidence: makeEvidence([makeLine({ serviceNotRenderedAttested: true })]), planContext: null, recipient: "provider", finAssistContext: true });
  check("D5 all-owed-attested + opt-in → no FA application ask (coherence gate)", !FA_ASK.test(letter), letter);
  check(
    "D5 all-owed-attested → hold renders WITHOUT the FA clause (no orphaned FA reference)",
    holdCount(letter) === 1 && !FA_HOLD_CLAUSE.test(letter),
    { holds: holdCount(letter), faClause: FA_HOLD_CLAUSE.test(letter) },
  );
}

console.log(`\nfin-assist-drill (Item D) fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

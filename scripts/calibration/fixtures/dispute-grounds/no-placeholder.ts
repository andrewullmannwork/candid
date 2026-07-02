/**
 * no-placeholder — dispute-letters v2 S3 (fail-closed enforcement).
 *
 * Asserts that NO literal placeholder token ($[…] / [date] / [X] / any [Word]
 * bracket token) EVER appears in a rendered dispute letter — on BOTH:
 *   1. the committed happy-path goldens (golden/*.txt), and
 *   2. ADVERSARIAL-sparse renders (null insurer / plan / account → the fail-closed
 *      path) where a `|| "[literal]"` fallback would otherwise leak into the letter.
 *
 * No golden exercises an all-null insurer, so (2) is what actually guards the
 * insurer-name chain in insuranceAppealTemplate (the [Insurance Company] leak this
 * fixture was born to catch). renderGated is the letter-side helper that keeps the
 * gated clauses fail-closed; this fixture is its CI enforcement.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/no-placeholder.ts
 * CI:   .github/workflows/ci.yml (dispute-letters S3).
 */
import { resolve } from "path";
import { readdirSync, readFileSync } from "fs";
import { LETTER_TEMPLATES } from "../../../../src/lib/disputes/templates";
import { generateNegotiationLetter } from "../../../../src/lib/disputes/negotiation-template";
import { buildFollowupLetter } from "../../../../src/lib/disputes/followup-letter";
import type { AuditFinding, ParsedBill, DisputeLetterType } from "../../../../src/lib/billing/types";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  ${String(got).slice(0, 160)}` : ""}`);
}

// The dangerous tokens: `$[` (e.g. $[X]), `[date]`, `[X]`, and any `[Word]` bracket
// token (e.g. the [Insurance Company] leak). Verified 0 matches across the current
// goldens (S3), so this never false-positives on legitimate letter prose.
const PLACEHOLDER = /\$\[|\[[A-Za-z]/;
function assertClean(label: string, body: string): void {
  const m = PLACEHOLDER.exec(body);
  check(
    `${label}: no placeholder token`,
    m === null,
    m ? `matched "${m[0]}" @${m.index}: …${body.slice(Math.max(0, m.index - 24), m.index + 24)}…` : undefined,
  );
}

// ── (1) committed goldens (happy path) ───────────────────────────────────────
const GOLDEN_DIR = resolve(__dirname, "golden");
for (const f of readdirSync(GOLDEN_DIR).filter((n) => n.endsWith(".txt")).sort()) {
  assertClean(`golden/${f}`, readFileSync(resolve(GOLDEN_DIR, f), "utf8"));
}

// ── (2) adversarial-sparse renders (the fail-closed path) ─────────────────────
// A bill stripped of EVERY optional identifier a `|| "[literal]"` fallback keys on:
// no insurer (→ the insurer-name chain hits its final fallback), no provider
// address, no memberId. planContext:null, findings:[], evidence:null, no account.
function sparseBill(over: Partial<ParsedBill> = {}): ParsedBill {
  return {
    id: "np",
    documentId: "np",
    userId: "np",
    billType: "eob",
    provider: { name: "Provider" }, // no address
    patient: { name: "Patient" }, // no memberId
    // insurer intentionally ABSENT → forces the insurer-name fallback path
    serviceDate: "2024-03-15",
    lineItems: [],
    totals: { totalBilled: 0 },
    rawText: "",
    confidence: 1,
    parseErrors: [],
    ...over,
  };
}

const COMMON = {
  patientName: "Patient",
  providerName: "Provider",
  serviceDate: "2024-03-15",
  findings: [] as AuditFinding[],
  planContext: null,
  evidence: null,
  gateUnverified: true,
  v3DesignOn: true,
};

// The 5 pre-existing body templates on the simple param set. insurance_appeal is
// the real leak target (its recipient block runs the insurer-name fallback chain).
for (const t of ["overcharge", "duplicate_charge", "balance_billing", "itemized_request", "insurance_appeal"] as DisputeLetterType[]) {
  try {
    assertClean(`${t} [sparse]`, LETTER_TEMPLATES[t].body({ ...COMMON, bill: sparseBill() }));
  } catch (e) {
    check(`render ${t} [sparse] does not throw`, false, e instanceof Error ? e.message : e);
  }
}

// The 3 S2 escalation/collections types — insurer-stripped bill + fail-closed gate
// inputs (recital / attestation / collector absent-or-minimal). They already use
// renderGated; this guards against a regression re-introducing a placeholder.
try {
  assertClean("final_notice [sparse]", LETTER_TEMPLATES.final_notice.body({ ...COMMON, bill: sparseBill(), priorContactDates: [], certifiedMail: false }));
} catch (e) {
  check("render final_notice [sparse] does not throw", false, e instanceof Error ? e.message : e);
}
try {
  assertClean("external_review [sparse]", LETTER_TEMPLATES.external_review.body({ ...COMMON, bill: sparseBill(), appealExhausted: { attested: true, denialDate: null } }));
} catch (e) {
  check("render external_review [sparse] does not throw", false, e instanceof Error ? e.message : e);
}
try {
  assertClean("debt_validation [sparse]", LETTER_TEMPLATES.debt_validation.body({ ...COMMON, bill: sparseBill(), collector: { name: "Collector" }, debtWithinWindow: false }));
} catch (e) {
  check("render debt_validation [sparse] does not throw", false, e instanceof Error ? e.message : e);
}

// negotiation — the separate self-pay path; sparse (no serviceDate, no billedAmount, null benchmarks).
try {
  assertClean(
    "negotiation [sparse]",
    generateNegotiationLetter({ patientName: "Patient", providerName: "Provider", serviceName: "the service", medicareBenchmark: null, communityMedian: null, suggestedRate: 100, communityReportCount: 0 }),
  );
} catch (e) {
  check("render negotiation [sparse] does not throw", false, e instanceof Error ? e.message : e);
}

// dispute-letters v2 S4 — graduated follow-up letters (map §3.3). Every reachable recipient track
// + final/interim + an adversarial empty parent date + an unknown parent type (fail-closed
// formatDate + PARENT_LABEL fallback). buildFollowupLetter uses no bracket templates → this locks
// that in at CI so a future edit can't re-introduce a placeholder.
const followupCases = [
  { recipientKind: "insurer" as const, parentLetterType: "insurance_appeal", deadlineType: "plan_response", isFinal: false },
  { recipientKind: "insurer" as const, parentLetterType: "insurance_appeal", deadlineType: "plan_response", isFinal: true },
  { recipientKind: "collector" as const, parentLetterType: "debt_validation", deadlineType: "fdcpa_validation_30", isFinal: true },
  { recipientKind: "provider" as const, parentLetterType: "overcharge", deadlineType: "state_timely_billing", isFinal: false },
  { recipientKind: "insurer" as const, parentLetterType: "unknown_type", deadlineType: "plan_response", isFinal: false },
];
for (const [i, c] of followupCases.entries()) {
  try {
    assertClean(
      `followup letter [${i} ${c.parentLetterType}/${c.recipientKind}${c.isFinal ? "/final" : ""}]`,
      buildFollowupLetter({ ...c, parentSentDate: i === 4 ? "" : "2024-03-15", governingDeadlineDate: "2024-06-01" }),
    );
  } catch (e) {
    check(`render followup [${i}] does not throw`, false, e instanceof Error ? e.message : e);
  }
}

// ── report ────────────────────────────────────────────────────────────────────
console.log(`\nno-placeholder fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

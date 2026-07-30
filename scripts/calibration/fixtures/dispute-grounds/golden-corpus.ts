/**
 * §18 Stage 0 — synthetic golden-letter corpus (COMMITTED firewall; PII-free, CI-runnable).
 *
 * The regression guard for the DisputeGround refactor. Renders each letter template on
 * BOTH paths the production code uses:
 *   - generate path = template.body({ ...real findings... })          (index.ts:120)
 *   - rerender path = template.body({ ...findings: []... })            (rerender.ts:113)
 * — captures the date-normalized body byte-exact (capture-or-assert), AND asserts the
 * known structural properties so the later stages are provable:
 *   - $0.00 BUG (present today): overcharge/balance_billing/duplicate ZERO their totals +
 *     empty their findingDetails on the rerender path (findings:[]). insurance_appeal is SAFE.
 *     → Stage 2 (the fix) FLIPS these assertions (rerender keeps the real total). Intentional.
 *   - PARITY: insurance_appeal + itemized_request render identically on both paths (they don't
 *     read `findings`).
 *
 * The oracles are all insurance_appeal (the safe type) → they can't exercise the $0.00 bug;
 * this synthetic corpus is the only thing that firewalls it. Fixtures are fictional — no PII.
 *
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/golden-corpus.ts
 *      npx tsx scripts/calibration/fixtures/dispute-grounds/golden-corpus.ts --update   (re-baseline)
 */
import { resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { LETTER_TEMPLATES, buildRequestSection } from "../../../../src/lib/disputes/templates";
import { generateNegotiationLetter } from "../../../../src/lib/disputes/negotiation-template";
import type { AuditFinding, ParsedBill, DisputeLetterType } from "../../../../src/lib/billing/types";
import type { DisputeEvidence, LineItemEvidence, ClaimEvidence } from "../../../../src/lib/disputes/evidence-resolver";
import type { PlanContext } from "../../../../src/lib/disputes/plan-context";

const GOLDEN_DIR = resolve(__dirname, "golden");
mkdirSync(GOLDEN_DIR, { recursive: true });
const UPDATE = process.argv.includes("--update");

let pass = 0;
const fails: string[] = [];
const captured: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

// The letter body opens with formatDate(new Date()) = today (templates.ts:966 etc.).
// Replicate formatDate(today) exactly (templates.ts:888) and normalize it out so snapshots
// are deterministic across days. The fixture serviceDate is a different (fixed) date → no collision.
// Most templates open with formatDate(today) (UTC, templates.ts:888); the negotiation
// template uses LOCAL time (negotiation-template.ts:33). Normalize BOTH formats so
// snapshots are deterministic across templates AND the UTC/local day boundary. The fixture
// serviceDate ("March 15, 2024") is a different, fixed date → never collides.
const DATE_OPTS = { year: "numeric", month: "long", day: "numeric" } as const;
const TODAY_UTC = new Date(new Date().toISOString()).toLocaleDateString("en-US", { ...DATE_OPTS, timeZone: "UTC" });
const TODAY_LOCAL = new Date().toLocaleDateString("en-US", DATE_OPTS);
const normalize = (body: string): string =>
  body.split(TODAY_UTC).join("<LETTER_DATE>").split(TODAY_LOCAL).join("<LETTER_DATE>");

function snapshot(name: string, body: string) {
  const file = resolve(GOLDEN_DIR, `${name}.txt`);
  const content = normalize(body);
  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, content);
    captured.push(name);
    return;
  }
  const golden = readFileSync(file, "utf8");
  check(
    `snapshot ${name} byte-identical`,
    golden === content,
    golden === content ? undefined : `len ${content.length} vs golden ${golden.length}`,
  );
}

// ── PII-FREE synthetic fixtures (fictional names/amounts) ────────────────────
const SERVICE_DATE = "2024-03-15"; // fixed → deterministic "March 15, 2024"

function makeBill(over: Partial<ParsedBill> = {}): ParsedBill {
  return {
    id: "fixture-bill-1",
    documentId: "fixture-doc-1",
    userId: "fixture-user-1",
    billType: "eob",
    provider: { name: "Sample Medical Center", address: "123 Care St\nAnytown, CA 90000" },
    patient: { name: "Jordan Sample", memberId: "MBR000000" },
    insurer: { name: "Sample Health Plan", planName: "Sample PPO" },
    serviceDate: SERVICE_DATE,
    lineItems: [],
    totals: { totalBilled: 500 },
    rawText: "",
    confidence: 1,
    parseErrors: [],
    ...over,
  };
}

function makeFinding(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "f1",
    type: "overcharge",
    severity: "high",
    lineItems: [1],
    title: "Potential overcharge on office visit",
    description: "The billed amount substantially exceeds the Medicare benchmark for this service.",
    estimatedOvercharge: 230,
    benchmarkSource: "Medicare",
    benchmarkAmount: 70,
    billedAmount: 300,
    confidence: 0.9,
    actionable: true,
    ...over,
  };
}

// Mirror the two production call sites (index.ts:120 / rerender.ts:113). Flags fixed to the
// PROD state (v3 ON, consumer-read-filter ON) so the golden is deterministic regardless of
// live flag reads. OFF-combo goldens can be added later (gate #9).
const V3 = true;
const GATE = true;

function renderGenerate(type: DisputeLetterType, bill: ParsedBill, findings: AuditFinding[]): string {
  return LETTER_TEMPLATES[type].body({
    patientName: bill.patient.name,
    providerName: bill.provider.name,
    serviceDate: bill.serviceDate,
    findings,
    bill,
    planContext: null,
    evidence: null,
    gateUnverified: GATE,
    v3DesignOn: V3,
  });
}
function renderRerender(type: DisputeLetterType, bill: ParsedBill): string {
  return LETTER_TEMPLATES[type].body({
    patientName: bill.patient.name,
    providerName: bill.provider.name,
    serviceDate: bill.serviceDate,
    findings: [], // ← the rerender path (rerender.ts:117). Source of the $0.00 bug.
    bill,
    planContext: null,
    evidence: null,
    gateUnverified: GATE,
    v3DesignOn: V3,
    attestingName: bill.patient.name,
  });
}

// ── §18 incr-3b — ON variant (dispute_grounds_v1). The OFF helpers above pass evidence:null
//    + the `findings` param; these pass disputeGroundsOn + a synthetic DisputeEvidence whose
//    line auditFindings mirror the same findings, so the 3 provider templates source their
//    finding block from groundFindingsForEvidence (rerender-safe). billedAmount lives on the
//    LINE (GroundFinding reads it there), matching the OFF finding's billedAmount. ───────────
function evidenceLine(f: AuditFinding, lineItemId: string): LineItemEvidence {
  return {
    lineItemId,
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: f.billedAmount,
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
    auditFindings: [
      {
        type: f.type,
        severity: f.severity,
        title: f.title,
        description: f.description,
        estimatedOvercharge: f.estimatedOvercharge,
        benchmarkAmount: f.benchmarkAmount ?? null,
        benchmarkSource: f.benchmarkSource ?? null,
      },
    ],
    auditRan: true,
    peerCodes: null,
    disputeType: "other",
    citeGradeTier: "header",
    dollarAtStake: f.estimatedOvercharge,
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
  };
}
function makeEvidence(findings: AuditFinding[]): DisputeEvidence {
  const claim = {
    claimId: "claim-1",
    dateOfService: SERVICE_DATE,
    providerName: "Sample Medical Center",
    totalBilled: 500,
    planYear: 2024,
    lineItemEvidence: findings.map((f, i) => evidenceLine(f, `li-${i + 1}`)),
    effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } satisfies ClaimEvidence;
  return {
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: findings.length, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: [],
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
}
function renderGenerateON(type: DisputeLetterType, bill: ParsedBill, findings: AuditFinding[], evidence: DisputeEvidence): string {
  return LETTER_TEMPLATES[type].body({
    patientName: bill.patient.name,
    providerName: bill.provider.name,
    serviceDate: bill.serviceDate,
    findings,
    bill,
    planContext: null,
    evidence,
    gateUnverified: GATE,
    v3DesignOn: V3,
    disputeGroundsOn: true,
  });
}
function renderRerenderON(type: DisputeLetterType, bill: ParsedBill, evidence: DisputeEvidence): string {
  return LETTER_TEMPLATES[type].body({
    patientName: bill.patient.name,
    providerName: bill.provider.name,
    serviceDate: bill.serviceDate,
    findings: [], // ← the rerender path. On the ON path it is IGNORED (sourced from evidence).
    bill,
    planContext: null,
    evidence,
    gateUnverified: GATE,
    v3DesignOn: V3,
    disputeGroundsOn: true,
    attestingName: bill.patient.name,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const bill = makeBill();

// The 3 findings-driven templates that exhibit the $0.00 refresh bug.
const ZERO_BUG_TYPES: { type: DisputeLetterType; findings: AuditFinding[] }[] = [
  { type: "overcharge", findings: [makeFinding()] },
  { type: "balance_billing", findings: [makeFinding({ type: "balance_billing", title: "Balance billed above allowed amount", description: "This amount exceeds my plan's allowed amount after the insurer's payment.", estimatedOvercharge: 150, billedAmount: 400, benchmarkAmount: undefined, benchmarkSource: undefined })] },
  { type: "duplicate_charge", findings: [makeFinding({ type: "duplicate", title: "Duplicate charge for the same service", description: "This service appears billed more than once for the same date of service.", estimatedOvercharge: 120, billedAmount: 120, benchmarkAmount: undefined, benchmarkSource: undefined })] },
];

for (const { type, findings } of ZERO_BUG_TYPES) {
  const gen = renderGenerate(type, bill, findings);
  const rer = renderRerender(type, bill);
  snapshot(`${type}.generate`, gen);
  snapshot(`${type}.rerender`, rer);

  const expectedTotal = findings.reduce((s, f) => s + f.estimatedOvercharge, 0);
  // generate path: real total present, findings detail present
  check(`${type} generate shows real total $${expectedTotal.toFixed(2)}`, gen.includes(`$${expectedTotal.toFixed(2)}`));
  check(`${type} generate lists the finding`, gen.includes(findings[0].title));
  // rerender path (findings:[], flag OFF): the $0.00 BUG persists — total zeroed, detail gone.
  // The fix is FLAG-GATED, so these do NOT flip: OFF stays byte-identical (they pin OFF parity);
  // the grounds-ON block below proves the fix (rerender keeps the real total + detail).
  check(`${type} rerender ZEROS the total ($0.00) [flag OFF — byte-identical legacy]`, rer.includes("$0.00"));
  check(`${type} rerender DROPS the finding detail [flag OFF — byte-identical legacy]`, !rer.includes(findings[0].title));
  check(`${type} generate≠rerender [flag OFF — the bug diverges them]`, normalize(gen) !== normalize(rer));

  // §18 incr-3b — ON variant (dispute_grounds_v1 + evidence): the FIX. Both generate AND
  // rerender source the finding block from `evidence`, so they can't diverge and the rerender
  // keeps the real total/detail. Snapshots captured as new goldens for review.
  const evidence = makeEvidence(findings);
  const genON = renderGenerateON(type, bill, findings, evidence);
  const rerON = renderRerenderON(type, bill, evidence);
  snapshot(`${type}.generate.grounds-on`, genON);
  snapshot(`${type}.rerender.grounds-on`, rerON);
  check(`${type} [grounds ON] rerender keeps the real total $${expectedTotal.toFixed(2)} (bug FIXED)`, rerON.includes(`$${expectedTotal.toFixed(2)}`));
  check(`${type} [grounds ON] rerender lists the finding (bug FIXED)`, rerON.includes(findings[0].title));
  check(`${type} [grounds ON] rerender has NO $0.00`, !rerON.includes("$0.00"));
  check(`${type} [grounds ON] generate == rerender (one evidence source → no divergence)`, normalize(genON) === normalize(rerON));
}

// insurance_appeal — the SAFE template (reads `evidence`, not `findings`). With evidence:null
// it renders its no-evidence path; findings:[] must NOT change it → parity on both paths.
{
  const gen = renderGenerate("insurance_appeal", bill, [makeFinding()]);
  const rer = renderRerender("insurance_appeal", bill);
  snapshot("insurance_appeal.generate", gen);
  snapshot("insurance_appeal.rerender", rer);
  check("insurance_appeal PARITY (generate==rerender; ignores findings)", normalize(gen) === normalize(rer));
  check("insurance_appeal has NO $0.00 total bug", !rer.includes("estimated overcharge across these items is $0.00"));
}

// itemized_request — fixed form, no findings → parity.
{
  const gen = renderGenerate("itemized_request", bill, [makeFinding()]);
  const rer = renderRerender("itemized_request", bill);
  snapshot("itemized_request.generate", gen);
  snapshot("itemized_request.rerender", rer);
  check("itemized_request PARITY (no findings dependence)", normalize(gen) === normalize(rer));
}

// negotiation — SEPARATE product/path (generateNegotiationLetter); snapshot only so the
// refactor can't silently touch it (Correction 1: it stays out of the grounds model).
{
  const neg = generateNegotiationLetter({
    patientName: "Jordan Sample",
    providerName: "Sample Medical Center",
    serviceName: "MRI of the knee",
    serviceDate: SERVICE_DATE,
    billedAmount: 1200,
    medicareBenchmark: 400,
    communityMedian: 550,
    suggestedRate: 500,
    communityReportCount: 12,
  });
  snapshot("negotiation.generate", neg);
  check("negotiation renders a non-empty body", neg.length > 0);
}

// ── R3 step 5.4 (1c) — dismissed audit findings drop from the per-line evidence bullet when
//    dispute_grounds_v1 is ON; OFF renders them (byte-identical legacy). The skip is in
//    renderLineItemEvidence's "Candid audit flag (…)" loop, reached via the evidence section. ──
{
  const dismissLine: LineItemEvidence = {
    ...evidenceLine(makeFinding(), "li-dz"),
    auditFindings: [
      { type: "overcharge", severity: "medium", title: "DISMISSED-FLAG", description: "user marked not an issue", estimatedOvercharge: 50, benchmarkAmount: null, benchmarkSource: null, dismissed: true },
      { type: "overcharge", severity: "medium", title: "ACTIVE-FLAG", description: "", estimatedOvercharge: 50, benchmarkAmount: null, benchmarkSource: null },
    ],
  };
  const ev: DisputeEvidence = {
    claims: [{
      claimId: "claim-dz", dateOfService: SERVICE_DATE, providerName: "Sample Medical Center",
      totalBilled: 500, planYear: 2024, lineItemEvidence: [dismissLine],
      effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    } satisfies ClaimEvidence],
    totals: { claimCount: 1, lineItemCount: 1, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
  const renderDismiss = (groundsOn: boolean): string =>
    LETTER_TEMPLATES.overcharge.body({
      patientName: bill.patient.name, providerName: bill.provider.name, serviceDate: bill.serviceDate,
      findings: [], bill, planContext: null, evidence: ev, gateUnverified: GATE, v3DesignOn: V3, disputeGroundsOn: groundsOn,
    });
  const dismOff = renderDismiss(false);
  const dismOn = renderDismiss(true);
  // OFF — legacy: BOTH flags render (byte-identical; the OFF-combo this fixture also exercises with
  // the default gate/v3 left untouched is gate #9's domain, but the dismissed bullet path is proven here).
  check("1c OFF renders the dismissed audit flag (byte-identical legacy)", dismOff.includes("Candid audit flag (DISMISSED-FLAG)"), dismOff);
  check("1c OFF renders the active audit flag", dismOff.includes("Candid audit flag (ACTIVE-FLAG)"));
  // ON — the fix: dismissed skipped, active kept.
  check("1c ON SKIPS the dismissed audit flag", !dismOn.includes("Candid audit flag (DISMISSED-FLAG)"), dismOn);
  check("1c ON keeps the active (non-dismissed) audit flag", dismOn.includes("Candid audit flag (ACTIVE-FLAG)"));
}

// ── R3 step 5.4 Phase 3 (Item A) — itemized routing + collections-hold. The OFF golden variants
//    pass evidence:null, so buildRequestSection is never exercised there; these drills feed the
//    real conditions A2/A1′ need (an outstanding balance; an insurer letter with evidence) so the
//    new behavior is PROVEN, not assumed. ─────────────────────────────────────────────────────
{
  const evFrom = (lines: LineItemEvidence[]): DisputeEvidence => ({
    claims: [{
      claimId: "claim-a", dateOfService: SERVICE_DATE, providerName: "Sample Medical Center",
      totalBilled: 500, planYear: 2024, lineItemEvidence: lines,
      effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    } satisfies ClaimEvidence],
    totals: { claimCount: 1, lineItemCount: lines.length, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  });
  const HOLD = "place any collection activity for this balance on hold";
  const ITEMIZED = "Provide a fully itemized statement for this account";
  const EOB = "line-by-line adjudication";

  // A2 — provider letter + outstanding balance (patientOwes>0) → standing collections-hold present.
  const provOwes = renderGenerateON("overcharge", bill, [makeFinding()],
    evFrom([{ ...evidenceLine(makeFinding(), "li-owes"), patientOwes: 120 }]));
  check("A2 provider + owes>0 renders the collections-hold", provOwes.includes(HOLD), provOwes);
  check("A2 collections-hold establishes disputed status", provOwes.includes("I dispute these charges"));
  // A2 — provider letter, balance already paid (owes==0) → NO collections-hold.
  const provPaid = renderGenerateON("overcharge", bill, [makeFinding()],
    evFrom([{ ...evidenceLine(makeFinding(), "li-paid"), patientOwes: 0, patientPaid: 100 }]));
  check("A2 provider + owes==0 OMITS the collections-hold", !provPaid.includes(HOLD));
  // A1 — provider letter always requests the itemized statement.
  check("A1 provider requests the itemized statement", provOwes.includes(ITEMIZED));
  // A1′ — insurer recipient → EOB/adjudication ask, NOT an itemized statement, no collections-hold.
  // Tests buildRequestSection directly: insurance_appeal's full body needs an effectiveTotals.provenance
  // orthogonal to the tail routing under test; the insurer wiring is the call site at templates.ts ~1397.
  const insReq = buildRequestSection({
    evidence: evFrom([evidenceLine(makeFinding(), "li-ins")]), planContext: null,
    recipient: "insurer", demandsEnabled: true,
  });
  check("A1′ insurer asks for the EOB / line-by-line adjudication", insReq.includes(EOB), insReq);
  check("A1′ insurer does NOT request an itemized statement (provider artifact)", !insReq.includes(ITEMIZED));
  check("A1′ insurer does NOT render the collections-hold", !insReq.includes(HOLD));

  // ── dispute-letters v2 S1 — ERISA claim-file gate. plan_source='employer' unlocks the
  //    §2560.503-1(h)(2)(iii) claim-file ask on the LIVE (v3) insurer relief section; any other/
  //    unknown source → generic (no ERISA statute). Tested directly on buildRequestSection (mirrors
  //    A1′) to sidestep the full body's effectiveTotals.provenance requirement, orthogonal here. ──
  const CLAIMFILE = "29 CFR §2560.503-1(h)(2)(iii)";
  const APPEAL_DATE_ASK = "confirm in writing the date this appeal was received";
  const insReqErisa = buildRequestSection({
    evidence: evFrom([evidenceLine(makeFinding(), "li-erisa")]),
    planContext: { planSource: "employer" } as unknown as PlanContext,
    recipient: "insurer", demandsEnabled: true,
  });
  snapshot("insurer_request.generic", insReq);     // non-employer (A1′ planContext:null) → no ERISA cite
  snapshot("insurer_request.erisa", insReqErisa);   // employer → claim-file cite present
  check("ERISA employer insurer request includes the §2560.503-1(h)(2)(iii) claim-file ask", insReqErisa.includes(CLAIMFILE), insReqErisa);
  check("ERISA employer request asks the plan to confirm the appeal-received date", insReqErisa.includes(APPEAL_DATE_ASK));
  check("non-employer insurer request OMITS the ERISA claim-file cite", !insReq.includes(CLAIMFILE));

  // A.2 — duplicate_charge now routes through buildRequestSection → carries the itemized ask + (owes>0) the hold.
  const dupReq = renderGenerateON("duplicate_charge", bill,
    [makeFinding({ type: "duplicate", title: "Duplicate charge", estimatedOvercharge: 120, billedAmount: 120 })],
    evFrom([{ ...evidenceLine(makeFinding(), "li-dup"), patientOwes: 120 }]));
  check("A.2 duplicate_charge routes through buildRequestSection (itemized ask present)", dupReq.includes(ITEMIZED), dupReq);
  check("A.2 duplicate_charge carries the collections-hold (owes>0)", dupReq.includes(HOLD));
}

// ── dispute-letters v2 S2 — the 3 new escalation/collections templates. Rendered with gate inputs
//    present (recital / denial date / in-window §1692g); debt_validation ALSO out-of-window to prove
//    the fail-closed 30-day gate (teeth omitted, §1692e(8) disputed-status still fires). ──────────
{
  const finalNotice = LETTER_TEMPLATES.final_notice.body({
    patientName: bill.patient.name, providerName: bill.provider.name, serviceDate: bill.serviceDate,
    accountNumber: "ACCT-1", findings: [makeFinding()], bill, planContext: null,
    priorContactDates: ["January 10, 2024", "February 2, 2024"], certifiedMail: true,
  });
  snapshot("final_notice.generate", finalNotice);
  check("final_notice → provider Compliance Department", finalNotice.includes("Compliance Department"), finalNotice);
  check("final_notice recital renders attested prior dates", finalNotice.includes("January 10, 2024"));
  check("final_notice certified-mail notation (opt-in)", finalNotice.includes("certified mail"));
  check("final_notice 15 business days + will-be-noted", finalNotice.includes("15 business days") && finalNotice.includes("will be noted in those complaints"));
  check("final_notice collections-hold protection", finalNotice.includes("do not refer this account to collections"));

  const externalReview = LETTER_TEMPLATES.external_review.body({
    patientName: bill.patient.name, providerName: bill.provider.name, serviceDate: bill.serviceDate,
    accountNumber: "CLM-9", findings: [], bill, planContext: null,
    appealExhausted: { attested: true, denialDate: "2024-04-01" },
  });
  snapshot("external_review.generate", externalReview);
  check("external_review → insurer Appeals Department", externalReview.includes("Appeals Department"), externalReview);
  check("external_review cites ACA §2719 / 45 CFR §147.136", externalReview.includes("ACA §2719 / 45 CFR §147.136"));
  check("external_review lists enclosures", externalReview.includes("Enclosed with this request:"));
  check("external_review renders attested denial date", externalReview.includes("April 1, 2024"));

  const collector = { name: "ABC Collections LLC", address: "1 Debt Way\nCollectionville, TX 70000", originalCreditor: "Sample Medical Center" };
  const debtInWindow = LETTER_TEMPLATES.debt_validation.body({
    patientName: bill.patient.name, providerName: bill.provider.name, serviceDate: bill.serviceDate,
    accountNumber: "COLL-1", findings: [], bill, planContext: null, collector, debtWithinWindow: true,
  });
  snapshot("debt_validation.in_window", debtInWindow);
  check("debt_validation → the collector (user-supplied)", debtInWindow.includes("ABC Collections LLC"), debtInWindow);
  check("debt_validation not-an-acknowledgment line", debtInWindow.includes("not an acknowledgment that I owe this debt"));
  check("debt_validation §1692e(8) disputed-status (always)", debtInWindow.includes("§1692e(8)"));
  check("debt_validation in-window renders §1692g teeth + cease", debtInWindow.includes("§1692g") && debtInWindow.includes("cease collection activity"));

  const debtOutWindow = LETTER_TEMPLATES.debt_validation.body({
    patientName: bill.patient.name, providerName: bill.provider.name, serviceDate: bill.serviceDate,
    accountNumber: "COLL-1", findings: [], bill, planContext: null, collector, debtWithinWindow: false,
  });
  snapshot("debt_validation.out_window", debtOutWindow);
  check("debt_validation OUT-of-window still marks disputed (§1692e(8))", debtOutWindow.includes("§1692e(8)"));
  check("debt_validation OUT-of-window OMITS §1692g teeth (fail-closed)", !debtOutWindow.includes("§1692g"));
  check("debt_validation OUT-of-window OMITS cease-collection", !debtOutWindow.includes("cease collection activity"));
}

// ── dispute-letters v2 S3 — fallback-first EOB arithmetic gate. A line whose EOB
//    figures reconcile (insurer-paid + patient-owes ≤ billed) renders the "EOB shows"
//    numbers; a line that VIOLATES reconciliation (sum > billed, or a negative) omits
//    them (almost always our parse error, not the insurer's — insurer EOBs reconcile
//    by construction). Partial data (one field) is unaffected. ─────────────────────
{
  const eobEvidence = (over: Partial<LineItemEvidence>): DisputeEvidence => ({
    claims: [{
      claimId: "claim-eob", dateOfService: SERVICE_DATE, providerName: "Sample Medical Center",
      totalBilled: 500, planYear: 2024,
      lineItemEvidence: [{ ...evidenceLine(makeFinding(), "li-eob"), billedAmount: 500, ...over }],
      effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    } satisfies ClaimEvidence],
    totals: { claimCount: 1, lineItemCount: 1, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  });
  const sane = renderGenerateON("overcharge", bill, [makeFinding()], eobEvidence({ insurancePaid: 300, patientOwes: 100 }));
  const insaneSum = renderGenerateON("overcharge", bill, [makeFinding()], eobEvidence({ insurancePaid: 300, patientOwes: 400 }));
  const insaneNeg = renderGenerateON("overcharge", bill, [makeFinding()], eobEvidence({ insurancePaid: -50, patientOwes: 100 }));
  check("EOB gate — reconciling line renders the numbers",
    sane.includes("EOB shows: $500.00 billed · $300.00 insurance paid · $100.00 patient responsibility."), sane);
  check("EOB gate — non-reconciling (P+O > billed) OMITS the EOB numbers", !insaneSum.includes("EOB shows:"), insaneSum);
  check("EOB gate — negative figure OMITS the EOB numbers", !insaneNeg.includes("EOB shows:"), insaneNeg);

  // ── S295 — the denial-framing gate. insurance_appeal opened by ASSERTING a
  //    denial on every claim, including a bill with no insurer figures anywhere
  //    in evidence — i.e. no adverse determination to appeal. Assert the
  //    CONSUMER (the rendered opener), not the predicate.
  const withEob = renderGenerateON(
    "insurance_appeal", bill, [makeFinding()],
    eobEvidence({ insurancePaid: 0, patientOwes: 500 }),
  );
  const noEob = renderGenerateON(
    "insurance_appeal", bill, [makeFinding()],
    eobEvidence({ insurancePaid: null, patientOwes: null }),
  );
  check("denial framing — insurer figures present → appeals the denial",
    withEob.includes("I am writing to formally appeal the denial of my claim"), withEob);
  check("denial framing — no insurer figures → disputes the PROCESSING, asserts no denial",
    noEob.includes("I am writing to formally dispute how my claim") &&
      !noEob.includes("appeal the denial of my claim"), noEob);

  // The Re: header and the subject line are read BEFORE the opener, so they
  // have to agree with it — all three off the one `hasAdjudicationEvidence` signal.
  check("denial framing — Re: header asserts the determination only with evidence",
    withEob.includes("Re: Appeal of Adverse Benefit Determination"), withEob);
  check("denial framing — Re: header withdraws the assertion without evidence",
    noEob.includes("Re: Claim Processing Dispute — Request for Review") &&
      !noEob.includes("Adverse Benefit Determination"), noEob);

  const subjectWith = LETTER_TEMPLATES.insurance_appeal.subject(
    "Sample Medical Center", eobEvidence({ insurancePaid: 0, patientOwes: 500 }));
  const subjectWithout = LETTER_TEMPLATES.insurance_appeal.subject(
    "Sample Medical Center", eobEvidence({ insurancePaid: null, patientOwes: null }));
  check("denial framing — subject asserts the denial only with evidence",
    subjectWith === "Appeal of Claim Denial — Sample Medical Center", subjectWith);
  check("denial framing — subject withdraws the assertion without evidence",
    subjectWithout === "Claim Processing Dispute — Request for Review — Sample Medical Center",
    subjectWithout);
  check("denial framing — a template that ignores the evidence arg is unchanged",
    LETTER_TEMPLATES.overcharge.subject("Sample Medical Center", null) ===
      LETTER_TEMPLATES.overcharge.subject("Sample Medical Center"),
    "overcharge subject must not vary on the additive arg");

  // balance_billing — the one unevidenced assertion outside insurance_appeal:
  // it recited having REVIEWED AN EOB and an insurance payment having been made,
  // neither of which a letter drafted from a provider bill alone can support.
  const bbWith = renderGenerateON(
    "balance_billing", bill, [makeFinding()],
    eobEvidence({ insurancePaid: 300, patientOwes: 100 }),
  );
  const bbWithout = renderGenerateON(
    "balance_billing", bill, [makeFinding()],
    eobEvidence({ insurancePaid: null, patientOwes: null }),
  );
  check("balance billing — EOB present → recites the EOB review unchanged",
    bbWith.includes("After reviewing my Explanation of Benefits and your bill"), bbWith);
  check("balance billing — no EOB → claims no EOB review and no insurance payment",
    bbWithout.includes("Reviewing your bill, I have identified charges that may exceed") &&
      !bbWithout.includes("Explanation of Benefits") &&
      !bbWithout.includes("minus my insurance payment"), bbWithout);
  check("balance billing — the NSA ask survives in both (it is already conditional voice)",
    bbWith.includes("subject to the No Surprises Act") &&
      bbWithout.includes("subject to the No Surprises Act"), bbWithout);
}

// ── Report (house style) ─────────────────────────────────────────────────────
if (captured.length) console.log(`Captured ${captured.length} new golden(s): ${captured.join(", ")}`);
console.log(`\ndispute-grounds golden corpus: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

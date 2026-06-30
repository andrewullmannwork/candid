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
    description: "The billed amount exceeds the Medicare national average for this service.",
    estimatedOvercharge: 230,
    benchmarkSource: "CMS PPL",
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
  { type: "balance_billing", findings: [makeFinding({ type: "balance_billing", title: "Balance billed above allowed amount", estimatedOvercharge: 150, billedAmount: 400 })] },
  { type: "duplicate_charge", findings: [makeFinding({ type: "duplicate", title: "Duplicate charge for the same service", estimatedOvercharge: 120, billedAmount: 120 })] },
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

  // A.2 — duplicate_charge now routes through buildRequestSection → carries the itemized ask + (owes>0) the hold.
  const dupReq = renderGenerateON("duplicate_charge", bill,
    [makeFinding({ type: "duplicate", title: "Duplicate charge", estimatedOvercharge: 120, billedAmount: 120 })],
    evFrom([{ ...evidenceLine(makeFinding(), "li-dup"), patientOwes: 120 }]));
  check("A.2 duplicate_charge routes through buildRequestSection (itemized ask present)", dupReq.includes(ITEMIZED), dupReq);
  check("A.2 duplicate_charge carries the collections-hold (owes>0)", dupReq.includes(HOLD));
}

// ── Report (house style) ─────────────────────────────────────────────────────
if (captured.length) console.log(`Captured ${captured.length} new golden(s): ${captured.join(", ")}`);
console.log(`\ndispute-grounds golden corpus: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");

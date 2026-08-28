/**
 * _compose-harness — shared builders for the S326 member-composition fixture
 * family (member-composition / citation-party-split / conspicuous-statement).
 * Not a CI step itself; imported by the three fixtures. Mirrors the golden
 * corpus's evidence-literal pattern (post-resolver state built by hand) with a
 * `compositionScope` knob, so the compose layer's scoped behavior is testable
 * without a database.
 */
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
  MemberSelection,
} from "../../../../src/lib/disputes/evidence-resolver";
import type { AuditReport, AuditFinding, ParsedBill, DisputeLetterType } from "../../../../src/lib/billing/types";
import { generateDisputeLetter } from "../../../../src/lib/disputes";

export const SERVICE_DATE = "2026-03-11";

export function mkFinding(
  type: AuditFinding["type"],
  over = 110,
  billed = 240,
): AuditFinding {
  return {
    id: `f-${type}`,
    type,
    severity: "medium",
    title: `finding ${type}`,
    description: `detail for ${type}`,
    estimatedOvercharge: over,
    billedAmount: billed,
    benchmarkAmount: 130,
    benchmarkSource: "cms_ppl",
    lineItems: [1],
    actionable: true,
  } as unknown as AuditFinding;
}

export function mkLine(
  findings: AuditFinding[],
  lineItemId = "li-1",
  extra: Partial<LineItemEvidence> = {},
): LineItemEvidence {
  return {
    lineItemId,
    billingCode: { value: "99213", type: "CPT" },
    serviceSlug: "office_visit",
    serviceName: "Office visit",
    billedAmount: 240,
    insurancePaid: null,
    patientOwes: 240,
    patientPaid: null,
    planBenefit: null,
    expectedPatientCost: null,
    actualPatientCost: 240,
    discrepancyAmount: null,
    discrepancyReason: null,
    communityOutcome: null,
    siblingCodes: null,
    pricingBenchmark: null,
    auditFindings: findings.map((f) => ({
      type: f.type,
      severity: f.severity,
      title: f.title,
      description: f.description,
      estimatedOvercharge: f.estimatedOvercharge,
      benchmarkAmount: f.benchmarkAmount ?? null,
      benchmarkSource: f.benchmarkSource ?? null,
    })),
    auditRan: true,
    peerCodes: null,
    disputeType: "other",
    citeGradeTier: "header",
    dollarAtStake: findings.reduce((s, f) => s + f.estimatedOvercharge, 0),
    serviceNotRenderedAttested: false,
    secondaryCoverageVerify: null,
    ...extra,
  } as LineItemEvidence;
}

export function mkEvidence(
  lines: LineItemEvidence[],
  compositionScope: MemberSelection | null,
): DisputeEvidence {
  const claim = {
    claimId: "claim-1",
    dateOfService: SERVICE_DATE,
    providerName: "Sample Medical Center",
    totalBilled: 500,
    planYear: 2026,
    lineItemEvidence: lines,
    effectiveTotals: {
      patientPaid: 0,
      insurancePaid: 0,
      insuranceAdjusted: 0,
      patientResponsibility: 500,
      provenance: {
        patientPaidSource: "line_sum",
        insurancePaidSource: "line_sum",
        insuranceAdjustedSource: "line_sum",
        patientResponsibilitySource: "line_sum",
      },
    } as unknown as ClaimEvidence["effectiveTotals"],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } satisfies ClaimEvidence;
  return {
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: lines.length, totalBilled: 500, totalDiscrepancy: 0 },
    planEvidence: null,
    networkEvidence: null,
    communityEvidence: null,
    legalBasis: [],
    gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
    compositionScope,
  };
}

export function mkBill(): ParsedBill {
  return {
    provider: { name: "Sample Medical Center", address: "1 Main St" },
    patient: { name: "Pat Example" },
    serviceDate: SERVICE_DATE,
    lineItems: [
      {
        lineNumber: 1,
        description: "Office visit",
        procedureCode: "99213",
        billedAmount: 240,
      },
    ],
    totals: { totalBilled: 500 },
  } as unknown as ParsedBill;
}

export function mkReport(findings: AuditFinding[]): AuditReport {
  return {
    id: "claim-1",
    documentId: "doc-1",
    userId: "user-1",
    parsedBill: mkBill(),
    findings,
    summary: {
      totalFindings: findings.length,
      totalEstimatedOvercharge: findings.reduce((s, f) => s + f.estimatedOvercharge, 0),
      highSeverityCount: 0,
      actionableCount: findings.length,
    },
    createdAt: new Date().toISOString(),
  } as unknown as AuditReport;
}

/** Compose one letter through the REAL composer (footer + scope + everything). */
export function composeLetter(
  letterType: DisputeLetterType,
  findings: AuditFinding[],
  evidence: DisputeEvidence | null,
  opts: { collector?: { name: string; address?: string | null; originalCreditor?: string | null }; debtWithinWindow?: boolean; appealExhausted?: { attested: boolean; denialDate?: string | null } } = {},
): string {
  const report = mkReport(findings);
  const letter = generateDisputeLetter(report, findings.map((f) => f.id), letterType, {
    evidence,
    planContext: null,
    enforceDataTrustGate: true, // v3 ON — the live path
    disputeGroundsOn: true,
    ...opts,
  });
  if (!letter) throw new Error(`composer returned null for ${letterType}`);
  return letter.body;
}

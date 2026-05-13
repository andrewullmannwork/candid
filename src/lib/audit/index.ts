// Audit engine — orchestrates bill parsing, benchmark lookup, and rule evaluation

import type { AuditReport, ParsedBill, AuditFinding } from "../billing/types";
import { lookupCMSRatesBatch } from "../cms/ppl";
import { ALL_RULES } from "./rules";
import { runZeroCostShareCheck } from "./zero-cost-share";
import { runClaimHeaderArithmeticCheck } from "./claim-header-arithmetic";
import { runInsuranceUnderpaymentCheck } from "./insurance-underpayment";
import type { PlanCoverageMap } from "./coverage-loader";
import { randomUUID } from "crypto";

/**
 * Thread plan-coverage into runAudit so rules can compute should_owe (copay /
 * coinsurance) and emit user-facing recovery numbers instead of contractual
 * adjustments. Callers (process-chunk first-audit, reaudit.ts view-fetch,
 * admin re-classify, dispute rerun) load via `loadCoverageMapForPlan` and
 * pass through. `null` is allowed — rules treat as "coverage unknown" and
 * default should_owe to 0.
 */
export async function runAudit(
  bill: ParsedBill,
  planCoverage: PlanCoverageMap | null = null,
): Promise<AuditReport> {
  // Step 1: Look up CMS benchmarks for all procedure codes in the bill
  const codes = bill.lineItems.map((item) => ({
    code: item.procedureCode,
    modifier: item.modifier,
  }));

  const benchmarks = await lookupCMSRatesBatch(codes);

  // Step 2: Run all audit rules
  const allFindings: AuditFinding[] = [];

  for (const rule of ALL_RULES) {
    const findings = rule(bill, benchmarks, planCoverage);
    allFindings.push(...findings);
  }

  // Step 2b: S74.5 D13 — Zero-cost-share registry check (ACA preventive + ACIP
  // vaccine). Runs BEFORE plan-coverage check semantically; fires only when
  // s74_5_categorization_flywheel_v1 flag is ON.
  const zeroCostFindings = await runZeroCostShareCheck(bill);
  allFindings.push(...zeroCostFindings);

  // Step 2c: S74.5 D15 — Claim-header arithmetic check. Catches unallocated
  // balance between header total and itemized lines. Gated on same flag.
  const headerFindings = await runClaimHeaderArithmeticCheck(bill);
  allFindings.push(...headerFindings);

  // Step 2d: F-14 — Insurance under-payment check. Fires when the insurer
  // paid $0 (or near-$0) on a service the plan covers, AND the patient is
  // carrying the burden. Catches Andrew's Bill 1 pattern (Nicole paid $292.41
  // OOP on a covered service the insurer never processed). Recovery target
  // is the user-recovery delta (patient_responsibility − should_owe), not the
  // contractual writeoff. Address dispute to the INSURER, not the provider.
  const underpayFindings = runInsuranceUnderpaymentCheck(bill, planCoverage);
  allFindings.push(...underpayFindings);

  // Step 3: Deduplicate findings that flag the same line items
  const deduped = deduplicateFindings(allFindings);

  // Step 4: Sort by severity (critical first) then by estimated overcharge
  deduped.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.estimatedOvercharge - a.estimatedOvercharge;
  });

  // S74.5c §1.7 — partition findings into line-level and claim-level. The
  // reaudit + persist write loops key per-line findings by lineNumber; findings
  // with lineItems=[] (claim-header findings like D15 unallocated_balance)
  // would be silently dropped. Persist them on claim.metadata.auditSummary
  // so ClaimDetail renders them in a dedicated "Claim-level issues" section
  // and the dismiss endpoint can target them via a claim-level fallback path.
  const claimLevelFindings = deduped
    .filter((f) => !Array.isArray(f.lineItems) || f.lineItems.length === 0)
    .map((f) => ({
      id: f.id,
      type: f.type,
      severity: f.severity,
      estimatedOvercharge: f.estimatedOvercharge,
      title: f.title,
      description: f.description,
      benchmarkSource: f.benchmarkSource,
      actionable: f.actionable,
    }));

  // Step 5: Build report
  return {
    id: randomUUID(),
    documentId: bill.documentId,
    userId: bill.userId,
    parsedBill: bill,
    findings: deduped,
    summary: {
      totalFindings: deduped.length,
      totalEstimatedOvercharge: deduped.reduce(
        (sum, f) => sum + f.estimatedOvercharge,
        0
      ),
      highSeverityCount: deduped.filter(
        (f) => f.severity === "high" || f.severity === "critical"
      ).length,
      actionableCount: deduped.filter((f) => f.actionable).length,
      claimLevelFindings,
    },
    createdAt: new Date().toISOString(),
  };
}

function deduplicateFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Map<string, AuditFinding>();

  for (const finding of findings) {
    // Key on type + sorted line items
    const key = `${finding.type}-${finding.lineItems.sort().join(",")}`;

    if (!seen.has(key)) {
      seen.set(key, finding);
    } else {
      // Keep the one with higher estimated overcharge
      const existing = seen.get(key)!;
      if (finding.estimatedOvercharge > existing.estimatedOvercharge) {
        seen.set(key, finding);
      }
    }
  }

  return Array.from(seen.values());
}

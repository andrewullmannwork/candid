// Audit engine — orchestrates bill parsing, benchmark lookup, and rule evaluation

import type { AuditReport, ParsedBill, AuditFinding } from "../billing/types";
import { lookupCMSRatesBatch } from "../cms/ppl";
import { ALL_RULES } from "./rules";
import { runZeroCostShareCheck } from "./zero-cost-share";
import { runClaimHeaderArithmeticCheck } from "./claim-header-arithmetic";
import { runInsuranceUnderpaymentCheck } from "./insurance-underpayment";
import { runDescriptionMatchCheck } from "./description-service-match";
import type { PlanCoverageMap } from "./coverage-loader";
import { createServerClient } from "../supabase/server";
import {
  loadAccuracyCohortMap,
  decideAccuracyAdjustment,
  applyAccuracyAdjustment,
  mapKey,
  type CohortStats,
} from "./accuracy-cohort-loader";
import { randomUUID } from "crypto";

/**
 * S74.6 D3 — Optional audit context. When `insurerName` is provided, runAudit
 * batch-reads `audit_rule_accuracy` for each emitted finding's cohort and applies
 * tiered confidence adjustment (boost / informational / suppress) per Subplan §B.
 * When omitted (legacy callers / documents/process single-pass), findings emit
 * at baseline confidence with no adjustment.
 */
export interface AuditContext {
  insurerName?: string | null;
}

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
  auditContext: AuditContext | null = null,
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

  // Step 2e: S74.6 D4 — Description → service_catalog Haiku similarity match.
  // For uncategorized lines (no slug yet), fires either
  // `code_uncategorized_description_match` (confident provisional slug ≥0.85)
  // or `uncategorized_service` (soft "review or correct"). Gated on
  // s74_5_categorization_flywheel_v1 flag. Per-user-day budget cap inherited
  // from S74.5 (haiku_budget_tracking + reserve_haiku_budget RPC).
  const descMatchFindings = await runDescriptionMatchCheck(bill);
  allFindings.push(...descMatchFindings);

  // Step 3: Deduplicate findings that flag the same line items
  const deduped = deduplicateFindings(allFindings);

  // Step 3b: S74.6 D3 — apply tiered cohort accuracy adjustment. Batch-load
  // (rule_type, insurer_name, service_slug) cohorts once, then per-finding
  // boost / chip / suppress / leave-alone per Subplan §B. Suppressed findings
  // drop entirely; informational tier surfaces with a UI chip. Empty cohorts
  // emit at baseline (no regression). Only runs when auditContext.insurerName
  // is provided — legacy callers (documents/process single-pass) emit unadjusted.
  const adjustedFindings = await applyCohortAccuracyAdjustments(
    deduped,
    bill,
    auditContext,
  );

  // Step 4: Sort by severity (critical first) then by estimated overcharge
  adjustedFindings.sort((a, b) => {
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
  const claimLevelFindings = adjustedFindings
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
    findings: adjustedFindings,
    summary: {
      totalFindings: adjustedFindings.length,
      totalEstimatedOvercharge: adjustedFindings.reduce(
        (sum, f) => sum + f.estimatedOvercharge,
        0
      ),
      highSeverityCount: adjustedFindings.filter(
        (f) => f.severity === "high" || f.severity === "critical"
      ).length,
      actionableCount: adjustedFindings.filter((f) => f.actionable).length,
      claimLevelFindings,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * S74.6 D3 — Apply cohort accuracy adjustments per finding. Findings without a
 * cohort lookup (no auditContext.insurerName OR claim-level findings without
 * service_slug context) pass through unchanged. Returns the filtered + adjusted
 * findings array; suppressed findings are dropped entirely.
 */
async function applyCohortAccuracyAdjustments(
  findings: AuditFinding[],
  bill: ParsedBill,
  context: AuditContext | null,
): Promise<AuditFinding[]> {
  if (!context?.insurerName || findings.length === 0) return findings;

  // Build per-finding cohort key: (ruleType, insurerName). v1 collapses
  // service_slug across (rule, insurer) since slug-mapping runs post-audit;
  // Phase 2 can refine to per-slug once service-mapper moves upstream.
  type FindingWithKey = { finding: AuditFinding; cohortKey: string | null };
  const annotated: FindingWithKey[] = findings.map((f) => ({
    finding: f,
    cohortKey: mapKey(f.type, context.insurerName!),
  }));

  const tuples = annotated
    .map((a) => {
      if (!a.cohortKey) return null;
      return {
        ruleType: a.finding.type,
        insurerName: context.insurerName!,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (tuples.length === 0) return findings;

  const supabase = createServerClient();
  let cohortMap: Map<string, CohortStats>;
  try {
    cohortMap = await loadAccuracyCohortMap(supabase, tuples);
  } catch (err) {
    console.warn("[audit] accuracy cohort load failed, emitting unadjusted", err);
    return findings;
  }

  const result: AuditFinding[] = [];
  for (const { finding, cohortKey } of annotated) {
    if (!cohortKey) {
      result.push(finding);
      continue;
    }
    const cohort = cohortMap.get(cohortKey);
    const decision = decideAccuracyAdjustment(finding.confidence, cohort);
    const adjusted = applyAccuracyAdjustment(finding, decision);
    if (adjusted) result.push(adjusted);
  }
  return result;
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

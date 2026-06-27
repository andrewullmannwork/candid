// Audit engine — orchestrates bill parsing, benchmark lookup, and rule evaluation

import type { AuditReport, ParsedBill, AuditFinding } from "../billing/types";
import { lookupCMSRatesBatch } from "../cms/ppl";
import { DETECTOR_REGISTRY } from "./detector-registry";
import { isFeatureEnabled } from "../config/product-flags";
import type { AcaFallbackLineCoverageMap, PlanCoverageMap } from "./coverage-loader";
import { createServerClient } from "../supabase/server";
import {
  loadAccuracyCohortMap,
  decideAccuracyAdjustment,
  applyAccuracyAdjustment,
  lookupCohort,
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
 *
 * S74.6 D2 §B — `acaFallback` is the audit-side ACA-mandated zero-cost-share
 * fallback indexed by line number, loaded via `loadAcaFallbackForAudit`. Rules
 * prefer `acaFallback.get(lineNumber)` over `planCoverage.get(slug)` when both
 * are present, so ACA-mandated vaccine + preventive lines see should_owe=0
 * even when categorization hasn't bound a slug. Callers MUST merge the ACA
 * fallback's bySlug map into `planCoverage` themselves (the merge belongs to
 * the caller because plan rows win on key conflict — see Subplan §B.2).
 */
export async function runAudit(
  bill: ParsedBill,
  planCoverage: PlanCoverageMap | null = null,
  auditContext: AuditContext | null = null,
  acaFallback: AcaFallbackLineCoverageMap | null = null,
): Promise<AuditReport> {
  // Step 1: Look up CMS benchmarks for all procedure codes in the bill
  const codes = bill.lineItems.map((item) => ({
    code: item.procedureCode,
    modifier: item.modifier,
  }));

  const benchmarks = await lookupCMSRatesBatch(codes);

  // Step 2: Run the detector pipeline — the ORDERED registry unifying the former sync ALL_RULES
  // loop + the hand-wired async checks (detector-registry.ts). Each detector sees the findings
  // accumulated by EARLIER detectors via `priorFindings`, so cross-detector ordering deps are
  // first-class: insurance_underpayment (F-14) skips lines zero_cost_share (D13) already fired on
  // (== the old hand-built d13FiredLineNumbers Set). Order + the dep are asserted at module load.
  const allFindings: AuditFinding[] = [];
  for (const detector of DETECTOR_REGISTRY) {
    const findings = await detector.run({
      bill,
      benchmarks,
      planCoverage,
      acaFallback,
      priorFindings: allFindings,
    });
    allFindings.push(...findings);
  }

  // S94 B4 Fix #4 — NaN guard. Drop findings whose displayed dollar
  // values are non-finite (NaN / Infinity). Pre-fix, NaN could leak in
  // from claim-header-arithmetic.ts (unallocated calc when source values
  // were undefined-coerced-to-number) or rules.ts checkDuplicates /
  // checkMissingAdjustments paths. NaN findings render "$NaN" in copy and
  // mark themselves actionable=true.
  const nanGuardEnabled = await isFeatureEnabled("bill_parser_nan_guard");
  const finiteFindings = nanGuardEnabled
    ? allFindings.filter((f) => {
        const ok = Number.isFinite(f.estimatedOvercharge) && Number.isFinite(f.billedAmount);
        if (!ok) {
          console.warn(
            `[audit] Dropped non-finite finding: type=${f.type} title="${f.title}" overcharge=${f.estimatedOvercharge} billed=${f.billedAmount}`
          );
        }
        return ok;
      })
    : allFindings;

  // Step 3: Deduplicate findings that flag the same line items
  const deduped = deduplicateFindings(finiteFindings);

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
 * §C.1 — resolve the service slug a finding pertains to. D4 description-match
 * findings carry the provisional slug in `descriptionMatch.provisionalSlug`;
 * other rules emit findings flagging specific line numbers — for those we look
 * up the pre-flight-resolved slug from the bill's lineItems. Claim-level
 * findings (lineItems=[]) return null and fall through to the slug-less rollup.
 *
 * Multi-line findings: use the FIRST line's slug. Mixed-slug multi-line findings
 * are an edge case; v1 treats them as cohort-keyed by the first match.
 */
function resolveSlugForFinding(
  finding: AuditFinding,
  lineSlugIndex: Map<number, string | null>,
): string | null {
  if (finding.descriptionMatch?.provisionalSlug) {
    return finding.descriptionMatch.provisionalSlug;
  }
  if (!Array.isArray(finding.lineItems) || finding.lineItems.length === 0) {
    return null;
  }
  return lineSlugIndex.get(finding.lineItems[0]) ?? null;
}

/**
 * S74.6 §C.1 D3 — Apply cohort accuracy adjustments per finding. Cohort key is
 * `(rule_type, insurer_name, service_slug)`; slug comes from the pre-flight
 * resolution attached to bill.lineItems[i].serviceSlug. Findings without slug
 * context fall back to the slug-less rollup (preserves S87 behavior for
 * claim-level findings + lines pre-flight couldn't resolve). Returns the
 * filtered + adjusted findings array; suppressed findings are dropped entirely.
 */
async function applyCohortAccuracyAdjustments(
  findings: AuditFinding[],
  bill: ParsedBill,
  context: AuditContext | null,
): Promise<AuditFinding[]> {
  if (!context?.insurerName || findings.length === 0) return findings;

  // Build lineNumber → slug index from the bill's pre-flight-resolved slugs.
  // Empty index when pre-flight didn't run upstream (legacy caller path).
  const lineSlugIndex = new Map<number, string | null>();
  for (const li of bill.lineItems) {
    lineSlugIndex.set(li.lineNumber, li.serviceSlug ?? null);
  }

  type FindingWithSlug = { finding: AuditFinding; slug: string | null };
  const annotated: FindingWithSlug[] = findings.map((f) => ({
    finding: f,
    slug: resolveSlugForFinding(f, lineSlugIndex),
  }));

  const insurerName = context.insurerName;
  const tuples = annotated.map((a) => ({
    ruleType: a.finding.type,
    insurerName,
    serviceSlug: a.slug,
  }));

  let cohortMap: Awaited<ReturnType<typeof loadAccuracyCohortMap>>;
  try {
    const supabase = createServerClient();
    cohortMap = await loadAccuracyCohortMap(supabase, tuples);
  } catch (err) {
    console.warn("[audit] accuracy cohort load failed, emitting unadjusted", err);
    return findings;
  }

  const result: AuditFinding[] = [];
  for (const { finding, slug } of annotated) {
    const cohort = lookupCohort(cohortMap, finding.type, insurerName, slug);
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

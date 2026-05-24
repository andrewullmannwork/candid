// Audit rules engine — checks parsed bills for common billing errors
// Each rule is a pure function: (ParsedBill, benchmarks, planCoverage) → AuditFinding[]

import type {
  ParsedBill,
  BillLineItem,
  AuditFinding,
  CMSPPLRate,
} from "../billing/types";
import type { AcaFallbackLineCoverageMap, PlanCoverageMap } from "./coverage-loader";
import type { PlanCoverageInput } from "../claims/recovery-math";
import { computeShouldOwe } from "../claims/recovery-math";
import { randomUUID } from "crypto";

type AuditRule = (
  bill: ParsedBill,
  benchmarks: Map<string, CMSPPLRate>,
  planCoverage: PlanCoverageMap | null,
  acaFallback: AcaFallbackLineCoverageMap | null,
) => AuditFinding[];

/**
 * Resolve the most specific coverage entry for a line.
 *
 * S74.6 D2 §B — ACA-mandated zero-cost-share fallback (`acaFallback` keyed by
 * line number) takes precedence over plan-slug coverage because ACA preventive
 * lines are universally $0 by federal law even when plan_covered_services has
 * no row (slug never bound) or has a stale row. Plan-slug lookup is the
 * fallback when ACA fallback is absent for this line.
 */
function resolveCoverageForLine(
  item: BillLineItem,
  planCoverage: PlanCoverageMap | null,
  acaFallback: AcaFallbackLineCoverageMap | null,
  serviceSlug: string | null,
): PlanCoverageInput | null {
  if (acaFallback) {
    const lineCov = acaFallback.get(item.lineNumber);
    if (lineCov) return lineCov;
  }
  if (planCoverage && serviceSlug) {
    const slugCov = planCoverage.get(serviceSlug);
    if (slugCov) return slugCov;
  }
  return null;
}

/**
 * Per-line plan-defined cost share — defaults to 0 when planCoverage is null
 * or the line has no service_slug yet (categorization flywheel hasn't mapped it).
 * Mirrors `computeShouldOwe` from recovery-math but resolves via slug lookup.
 *
 * NOTE: BillLineItem.category is NOT a service_slug — it's a plain-English
 * label. We can't infer slug here without the categorization flywheel. For
 * rules that need should_owe per line, the safest fallback when slug is
 * unknown is to use the claim-level coverage if exactly one applies, OR 0.
 */
function shouldOweForLine(
  item: BillLineItem,
  planCoverage: PlanCoverageMap | null,
  acaFallback: AcaFallbackLineCoverageMap | null,
  serviceSlug: string | null,
): number {
  const cov = resolveCoverageForLine(item, planCoverage, acaFallback, serviceSlug);
  if (!cov) return 0;
  return computeShouldOwe({
    billed: item.billedAmount,
    // S120 — apply coinsurance/copay to adjusted (post-writeoff), not gross.
    insuranceAdjusted: item.ins_adjusted ?? 0,
    planCoverage: cov,
  });
}

// ============================================================================
// RULE 1: Overcharge Detection (vs. CMS Medicare benchmark)
// ============================================================================

const OVERCHARGE_THRESHOLD = 2.0; // Flag if billed > 2x Medicare rate

const checkOvercharges: AuditRule = (bill, benchmarks) => {
  const findings: AuditFinding[] = [];

  for (const item of bill.lineItems) {
    const benchmark = benchmarks.get(item.procedureCode);
    if (!benchmark) continue;

    const ratio = item.billedAmount / benchmark.nationalAverage;
    if (ratio > OVERCHARGE_THRESHOLD && item.billedAmount > 50) {
      const estimatedOvercharge =
        item.billedAmount - benchmark.nationalAverage;

      findings.push({
        id: randomUUID(),
        type: "overcharge",
        severity:
          ratio > 5
            ? "critical"
            : ratio > 3
              ? "high"
              : "medium",
        lineItems: [item.lineNumber],
        title: `Potential overcharge on ${item.category}`,
        description: `You were billed $${item.billedAmount.toFixed(2)} for ${item.category.toLowerCase()}, which is ${ratio.toFixed(1)}x the Medicare national average of $${benchmark.nationalAverage.toFixed(2)}. While private insurance rates are typically higher than Medicare, amounts exceeding 2x the benchmark warrant review.`,
        estimatedOvercharge,
        benchmarkSource: "CMS PPL",
        benchmarkAmount: benchmark.nationalAverage,
        billedAmount: item.billedAmount,
        confidence: 0.7,
        actionable: true,
      });
    }
  }

  return findings;
};

// ============================================================================
// RULE 2: Duplicate Line Item Detection
// ============================================================================

const checkDuplicates: AuditRule = (bill) => {
  const findings: AuditFinding[] = [];
  const seen = new Map<string, BillLineItem[]>();

  for (const item of bill.lineItems) {
    const key = `${item.procedureCode}-${item.serviceDate}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key)!.push(item);
  }

  for (const [, items] of seen) {
    if (items.length > 1) {
      const totalOvercharge = items
        .slice(1)
        .reduce((sum, i) => sum + i.billedAmount, 0);

      findings.push({
        id: randomUUID(),
        type: "duplicate",
        severity: totalOvercharge > 500 ? "high" : "medium",
        lineItems: items.map((i) => i.lineNumber),
        title: `Possible duplicate charge for ${items[0].category}`,
        description: `The same procedure code (${items[0].procedureCode}) appears ${items.length} times on ${items[0].serviceDate}. Unless multiple distinct procedures were performed, this may be a duplicate charge totaling $${totalOvercharge.toFixed(2)}.`,
        estimatedOvercharge: totalOvercharge,
        benchmarkSource: "Internal",
        billedAmount: items.reduce((sum, i) => sum + i.billedAmount, 0),
        confidence: 0.6,
        actionable: true,
      });
    }
  }

  return findings;
};

// ============================================================================
// RULE 3: Balance Billing Detection
// ============================================================================

const checkBalanceBilling: AuditRule = (bill) => {
  const findings: AuditFinding[] = [];

  for (const item of bill.lineItems) {
    if (
      item.allowedAmount !== undefined &&
      item.insurancePaid !== undefined &&
      item.patientResponsibility !== undefined
    ) {
      // Patient should owe: allowed - insurance paid (copay/coinsurance/deductible)
      // If patient responsibility > allowed - insurance paid, possible balance billing
      const expectedPatientShare =
        item.allowedAmount - item.insurancePaid;
      const excess = item.patientResponsibility - expectedPatientShare;

      if (excess > 10) {
        // Allow $10 rounding buffer
        findings.push({
          id: randomUUID(),
          type: "balance_billing",
          severity: excess > 200 ? "high" : "medium",
          lineItems: [item.lineNumber],
          title: `Possible balance billing on ${item.category}`,
          description: `You were charged $${item.patientResponsibility.toFixed(2)} for this service, but based on the allowed amount ($${item.allowedAmount.toFixed(2)}) minus what insurance paid ($${item.insurancePaid.toFixed(2)}), your share should be approximately $${expectedPatientShare.toFixed(2)}. The excess of $${excess.toFixed(2)} may be illegal balance billing, depending on your state and network status.`,
          estimatedOvercharge: excess,
          benchmarkSource: "Internal",
          billedAmount: item.billedAmount,
          confidence: 0.75,
          actionable: true,
        });
      }
    }
  }

  return findings;
};

// ============================================================================
// RULE 4: Unbundling Detection (common code pairs that should be bundled)
// ============================================================================

// CCI (Correct Coding Initiative) common unbundling pairs
// These are codes that should NOT be billed together
const UNBUNDLING_PAIRS: Array<[string, string, string]> = [
  ["36415", "36416", "Venipuncture should not be billed alongside capillary blood collection"],
  ["99213", "99214", "Cannot bill two E/M visits at different levels on same date"],
  ["80053", "80048", "Comprehensive metabolic panel includes basic metabolic panel"],
  ["80061", "82465", "Lipid panel includes total cholesterol"],
  ["85025", "85027", "CBC with differential includes CBC without"],
  ["80053", "82310", "Comprehensive metabolic panel includes calcium"],
  ["80053", "84443", "CMP does not include TSH — but check if TSH was actually ordered separately"],
];

const checkUnbundling: AuditRule = (bill) => {
  const findings: AuditFinding[] = [];
  const codeSet = new Set(bill.lineItems.map((i) => i.procedureCode));
  const codeToItem = new Map(
    bill.lineItems.map((i) => [i.procedureCode, i])
  );

  for (const [code1, code2, reason] of UNBUNDLING_PAIRS) {
    if (codeSet.has(code1) && codeSet.has(code2)) {
      const item1 = codeToItem.get(code1)!;
      const item2 = codeToItem.get(code2)!;

      // Only flag if same service date
      if (item1.serviceDate === item2.serviceDate) {
        const smallerAmount = Math.min(
          item1.billedAmount,
          item2.billedAmount
        );

        findings.push({
          id: randomUUID(),
          type: "unbundling",
          severity: smallerAmount > 200 ? "high" : "medium",
          lineItems: [item1.lineNumber, item2.lineNumber],
          title: "Possible unbundling — services should be billed together",
          description: `${reason}. Codes ${code1} and ${code2} were both billed on ${item1.serviceDate}. If these should be bundled, the separate charge of $${smallerAmount.toFixed(2)} may be an overcharge.`,
          estimatedOvercharge: smallerAmount,
          benchmarkSource: "Internal",
          billedAmount: item1.billedAmount + item2.billedAmount,
          confidence: 0.65,
          actionable: true,
        });
      }
    }
  }

  return findings;
};

// ============================================================================
// RULE 5: Missing Insurance Adjustment
// ============================================================================

// RULE 5: Missing Insurance Adjustment
//
// F-13 (Session 85) — fires ONLY when the bill genuinely lacks the
// contractual writeoff. Parser now extracts `ins_adjusted` and `adjustments`
// separately; if EITHER captured a value within tolerance of the
// (billed − allowed) gap, the writeoff WAS applied and this rule no-ops.
// F-14 `insurance_underpayment` covers the case where the writeoff is
// fine but the insurer never paid → patient bears the burden.
//
// F-3 (Session 85) — when this rule does fire, `estimatedOvercharge` is the
// user-recovery target (patient_responsibility − should_owe per plan), not
// the contractual writeoff amount. Copy frames the dispute in user terms:
// "You shouldn't owe more than $X for [service]; dispute the extra $Y."
const checkMissingAdjustments: AuditRule = (bill, _benchmarks, planCoverage, acaFallback) => {
  const findings: AuditFinding[] = [];

  for (const item of bill.lineItems) {
    if (
      !(item.billedAmount > 0) ||
      item.allowedAmount === undefined ||
      !(item.billedAmount > item.allowedAmount)
    ) {
      continue;
    }
    const expectedAdjustment = item.billedAmount - item.allowedAmount;

    // F-13: combined writeoff = lump-sum `adjustments` + split `ins_adjusted`
    // + `provider_adjusted`. Within 10% tolerance, writeoff is applied.
    const writeoffApplied =
      (item.adjustments ?? 0) +
      (item.ins_adjusted ?? 0) +
      (item.provider_adjusted ?? 0);
    if (writeoffApplied >= expectedAdjustment * 0.9) {
      continue; // adjustment WAS applied — don't fire this rule
    }

    if (
      item.patientResponsibility === undefined ||
      item.patientResponsibility <= item.allowedAmount * 0.5
    ) {
      continue;
    }

    // F-3: recovery target = patient_responsibility − should_owe. When plan
    // coverage isn't known for this slug, fall back to the contractual gap
    // (preserves legacy behavior for un-categorized lines).
    // S74.6 D2 §B: acaFallback layer takes precedence over plan-slug lookup
    // for ACA-mandated preventive lines (should_owe=0 makes the recovery
    // target = full patient_responsibility for those lines).
    const slug = item.category ?? null;
    const lineCoverage = resolveCoverageForLine(item, planCoverage, acaFallback, slug);
    const shouldOwe = shouldOweForLine(item, planCoverage, acaFallback, slug);
    const recoveryTarget = Math.max(
      0,
      item.patientResponsibility - shouldOwe,
    );
    const useRecoveryFraming = shouldOwe > 0 || lineCoverage?.covered === true;
    const dollarOvercharge = useRecoveryFraming ? recoveryTarget : expectedAdjustment;

    const title = useRecoveryFraming
      ? `You shouldn't owe more than $${shouldOwe.toFixed(0)} for ${item.category}`
      : `Insurance adjustment may not have been applied for ${item.category}`;
    const description = useRecoveryFraming
      ? `Your plan covers ${item.category.toLowerCase()} with a $${shouldOwe.toFixed(0)} cost share, but the bill charges you $${item.patientResponsibility.toFixed(2)}. The provider billed $${item.billedAmount.toFixed(2)} and the insurer should have written off the difference (allowed amount: $${item.allowedAmount.toFixed(2)}), leaving only your $${shouldOwe.toFixed(0)} share. Dispute the extra $${recoveryTarget.toFixed(2)} as a missed contractual adjustment.`
      : `The billed amount is $${item.billedAmount.toFixed(2)} but the allowed amount is $${item.allowedAmount.toFixed(2)}. The difference of $${expectedAdjustment.toFixed(2)} should be written off as a contractual adjustment, not passed to you.`;

    findings.push({
      id: randomUUID(),
      type: "missing_adjustment",
      severity: dollarOvercharge > 300 ? "high" : "medium",
      lineItems: [item.lineNumber],
      title,
      description,
      estimatedOvercharge: dollarOvercharge,
      benchmarkSource: "Internal",
      billedAmount: item.billedAmount,
      confidence: 0.7,
      actionable: true,
    });
  }

  return findings;
};

// ============================================================================
// ALL RULES
// ============================================================================

export const ALL_RULES: AuditRule[] = [
  checkOvercharges,
  checkDuplicates,
  checkBalanceBilling,
  checkUnbundling,
  checkMissingAdjustments,
];

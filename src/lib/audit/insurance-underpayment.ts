/**
 * F-14 (Session 85) — Insurance under-payment audit rule.
 *
 * Fires when the bill shows the insurer paid $0 (or near-$0) on a service
 * the plan covers, AND the patient is carrying the burden — either still-
 * outstanding OR already paid out of pocket.
 *
 * Captures Andrew's Bill 1 pattern (Nicole's 06/02/25 Swedish bill):
 *   - 99214 office visit, billed $428, allowed $292.41 (ins_adjusted $135.59)
 *   - Insurance paid $0 (the insurer wrote down the bill but never processed
 *     payment — common for claims that got stuck or weren't filed)
 *   - Patient paid $292.41 OOP
 *   - Plan says: covered with $20 copay
 *   - Recovery target: $272.41 refund from insurer (or provider if user
 *     already paid the provider)
 *
 * This is distinct from `missing_adjustment` (writeoff not applied — the
 * provider tried to bill the full charge) and from `balance_billing`
 * (patient charged above their plan share after insurance paid). It's an
 * INSURER-side failure: the writeoff was applied but the payment wasn't.
 *
 * Dispute target: the INSURER, not the provider. The remedy is to have the
 * insurer process/reprocess the claim and either remit payment to the
 * provider (refund to patient cascades) or refund the patient directly.
 *
 * Skipped when:
 *   - plan coverage is unknown for the slug (we don't know if it's covered)
 *   - coverage indicates the service is NOT covered (then balance is legit)
 *   - insurance_paid is non-trivial (covered case is the under-payment OR
 *     missing-adjustment rules; not this one)
 *   - billed_amount is missing or zero
 */

import type { ParsedBill, AuditFinding } from "../billing/types";
import type { AcaFallbackLineCoverageMap, PlanCoverageMap } from "./coverage-loader";
import { computeShouldOwe } from "../claims/recovery-math";
import { randomUUID } from "crypto";

const INSURANCE_PAID_ZERO_THRESHOLD = 1.0; // ≤ $1.00 treated as "zero" (rounding tolerance)

export function runInsuranceUnderpaymentCheck(
  bill: ParsedBill,
  planCoverage: PlanCoverageMap | null,
  acaFallback: AcaFallbackLineCoverageMap | null = null,
): AuditFinding[] {
  // S74.6 D2 §B: ACA fallback can supply coverage even when slug-keyed plan
  // coverage is empty (ACA-mandated vaccine on a plan whose plan_covered_services
  // doesn't list the slug). Short-circuit only when BOTH coverage sources empty.
  if (!planCoverage && !acaFallback) return [];

  const findings: AuditFinding[] = [];

  for (const item of bill.lineItems) {
    if (!(item.billedAmount > 0)) continue;
    // Insurance under-payment defined as ≤ $1 actually paid by insurer
    // (after our parser fix correctly separates `insurance_paid` from
    // `ins_adjusted`). Per-line `insurance_paid` is the canonical source.
    const insPaid = item.insurancePaid ?? null;
    if (insPaid == null || insPaid > INSURANCE_PAID_ZERO_THRESHOLD) continue;

    // Coverage lookup: prefer ACA-mandated zero-cost-share by line number,
    // fall back to slug-keyed plan coverage. ACA-mandated lines may have no
    // slug (D4 hasn't bound one yet) — line-level lookup handles that case.
    const slug = item.category ?? null;
    const acaCov = acaFallback?.get(item.lineNumber) ?? null;
    const slugCov = planCoverage && slug ? planCoverage.get(slug) ?? null : null;
    const coverage = acaCov ?? slugCov;
    if (!coverage || coverage.covered !== true) continue;

    // Patient must actually be carrying a burden — either still-outstanding
    // OR already paid OOP. If both are 0 there's nothing to dispute.
    const responsibility = item.patientResponsibility ?? 0;
    const paid = item.patient_paid ?? 0;
    const totalBurden = Math.max(responsibility, paid);
    if (totalBurden <= 0) continue;

    const shouldOwe = computeShouldOwe({
      billed: item.billedAmount,
      // S120 — apply coinsurance/copay to adjusted (post-writeoff), not gross.
      insuranceAdjusted: item.ins_adjusted ?? 0,
      planCoverage: coverage,
    });
    const recoveryTarget = Math.max(0, responsibility - shouldOwe);
    if (recoveryTarget < 1) continue; // sub-$1 deltas not worth surfacing

    const alreadyPaidOOP = paid > 0;
    // Session 85 — title leads with the dollar amount + action. Title is
    // user-facing; description is reserved for dispute-letter generation
    // (the amber card now renders a separate breakdown built from the
    // line's refund/insured values, not this description).
    const title = alreadyPaidOOP
      ? `You can recover $${recoveryTarget.toFixed(2)} on this visit`
      : `You shouldn't owe $${recoveryTarget.toFixed(2)} on this visit`;
    const description = alreadyPaidOOP
      ? `Your plan covers this service with a $${shouldOwe.toFixed(0)} ${coverage.copay != null ? "copay" : "cost share"}, but you paid $${paid.toFixed(2)} out of pocket — that's $${recoveryTarget.toFixed(2)} above your plan share. Your insurer wrote off $${((item.ins_adjusted ?? 0) + (item.adjustments ?? 0)).toFixed(2)} but never paid the provider anything (a stuck or unprocessed claim). The insurer should reprocess this claim and refund $${recoveryTarget.toFixed(2)}.`
      : `Your plan covers this service with a $${shouldOwe.toFixed(0)} ${coverage.copay != null ? "copay" : "cost share"}, but the bill assigns you $${responsibility.toFixed(2)} — that's $${recoveryTarget.toFixed(2)} above your plan share. Your insurer wrote off $${((item.ins_adjusted ?? 0) + (item.adjustments ?? 0)).toFixed(2)} but never paid the provider anything (a stuck or unprocessed claim). The insurer should reprocess this claim and insure the $${recoveryTarget.toFixed(2)} above your $${shouldOwe.toFixed(0)} plan share.`;

    findings.push({
      id: randomUUID(),
      type: "insurance_underpayment", // F-14 — dedicated FindingType enum value
      severity: recoveryTarget > 300 ? "high" : recoveryTarget > 50 ? "medium" : "low",
      lineItems: [item.lineNumber],
      title,
      description,
      estimatedOvercharge: recoveryTarget,
      benchmarkSource: "plan_coverage",
      billedAmount: item.billedAmount,
      confidence: 0.85,
      actionable: true,
    });
  }

  return findings;
}

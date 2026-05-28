/**
 * S140 — Effective claim totals with per-field provenance.
 *
 * The Haiku bill parser today populates claim-header totals (mig 092:
 * total_billed, total_insurance_paid, total_insurance_adjusted,
 * total_patient_paid) but frequently leaves the corresponding per-line
 * columns NULL. Naive `sum(per-line.X)` aggregation silently produces 0
 * for these fields → wrong UI displays + Pattern P-8 cite-grade VIOLATION
 * in dispute letters (citing $0 insurance paid when claim header records
 * the actual value).
 *
 * This helper resolves "what's the effective total for this claim" with
 * a per-field provenance flag so downstream consumers can:
 *   - display the right number regardless of where it came from
 *   - mark synthesized values as NOT citable per-line in dispute letters
 *   - shift citation framing ("EOB summary records…" when header-sourced)
 *
 * Root-cause fix lives in the backend parser-fix docket (per-line
 * breakdown extraction via tool-use migration + reconciliation invariant
 * + sign-convention prompt fix). This module is the display-layer
 * correctness layer until that ships. Telemetry on
 * `dispute_outcomes.metadata.citation_source` is the removal-trigger
 * signal.
 *
 * Decision rule per field is bi-directional: cite-grade match requires
 * |sum(per-line) - header| <= $0.01. Mismatch in EITHER direction
 * (sparse per-line OR inflated per-line) falls back to header. Header
 * NULL → trust per-line by default (nothing better to compare against).
 */

export type EffectiveTotalsSource = "per_line_sum" | "claim_header";

export interface EffectiveClaimTotals {
  patientPaid: number;
  insurancePaid: number;
  insuranceAdjusted: number;
  patientResponsibility: number;
  provenance: {
    patientPaidSource: EffectiveTotalsSource;
    insurancePaidSource: EffectiveTotalsSource;
    insuranceAdjustedSource: EffectiveTotalsSource;
    patientResponsibilitySource: EffectiveTotalsSource;
  };
}

export interface EffectiveTotalsClaimInput {
  total_billed?: number | null;
  total_patient_paid?: number | null;
  total_insurance_paid?: number | null;
  total_insurance_adjusted?: number | null;
  total_patient_responsibility?: number | null;
  amount_still_outstanding?: number | null;
}

export interface EffectiveTotalsLineInput {
  billed_amount?: number | null;
  patient_paid_amount?: number | null;
  insurance_paid?: number | null;
  insurance_adjusted_amount?: number | null;
  patient_owes?: number | null;
}

const CITE_GRADE_TOLERANCE = 0.01;

function toNumber(v: number | null | undefined): number {
  return v != null ? Number(v) : 0;
}

function decideField(
  perLineSum: number,
  header: number | null,
): { value: number; source: EffectiveTotalsSource } {
  // Header absent → trust per-line sum (no other signal to compare against).
  if (header == null) {
    return { value: perLineSum, source: "per_line_sum" };
  }
  // Bi-directional cite-grade match — within tolerance means per-line and
  // header agree; either way of mismatch (sparse OR inflated per-line)
  // disqualifies per-line as cite-grade and we surface header instead.
  if (Math.abs(perLineSum - header) <= CITE_GRADE_TOLERANCE) {
    return { value: perLineSum, source: "per_line_sum" };
  }
  return { value: header, source: "claim_header" };
}

/**
 * Compute effective claim-level totals with per-field provenance. Used
 * inside /api/claims/[claimId] for display + dispute pipeline citations.
 */
export function resolveEffectiveClaimTotals(args: {
  claim: EffectiveTotalsClaimInput;
  lineItems: EffectiveTotalsLineInput[];
}): EffectiveClaimTotals {
  const { claim, lineItems } = args;

  // Per-line sums — treat NULL as 0 within the sum (sparse rows contribute
  // nothing). This is the value the comparison gate is checking AGAINST
  // the header.
  let sumPatientPaid = 0;
  let sumInsurancePaid = 0;
  let sumInsuranceAdjusted = 0;
  let sumPatientResp = 0;
  for (const li of lineItems) {
    sumPatientPaid += toNumber(li.patient_paid_amount);
    sumInsurancePaid += toNumber(li.insurance_paid);
    sumInsuranceAdjusted += toNumber(li.insurance_adjusted_amount);
    sumPatientResp += toNumber(li.patient_owes);
  }

  // Header values. patient_responsibility cascades through
  // total_patient_responsibility → amount_still_outstanding, matching the
  // existing `resolveStillOutstanding` lookup pattern in recovery-math.ts.
  const headerPatientPaid =
    claim.total_patient_paid != null ? Number(claim.total_patient_paid) : null;
  const headerInsurancePaid =
    claim.total_insurance_paid != null
      ? Number(claim.total_insurance_paid)
      : null;
  const headerInsuranceAdjusted =
    claim.total_insurance_adjusted != null
      ? Number(claim.total_insurance_adjusted)
      : null;
  const headerPatientResp =
    claim.total_patient_responsibility != null
      ? Number(claim.total_patient_responsibility)
      : claim.amount_still_outstanding != null
        ? Number(claim.amount_still_outstanding)
        : null;

  const patientPaid = decideField(sumPatientPaid, headerPatientPaid);
  const insurancePaid = decideField(sumInsurancePaid, headerInsurancePaid);
  const insuranceAdjusted = decideField(
    sumInsuranceAdjusted,
    headerInsuranceAdjusted,
  );
  const patientResponsibility = decideField(sumPatientResp, headerPatientResp);

  return {
    patientPaid: patientPaid.value,
    insurancePaid: insurancePaid.value,
    insuranceAdjusted: insuranceAdjusted.value,
    patientResponsibility: patientResponsibility.value,
    provenance: {
      patientPaidSource: patientPaid.source,
      insurancePaidSource: insurancePaid.source,
      insuranceAdjustedSource: insuranceAdjusted.source,
      patientResponsibilitySource: patientResponsibility.source,
    },
  };
}

export interface ResolvedPerLineValue {
  value: number;
  source: "per_line" | "header_prorated";
}

/**
 * Resolve per-line patient_paid with provenance, used inside the per-line
 * map in /api/claims/[claimId]. Cite-grade path: helper says per-line sum
 * is reliable AND this line has a non-null raw value → return raw.
 * Otherwise pro-rate the effective header value by line-billed share.
 *
 * Defensive: claimTotalBilled <= 0 → return 0 (no division by zero).
 */
export function resolvePerLinePatientPaid(args: {
  lineBilled: number;
  linePatientPaid: number | null;
  claimTotalBilled: number;
  effectiveClaimPatientPaid: EffectiveClaimTotals;
}): ResolvedPerLineValue {
  const citeGradeOk =
    args.effectiveClaimPatientPaid.provenance.patientPaidSource ===
      "per_line_sum" && args.linePatientPaid != null;
  if (citeGradeOk) {
    return { value: args.linePatientPaid as number, source: "per_line" };
  }
  if (args.claimTotalBilled <= 0) {
    return { value: 0, source: "header_prorated" };
  }
  const prorated =
    Math.round(
      (args.lineBilled / args.claimTotalBilled) *
        args.effectiveClaimPatientPaid.patientPaid *
        100,
    ) / 100;
  return { value: prorated, source: "header_prorated" };
}

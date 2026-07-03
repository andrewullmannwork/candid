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

/**
 * Resolve per-line insurance_paid (insurer payment) with provenance, used
 * for DISPLAY ONLY in LineDrawer Bill card + desktop YOU PAID column. When
 * per-line is sparse but claim header `total_insurance_paid` is populated,
 * pro-rate by line-billed share. Without this, LineDrawer shows
 * "Insurer paid $0.00" on every line for header-only EOBs (Dec 12 case)
 * while bill-level FlaggedBody shows the actual header value — confusing.
 *
 * Math layer (computeShouldOwe / computeRecoveryV2) does NOT consume
 * insurance_paid as an input, so no recovery math ripple.
 *
 * Defensive: claimTotalBilled <= 0 → return 0.
 */
export function resolvePerLineInsurancePaid(args: {
  lineBilled: number;
  lineInsurancePaid: number | null;
  claimTotalBilled: number;
  effectiveClaimInsurancePaid: EffectiveClaimTotals;
}): ResolvedPerLineValue {
  const citeGradeOk =
    args.effectiveClaimInsurancePaid.provenance.insurancePaidSource ===
      "per_line_sum" && args.lineInsurancePaid != null;
  if (citeGradeOk) {
    return { value: args.lineInsurancePaid as number, source: "per_line" };
  }
  if (args.claimTotalBilled <= 0) {
    return { value: 0, source: "header_prorated" };
  }
  const prorated =
    Math.round(
      (args.lineBilled / args.claimTotalBilled) *
        args.effectiveClaimInsurancePaid.insurancePaid *
        100,
    ) / 100;
  return { value: prorated, source: "header_prorated" };
}

/**
 * Resolve per-line insurance_adjusted_amount (the contractual writeoff) with
 * provenance, used to feed computeRecoveryV2's `insuranceAdjusted` arg. When
 * per-line writeoff is sparse but claim header `total_insurance_adjusted` is
 * populated, pro-rate the header value by line-billed share.
 *
 * Critical for coinsurance correctness: computeShouldOwe applies coinsurance
 * to (billed - writeoff). Without per-line writeoff, coinsurance ends up
 * applied to gross billed (~2-3× too high). Pro-rate fallback corrects this.
 *
 * Defensive: claimTotalBilled <= 0 → return 0 (no division by zero).
 */
export function resolvePerLineInsuranceAdjusted(args: {
  lineBilled: number;
  lineInsuranceAdjusted: number | null;
  claimTotalBilled: number;
  effectiveClaimInsuranceAdjusted: EffectiveClaimTotals;
}): ResolvedPerLineValue {
  const citeGradeOk =
    args.effectiveClaimInsuranceAdjusted.provenance
      .insuranceAdjustedSource === "per_line_sum" &&
    args.lineInsuranceAdjusted != null;
  if (citeGradeOk) {
    return {
      value: args.lineInsuranceAdjusted as number,
      source: "per_line",
    };
  }
  if (args.claimTotalBilled <= 0) {
    return { value: 0, source: "header_prorated" };
  }
  const prorated =
    Math.round(
      (args.lineBilled / args.claimTotalBilled) *
        args.effectiveClaimInsuranceAdjusted.insuranceAdjusted *
        100,
    ) / 100;
  return { value: prorated, source: "header_prorated" };
}

/**
 * Dispute Letters v2 (Z1.1b) — read a user-confirmed claim-level amount-paid override
 * from claims.metadata (Rule #9 JSONB store; key `userPatientPaid`). Returns a finite
 * dollar amount >= 0, or null when unset/invalid (→ caller no-ops and the parsed values
 * stand). Zero is a valid, meaningful override ("I paid nothing" → suppresses a refund).
 */
export function readUserPatientPaidOverride(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).userPatientPaid;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100) / 100;
}

/**
 * Overlay a user-confirmed claim-level amount-paid onto a claim + its line items IN PLACE,
 * so the dispute letter's refund math reflects it. Sets the claim header total_patient_paid
 * to the override AND distributes the same total across the lines' patient_paid_amount by
 * billed share (equal split when nothing is billed), placing the rounding remainder on the
 * largest-billed line so the per-line sum equals the header exactly. Keeping header == sum
 * makes resolveEffectiveClaimTotals treat it as cite-grade `per_line_sum`, so BOTH the
 * detail (prorated) and list (raw per-line) cost-share strategies read consistent values —
 * no list/detail divergence. Mutates the passed objects (in-memory reads only; never
 * persisted). Callers no-op when readUserPatientPaidOverride returns null → byte-identical.
 */
export function applyUserPatientPaidOverride(
  claim: { total_patient_paid?: number | null },
  lines: Array<{ billed_amount?: number | null; patient_paid_amount?: number | null }>,
  overrideTotal: number,
): void {
  claim.total_patient_paid = overrideTotal;
  if (lines.length === 0) return;

  const totalBilled = lines.reduce((s, li) => s + toNumber(li.billed_amount), 0);
  const n = lines.length;
  const shares = lines.map((li) =>
    totalBilled > 0
      ? Math.round((toNumber(li.billed_amount) / totalBilled) * overrideTotal * 100) / 100
      : Math.round((overrideTotal / n) * 100) / 100,
  );

  // Correct rounding drift so sum(shares) === overrideTotal (keeps header == sum, and thus
  // within resolveEffectiveClaimTotals' $0.01 cite-grade tolerance). Residual lands on the
  // largest-billed line (index 0 fallback).
  const sum = shares.reduce((s, v) => s + v, 0);
  const remainder = Math.round((overrideTotal - sum) * 100) / 100;
  if (remainder !== 0) {
    let idx = 0;
    let maxBilled = -Infinity;
    lines.forEach((li, i) => {
      const b = toNumber(li.billed_amount);
      if (b > maxBilled) {
        maxBilled = b;
        idx = i;
      }
    });
    shares[idx] = Math.round((shares[idx] + remainder) * 100) / 100;
  }

  lines.forEach((li, i) => {
    li.patient_paid_amount = shares[i];
  });
}

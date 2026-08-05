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

export type EffectiveTotalsSource =
  | "per_line_sum"
  | "claim_header"
  /**
   * S302 — the user adjudicated. A bill is internally consistent on paper, so
   * when our line-item parse and our header parse disagree, one of OURS is
   * wrong; these two sources record which one the user says to trust. They are
   * a CHOICE between two already-parsed numbers, never a new value — no
   * per-line writes, no redistribution, no imputation.
   */
  | "user_line_items"
  | "user_summary";

/** The user's answer, or null when they have not been asked / have cleared it. */
export type UserTotalsSource = "summary" | "line_items" | null;

/**
 * Read the durable answer from `claims.metadata` (Rule #9 JSONB-first,
 * re-parse-proof — mirrors `userPatientPaid`). ONE reader, so all five
 * `resolveEffectiveClaimTotals` call sites read the same key the same way.
 */
export function readUserTotalsSource(metadata: unknown): UserTotalsSource {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).userTotalsSource;
  return v === "summary" || v === "line_items" ? v : null;
}

/**
 * Is this source safe to cite PER LINE?
 *
 * The per-line resolvers below prorate the header whenever the raw line values
 * are untrustworthy. `user_line_items` must count as trustworthy — the user
 * just told us the line items are right — or choosing "the line items" would
 * keep prorating and the choice would do nothing visible. ONE predicate, so a
 * new source kind cannot be added to some resolvers and forgotten in others.
 */
export function isPerLineCiteGrade(source: EffectiveTotalsSource): boolean {
  return source === "per_line_sum" || source === "user_line_items";
}

/**
 * S304 — what the LINES say about one field, as a fact rather than a proxy.
 *
 * The line-items-vs-summary question was computed a second time in ClaimDetail,
 * from the raw rows, with its own header-column→line-column mapping and its own
 * null-treated-as-zero sum. That third derivation could not tell "the bill does
 * not state this per line" from "the lines say zero", so it asked users to
 * adjudicate a conflict that did not exist on 14 of 17 DEV claims. The resolver
 * already computes everything the question needs — so it reports it.
 */
export interface PerLineFieldFact {
  /** Sum of the per-line values; lines with no value contribute nothing. */
  sum: number;
  /**
   * Did ANY line carry a value? False means the bill states this field only in
   * its summary block — an absence, not a competing opinion.
   */
  present: boolean;
  /**
   * A REAL conflict: line values exist AND disagree with the header beyond a
   * cent. This — not a bare delta — is the condition worth asking a user about.
   */
  contradictsHeader: boolean;
}

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
  /**
   * S304 — the per-line facts behind each decision.
   *
   * OPTIONAL on the type, ALWAYS populated by `resolveEffectiveClaimTotals` —
   * and the totals-source fixture asserts that, so the guarantee is tested, not
   * merely commented. Optional deliberately, unlike `userTotalsSource`: that is
   * an INPUT five production call sites supply, where an optional param lets one
   * silently keep the old answer. This is an OUTPUT with a single producer and a
   * single consumer (the claim detail GET → ClaimDetail's question). The only
   * objects lacking it are dispute-pipeline fixtures that hand-build totals for
   * unrelated assertions; requiring it there would duplicate the same four
   * literals across five files, which is the drift, not the guard against it.
   */
  perLine?: {
    patientPaid: PerLineFieldFact;
    insurancePaid: PerLineFieldFact;
    insuranceAdjusted: PerLineFieldFact;
    patientResponsibility: PerLineFieldFact;
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
  userChoice: UserTotalsSource,
  /**
   * S304 — did ANY line carry a value for this field? A bill that states a total
   * only in its summary block (a provider itemised receipt) has NO per-line
   * values, which is not the same as per-line values that happen to sum to zero.
   */
  perLinePresent: boolean,
): { value: number; source: EffectiveTotalsSource } {
  // Header absent → trust per-line sum (no other signal to compare against).
  if (header == null) {
    return { value: perLineSum, source: "per_line_sum" };
  }
  // S304 — AGREEMENT OUTRANKS A STORED ANSWER. When the per-line values and the
  // header produce the same number there is nothing to choose between, so the
  // user's answer is moot and the lines stay cite-grade. This check used to sit
  // BELOW the user branches, so an answer given once kept suppressing cite-grade
  // for good — even after a re-parse (or the single-line header identity) made
  // the two agree. A choice between two identical numbers is not a choice.
  if (perLinePresent && Math.abs(perLineSum - header) <= CITE_GRADE_TOLERANCE) {
    return { value: perLineSum, source: "per_line_sum" };
  }
  // S302 — the user's answer OUTRANKS the default rule. It is a choice between
  // the two numbers already computed below, so nothing else changes shape.
  //
  // S304 — "the line items are right" requires that there BE line items. On a
  // header-only bill the per-line sum is 0, so honoring the answer would report
  // $0.00 for money the bill plainly states. The question no longer fires on
  // those bills, but a stored answer outlives the question that produced it.
  if (userChoice === "line_items" && perLinePresent) {
    return { value: perLineSum, source: "user_line_items" };
  }
  if (userChoice === "summary") {
    return { value: header, source: "user_summary" };
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
  /**
   * S302 — REQUIRED, deliberately. Five production call sites feed this
   * (claims list, claim detail, dispute-ground-basis, evidence-resolver,
   * accumulator-loader); an optional param would let one of them silently keep
   * the old answer, so the claim page would show the corrected total while the
   * LETTER still cited the old one. Making it required means the compiler names
   * every site — the S301 lesson, where `letterRequirementsOn` shipped optional
   * with zero callers and the readiness floor quietly never moved.
   * Pass `readUserTotalsSource(claim.metadata)`; `null` = today's rule.
   */
  userTotalsSource: UserTotalsSource;
}): EffectiveClaimTotals {
  const { claim, lineItems, userTotalsSource } = args;

  // Per-line sums — treat NULL as 0 within the sum (sparse rows contribute
  // nothing). This is the value the comparison gate is checking AGAINST
  // the header.
  let sumPatientPaid = 0;
  let sumInsurancePaid = 0;
  let sumInsuranceAdjusted = 0;
  let sumPatientResp = 0;
  // S304 — presence is tracked alongside the sum, because null and 0 sum
  // identically and the two mean opposite things.
  let anyPatientPaid = false;
  let anyInsurancePaid = false;
  let anyInsuranceAdjusted = false;
  let anyPatientResp = false;
  for (const li of lineItems) {
    sumPatientPaid += toNumber(li.patient_paid_amount);
    sumInsurancePaid += toNumber(li.insurance_paid);
    sumInsuranceAdjusted += toNumber(li.insurance_adjusted_amount);
    sumPatientResp += toNumber(li.patient_owes);
    if (li.patient_paid_amount != null) anyPatientPaid = true;
    if (li.insurance_paid != null) anyInsurancePaid = true;
    if (li.insurance_adjusted_amount != null) anyInsuranceAdjusted = true;
    if (li.patient_owes != null) anyPatientResp = true;
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

  const patientPaid = decideField(sumPatientPaid, headerPatientPaid, userTotalsSource, anyPatientPaid);
  const insurancePaid = decideField(sumInsurancePaid, headerInsurancePaid, userTotalsSource, anyInsurancePaid);
  const insuranceAdjusted = decideField(sumInsuranceAdjusted, headerInsuranceAdjusted, userTotalsSource, anyInsuranceAdjusted);
  const patientResponsibility = decideField(sumPatientResp, headerPatientResp, userTotalsSource, anyPatientResp);

  const fact = (sum: number, present: boolean, header: number | null): PerLineFieldFact => ({
    sum,
    present,
    contradictsHeader:
      present && header != null && Math.abs(sum - header) > CITE_GRADE_TOLERANCE,
  });

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
    perLine: {
      patientPaid: fact(sumPatientPaid, anyPatientPaid, headerPatientPaid),
      insurancePaid: fact(sumInsurancePaid, anyInsurancePaid, headerInsurancePaid),
      insuranceAdjusted: fact(sumInsuranceAdjusted, anyInsuranceAdjusted, headerInsuranceAdjusted),
      patientResponsibility: fact(sumPatientResp, anyPatientResp, headerPatientResp),
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
    isPerLineCiteGrade(args.effectiveClaimPatientPaid.provenance.patientPaidSource) && args.linePatientPaid != null;
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
    isPerLineCiteGrade(args.effectiveClaimInsurancePaid.provenance.insurancePaidSource) && args.lineInsurancePaid != null;
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
    isPerLineCiteGrade(
      args.effectiveClaimInsuranceAdjusted.provenance.insuranceAdjustedSource,
    ) && args.lineInsuranceAdjusted != null;
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
 * S292 (#4) — per-line "BILLED TO YOU" display value.
 *
 * The bill-table column previously led with the provider's charge; the number
 * the patient actually cares about is what they were ASKED to pay after
 * adjudication: billed − insurer's negotiated adjustment − insurer's payment.
 * This resolver derives that per line by reusing the S140 per-line resolvers
 * above (same proportional-split method the YOU PAID column uses via
 * resolvePerLinePatientPaid — cite-grade raw per-line values when the sums
 * reconcile with the claim header, header-prorated by billed share otherwise).
 *
 * DISPLAY ONLY — feeds no recovery/forgiveness/verdict math.
 *
 * HONESTY FALLBACK: when the bill has NO insurer adjustment/payment data at
 * all (per-line AND header both empty → effective totals resolve to 0), the
 * value is the gross charge and no "before insurance" sub-line renders. We
 * never invent an adjustment. Likewise, inconsistent data (adjustment +
 * payment exceeding the charge → negative) falls back to the gross with no
 * sub-line rather than displaying a negative.
 *
 * NOTE: this is deliberately a SEPARATE fact from YOU PAID (actual money paid
 * so far). On a fresh unpaid bill the two legitimately disagree — billed-to-you
 * > 0 while you-paid is $0.00 — that gap is the point. Neither is derived from
 * the other.
 */
export interface PerLineBilledToYou {
  /** Main display value — what the patient was actually asked to pay on this line. */
  value: number;
  /** The provider's gross charge (raw billed_amount). */
  gross: number;
  /**
   * Render the "$<gross> before insurance" sub-line? False when the bill has
   * no insurer data, when the data is inconsistent (fallback to gross), or
   * when the value equals the gross (sub-line would add nothing).
   */
  showBeforeInsurance: boolean;
}

export function resolvePerLineBilledToYou(args: {
  lineBilled: number;
  lineInsuranceAdjusted: number | null;
  lineInsurancePaid: number | null;
  claimTotalBilled: number;
  effectiveTotals: EffectiveClaimTotals;
}): PerLineBilledToYou {
  const gross = args.lineBilled;
  // Honesty fallback — no insurer adjustment/payment signal anywhere on the
  // bill. Both effective totals resolving to 0 covers per-line-all-NULL AND
  // header-NULL (decideField treats NULL header as per-line-sum = 0).
  const hasInsurerData =
    args.effectiveTotals.insuranceAdjusted > 0 ||
    args.effectiveTotals.insurancePaid > 0;
  if (!hasInsurerData) {
    return { value: gross, gross, showBeforeInsurance: false };
  }
  const adjusted = resolvePerLineInsuranceAdjusted({
    lineBilled: args.lineBilled,
    lineInsuranceAdjusted: args.lineInsuranceAdjusted,
    claimTotalBilled: args.claimTotalBilled,
    effectiveClaimInsuranceAdjusted: args.effectiveTotals,
  }).value;
  const insurerPaid = resolvePerLineInsurancePaid({
    lineBilled: args.lineBilled,
    lineInsurancePaid: args.lineInsurancePaid,
    claimTotalBilled: args.claimTotalBilled,
    effectiveClaimInsurancePaid: args.effectiveTotals,
  }).value;
  const raw = Math.round((gross - adjusted - insurerPaid) * 100) / 100;
  if (raw < 0) {
    // Inconsistent data — adjustment + payment exceed the charge. Never show
    // a negative; surface the gross with no sub-line.
    return { value: gross, gross, showBeforeInsurance: false };
  }
  const value = raw === 0 ? 0 : raw; // normalize -0 from rounding
  // Sub-line only when it adds information (insurer data moved the number).
  return { value, gross, showBeforeInsurance: value !== gross };
}

/**
 * Dispute Letters v2 (Z1.1b) — read a user-confirmed claim-level amount-paid override
 * from claims.metadata (Rule #9 JSONB store; key `userPatientPaid`). Returns a finite
 * dollar amount >= 0, or null when unset/invalid (→ caller no-ops and the parsed values
 * stand). Zero is a valid, meaningful override ("I paid nothing" → suppresses a refund).
 */
/**
 * S291 — when the user last confirmed this bill's service list ("All services
 * look right"). ISO timestamp in `claims.metadata.servicesConfirmedAt`, or null
 * if never confirmed. Sibling of the patient-paid override: same JSONB-first
 * convention (Rule #9), same read-it-back-from-the-server discipline, so the
 * guided-rail step isn't local state that evaporates on reload.
 */
export function readServicesConfirmedAt(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).servicesConfirmedAt;
  return typeof v === "string" && v.length > 0 ? v : null;
}

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

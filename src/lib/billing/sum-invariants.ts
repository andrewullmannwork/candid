/**
 * Bill parser persist-time verifiers (PR4 / S142).
 *
 * Three invariants ride together in persist.ts on every bill claim insert:
 *
 *   B-1 per-line sum-equals-header — for each of insurance_paid /
 *       patient_paid_amount / insurance_adjusted_amount, when per-line numerics
 *       are populated on ≥1 line, the sum of per-line values must match the
 *       claim-header total within tolerance. Sparse per-line outputs (all NULL)
 *       are NOT a violation — they're the documented frontend Path B fallback
 *       path. Mismatch IS a violation (parser populated some lines but the
 *       arithmetic doesn't close).
 *
 *   B-2 header reconciliation — |total_billed - total_insurance_adjusted -
 *       total_insurance_paid - total_patient_paid| within tolerance. Violation
 *       means the four header totals are mutually incoherent (see Jun 23
 *       PROD claim 4d8c0cad: adjusted equals billed yet paid is nonzero).
 *
 *   B-3 sign violation — any of insurance_paid / patient_paid /
 *       insurance_adjusted_amount arrived negative on input. Violation lives at
 *       the sign-detection layer (this module) — persist.ts records the
 *       decision + admin queue row instead of silently flipping signs via the
 *       S135 Math.abs() bandaid.
 *
 * Tolerances are tunable via the `bill_parser_tool_use_v1` flag config JSONB:
 *   per_line_sum_tolerance_abs   ($0.01 floor)
 *   per_line_sum_tolerance_rel   (0.1% of header)
 *   header_reconciliation_abs    ($0.50 floor)
 *   header_reconciliation_rel    (0.5% of total_billed)
 *
 * No throws — verifiers return verdict objects. Callers (persist.ts) decide
 * what to do (record decision, set metadata flag, drop per-line numerics).
 */

import type { BillLineItem, ParsedBill } from "./types";
import { createServerClient } from "@/lib/supabase/server";

// Default tolerances if the flag row is missing or config is malformed.
// Match the migration 133 seed values so that "flag deleted" reverts to the
// same regime as "flag present, defaults".
const DEFAULT_PER_LINE_ABS = 0.01;
const DEFAULT_PER_LINE_REL = 0.001;
const DEFAULT_HEADER_ABS = 0.50;
const DEFAULT_HEADER_REL = 0.005;

export interface VerifierTolerances {
  perLineSumAbs: number;
  perLineSumRel: number;
  headerReconciliationAbs: number;
  headerReconciliationRel: number;
}

/**
 * Reads the tolerance constants from `feature_flag_rules.config` for the
 * `bill_parser_tool_use_v1` flag (mig 133). Single DB round-trip rather than
 * four readFeatureFlagConfig calls because verifiers run inside the persist
 * hot path. Tolerances are read even when the flag is OFF — they govern the
 * B-1 / B-2 / B-3 verifiers regardless of which parser path produced the
 * input (raw_json or tool_use).
 */
export async function loadVerifierTolerances(): Promise<VerifierTolerances> {
  try {
    const supabase = createServerClient();
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "bill_parser_tool_use_v1")
      .single();
    const cfg = (data?.config ?? {}) as Record<string, unknown>;
    return {
      perLineSumAbs: numOr(cfg.per_line_sum_tolerance_abs, DEFAULT_PER_LINE_ABS),
      perLineSumRel: numOr(cfg.per_line_sum_tolerance_rel, DEFAULT_PER_LINE_REL),
      headerReconciliationAbs: numOr(cfg.header_reconciliation_abs, DEFAULT_HEADER_ABS),
      headerReconciliationRel: numOr(cfg.header_reconciliation_rel, DEFAULT_HEADER_REL),
    };
  } catch {
    return {
      perLineSumAbs: DEFAULT_PER_LINE_ABS,
      perLineSumRel: DEFAULT_PER_LINE_REL,
      headerReconciliationAbs: DEFAULT_HEADER_ABS,
      headerReconciliationRel: DEFAULT_HEADER_REL,
    };
  }
}

function numOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// B-3 sign violation detection
// ---------------------------------------------------------------------------

export interface SignViolationDetail {
  field: string;
  value: number;
  lineNumber?: number;
}

export function detectSignViolations(parsedBill: ParsedBill): SignViolationDetail[] {
  const violations: SignViolationDetail[] = [];

  // Header totals.
  const headerChecks: Array<[string, number | undefined]> = [
    ["total_insurance_paid", parsedBill.totals.totalInsurancePaid],
    ["total_insurance_adjusted", parsedBill.totals.totalInsAdjusted],
    ["total_patient_paid", parsedBill.totals.totalPatientPaid],
  ];
  for (const [field, value] of headerChecks) {
    if (value != null && value < 0) {
      violations.push({ field, value });
    }
  }

  // Per-line numeric fields.
  for (const item of parsedBill.lineItems) {
    const lineChecks: Array<[string, number | undefined]> = [
      ["insurance_paid", item.insurancePaid],
      ["insurance_adjusted_amount", item.ins_adjusted],
      ["patient_paid_amount", item.patient_paid],
    ];
    for (const [field, value] of lineChecks) {
      if (value != null && value < 0) {
        violations.push({ field, value, lineNumber: item.lineNumber });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// B-1 per-line sum-equals-header verifier
// ---------------------------------------------------------------------------

export interface PerLineSumVerdict {
  field: string;
  headerKey: keyof ParsedBill["totals"];
  perLineKey: keyof BillLineItem;
  populated: boolean; // at least one line has a non-null value for this field
  lineSum: number;
  header: number | null;
  delta: number; // |lineSum - header| (NaN if header null)
  tolerance: number; // max(abs, header * rel)
  withinTolerance: boolean; // true when populated=false OR delta ≤ tolerance
}

const PER_LINE_FIELD_SPEC: Array<{
  field: string;
  headerKey: keyof ParsedBill["totals"];
  perLineKey: keyof BillLineItem;
}> = [
  { field: "insurance_paid", headerKey: "totalInsurancePaid", perLineKey: "insurancePaid" },
  { field: "insurance_adjusted_amount", headerKey: "totalInsAdjusted", perLineKey: "ins_adjusted" },
  { field: "patient_paid_amount", headerKey: "totalPatientPaid", perLineKey: "patient_paid" },
];

export function verifyPerLineSums(
  parsedBill: ParsedBill,
  tolerances: VerifierTolerances,
): PerLineSumVerdict[] {
  const out: PerLineSumVerdict[] = [];
  for (const spec of PER_LINE_FIELD_SPEC) {
    let populated = false;
    let lineSum = 0;
    for (const item of parsedBill.lineItems) {
      const raw = item[spec.perLineKey];
      const v = typeof raw === "number" ? raw : null;
      if (v != null && !Number.isNaN(v)) {
        populated = true;
        // Use the magnitude so a stray negative doesn't mask a real mismatch.
        // B-3 sign violations are detected upstream; this verifier focuses on
        // arithmetic-closure of the populated values themselves.
        lineSum += Math.abs(v);
      }
    }
    const header = parsedBill.totals[spec.headerKey] ?? null;
    const headerMag = header != null ? Math.abs(header) : null;
    const tolerance = Math.max(
      tolerances.perLineSumAbs,
      (headerMag ?? 0) * tolerances.perLineSumRel,
    );
    const delta = headerMag != null ? Math.abs(lineSum - headerMag) : NaN;
    // Sparse path: per-line numerics ALL null → not a violation; frontend Path B
    // pro-rates from header. Populated path: delta must be within tolerance.
    const withinTolerance = !populated ? true : Number.isFinite(delta) && delta <= tolerance;
    out.push({
      field: spec.field,
      headerKey: spec.headerKey,
      perLineKey: spec.perLineKey,
      populated,
      lineSum,
      header: headerMag,
      delta,
      tolerance,
      withinTolerance,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// B-2 header reconciliation verifier
// ---------------------------------------------------------------------------

export interface HeaderReconciliationVerdict {
  totalBilled: number | null;
  totalInsAdjusted: number | null;
  totalInsurancePaid: number | null;
  totalPatientPaid: number | null;
  // PR4b (S143) — provider_adjusted is part of the reconciliation formula:
  // billed = ins_adjusted + provider_adjusted + insurance_paid + patient_paid.
  // PR4 (S142) initial verifier omitted this; Opus calibration baseline
  // (2026-05-29) surfaced false-fires on bills with non-zero provider_adjusted
  // (e.g., Swedish 7_1.pdf $33.85 provider_adjusted, 12_12.pdf $7.00).
  totalProviderAdjusted: number | null;
  delta: number; // |billed - adjusted - provider_adjusted - paid - patient_paid|
  tolerance: number;
  withinTolerance: boolean;
  // Distinguishes "header totals incomplete (NULLs)" from "header totals all
  // present + mathematically incoherent". Persist treats only the latter as a
  // B-2 violation; missing header totals are normal for itemized-bill uploads
  // that the parser couldn't decompose. provider_adjusted is treated as 0
  // when null (some bills don't have a provider writeoff column at all — the
  // formula degrades to the 4-field form without firing a violation).
  allHeaderTotalsPresent: boolean;
}

export function verifyHeaderReconciliation(
  parsedBill: ParsedBill,
  tolerances: VerifierTolerances,
): HeaderReconciliationVerdict {
  const totalBilled = parsedBill.totals.totalBilled ?? null;
  const totalInsAdjusted = parsedBill.totals.totalInsAdjusted ?? null;
  const totalInsurancePaid = parsedBill.totals.totalInsurancePaid ?? null;
  const totalPatientPaid = parsedBill.totals.totalPatientPaid ?? null;
  const totalProviderAdjusted = parsedBill.totals.totalProviderAdjusted ?? null;

  // The 4 core totals must all be present for the verifier to fire. provider_adjusted
  // is OPTIONAL — many bills don't have a provider writeoff at all; treat null as 0
  // in the formula so the verifier doesn't false-fire on bills that omit it.
  const allPresent =
    totalBilled != null &&
    totalInsAdjusted != null &&
    totalInsurancePaid != null &&
    totalPatientPaid != null;

  // Magnitude-only math; B-3 sign violations are detected upstream. Header
  // reconciliation asks "do the totals balance under positive convention?"
  const mag = (n: number | null) => (n != null ? Math.abs(n) : 0);
  const delta = allPresent
    ? Math.abs(
        mag(totalBilled) -
          mag(totalInsAdjusted) -
          mag(totalProviderAdjusted) -
          mag(totalInsurancePaid) -
          mag(totalPatientPaid),
      )
    : NaN;
  const tolerance = Math.max(
    tolerances.headerReconciliationAbs,
    mag(totalBilled) * tolerances.headerReconciliationRel,
  );
  const withinTolerance = allPresent && Number.isFinite(delta) && delta <= tolerance;

  return {
    totalBilled,
    totalInsAdjusted,
    totalInsurancePaid,
    totalPatientPaid,
    totalProviderAdjusted,
    delta,
    tolerance,
    withinTolerance,
    allHeaderTotalsPresent: allPresent,
  };
}

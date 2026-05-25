/**
 * Garbage-pattern validators for plan-identity fields (Ing-B / CF-63 RC-6).
 *
 * Catches Haiku non-null outputs that pass null discipline but are obviously
 * wrong: HIOS Plan IDs, FAQ-answer column-wrap fragments, footer boilerplate
 * sitting in `plan_name` / `insurer_name` / `metal_tier` / `group_number`
 * slots. These all share the same OCR column-wrap root cause that Ing-C's
 * RC-3 + RC-5 fix at the section-discovery layer.
 *
 * Validator semantics:
 *   - Pure regex; no DB calls.
 *   - Null/undefined/empty/whitespace input → no-op (returns the value
 *     unchanged + no warning). We never invent garbage where there is none.
 *   - On match: caller sets the field to null and pushes a structured
 *     parseWarning of shape `"{field}_rejected_garbage:{pattern_name}"`.
 *
 * Pattern-to-field map is CURATED (not "all 8 patterns apply to all 4
 * fields"). Two refinements baked in:
 *   1. The `caps_token` pattern is restricted to metal_tier + group_number.
 *      Applying it to plan_name or insurer_name would false-positive on
 *      legitimate insurer abbreviations (BCBS, UHC, AETNA, ANTHEM, etc.).
 *   2. The `hios_id` pattern is excluded from group_number. Real group
 *      numbers can coincidentally match the 14-char `\d{5}[A-Z]{2}\d{7}`
 *      shape, and the cost of a false-positive (silent data loss) is higher
 *      than the false-negative (HIOS ID leaking into a group_number slot is
 *      implausible — different OCR section).
 *
 * One additional regex tightening vs the Opus spec verbatim: `caps_token`
 * is `/^[A-Z0-9]+(_[A-Z0-9]+)+$/` instead of the spec's `/^[A-Z0-9_]+$/`.
 * Requires at least one underscore-delimited segment so BRONZE / SILVER /
 * GOLD / PLATINUM / CATASTROPHIC (legitimate ACA metal-tier values) don't
 * false-positive when RC-4 lands and metal_tier starts being populated.
 * Still catches the original target shape (HOMP_BR_2024, INSURER_PLAN_CODE).
 *
 * Gated by `garbage_validators_enabled` (mig 121, default ON). Flag check
 * happens at call sites (process-plan.ts, process-eoc.ts, reparse paths);
 * validator itself is flag-agnostic for easier unit testing.
 */

import type { InsurancePlanInsert } from "@/lib/supabase/types";

export type GarbageField =
  | "plan_name"
  | "insurer_name"
  | "metal_tier"
  | "group_number";

export type GarbagePatternName =
  | "hios_label"
  | "hios_id"
  | "faq_answer"
  | "referrals_fragment"
  | "boilerplate_more_info"
  | "boilerplate_policy_doc"
  | "boilerplate_limitations"
  | "caps_token";

interface GarbagePattern {
  name: GarbagePatternName;
  regex: RegExp;
  fields: readonly GarbageField[];
}

const ALL_FIELDS: readonly GarbageField[] = [
  "plan_name",
  "insurer_name",
  "metal_tier",
  "group_number",
] as const;

const TEXT_FIELDS: readonly GarbageField[] = [
  "plan_name",
  "insurer_name",
  "metal_tier",
] as const;

/**
 * Subset of ALL_FIELDS that maps to actual columns on InsurancePlanInsert
 * today. `metal_tier` is excluded — it isn't surfaced on InsurancePlanRow
 * yet (Ing-C RC-4 + RC-1 land it on canonical_plans as `metal_level` and
 * may add it to insurance_plans). When that happens, add `metal_tier` back
 * here (single change; the pattern map already covers it).
 */
const PLAN_INSERT_FIELDS: readonly GarbageField[] = [
  "plan_name",
  "insurer_name",
  "group_number",
] as const;

export const GARBAGE_PATTERNS: readonly GarbagePattern[] = [
  {
    name: "hios_label",
    regex: /\bHIOS Plan ID\b/i,
    fields: ALL_FIELDS,
  },
  {
    name: "hios_id",
    regex: /^\d{5}[A-Z]{2}\d{7}/,
    fields: TEXT_FIELDS, // exclude group_number — real group nums can coincidentally match
  },
  {
    name: "faq_answer",
    regex: /\bNo\.\s+You can\b/i,
    fields: ALL_FIELDS,
  },
  {
    name: "referrals_fragment",
    regex: /\bReferrals\)\s*$/i,
    fields: TEXT_FIELDS,
  },
  {
    name: "boilerplate_more_info",
    regex: /For more information about/i,
    fields: TEXT_FIELDS,
  },
  {
    name: "boilerplate_policy_doc",
    regex: /see the plan or policy document/i,
    fields: TEXT_FIELDS,
  },
  {
    name: "boilerplate_limitations",
    regex: /limitations and exceptions/i,
    fields: TEXT_FIELDS,
  },
  {
    name: "caps_token",
    regex: /^[A-Z0-9]+(_[A-Z0-9]+)+$/, // tighter than spec — requires underscore-delim segments
    fields: ["metal_tier", "group_number"], // exclude plan_name / insurer_name to avoid BCBS/UHC/AETNA false-positives
  },
];

/**
 * Returns the pattern name if `value` matches any garbage pattern enabled
 * for `field`; returns null otherwise — including null/undefined/empty
 * /whitespace input (a missing value is never garbage).
 */
export function findGarbageMatch(
  value: string | null | undefined,
  field: GarbageField,
): GarbagePatternName | null {
  if (!value || !value.trim()) return null;
  for (const pattern of GARBAGE_PATTERNS) {
    if (!pattern.fields.includes(field)) continue;
    if (pattern.regex.test(value)) return pattern.name;
  }
  return null;
}

/**
 * Single-field validation. On garbage match: returns `{ value: null,
 * warning }`. Otherwise: returns `{ value: <unchanged>, warning: null }`.
 * Used by the reparse paths which only know one field at a time.
 */
export function validatePlanField<T extends string | null | undefined>(
  value: T,
  field: GarbageField,
): { value: T | null; warning: string | null } {
  const match = findGarbageMatch(value, field);
  if (match) {
    return { value: null, warning: `${field}_rejected_garbage:${match}` };
  }
  return { value, warning: null };
}

/**
 * Batch validation over the 4 plan-identity fields on a partial
 * InsurancePlanInsert. Returns the cleaned plan (with garbage fields
 * NULLed) + a list of warning strings to append to the caller's existing
 * `parseWarnings` array.
 *
 * Non-mutating — clones `plan` before nulling fields.
 */
export function validatePlanFields(plan: Partial<InsurancePlanInsert>): {
  cleanedPlan: Partial<InsurancePlanInsert>;
  warnings: string[];
} {
  const cleanedPlan: Partial<InsurancePlanInsert> = { ...plan };
  const warnings: string[] = [];

  for (const field of PLAN_INSERT_FIELDS) {
    const value = (cleanedPlan as Record<string, unknown>)[field] as
      | string
      | null
      | undefined;
    const result = validatePlanField(value, field);
    if (result.warning) {
      (cleanedPlan as Record<string, unknown>)[field] = null;
      warnings.push(result.warning);
    }
  }

  return { cleanedPlan, warnings };
}

/**
 * Profile completion percentage helper (S121 B2.1).
 *
 * Per Phase 1 §1.B.2 Rec 8 + D-§1.B.2-G:
 * - Predicate combines the 4 plan-identity fields (insurer + plan_name +
 *   plan_type + state) with the 3 demographic-identity fields (DOB + phone +
 *   zip) — total 7 fields.
 * - Tier mapping: filled=0 → null (hide pill); filled=7 → 100; ≥6/7 → 80; ≥4/7
 *   → 50; otherwise → null. Tiered display progressively encourages completion
 *   per Andrew Q3 direction at S121 (hide when nothing populated).
 */

export interface ProfileCompletionInput {
  insurer: string;
  plan_name: string;
  plan_type: string;
  state: string;
  date_of_birth: string;
  phone: string;
  zip_code: string;
}

export type CompletionTier = 50 | 80 | 100 | null;

export interface ProfileCompletion {
  tier: CompletionTier;
  percentage: number;
  filledCount: number;
  totalCount: number;
}

const REQUIRED_FIELDS: (keyof ProfileCompletionInput)[] = [
  "insurer",
  "plan_name",
  "plan_type",
  "state",
  "date_of_birth",
  "phone",
  "zip_code",
];

export function computeProfileCompletion(
  profile: ProfileCompletionInput,
): ProfileCompletion {
  const filledCount = REQUIRED_FIELDS.filter(
    (f) => !!profile[f] && profile[f].trim().length > 0,
  ).length;
  const totalCount = REQUIRED_FIELDS.length;
  const percentage = Math.round((filledCount / totalCount) * 100);

  let tier: CompletionTier;
  if (filledCount === 0) tier = null;
  else if (filledCount === totalCount) tier = 100;
  else if (percentage >= 80) tier = 80;
  else if (percentage >= 50) tier = 50;
  else tier = null;

  return { tier, percentage, filledCount, totalCount };
}

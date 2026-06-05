/**
 * Compare v2 (S156) — premium suggestion model.
 *
 * Confidence-tiered "ghost suggestion, always editable" (compare_v2 §4.1).
 * Priority: user override > own-plan stored (paycheck share net subsidy) >
 * community avg (≥5, k-anon) > illustrative metal band. Never returns a fabricated
 * $0 as if real (source="none" when nothing is groundable).
 *
 * Forward-compatible: own-plan employee share + subsidy + community avg are
 * OPTIONAL inputs, supplied once the backend payload/flywheel land (PR4 / task #9).
 * Until then `premiumMonthlyFor` still resolves from `premiumTotal` + the band.
 */

export type PremiumFrequency =
  | "monthly"
  | "annual"
  | "yearly"
  | "biweekly"
  | "semimonthly"
  | "weekly"
  | "per_paycheck"
  | string
  | null;

/** Normalize a premium at any frequency to a monthly figure. */
export function normalizePremiumToMonthly(
  amount: number | null | undefined,
  frequency: PremiumFrequency,
): number | null {
  if (amount == null || !Number.isFinite(amount) || amount < 0) return null;
  switch ((frequency ?? "monthly").toString().toLowerCase()) {
    case "annual":
    case "yearly":
      return amount / 12;
    case "biweekly":
      return (amount * 26) / 12;
    case "semimonthly":
      return amount * 2; // 24 pay periods / 12
    case "weekly":
      return (amount * 52) / 12;
    case "per_paycheck": // ambiguous without a pay schedule → treat as monthly equiv (documented)
    case "monthly":
    default:
      return amount;
  }
}

export type PremiumSource = "user_input" | "your_plan" | "community" | "estimate" | "none";
export type PremiumConfidence = "high" | "medium" | "low" | "none";

export interface PremiumSuggestion {
  /** Monthly premium in whole dollars, or null when nothing is groundable. */
  value: number | null;
  source: PremiumSource;
  confidence: PremiumConfidence;
  /** True when safe to drive a yearly-total verdict (confirmed/grounded). */
  grounded: boolean;
  /** Optional caveat tag, e.g. "incl. employer" when only total premium is known. */
  caveat?: string;
}

/** Illustrative monthly premium bands by metal level (single adult, pre-subsidy). ILLUSTRATIVE. */
export const ILLUSTRATIVE_PREMIUM_BANDS: Record<string, number> = {
  catastrophic: 250,
  bronze: 350,
  expanded_bronze: 380,
  silver: 480,
  gold: 600,
  platinum: 760,
};

/** Rule #5 k-anonymity floor for showing a community aggregate. */
export const COMMUNITY_MIN_SAMPLE = 5;

export interface PremiumInputs {
  /** User-entered override for this plan (session or persisted). Authoritative. */
  userOverride?: number | null;
  /** Own-plan stored premium parts (when this column is the user's own plan). */
  ownPlan?: {
    premiumEmployee?: number | null;
    premiumSubsidy?: number | null;
    premiumTotal?: number | null;
    frequency?: PremiumFrequency;
  } | null;
  /** Community flywheel aggregate for this plan (backend; optional). */
  community?: { avgMonthly: number | null; sampleSize: number } | null;
  /** Metal level for the illustrative band fallback. */
  metalLevel?: string | null;
}

/**
 * Resolve the premium suggestion for one plan column (§4.1 priority).
 *
 * `minSample` is the k-anon floor for showing a community average (Rule #5). It
 * defaults to COMMUNITY_MIN_SAMPLE; the server passes the admin-adjustable
 * COMPARE_FLYWHEEL_MIN_MEMBERS (/admin/settings) once the flywheel aggregation
 * read-back lands. Until then no `community` input flows, so the default holds.
 */
export function premiumMonthlyFor(
  inputs: PremiumInputs,
  minSample: number = COMMUNITY_MIN_SAMPLE,
): PremiumSuggestion {
  // 1. explicit user input — authoritative.
  if (
    inputs.userOverride != null &&
    Number.isFinite(inputs.userOverride) &&
    inputs.userOverride >= 0
  ) {
    return {
      value: Math.round(inputs.userOverride),
      source: "user_input",
      confidence: "high",
      grounded: true,
    };
  }

  // 2. own-plan stored — prefer employee paycheck share net subsidy; else total (caveated).
  const own = inputs.ownPlan;
  if (own) {
    if (own.premiumEmployee != null && Number.isFinite(own.premiumEmployee)) {
      const net =
        own.premiumSubsidy != null
          ? Math.max(0, own.premiumEmployee - own.premiumSubsidy)
          : own.premiumEmployee;
      const v = normalizePremiumToMonthly(net, own.frequency ?? null);
      if (v != null) {
        return { value: Math.round(v), source: "your_plan", confidence: "high", grounded: true };
      }
    }
    if (own.premiumTotal != null && Number.isFinite(own.premiumTotal)) {
      const net =
        own.premiumSubsidy != null
          ? Math.max(0, own.premiumTotal - own.premiumSubsidy)
          : own.premiumTotal;
      const v = normalizePremiumToMonthly(net, own.frequency ?? null);
      if (v != null) {
        return {
          value: Math.round(v),
          source: "your_plan",
          confidence: "medium",
          grounded: true,
          caveat: "incl. employer",
        };
      }
    }
  }

  // 3. community flywheel ≥5 (k-anon).
  const c = inputs.community;
  if (
    c &&
    c.avgMonthly != null &&
    Number.isFinite(c.avgMonthly) &&
    c.sampleSize >= minSample
  ) {
    return { value: Math.round(c.avgMonthly), source: "community", confidence: "medium", grounded: true };
  }

  // 4. illustrative metal band — a ghost suggestion, NOT grounded.
  const metal = (inputs.metalLevel ?? "").toString().toLowerCase().replace(/\s+/g, "_");
  const band = ILLUSTRATIVE_PREMIUM_BANDS[metal];
  if (band != null) {
    return { value: band, source: "estimate", confidence: "low", grounded: false };
  }

  // 5. nothing groundable.
  return { value: null, source: "none", confidence: "none", grounded: false };
}

/** Per-plan premium cell state (the design's `premiums` map value). */
export interface PremiumEntry {
  value: number | null;
  confirmed: boolean;
  source: PremiumSource;
  inclEmployer: boolean;
}

/**
 * Derive the default cell entry from a resolved suggestion. `your_plan` and
 * `user_input` read as CONFIRMED (calm, prefilled); `community` and `estimate`
 * read as an unconfirmed GHOST (tinted "Suggested" card that needs accept/enter).
 */
export function suggestionToEntry(s: PremiumSuggestion): PremiumEntry {
  return {
    value: s.value,
    confirmed: s.source === "your_plan" || s.source === "user_input",
    source: s.source,
    inclEmployer: s.caveat === "incl. employer",
  };
}

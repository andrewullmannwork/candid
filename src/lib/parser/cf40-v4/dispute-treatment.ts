/**
 * CF-40 v4 (S73.5 D11) — Dispute letter cite-grade treatment.
 *
 * Per Subplan §2.16 Q-S73.5-35 LOCK. Backend confidence drives dispute letter
 * behavior:
 *
 *   verified         → blockquote, no disclaimer (fact)
 *   user_cite_grade  → blockquote, no disclaimer (user's own doc; their truth)
 *   provisional      → blockquote with disclaimer IFF ≥2 distinct docs AND ≥2
 *                      distinct users in canonical_field_corroboration; else hide
 *   user_no_cite     → hide
 *   inherited        → hide
 *   public_only      → hide
 *
 * Corroboration strength queried from canonical_field_corroboration
 * materialized table (mig 086).
 */

import type { BackendConfidence } from "./badge";

export type DisputeRenderMode = "blockquote" | "hide";

export interface DisputeTreatmentResult {
  mode: DisputeRenderMode;
  disclaimer: string | null;
}

export interface CorroborationStrength {
  distinctDocuments: number;
  distinctUsers: number;
}

/**
 * Query helper signature — callers pass a real Supabase query function or a
 * stub for tests. Returns the corroboration strength for a specific
 * (canonical, service_slug, field, value) tuple.
 */
export type CorroborationStrengthLookup = (input: {
  canonicalPlanId: string;
  serviceSlug: string | null;
  fieldName: string;
  value: unknown;
}) => Promise<CorroborationStrength>;

export interface DisputeTreatmentInput {
  backendConfidence: BackendConfidence;
  /** For 'provisional' tier: canonical + field tuple for corroboration lookup. */
  canonicalPlanId?: string;
  serviceSlug?: string | null;
  fieldName?: string;
  value?: unknown;
  lookupCorroboration?: CorroborationStrengthLookup;
}

/**
 * Subplan §2.16 — getDisputeLetterTreatment. Pure-function for `verified` /
 * `user_cite_grade` / non-citable tiers; calls `lookupCorroboration` for
 * `provisional` to query canonical_field_corroboration.
 */
export async function getDisputeLetterTreatment(
  input: DisputeTreatmentInput,
): Promise<DisputeTreatmentResult> {
  switch (input.backendConfidence) {
    case "verified":
      return { mode: "blockquote", disclaimer: null };
    case "user_cite_grade":
      return { mode: "blockquote", disclaimer: null };
    case "provisional": {
      if (
        !input.lookupCorroboration ||
        !input.canonicalPlanId ||
        !input.fieldName
      ) {
        // No way to query corroboration — graceful degradation = hide.
        return { mode: "hide", disclaimer: null };
      }
      const strength = await input.lookupCorroboration({
        canonicalPlanId: input.canonicalPlanId,
        serviceSlug: input.serviceSlug ?? null,
        fieldName: input.fieldName,
        value: input.value,
      });
      if (strength.distinctDocuments >= 2 && strength.distinctUsers >= 2) {
        return {
          mode: "blockquote",
          disclaimer:
            "Sourced from your uploaded document; corroborated by other Candid members on similar plans.",
        };
      }
      return { mode: "hide", disclaimer: null };
    }
    case "user_no_cite":
    case "inherited":
    case "public_only":
      return { mode: "hide", disclaimer: null };
    default: {
      // Exhaustiveness defense — if a new BackendConfidence tier is added but
      // not handled here, default to hide.
      return { mode: "hide", disclaimer: null };
    }
  }
}

/**
 * Small Claims Court — eligibility check + court info lookup.
 *
 * Checks whether a user's dispute amount is within their state's small claims
 * dollar limit and provides court filing information.
 *
 * Does NOT provide legal advice — informational only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SmallClaimsCourtInfo {
  state: string;
  county: string | null;
  dollarLimitIndividual: number | null;
  filingFeeMin: number | null;
  filingFeeMax: number | null;
  statuteOfLimitationsYears: number | null;
  courtName: string | null;
  courtWebsite: string | null;
  formsUrl: string | null;
  attorneyAllowed: boolean;
  notes: string | null;
  lastVerified: string | null;
  isStale: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
  courtInfo: SmallClaimsCourtInfo | null;
}

/**
 * Check small claims eligibility and return court information.
 */
export async function checkSmallClaimsEligibility(
  supabase: SupabaseClient,
  params: {
    state: string;
    county?: string;
    disputeAmount: number;
  }
): Promise<EligibilityResult> {
  const { state, county, disputeAmount } = params;

  // Look up court info — try county first, fall back to state-level
  let courtData = null;

  if (county) {
    const { data } = await supabase
      .from("small_claims_courts")
      .select("*")
      .eq("state", state)
      .eq("county", county)
      .maybeSingle();
    courtData = data;
  }

  if (!courtData) {
    const { data } = await supabase
      .from("small_claims_courts")
      .select("*")
      .eq("state", state)
      .is("county", null)
      .maybeSingle();
    courtData = data;
  }

  if (!courtData) {
    return {
      eligible: false,
      reason: `No small claims court data available for ${state}. Check your local court's website.`,
      courtInfo: null,
    };
  }

  // Check staleness (> 6 months since last verified)
  const isStale = courtData.last_verified
    ? (Date.now() - new Date(courtData.last_verified).getTime()) / (1000 * 60 * 60 * 24) > 180
    : true;

  const courtInfo: SmallClaimsCourtInfo = {
    state: courtData.state,
    county: courtData.county,
    dollarLimitIndividual: courtData.dollar_limit_individual,
    filingFeeMin: courtData.filing_fee_min,
    filingFeeMax: courtData.filing_fee_max,
    statuteOfLimitationsYears: courtData.statute_of_limitations_years,
    courtName: courtData.court_name,
    courtWebsite: courtData.court_website,
    formsUrl: courtData.forms_url,
    attorneyAllowed: courtData.attorney_allowed ?? true,
    notes: courtData.notes,
    lastVerified: courtData.last_verified,
    isStale,
  };

  // Check dollar limit
  if (courtData.dollar_limit_individual != null && disputeAmount > courtData.dollar_limit_individual) {
    return {
      eligible: false,
      reason: `Your dispute amount ($${disputeAmount.toLocaleString()}) exceeds the small claims limit of $${courtData.dollar_limit_individual.toLocaleString()} in ${state}. Consider consulting an attorney for higher amounts.`,
      courtInfo,
    };
  }

  return {
    eligible: true,
    reason: `Your dispute of $${disputeAmount.toLocaleString()} is within ${state}'s small claims limit${courtData.dollar_limit_individual ? ` of $${courtData.dollar_limit_individual.toLocaleString()}` : ""}.`,
    courtInfo,
  };
}

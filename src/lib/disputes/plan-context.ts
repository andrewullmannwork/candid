/**
 * Dispute letter plan context resolver (Phase 1 of t_dispute_letter_redesign)
 *
 * Given a claim, resolve the user's insurance plan that was active for the
 * claim's plan year, plus the insurer's appeals contact from insurer_catalog.
 *
 * This is what powers the "To:" line of a dispute letter (insurer name +
 * appeals address) and the "Why this should be covered" citations (plan name
 * + plan year). The legacy flow hardcoded "Insurance Appeals Department" +
 * provider name; this resolver returns the real insurer.
 *
 * Behavior when data is missing:
 *   - Claim has no plan_year: derive from date_of_service. If still NULL,
 *     fall back to user's currently-active plan.
 *   - No plan exists for the claim year: returns `missingForYear: <year>`
 *     so the UI can prompt the user to upload their plan for that year.
 *     Letter generation proceeds with provider-name fallback.
 *   - Insurer not in insurer_catalog OR no appeals address seeded: returns
 *     `insurer: null`, letter falls back to provider-name recipient.
 *   - No user plan on file at all: `plan` and `fallbackPlan` both null.
 *
 * Consumers: /api/disputes/generate, /api/disputes/[disputeId],
 * evidence-resolver.ts, DisputeRecipientCard.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AppealsAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
}

export interface InsurerContext {
  id: string;
  name: string;
  appealsAddress: AppealsAddress | null;
  appealsPhone: string | null;
  appealsSource: "admin_verified" | "doc_extraction" | "user_correction" | "unknown" | null;
  appealsLastConfirmedAt: string | null;
  appealsVerificationCount: number;
  needsConfirmation: boolean;
}

export interface ResolvedPlan {
  id: string;
  planName: string | null;
  planYear: number | null;
  insurerName: string | null;
  planType: string | null;
  canonicalPlanId: string | null;
}

/**
 * Provider mailing contact resolved from the linked claim's `claims.metadata.provider`
 * JSONB. Populated by `resolvePlanContext` when called with a `claimId`. Used as the
 * recipient block for non-appeal letter types (overcharge, balance billing, duplicate
 * charge, itemized request, negotiation) where the letter is mailed to the provider
 * billing department rather than the insurer.
 *
 * `source` discriminates how the address was captured:
 *   - 'doc_extraction'  → bill parser pulled it from the EOB/itemized bill
 *   - 'user_correction' → user typed/edited via /api/disputes/[disputeId]/provider-contact
 *   - 'unknown'         → legacy claims without a recorded source (treat as doc_extraction)
 *
 * Address may be null even when the provider name is known (e.g., legacy EOBs that
 * parsed name only). The UI surfaces a Pillar-3 EvidenceGap prompting the user to
 * fill it in before printing.
 */
export interface ProviderContact {
  name: string | null;
  address: string | null;
  phone: string | null;
  npi: string | null;
  source: "doc_extraction" | "user_correction" | "unknown";
}

export interface PlanContext {
  plan: ResolvedPlan | null;
  insurer: InsurerContext | null;
  missingForYear: number | null;
  fallbackPlan: ResolvedPlan | null;
  /**
   * Resolved from the linked claim's `claims.metadata.provider`. Null when
   * resolvePlanContext is called without a claimId, or when the claim row
   * carries no provider metadata. Pillar-1 plumbing for the recipient block
   * of non-appeal dispute letters.
   */
  providerContact: ProviderContact | null;
}

const STALE_THRESHOLD_DAYS = 180;
const DOC_EXTRACTION_MIN_VERIFICATIONS = 3;

export async function resolvePlanContext(
  supabase: SupabaseClient,
  params: {
    userId: string;
    claimId?: string | null;
    planYear?: number | null;
    dateOfService?: string | null;
  }
): Promise<PlanContext> {
  const { userId, claimId } = params;
  let { planYear, dateOfService } = params;
  let providerContact: ProviderContact | null = null;

  // If given a claim, hydrate year + DOS + provider contact from the claim row.
  if (claimId) {
    const { data: claim } = await supabase
      .from("claims")
      .select("plan_year, date_of_service, insurance_plan_id, metadata")
      .eq("id", claimId)
      .eq("user_id", userId)
      .maybeSingle();
    if (claim) {
      if (planYear == null) planYear = claim.plan_year ?? null;
      if (!dateOfService) dateOfService = claim.date_of_service ?? null;
      providerContact = extractProviderContact(claim.metadata);
    }
  }

  if (planYear == null && dateOfService) {
    const m = dateOfService.match(/^(\d{4})/);
    if (m) planYear = parseInt(m[1], 10);
  }

  // Fetch user's plans once; we pick the right one locally. `is_active` is
  // pulled in so we can prefer the active row when multiple rows match the
  // same year/window — happens when the user has duplicate insurance_plans
  // rows (case + name variants from card vs SBC vs PEO uploads). Without
  // this preference, `created_at DESC` ordering would pick the most recent
  // upload, which is often NOT the user's currently-active plan.
  const { data: userPlans } = await supabase
    .from("insurance_plans")
    .select("id, plan_name, plan_year, insurer_name, plan_type, canonical_plan_id, coverage_period_start, coverage_period_end, created_at, is_active")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const plans = userPlans ?? [];

  const yearMatches = planYear != null
    ? plans.filter((p) => p.plan_year === planYear)
    : [];
  // Prefer the active plan among equal-year matches; otherwise newest by
  // created_at (already pre-sorted DESC by the query above).
  const yearMatch = yearMatches.find((p) => p.is_active) ?? yearMatches[0] ?? null;

  const windowMatches = !yearMatch && dateOfService
    ? plans.filter((p) =>
        p.coverage_period_start &&
        p.coverage_period_end &&
        dateOfService! >= p.coverage_period_start &&
        dateOfService! <= p.coverage_period_end)
    : [];
  const windowMatch = windowMatches.find((p) => p.is_active) ?? windowMatches[0] ?? null;

  const resolvedPlan = yearMatch ?? windowMatch ?? null;

  // Fallback plan = any plan on file when no year/window match, so the
  // resolver can still surface *something* useful (e.g., user's 2026 plan
  // when claim is 2025 but no 2025 plan on file yet). Prefer the active
  // row over the most-recently-created so we don't surface a stale or
  // duplicate row.
  const fallbackPlan = !resolvedPlan && plans.length > 0
    ? (plans.find((p) => p.is_active) ?? plans[0])
    : null;

  const missingForYear = planYear != null && !resolvedPlan ? planYear : null;

  const toResolved = (p: typeof plans[number] | null): ResolvedPlan | null =>
    p ? {
      id: p.id,
      planName: p.plan_name,
      planYear: p.plan_year,
      insurerName: p.insurer_name,
      planType: p.plan_type,
      canonicalPlanId: p.canonical_plan_id,
    } : null;

  const activeFor = resolvedPlan ?? fallbackPlan;
  // Try insurer_name first; if that doesn't match insurer_catalog (common when
  // the plan is administered by a PEO whose name was captured instead of the
  // carrier), fall back to matching carrier product keywords in the plan_name
  // (e.g. "Open Access Plus" → Cigna, "Blue Advantage" → Anthem).
  let insurer = await resolveInsurer(supabase, activeFor?.insurer_name ?? null);
  if (!insurer && activeFor?.plan_name) {
    const carrierHint = inferCarrierFromPlanName(activeFor.plan_name);
    if (carrierHint) {
      console.log("[plan-context] trying plan_name-derived carrier hint:", { planName: activeFor.plan_name, hint: carrierHint });
      insurer = await resolveInsurer(supabase, carrierHint);
    }
  }

  return {
    plan: toResolved(resolvedPlan),
    insurer,
    missingForYear,
    fallbackPlan: toResolved(fallbackPlan),
    providerContact,
  };
}

/**
 * Pull a ProviderContact out of `claims.metadata.provider` JSONB. The bill parser
 * (`src/lib/billing/haiku-bill-parser.ts`) extracts `name + npi + address` directly
 * into this shape; we read it back without further normalization. `phone` is not
 * captured by the bill parser today but the field exists for future enrichment
 * (admin tooling, provider directory join, user correction).
 *
 * Returns null when `metadata.provider` is absent or has no usable fields — the
 * caller surfaces a Pillar-3 EvidenceGap prompting the user to fill it in.
 */
function extractProviderContact(metadata: unknown): ProviderContact | null {
  if (!metadata || typeof metadata !== "object") return null;
  const provider = (metadata as { provider?: unknown }).provider;
  if (!provider || typeof provider !== "object") return null;
  const p = provider as {
    name?: unknown;
    address?: unknown;
    phone?: unknown;
    npi?: unknown;
    source?: unknown;
  };
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : null;
  const address = typeof p.address === "string" && p.address.trim() ? p.address.trim() : null;
  const phone = typeof p.phone === "string" && p.phone.trim() ? p.phone.trim() : null;
  const npi = typeof p.npi === "string" && p.npi.trim() ? p.npi.trim() : null;
  // Source defaults to 'doc_extraction' for legacy rows (bill parser writes provider
  // metadata at parse time). Only set 'user_correction' when the provider-contact
  // endpoint stamps the source explicitly.
  const rawSource = typeof p.source === "string" ? p.source : null;
  const source: ProviderContact["source"] =
    rawSource === "user_correction"
      ? "user_correction"
      : rawSource === "doc_extraction"
      ? "doc_extraction"
      : name || address || phone || npi
      ? "doc_extraction"
      : "unknown";

  if (!name && !address && !phone && !npi) return null;
  return { name, address, phone, npi, source };
}

async function resolveInsurer(
  supabase: SupabaseClient,
  insurerName: string | null,
): Promise<InsurerContext | null> {
  if (!insurerName) return null;

  // Try exact match first, then normalized (lowercased, stripped punctuation).
  // insurer_catalog is only a few hundred rows — safe to do sequential lookups.
  let { data: row } = await supabase
    .from("insurer_catalog")
    .select("id, name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_last_confirmed_at, appeals_verification_count")
    .eq("name", insurerName)
    .maybeSingle();
  let matchStage: "exact" | "normalized" | "fuzzy" | "none" = row ? "exact" : "none";

  if (!row) {
    const normalized = normalizeInsurerName(insurerName);
    const { data: byNormalized } = await supabase
      .from("insurer_catalog")
      .select("id, name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_last_confirmed_at, appeals_verification_count")
      .eq("normalized_name", normalized)
      .maybeSingle();
    row = byNormalized;
    if (row) matchStage = "normalized";
  }

  if (!row) {
    // Last resort: broad ilike. Try the head word first (e.g. "Aetna" from
    // "Aetna Life Insurance Company") before the full string, which often
    // has too many qualifiers to match a short catalog name.
    const headWord = insurerName.split(/\s+/)[0];
    const { data: byFuzzy } = await supabase
      .from("insurer_catalog")
      .select("id, name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_last_confirmed_at, appeals_verification_count")
      .or(`name.ilike.%${insurerName}%,name.ilike.%${headWord}%`)
      .limit(1)
      .maybeSingle();
    row = byFuzzy;
    if (row) matchStage = "fuzzy";
  }

  if (!row) {
    console.log("[plan-context] resolveInsurer: no match for", { insurerName });
    return null;
  }
  console.log("[plan-context] resolveInsurer match:", {
    inputName: insurerName,
    matchedName: row.name,
    stage: matchStage,
    hasAppealsAddress: !!row.appeals_address_line_1,
  });

  const hasAddress = !!row.appeals_address_line_1;
  const appealsAddress: AppealsAddress | null = hasAddress
    ? {
        line1: row.appeals_address_line_1!,
        line2: row.appeals_address_line_2 ?? null,
        city: row.appeals_city ?? "",
        state: row.appeals_state ?? "",
        postalCode: row.appeals_postal_code ?? "",
      }
    : null;

  return {
    id: row.id,
    name: row.name,
    appealsAddress,
    appealsPhone: row.appeals_phone ?? null,
    appealsSource: (row.appeals_source as InsurerContext["appealsSource"]) ?? null,
    appealsLastConfirmedAt: row.appeals_last_confirmed_at ?? null,
    appealsVerificationCount: row.appeals_verification_count ?? 0,
    needsConfirmation: computeNeedsConfirmation({
      source: row.appeals_source as InsurerContext["appealsSource"],
      lastConfirmedAt: row.appeals_last_confirmed_at,
      verificationCount: row.appeals_verification_count ?? 0,
      hasAddress,
    }),
  };
}

// Carrier product keyword → insurer_catalog display name. Used when the
// plan row's insurer_name was captured as a PEO / group sponsor instead of
// the actual carrier. Kept narrow — only confident matches.
const CARRIER_PRODUCT_KEYWORDS: Array<{ match: RegExp; carrier: string }> = [
  { match: /open\s+access\s+plus|cigna/i, carrier: "Cigna" },
  { match: /choice\s+plus|united\s*healthcare|uhc/i, carrier: "UnitedHealthcare" },
  { match: /aetna/i, carrier: "Aetna" },
  { match: /humana/i, carrier: "Humana" },
  { match: /kaiser/i, carrier: "Kaiser Permanente" },
  { match: /blue\s+cross\s+blue\s+shield|bcbs|anthem\s+bluecross|blue\s+advantage/i, carrier: "Anthem" },
  { match: /ambetter|centene/i, carrier: "Centene" },
  { match: /molina/i, carrier: "Molina Healthcare" },
  { match: /florida\s+blue/i, carrier: "Florida Blue" },
  { match: /highmark/i, carrier: "Highmark" },
  { match: /premera/i, carrier: "Premera Blue Cross" },
  { match: /regence/i, carrier: "Regence BlueShield" },
  { match: /independence\s+blue/i, carrier: "Independence Blue Cross" },
  { match: /carefirst/i, carrier: "CareFirst BlueCross BlueShield" },
  { match: /horizon\s+(?:bcbs|blue)/i, carrier: "Horizon Blue Cross Blue Shield of New Jersey" },
];

export function inferCarrierFromPlanName(planName: string): string | null {
  for (const { match, carrier } of CARRIER_PRODUCT_KEYWORDS) {
    if (match.test(planName)) return carrier;
  }
  return null;
}

export function normalizeInsurerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\binc\b|\bllc\b|\bco\b|\bcorp(oration)?\b/g, "")
    .trim();
}

function computeNeedsConfirmation(params: {
  source: InsurerContext["appealsSource"];
  lastConfirmedAt: string | null;
  verificationCount: number;
  hasAddress: boolean;
}): boolean {
  if (!params.hasAddress) return true;
  if (!params.lastConfirmedAt) return true;

  const ageMs = Date.now() - new Date(params.lastConfirmedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > STALE_THRESHOLD_DAYS) return true;

  if (
    params.source === "doc_extraction" &&
    params.verificationCount < DOC_EXTRACTION_MIN_VERIFICATIONS
  ) {
    return true;
  }

  return false;
}

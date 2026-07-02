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

/**
 * Block C2.2 (S152) — a user-typed insurer appeals address, stored per-dispute
 * on `dispute.metadata.insurerAddressOverride`. Used for THIS user's letter
 * immediately (Pattern 1 #14 user-scoped write); the shared insurer_catalog
 * address only changes via admin review of the queued community proposal.
 */
export interface InsurerAddressOverride {
  insurerId: string | null;
  insurerName: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  phone: string | null;
  confirmedAt: string;
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
 * S111 D2 — canonical_plans row the user has explicitly bound to this dispute
 * as the bill-year plan (via PlanSearchModal). Drives both letter citations
 * (`templates.ts` canonical_archive bullet variant reads from this field) AND
 * the VerifStrip's bound-verified rendering (the API GET surfaces this at the
 * response's top level so the frontend can render its state without crossing
 * planContext).
 *
 * `badgeLevel` mirrors the Pattern 1 #16 4-tier vocabulary used by
 * /api/plan/search — verified / community / estimated — so the strip's pill
 * is a 1:1 reflection of the canonical's promotion state.
 *
 * Distinct from `archiveCanonicalPlan` (auto-discovered Pattern 2 year-shift
 * match; UI-suggestion only per S111 D1 — never drives citations).
 */
export interface BoundCanonicalPlan {
  id: string;
  planName: string | null;
  planYear: number | null;
  insurerName: string | null;
  planType: string | null;
  canonicalPlanId: string;
  badgeLevel: "verified" | "community" | "estimated";
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
  /**
   * Block C2 — structured address parts when the address was captured structured
   * (via the provider-contact form). Null for legacy rows that only have the
   * `address` display string; the UI pre-fills the structured form from these
   * when present, else leaves the fields blank for the user to enter.
   */
  addressFields: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null;
  /**
   * Block C2 — ISO timestamp when the user confirmed this provider address is
   * correct (claim-scoped, reused across disputes for the same claim). Null when
   * never confirmed. Drives the "Confirm where you got care" → confirmed-state UI.
   */
  confirmedAt: string | null;
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
  /**
   * S109 PR #2 — user's state from profiles.state, used by the dispute letter
   * escalation paragraph to name the state Department of Insurance the user
   * may escalate to. Null when profile state is missing; letter falls back to
   * "the applicable state Department of Insurance".
   */
  userState: string | null;
  /**
   * dispute-letters v2 S1 — user's self-reported insurance funding type from
   * profiles.plan_source ('employer' | 'marketplace' | 'off_exchange' |
   * 'medicare' | 'medicaid'; may also carry a data-provenance marker like
   * 'insurance_card' / 'catalog_match' left by card-scan/search flows). Gates
   * the ERISA citations in the dispute letters: only 'employer' emits ERISA
   * §-cites (§2560.503-1 / §1024(b)(4)); anything else → generic full-and-fair-
   * review. Coarse + fail-safe — only the user's explicit "employer" choice
   * ever sets that value, so the gate can under-fire (→ safe generic) but never
   * over-fire. NOT the data-source `planSource` used by /api/plan/analyze.
   */
  planSource: string | null;
  /**
   * S110 Chunk C — community-corroborated bill-year canonical found via strict
   * Pattern 2 identity year-shift from the user's current plan canonical.
   *
   * S111 D1 refactor — this field is now **UI-suggestion only** (best-match
   * highlight in PlanSearchModal auto mode). It NO LONGER drives letter
   * citations; that's `boundCanonicalPlan` below.
   *
   * Populated when ALL hold:
   *   1. `plan` is null (no exact-year user plan on file)
   *   2. `fallbackPlan.canonicalPlanId` is non-null (anchor gate)
   *   3. `missingForYear` is non-null
   *   4. Strict 5-component match in canonical_plans returns exactly one row
   *
   * Null otherwise.
   */
  archiveCanonicalPlan: ResolvedPlan | null;
  /**
   * S111 D2 — canonical_plans row the user explicitly bound to this dispute
   * (via PlanSearchModal). Distinct from `archiveCanonicalPlan` (auto-
   * suggestion). Drives the canonical_archive bullet variant in templates.ts
   * AND the VerifStrip's bound-verified rendering (API GET surfaces at top
   * level).
   *
   * Populated when `canonicalPlanIdForBillYear` is passed to
   * `resolvePlanContext` AND the canonical row exists. Null otherwise.
   */
  boundCanonicalPlan: BoundCanonicalPlan | null;
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
    /**
     * S111 D2 — when set, resolves `boundCanonicalPlan` for letter-citation
     * use. Passed in by callers that have read it from
     * `dispute.metadata.canonicalPlanIdForBillYear` (or equivalent). Null /
     * undefined → boundCanonicalPlan stays null.
     */
    canonicalPlanIdForBillYear?: string | null;
    /**
     * Block C2.2 (S152) — user-scoped insurer appeals address override, read by
     * the caller from `dispute.metadata.insurerAddressOverride`. Overlaid onto
     * the resolved insurer so the letter, recipient card, readiness, and gaps
     * all use the user's address. Null/undefined → catalog address (status quo).
     */
    insurerAddressOverride?: InsurerAddressOverride | null;
    /**
     * The dispute's EXPLICIT user override — the insurance_plans id the user
     * deliberately chose for THIS dispute via the chooser / re-bind / upload
     * flow (read by the caller from dispute_outcomes.insurance_plan_id). It is
     * written ONLY by explicit user action — never auto-seeded — so when present
     * it wins unconditionally over the claim-anchored plan (product spec #3:
     * "if the user signals a different plan, use that"). Null/undefined →
     * resolution defaults to the claim's DOS-correct plan
     * (claims.insurance_plan_id) per the precedence in the resolver body.
     */
    pinnedInsurancePlanId?: string | null;
  }
): Promise<PlanContext> {
  const { userId, claimId } = params;
  let { planYear, dateOfService } = params;
  let providerContact: ProviderContact | null = null;
  // dispute_plan_pinning_v1 — the claim's DOS-correct plan (set server-side at
  // claim creation), used as the draft-time default pin when no explicit
  // dispute pin is passed (see effectivePin below). Server-sourced, so it is
  // not subject to the body-supplied insurancePlanId trust issue.
  let claimPinnedPlanId: string | null = null;

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
      claimPinnedPlanId = (claim.insurance_plan_id as string | null) ?? null;
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

  // ---- Plan resolution (claim-anchored; the default — no longer flag-gated) --
  // Precedence directly implements the product spec for "which plan was this
  // claim under?":
  //   1. EXPLICIT user override for this dispute (chooser / re-bind / upload) —
  //      a deliberate selection, so it wins unconditionally (#3).
  //   2. The claim's DOS-correct plan (claims.insurance_plan_id, resolved at
  //      claim creation) WHEN it genuinely matches the claim period — "the plan
  //      on file at the time the claim occurred" (#1). Read live (not a frozen
  //      copy), so correcting the claim's plan flows through with no staleness.
  //   3. Otherwise any coverage-window match, then any plan-year match.
  //   4. None → fallbackPlan (active) + missingForYear, which drives the
  //      "same plan in {year}?" upload/confirm prompt (#2 / #4).
  const inWindow = (p: typeof plans[number]): boolean =>
    !!(p.coverage_period_start &&
       p.coverage_period_end &&
       dateOfService &&
       dateOfService >= p.coverage_period_start &&
       dateOfService <= p.coverage_period_end);

  const windowMatches = dateOfService ? plans.filter(inWindow) : [];
  const windowMatch =
    windowMatches.find((p) => p.is_active) ?? windowMatches[0] ?? null;

  // 1. Explicit user override. dispute_outcomes.insurance_plan_id is written
  //    ONLY by explicit user choice (the legacy auto-seed + lazy backfill were
  //    removed, and a migration nulled pre-existing auto-pins), so a non-null
  //    value here is always a deliberate selection and wins outright. Direct-
  //    fetch covers the >1000-plan accounts where it fell outside the bulk cap.
  let explicitOverridePlan: typeof plans[number] | null =
    params.pinnedInsurancePlanId
      ? plans.find((p) => p.id === params.pinnedInsurancePlanId) ?? null
      : null;
  if (params.pinnedInsurancePlanId && !explicitOverridePlan) {
    const { data: pinnedRow } = await supabase
      .from("insurance_plans")
      .select(
        "id, plan_name, plan_year, insurer_name, plan_type, canonical_plan_id, coverage_period_start, coverage_period_end, created_at, is_active",
      )
      .eq("id", params.pinnedInsurancePlanId)
      .eq("user_id", userId)
      .maybeSingle();
    if (pinnedRow) explicitOverridePlan = pinnedRow as typeof plans[number];
  }

  // 2. Claim-anchored plan — only when it's a real match for the claim period.
  //    Guards the Tier-3 active-fallback case in plan-year-resolver (claim
  //    linked to the current active plan because no plan existed for the bill
  //    year): that must surface the prompt, not silently cite a wrong-year plan.
  //    A valid anchor is by definition also a window/year match — this step just
  //    makes the CLAIM's plan win the tiebreak over other same-year duplicate
  //    rows (instead of created_at / is_active ordering).
  const claimAnchorPlan = claimPinnedPlanId
    ? plans.find((p) => p.id === claimPinnedPlanId) ?? null
    : null;
  const claimAnchorValid =
    !!claimAnchorPlan &&
    ((planYear != null && claimAnchorPlan.plan_year === planYear) ||
      inWindow(claimAnchorPlan));

  const resolvedPlan: typeof plans[number] | null =
    explicitOverridePlan ??
    (claimAnchorValid ? claimAnchorPlan : null) ??
    windowMatch ??
    yearMatch ??
    null;

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

  // S111 D2 — bound canonical lookup. Populated when the caller passes
  // `canonicalPlanIdForBillYear` (read from dispute.metadata). Drives both
  // citation rendering (templates.ts canonical_archive bullet) and the
  // VerifStrip's bound-verified state. Resolved EARLY (before
  // resolveInsurer) so the bound canonical's insurer can take precedence
  // for the letter's recipient block + appeals address — required when
  // user binds a canonical from a different insurer than their fallback
  // plan (Smoke iteration 3 bug fix).
  const boundCanonicalPlan =
    params.canonicalPlanIdForBillYear
      ? await lookupBoundCanonical(supabase, params.canonicalPlanIdForBillYear)
      : null;

  // Resolve insurer for the letter recipient block + appeals address.
  // Precedence:
  //   1. Bound canonical's insurer (user explicitly selected this plan, so
  //      its insurer is authoritative for who the dispute is addressed to)
  //   2. activeFor (exact-year plan OR fallback plan).insurer_name
  //   3. Carrier hint inferred from plan_name (handles PEO-captured rows
  //      where insurer_name is the PEO + plan_name carries the carrier
  //      product like "Open Access Plus" → Cigna).
  const preferredInsurerName =
    boundCanonicalPlan?.insurerName ?? activeFor?.insurer_name ?? null;
  let insurer = await resolveInsurer(supabase, preferredInsurerName);

  // Carrier-hint recovery is ONLY for plans whose insurer_name captured a
  // benefits sponsor/administrator (a PEO or TPA) instead of the underlying
  // carrier — e.g. insurer_name "Sequoia One PEO, LLC" with the real carrier
  // hidden in plan_name ("Open Access Plus" → Cigna). It must NOT override a
  // plan whose insurer_name is already a real insurer: "Health Net of CA" must
  // never be silently redirected to "Centene" just because plan_name mentions
  // "Ambetter". The recipient is the insurer the USER's selected plan names.
  if (
    !insurer &&
    activeFor?.plan_name &&
    looksLikeBenefitsAdministrator(preferredInsurerName)
  ) {
    const carrierHint = inferCarrierFromPlanName(activeFor.plan_name);
    if (carrierHint) {
      console.log("[plan-context] insurer_name looks like a PEO/TPA; trying plan_name carrier hint:", {
        insurerName: preferredInsurerName,
        planName: activeFor.plan_name,
        hint: carrierHint,
      });
      insurer = await resolveInsurer(supabase, carrierHint);
    }
  }

  // Recipient identity = the user's selected plan's insurer. When the catalog
  // has no row for it (so no appeals address on file), still address the letter
  // to that insurer BY NAME — display-only, no address — instead of leaving the
  // recipient null (which falls through to the provider in the recipient block)
  // or fuzzy-matching an unrelated insurer. The missing address is surfaced
  // separately via the `insurer_address_missing` gap (keyed off appealsAddress,
  // not the insurer object) and the user can supply it through the per-dispute
  // address override. This is what guarantees a letter for "Health Net of CA"
  // is addressed to Health Net of CA, never to a stranger like "22 Health".
  if (!insurer && preferredInsurerName) {
    insurer = {
      id: "",
      name: preferredInsurerName,
      appealsAddress: null,
      appealsPhone: null,
      appealsSource: null,
      appealsLastConfirmedAt: null,
      appealsVerificationCount: 0,
      needsConfirmation: true,
    };
  }

  // Block C2.2 (S152) — overlay the user's per-dispute insurer appeals address
  // override (Pattern 1 #14 user-scoped write) so this letter mails to the
  // address the user supplied. Cascades to the letter body
  // (buildInsurerRecipientBlock), the recipient card, the readiness floor, and
  // suppresses the insurer_address_missing gap. The shared catalog address is
  // untouched — it only changes via admin review of the queued proposal.
  const ov = params.insurerAddressOverride;
  if (ov && ov.addressLine1 && ov.city && ov.state && ov.postalCode) {
    const overrideAddress: AppealsAddress = {
      line1: ov.addressLine1,
      line2: ov.addressLine2 ?? null,
      city: ov.city,
      state: ov.state,
      postalCode: ov.postalCode,
    };
    insurer = insurer
      ? {
          ...insurer,
          appealsAddress: overrideAddress,
          appealsPhone: ov.phone ?? insurer.appealsPhone,
          appealsSource: "user_correction",
          appealsLastConfirmedAt: ov.confirmedAt ?? insurer.appealsLastConfirmedAt,
          needsConfirmation: false,
        }
      : {
          id: ov.insurerId ?? "",
          name: ov.insurerName ?? preferredInsurerName ?? "Your insurer",
          appealsAddress: overrideAddress,
          appealsPhone: ov.phone ?? null,
          appealsSource: "user_correction",
          appealsLastConfirmedAt: ov.confirmedAt ?? null,
          appealsVerificationCount: 0,
          needsConfirmation: false,
        };
  }

  // S109 PR #2 — pull user's state for the dispute letter escalation paragraph
  // (names the state Department of Insurance the user may escalate to).
  // dispute-letters v2 S1 — also pull plan_source (self-reported funding type) to
  // gate the ERISA citations. Null when the profile field is missing → generic copy.
  const { data: profile } = await supabase
    .from("profiles")
    .select("state, plan_source")
    .eq("user_id", userId)
    .maybeSingle();
  const userState = (profile?.state as string | null) ?? null;
  const planSource = (profile?.plan_source as string | null) ?? null;

  // S110 Chunk C — community-corroborated bill-year canonical auto-lookup.
  // Only fires when (a) no exact-year user plan, (b) fallback plan has a
  // canonical anchor, (c) bill year known. The lookup itself enforces strict
  // 5-component identity + uniqueness.
  //
  // S111 D1 refactor: this field is **UI-suggestion only** (used as best-match
  // highlight in PlanSearchModal auto mode). It NO LONGER drives letter
  // citations; the evidence-resolver coverage chain dropped the archive Tier
  // per D1, and `templates.ts` canonical_archive reads from
  // `boundCanonicalPlan` (manual bind) instead. Pattern 1 #2 enforcement —
  // citations require explicit user binding.
  let archiveCanonicalPlan: ResolvedPlan | null = null;
  const fallbackAnchorId = fallbackPlan?.canonical_plan_id ?? null;
  if (!resolvedPlan && fallbackAnchorId && missingForYear != null) {
    archiveCanonicalPlan = await lookupArchiveCanonical(
      supabase,
      fallbackAnchorId,
      missingForYear,
    );
  }

  return {
    plan: toResolved(resolvedPlan),
    insurer,
    missingForYear,
    fallbackPlan: toResolved(fallbackPlan),
    providerContact,
    userState,
    planSource,
    archiveCanonicalPlan,
    boundCanonicalPlan,
  };
}

/**
 * S111 D2 — bound canonical lookup for letter-citation use.
 *
 * Given a canonical_plans id (the user's explicit bill-year plan selection
 * via PlanSearchModal), returns a BoundCanonicalPlan with insurer name and
 * Pattern 1 #16 badge level (verified / community / estimated). Returns null
 * when the row doesn't exist (orphan reference — Pattern 1 #2 preserved at
 * the data layer: never cite a canonical that doesn't exist).
 *
 * Badge derivation mirrors /api/plan/search/route.ts `deriveBadgeLevel`. Kept
 * inline rather than extracted to keep blast radius small; if a third caller
 * surfaces, lift to a shared util.
 */
async function lookupBoundCanonical(
  supabase: SupabaseClient,
  canonicalPlanId: string,
): Promise<BoundCanonicalPlan | null> {
  const { data: canonical, error } = await supabase
    .from("canonical_plans")
    .select(
      "id, plan_name, plan_year, plan_type, insurer_id, source_count, is_verified, field_provenance",
    )
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (error || !canonical) return null;

  let insurerName: string | null = null;
  if (canonical.insurer_id) {
    const { data: insurer } = await supabase
      .from("insurer_catalog")
      .select("name")
      .eq("id", canonical.insurer_id)
      .maybeSingle();
    insurerName = insurer?.name ?? null;
  }

  const badgeLevel = deriveBoundCanonicalBadgeLevel(
    canonical.field_provenance,
    canonical.source_count as number | null,
    canonical.is_verified as boolean | null,
  );

  return {
    id: canonical.id as string,
    planName: (canonical.plan_name as string | null) ?? null,
    planYear: (canonical.plan_year as number | null) ?? null,
    insurerName,
    planType: (canonical.plan_type as string | null) ?? null,
    canonicalPlanId: canonical.id as string,
    badgeLevel,
  };
}

function deriveBoundCanonicalBadgeLevel(
  fieldProvenance: unknown,
  sourceCount: number | null,
  isVerified: boolean | null,
): BoundCanonicalPlan["badgeLevel"] {
  if (isVerified === true) return "verified";
  if (fieldProvenance && typeof fieldProvenance === "object") {
    const provenance = fieldProvenance as Record<string, { source?: unknown }>;
    for (const key of Object.keys(provenance)) {
      const entry = provenance[key];
      if (
        entry &&
        typeof entry === "object" &&
        (entry.source === "admin_attested" || entry.source === "candid_verified")
      ) {
        return "verified";
      }
    }
  }
  if ((sourceCount ?? 0) >= 2) return "community";
  return "estimated";
}

/**
 * S110 Chunk C — Pattern 2 identity year-shift lookup.
 *
 * Given a canonical_plan_id (anchor — the user's current plan canonical) and
 * a target plan_year (the bill year), find the canonical_plans row that
 * represents THE SAME PLAN for the target year. Strict 5-component identity
 * gate (insurer_id + plan_name normalized + state + metal_level + plan_type)
 * + uniqueness gate (must return exactly one row to be confident).
 *
 * Why strict + unique:
 *   - Pattern 1 #2 ("no fabricated citations") demands high precision. False
 *     positive (matching the wrong plan's bill-year version) = citing terms
 *     that aren't actually the user's bill-year plan.
 *   - Asymmetric risk: false negative just falls through to user_fallback
 *     (cite current plan with year disclosed); false positive is a Pattern
 *     1 #2 violation. Bias toward strict matching.
 *
 * Components dropped from full Pattern 2 (employer/network/HIOS) because
 * those drift legitimately year-over-year and would cause false negatives.
 * Plan_name uses LOWER+TRIM normalization (whitespace + case insensitive)
 * per feedback_candid_recall_over_precision — no fuzzy matching.
 *
 * Returns null on any of: anchor missing identity components, no match,
 * multiple matches (ambiguous), DB error.
 */
async function lookupArchiveCanonical(
  supabase: SupabaseClient,
  anchorCanonicalPlanId: string,
  billYear: number,
): Promise<ResolvedPlan | null> {
  // Step 1 — fetch the anchor canonical to read its identity components.
  const { data: anchor, error: anchorErr } = await supabase
    .from("canonical_plans")
    .select("insurer_id, plan_name, plan_type, state, metal_level")
    .eq("id", anchorCanonicalPlanId)
    .maybeSingle();

  if (anchorErr || !anchor) {
    console.log("[plan-context] archive lookup: anchor canonical fetch failed", {
      anchorCanonicalPlanId,
      err: anchorErr?.message ?? null,
    });
    return null;
  }

  // Strict 5-component requirement: any missing component → abstain. Most
  // common cause is non-ACA / employer-sponsored plans without metal_level.
  if (
    !anchor.insurer_id ||
    !anchor.plan_name ||
    !anchor.state ||
    !anchor.metal_level ||
    !anchor.plan_type
  ) {
    console.log("[plan-context] archive lookup: anchor missing identity components", {
      anchorCanonicalPlanId,
      hasInsurerId: !!anchor.insurer_id,
      hasPlanName: !!anchor.plan_name,
      hasState: !!anchor.state,
      hasMetalLevel: !!anchor.metal_level,
      hasPlanType: !!anchor.plan_type,
    });
    return null;
  }

  // Step 2 — find canonical(s) for bill year matching insurer + state +
  // metal + plan_type. Plan-name matched in-memory after LOWER+TRIM to avoid
  // ILIKE wildcard interpretation on user-uploaded names that may contain
  // literal `%` or `_`.
  const { data: candidates, error: matchErr } = await supabase
    .from("canonical_plans")
    .select("id, plan_name, plan_year, plan_type, state, metal_level, insurer_id")
    .eq("insurer_id", anchor.insurer_id)
    .eq("state", anchor.state)
    .eq("metal_level", anchor.metal_level)
    .eq("plan_type", anchor.plan_type)
    .eq("plan_year", billYear);

  if (matchErr) {
    console.log("[plan-context] archive lookup: candidate query failed", {
      err: matchErr.message,
    });
    return null;
  }

  const normalizedAnchorName = anchor.plan_name.toLowerCase().trim();
  const matches = (candidates ?? []).filter(
    (c) =>
      typeof c.plan_name === "string" &&
      c.plan_name.toLowerCase().trim() === normalizedAnchorName,
  );

  // Uniqueness gate — abstain on 0 or >1 results.
  if (matches.length !== 1) {
    console.log("[plan-context] archive lookup: no unique match", {
      anchorCanonicalPlanId,
      billYear,
      candidateCount: candidates?.length ?? 0,
      exactNameMatchCount: matches.length,
    });
    return null;
  }

  const match = matches[0];

  // Hydrate insurer display name for the resulting ResolvedPlan.
  const { data: insurer } = await supabase
    .from("insurer_catalog")
    .select("name")
    .eq("id", match.insurer_id)
    .maybeSingle();

  console.log("[plan-context] archive lookup match", {
    anchorCanonicalPlanId,
    billYear,
    archiveCanonicalId: match.id,
    archivePlanName: match.plan_name,
    archiveInsurer: insurer?.name ?? match.insurer_id,
  });

  return {
    id: match.id,
    planName: match.plan_name ?? null,
    planYear: match.plan_year ?? null,
    insurerName: insurer?.name ?? null,
    planType: match.plan_type ?? null,
    canonicalPlanId: match.id,
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
    addressFields?: unknown;
    confirmedAt?: unknown;
  };
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : null;
  const address = typeof p.address === "string" && p.address.trim() ? p.address.trim() : null;
  const phone = typeof p.phone === "string" && p.phone.trim() ? p.phone.trim() : null;
  const npi = typeof p.npi === "string" && p.npi.trim() ? p.npi.trim() : null;

  // Block C2 — structured address parts (null-safe; legacy rows have none).
  const strField = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const af =
    p.addressFields && typeof p.addressFields === "object"
      ? (p.addressFields as Record<string, unknown>)
      : null;
  const addressFields = af
    ? {
        addressLine1: strField(af.addressLine1),
        addressLine2: strField(af.addressLine2),
        city: strField(af.city),
        state: strField(af.state),
        postalCode: strField(af.postalCode),
      }
    : null;
  const confirmedAt = strField(p.confirmedAt);
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
  return { name, address, phone, npi, source, addressFields, confirmedAt };
}

// Exported for the plan-resolution verification harness (no test framework in
// this repo); callers should go through resolvePlanContext, which adds the
// plan-name carrier hint + display-only synthesis around this catalog lookup.
export async function resolveInsurer(
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
    // Last resort: a TIGHT, anchored token-prefix match. We only accept a
    // catalog row whose normalized name is a contiguous *leading* token-prefix
    // of the input insurer name — e.g. catalog "Cigna" recovers from the
    // verbose plan-supplied "Cigna Health and Life Insurance Co.".
    //
    // This replaces the old `.or(name.ilike.%input%, name.ilike.%headWord%)
    // .limit(1)` fallback, which blew up on generic first tokens: input
    // "Health Net of CA" → `%Health%` matched 86 unrelated rows and `.limit(1)`
    // returned an arbitrary one ("22 Health"). Anchoring on the first token
    // makes that impossible — "22 Health" begins with "22", not "Health", so it
    // can never match "Health Net of CA". When nothing is a true prefix we
    // abstain (return null) and the caller addresses the letter to the plan's
    // own insurer_name rather than a stranger.
    const inputTokens = normalizeInsurerName(insurerName).split(" ").filter(Boolean);
    const firstToken = inputTokens[0] ?? "";
    // Guard against ILIKE wildcard injection from user-supplied names: only
    // probe when the first token is plain alphanumerics.
    if (inputTokens.length > 0 && /^[a-z0-9]+$/.test(firstToken)) {
      const { data: candidates } = await supabase
        .from("insurer_catalog")
        .select("id, name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_last_confirmed_at, appeals_verification_count")
        .ilike("name", `${firstToken}%`); // name must BEGIN with the input's first token
      const prefixMatches = (candidates ?? [])
        .map((c) => ({ c, toks: normalizeInsurerName(c.name).split(" ").filter(Boolean) }))
        .filter(({ toks }) =>
          toks.length > 0 &&
          toks.length <= inputTokens.length &&
          toks.every((t, i) => t === inputTokens[i]),
        )
        // Most specific (longest) prefix wins; reject ties as ambiguous.
        .sort((a, b) => b.toks.length - a.toks.length);
      const unambiguous =
        prefixMatches.length === 1 ||
        (prefixMatches.length > 1 && prefixMatches[0].toks.length > prefixMatches[1].toks.length);
      if (unambiguous) {
        row = prefixMatches[0].c;
        matchStage = "fuzzy";
      }
    }
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

/**
 * A plan's insurer_name sometimes captures the benefits sponsor/administrator
 * (a PEO, TPA, or third-party benefit administrator) rather than the underlying
 * carrier. ONLY in that case should the letter recipient fall back to a
 * plan_name-derived carrier hint (inferCarrierFromPlanName). For a real insurer
 * name like "Health Net of CA" we trust the user's selected plan and never
 * redirect to a guessed carrier. Kept deliberately narrow — these tokens do not
 * appear in any real carrier's display name.
 */
export function looksLikeBenefitsAdministrator(name: string | null): boolean {
  if (!name) return false;
  return /\b(peo|tpa)\b|third[-\s]?party admin|benefits? admin(?:istrator)?s?/i.test(name);
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

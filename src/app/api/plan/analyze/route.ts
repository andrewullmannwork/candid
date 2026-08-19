import { NextResponse, type NextRequest } from "next/server";
import { analyzePlan } from "@/lib/plan/analyzer";
import { lookupBenefitProseByCategory } from "@/lib/plan/benefits-catalog";
import { createServerClient } from "@/lib/supabase/server";
import { loadDecorationContext, type DecorationContext } from "@/lib/plan/analyze-decoration";
import { decorateFieldFromEntry } from "@/lib/parser/consumer-read";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";
import { resolveCanonicalSlugs } from "@/lib/parser/canonical-resolution";
import { loadCatalogIdentity } from "@/lib/plan/catalog-identity";
import { readUsedBenefits } from "@/lib/plan/benefit-usage";
import { formatInNetworkCost, formatOutOfNetworkCost } from "@/lib/plan/cost-share-format";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  resolveEocReaderSurfaces,
  extractServiceCoverageDetail,
  prettifySlug,
  type ListedService,
  type EocReaderSurfaces,
} from "@/lib/plan/eoc-reader-resolution";

export async function POST(request: NextRequest) {
  try {
    const authedUser = await requireAuthenticatedUser(request);
    if (!authedUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Authoritative userId comes from the verified Firebase token, not the
    // request body. Closes B9-1 §C2 IDOR.
    const userId = authedUser.id;

    const supabase = createServerClient();

    // Fetch user profile with demographics + plan match
    // B9 B1.2 — userScoped injects .eq("user_id", userId) (op-equivalent to the prior explicit filter).
    const { data: profile, error } = await userScoped(supabase, userId)
      .table("profiles")
      .select("insurer, plan_type, state, date_of_birth, sex, dependents, matched_plan_id, plan_source, active_insurance_plan_id, deductible_individual, oop_max_individual, county_fips")
      .single();

    if (error || !profile) {
      return NextResponse.json(
        { error: "Profile not found. Please complete your profile first." },
        { status: 404 }
      );
    }

    // Parse dependents to check for children
    let hasDependents = false;
    let hasChildren = false;
    try {
      const deps = profile.dependents || [];
      hasDependents = deps.length > 0;
      hasChildren = deps.some((d: { relationship: string }) => d.relationship === "child");
    } catch { /* empty */ }

    // ── Priority 0: User has insurance_plans + plan_covered_services ────
    // Merge: use the benefits catalog for rich educational content (descriptions,
    // whyUnderutilized, howToAccess) and overlay with actual cost sharing data
    // from the user's uploaded plan documents.
    if (profile.active_insurance_plan_id) {
      // B9 B1.2 — scope the active-plan read to the owner (id comes from the user's own
      // profile; userScoped adds .eq("user_id") → closes a latent foreign read, Pattern-B).
      const { data: userPlan } = await userScoped(supabase, userId)
        .table("insurance_plans")
        .select("*")
        .eq("id", profile.active_insurance_plan_id)
        .maybeSingle();

      if (userPlan) {
        // Phase 4 Task 4-B: load consumer-read filter decoration context.
        // Returns null when consumer_read_filter_v1 flag is OFF — response stays
        // byte-identical to pre-Phase-4. Returns context object when flag ON;
        // callers thread context through decorateFieldFromEntry() per field.
        const decoration: DecorationContext | null = await loadDecorationContext(
          supabase,
          authedUser.email,
          userPlan,
        );

        // S202 (block spec [[eoc_content_type_routing]] §9): EOC reader-resolution.
        // When OFF, the analyze response gains NONE of the reader fields (per-service
        // Surface 1 detail + the top-level eocReader aggregate) — byte-identical to today.
        const eocReaderOn = await isFeatureEnabled("eoc_reader_resolution_v1");

        // A3 (cite-grade gate): when ON, a synonym-inferred cell (field_provenance.resolution_source
        // set + unconfirmed) caps to `estimate` and is referenced-not-quoted via decorateFieldFromEntry.
        // Also conditions the cold-start section relabel below. OFF → byte-identical; dormant until
        // thesaurus_phase1a_v1 stamps cells.
        const citeGradeGateOn = await isFeatureEnabled("cite_grade_gate_v1");

        // Local helpers — keep route.ts self-contained for the Task 4-B atomic shape.
        // Future Tasks 4-D + 4-E may extract to a shared util when 3+ call sites need them.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function getProv(row: any, key: string): FieldProvenanceEntry | undefined {
          const fp = row?.field_provenance;
          if (!fp || typeof fp !== "object") return undefined;
          const entry = (fp as Record<string, unknown>)[key];
          return entry as FieldProvenanceEntry | undefined;
        }
        function maybeDecorate<T>(
          value: T,
          entry: FieldProvenanceEntry | undefined,
          source: string,
          sourceCount: number,
        ): T | ReturnType<typeof decorateFieldFromEntry<T>> {
          if (!decoration) return value;
          return decorateFieldFromEntry(value, entry, {
            sourceCount,
            source,
            multiSourceThreshold: decoration.multiSourceThreshold,
            identityGateOn: citeGradeGateOn,
          });
        }

        // B9 B1.2 — plan_covered_services has no user_id; read via the parent-join layer
        // (the parent insurance_plan is owned-verified by construction). The !inner join is
        // sent via the columns string; the `merged_into_id IS NULL` filter is re-applied in
        // JS (the primitive takes columns only) — op-equivalent: a foreign plan yields [],
        // and the owner's row set is identical to the prior query.
        const coveredRows = await selectOwnedChildren(
          supabase,
          userId,
          "plan_covered_services",
          [userPlan.id],
          "*, service_catalog!inner(slug, name, category, merged_into_id)",
        );
        const coveredServices = coveredRows.filter(
          (cs) => (cs.service_catalog?.merged_into_id ?? null) === null,
        );

        // ── S72 commit 5: plan-level access-instructions fallback ──
        // When plan_doc Haiku extracted plan-level customer service phone / network
        // finder URL (commit 5 persistence writes to insurance_plans.metadata.plan_doc_access_instructions),
        // surface as fallback in the howToAccess render-priority chain when per-service
        // coverage_rules.how_to_access is null. Replaces generic "Contact your insurer
        // for details" boilerplate with plan-specific copy where available.
        const planDocAccessMeta = (
          (userPlan.metadata as Record<string, unknown> | null)?.plan_doc_access_instructions as
            | Record<string, unknown>
            | undefined
        );
        const planLevelCustomerServicePhone =
          typeof planDocAccessMeta?.customer_service_phone === "string"
            ? (planDocAccessMeta.customer_service_phone as string)
            : null;
        const planLevelNetworkFinderUrl =
          typeof planDocAccessMeta?.network_finder_url === "string"
            ? (planDocAccessMeta.network_finder_url as string)
            : null;
        const planLevelAccessFallback: string | null = planLevelCustomerServicePhone
          ? `Call ${planLevelCustomerServicePhone} to confirm coverage${planLevelNetworkFinderUrl ? ` or find a provider at ${planLevelNetworkFinderUrl}` : ""}.`
          : planLevelNetworkFinderUrl
            ? `Find a covered provider at ${planLevelNetworkFinderUrl}.`
            : null;

        // S289 — cost-share display formatting extracted to the shared,
        // fixture-asserted module (src/lib/plan/cost-share-format.ts) so every
        // producer of `costDescription` (user-row path AND canonical gap-fill)
        // runs the same named rule. Local aliases keep call sites readable.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatCost = (s: any): string => formatInNetworkCost(s);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatOonCost = (s: any, planType: string | null): string =>
          formatOutOfNetworkCost(s, planType);

        function cleanDescription(raw: string): string {
          return raw
            .replace(/\s+/g, " ").trim()
            .replace(/\bTier\s*(\d)/gi, "Tier $1")
            .replace(/\b(\d+)\s*day\b/gi, "$1-day")
            .replace(/\bnon\s*emergency\b/gi, "non-emergency")
            .replace(/\bEmergent\b/g, "Emergency")
            .replace(/\bfollowed by\b/gi, "and")
            .replace(/\bRx\b/g, "Rx")
            .replace(/^[a-z]/, (c) => c.toUpperCase());
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function buildServiceDescription(s: any): string {
          if (s.covered === false) return "Not covered under this plan.";
          const parts: string[] = [];
          if (s.in_cost_description) {
            parts.push(`In-network: ${cleanDescription(s.in_cost_description)}`);
          } else {
            const cost = formatCost(s);
            if (cost !== "Covered") parts.push(`In-network: ${cost}`);
            else parts.push("Covered in-network");
          }
          if (s.annual_limit) parts.push(`Limit: ${s.annual_limit}`);
          if (s.prior_auth_required) parts.push("Prior authorization required");
          return parts.join(". ") + ".";
        }

        // S288 plan-flow unification: a link-only catalog plan (search-select /
        // "Change plan") has ZERO user coverage rows — its coverage lives
        // entirely behind canonical_plan_id. The old user-rows-only guard made
        // analyze skip its own canonical branch and fall through to the static
        // plan-type catalog ("Set up your profile" on a set-up account). Enter
        // Priority 0 whenever there are user rows OR a canonical link; every
        // path inside tolerates an empty user set (the canonical gap-fill then
        // supplies the full benefit list).
        if ((coveredServices && coveredServices.length > 0) || userPlan.canonical_plan_id) {
          // S99 B5: pre-resolve each row's slug to its canonical sibling (via
          // service_catalog.concept_id grouping). post-S95 reset, no aliases
          // exist; this is identity. Once admin promotes the first proposed_*
          // slug as an alias, raw alias rows will surface their canonical slug
          // in the API response so display consumers can dedupe + group.
          const rawSlugsForCanonical = coveredServices
            .map((s) => s.service_catalog?.slug)
            .filter((s): s is string => typeof s === "string" && s.length > 0);
          const canonicalSlugMap = await resolveCanonicalSlugs(rawSlugsForCanonical, supabase);

          // Reverse slug map: service slug → catalog benefit educational content.
          // S94 B1: keys use canonical 68-slug vocabulary; legacy slug aliases retained
          // defensively for any pre-S94 data still rendering.
          // item 4 (mig 183): composite "slug:virtual" keys route telehealth place
          // variants to "telehealth-primary" instead of the default catalog entry.
          const SLUG_TO_CATALOG: Record<string, string> = {
            // canonical (post-S94)
            pcp_visit: "annual-physical",
            annual_physical: "annual-physical",
            preventive_care: "annual-physical",
            mental_health_outpatient: "therapy-sessions",
            substance_abuse_outpatient: "substance-abuse",
            pt_rehab: "physical-therapy",
            ot_rehab: "occupational-therapy",
            speech_therapy: "speech-therapy",
            chiropractic: "chiro-visits",
            acupuncture: "acupuncture",
            specialist_visit: "cancer-screenings",
            cancer_screening: "cancer-screenings",
            prenatal_visit: "prenatal-care",
            durable_medical_equipment: "breast-pump",
            // place-aware composite keys (slug:place_of_service) — checked before slug-only fallback
            "pcp_visit:virtual": "telehealth-primary",
            "specialist_visit:virtual": "telehealth-primary",
            // (S289) the former telehealth_pcp/telehealth_specialist dead-slug aliases are gone:
            // the gap-fill path now resolves stored slugs through loadCatalogIdentity (merge-chain
            // aware) and keys this lookup on the LIVE slug; mig 213 also remaps the 7 stored
            // dead-slug rows onto pcp_visit/specialist_visit @ place_of_service='virtual'.
            // legacy aliases (pre-S94 data; safe to remove once S94 backfill complete)
            physical_therapy: "physical-therapy",
            occupational_therapy: "occupational-therapy",
            telehealth: "telehealth-primary",
            maternity_prenatal: "prenatal-care",
          };

          // Build static catalog unconditionally — used by both user-covered-services
          // path (line ~280) and canonical-gap-fill path (line ~369) so prose
          // back-fill per feedback_benefits_prose_preserve works for both sources.
          // analyzePlan is pure compute over the in-memory BENEFITS_CATALOG; cost
          // is negligible (~20-entry array filter).
          const catalogResult = analyzePlan({
            insurer: userPlan.insurer_name || profile.insurer || "",
            planType: userPlan.plan_type || profile.plan_type || "",
            state: profile.state || "",
            dateOfBirth: profile.date_of_birth || undefined,
            sex: undefined,
            hasDependents,
            hasChildren,
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catalogBenefitMap = new Map<string, any>(
            catalogResult.benefits.map((b) => [b.benefit.id, b.benefit])
          );

          // Build a benefit per covered service
          const benefits = coveredServices.map((s) => {
            const slug = s.service_catalog?.slug || "unknown";
            // S99 B5: canonical sibling resolution. Until admin promotes an
            // alias, canonicalSlug === slug (no-op). Surface separately on the
            // response so display consumers can group/dedupe; benefit.id stays
            // the raw slug to preserve React key + interaction state (composite
            // key from S98 keys by raw benefit.id + place_of_service).
            const canonicalSlug = canonicalSlugMap.get(slug) ?? slug;
            const rawName = s.service_catalog?.name || slug.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
            const name = cleanDescription(rawName);
            const category = s.service_catalog?.category || "other";

            // Find catalog educational content if available.
            // Composite key (slug:place_of_service) checked first so virtual
            // pcp_visit/specialist_visit resolve to "telehealth-primary" not
            // "annual-physical"/"cancer-screenings" (item 4, mig 183).
            const catalogId =
              (s.place_of_service === "virtual" ? SLUG_TO_CATALOG[`${slug}:virtual`] : undefined)
              ?? SLUG_TO_CATALOG[slug];
            const catalogBenefit = catalogId ? catalogBenefitMap.get(catalogId) : undefined;

            const isNotCovered = s.covered === false;
            // Phase 4 Task 4-B: when decoration context is present, wrap P-8-eligible
            // numeric/boolean fields in DecoratedValue<T>. plan_covered_services rows
            // are self-source — sourceCount=1, threshold=0 in consumer-read library
            // for non-canonical sources.
            const rowSource: string = s.source ?? "doc_extraction";
            return {
              serviceSlug: slug,
              // S99 B5 — canonical sibling for alias dedupe. Equal to serviceSlug
              // when there's no alias relationship (the current post-S95 state).
              canonicalServiceSlug: canonicalSlug,
              // S98 — surface place_of_service so the /plan render can build
              // a unique React key for POS-variant rows that share the same
              // benefit.id (e.g., mental_health_outpatient at pcp_office vs
              // specialist_office vs outpatient_facility). Interaction state
              // (toggle/expand) still tracks by benefit.id intentionally —
              // user-level "I use Mental Health Outpatient" is one benefit
              // semantically; the row split is purely cost-sharing detail.
              placeOfService: (s.place_of_service as string | null) ?? "any",
              benefit: {
                id: slug,
                category,
                title: name,
                description: buildServiceDescription(s),
                whyUnderutilized: catalogBenefit?.whyUnderutilized || "",
                // S72 commit 5: per-service access-instructions render priority chain
                // (master plan §S72): per-service coverage_rules.how_to_access (extracted
                // by plan_doc Haiku) → plan-level customerServicePhone / networkFinderUrl
                // (extracted by plan_doc Haiku; stored in insurance_plans.metadata) →
                // catalog-curated howToAccess → generic boilerplate fallback.
                howToAccess: isNotCovered
                  ? ""
                  : (
                      ((s.coverage_rules as Record<string, unknown> | null)?.how_to_access as string | undefined) ||
                      planLevelAccessFallback ||
                      catalogBenefit?.howToAccess ||
                      "Contact your insurer for details."
                    ),
                hsaFsaEligible: isNotCovered ? false : (catalogBenefit?.hsaFsaEligible || false),
                planTypes: [userPlan.plan_type || ""],
              },
              categoryLabel: category,
              relevanceNote: `Your ${userPlan.plan_name || "plan"}: ${isNotCovered ? "Not covered" : formatCost(s)}`,
              relevanceScore: isNotCovered ? 0 : 90,
              isRecommended: !isNotCovered,
              costSharing: {
                inNetwork: {
                  copay: maybeDecorate<number | null>(isNotCovered ? null : s.in_copay, getProv(s, "in_copay"), rowSource, 1),
                  coinsurance: maybeDecorate<number | null>(isNotCovered ? null : s.in_coinsurance, getProv(s, "in_coinsurance"), rowSource, 1),
                  deductibleApplies: isNotCovered ? false : s.in_deductible_applies,
                  costDescription: isNotCovered ? "Not covered" : (s.in_cost_description || formatCost(s)),
                },
                outOfNetwork: {
                  copay: maybeDecorate<number | null>(isNotCovered ? null : s.out_copay, getProv(s, "out_copay"), rowSource, 1),
                  coinsurance: maybeDecorate<number | null>(isNotCovered ? null : s.out_coinsurance, getProv(s, "out_coinsurance"), rowSource, 1),
                  deductibleApplies: isNotCovered ? false : s.out_deductible_applies,
                  costDescription: isNotCovered ? "Not covered" : formatOonCost(s, userPlan.plan_type),
                },
                annualLimit: maybeDecorate<string | null>(s.annual_limit, getProv(s, "annual_limit"), rowSource, 1),
                priorAuthRequired: maybeDecorate<boolean | null>(s.prior_auth_required, getProv(s, "prior_auth_required"), rowSource, 1),
                penaltyNoPrecert: s.penalty_no_precert,
              },
              visitLimit: s.annual_limit,
              priorAuthRequired: s.prior_auth_required,
              covered: s.covered,
              coverageConditions: s.coverage_conditions,
              // S202 §9 Surface 1: per-service EOC prior-auth + medical-necessity
              // detail (flag-gated). Keys are absent when the flag is OFF or when the
              // cell carries no EOC clinical detail (the overwhelming non-EOC case),
              // keeping the flag-OFF response byte-identical.
              ...(eocReaderOn
                ? (() => {
                    const d = extractServiceCoverageDetail(s.coverage_rules);
                    return d
                      ? {
                          priorAuthCriteria: d.priorAuthCriteria,
                          priorAuthAllCriteria: d.priorAuthAllCriteria,
                          priorAuthSourceExcerpt: d.priorAuthSourceExcerpt,
                          priorAuthSourceExcerptVerified: d.priorAuthSourceExcerptVerified,
                          medicalNecessityText: d.medicalNecessityText,
                          medicalNecessityCriteria: d.medicalNecessityCriteria,
                          diagnosisQualifiers: d.diagnosisQualifiers,
                        }
                      : {};
                  })()
                : {}),
            };
          });

          // ── Canonical plan gap-fill ─────────────────────────────────────
          // If this user's plan is linked to a canonical plan, fetch services
          // from the canonical plan that the user doesn't have yet (from
          // other users' uploads of the same plan).
          const userSlugs = new Set(coveredServices.map((s) => s.service_catalog?.slug).filter(Boolean));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let canonicalGapBenefits: any[] = [];

          if (userPlan.canonical_plan_id) {
            const { data: canonicalServices } = await supabase
              .from("canonical_plan_services")
              .select("*")
              .eq("canonical_plan_id", userPlan.canonical_plan_id);

            if (canonicalServices) {
              // S289 — canonical_plan_services stores a bare service_slug (no FK), so
              // category/name/merge-state come from the shared merge-chain resolver.
              // This replaced the hardcoded category:"other" that dumped every
              // search-selected plan's benefits into one "Other Services" bucket.
              const gapIdentity = await loadCatalogIdentity(
                supabase,
                canonicalServices.map((cs) => cs.service_slug as string | null),
              );
              // Gap = services the user doesn't already have. Compare on the LIVE
              // slug — "does the user already have this service" is an identity
              // question, so a stored dead slug must not slip past its live twin.
              const gapServices = canonicalServices.filter((cs) => {
                if (!cs.service_slug) return false;
                const live = gapIdentity.get(cs.service_slug)?.liveSlug ?? cs.service_slug;
                return !userSlugs.has(live);
              });

              // Phase 4 Task 4-B: canonical gap-fill rows are CROSS-USER source
              // ("canonical_inherited") — subject to multi-source corroboration
              // threshold per Q-P4-3 LOCK. sourceCount = canonical_plans.verification_count
              // (denormalized via mig 066). F.0 Phase 2 (mig 169): canonical_plan_services now uses the
              // aligned in_/covered/prior_auth_required names (same convention as plan_covered_services);
              // the legacy columns/keys stay synced via the symmetric align trigger.
              const canonicalSourceCount = decoration?.canonicalSourceCount ?? 1;
              const canonicalLogicalSource = "canonical_inherited";
              canonicalGapBenefits = gapServices.map((cs) => {
                // S289 — live catalog identity for this stored slug (undefined
                // only for a slug missing from service_catalog entirely; callers
                // fall back to the old prettify/"other" behavior there).
                const identity = cs.service_slug ? gapIdentity.get(cs.service_slug) : undefined;
                const liveSlug = identity?.liveSlug ?? (cs.service_slug as string | null);
                // FE→BE request resolution (feedback_benefits_prose_preserve):
                // back-fill whyUnderutilized + howToAccess from BENEFITS_CATALOG
                // when the canonical service slug maps to a catalog entry. Reuses
                // the same SLUG_TO_CATALOG + catalogBenefitMap that the user-row
                // branch (line ~280) uses, so behavior is symmetric across both
                // benefit sources.
                // item 4 (mig 183): composite key first, symmetric with the user-row path
                // (line ~281) — a virtual pcp_visit/specialist_visit canonical row resolves to
                // "telehealth-primary", not "annual-physical"/"cancer-screenings".
                // S289: keyed on the LIVE slug so rows stored on a merged slug
                // reach the same prose as their live twin.
                const gapCatalogId =
                  (cs.place_of_service === "virtual" && liveSlug
                    ? SLUG_TO_CATALOG[`${liveSlug}:virtual`]
                    : undefined)
                  ?? (liveSlug ? SLUG_TO_CATALOG[liveSlug] : undefined);
                const gapCatalogBenefit = gapCatalogId ? catalogBenefitMap.get(gapCatalogId) : undefined;
                // S289: real category from the live catalog row (was hardcoded "other").
                const gapCategory = identity?.category ?? "other";
                return {
                // S99 B5: canonical_plan_services entries should be canonical
                // slugs per Pattern 1 #14. Pass through; surface separately
                // for response-shape consistency with the user-row branch.
                serviceSlug: cs.service_slug,
                canonicalServiceSlug: cs.service_slug,
                benefit: {
                  id: cs.service_slug || cs.id,
                  category: gapCategory,
                  // S289: display name from the live catalog row (parity with the
                  // user-row path, which titles from service_catalog.name via its
                  // FK join) — "Pcp Visit" → "Primary Care Visit".
                  title: cleanDescription(
                    identity?.name
                      ?? (cs.service_slug || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
                  ),
                  description: cs.covered === false
                    ? "Not covered under this plan."
                    : [
                        cs.in_copay != null ? `$${cs.in_copay} copay` : null,
                        cs.in_coinsurance != null && cs.in_coinsurance > 0 ? `${normalizeCoinsurancePct(cs.in_coinsurance)}% coinsurance` : null,
                        cs.in_deductible_applies ? "after deductible" : null,
                      ].filter(Boolean).join(", ") || "Covered",
                  whyUnderutilized: gapCatalogBenefit?.whyUnderutilized || "",
                  howToAccess: cs.covered === false
                    ? ""
                    : (gapCatalogBenefit?.howToAccess || "Contact your insurer for details."),
                  hsaFsaEligible: gapCatalogBenefit?.hsaFsaEligible || false,
                  planTypes: [userPlan.plan_type || ""],
                },
                categoryLabel: gapCategory,
                // A3 (cite-grade gate): the cold-start seed IS the plan's own official SBC (admin
                // cold-start), so the prior "other plan members" label is the same over-claim the old
                // "Community" badge was. Relabel ONLY for the official seed (source='admin_attested');
                // user-derived/community canonical rows keep the neutral label (precision-first — never
                // call community data "official"). Flag-gated → OFF = byte-identical.
                relevanceNote:
                  citeGradeGateOn && cs.source === "admin_attested"
                    ? "Coverage details from your plan's official Summary of Benefits"
                    : "Coverage details from other plan members",
                relevanceScore: 70,
                isRecommended: cs.covered !== false,
                costSharing: {
                  inNetwork: {
                    copay: maybeDecorate<number | null>(cs.covered === false ? null : cs.in_copay, getProv(cs, "in_copay"), canonicalLogicalSource, canonicalSourceCount),
                    coinsurance: maybeDecorate<number | null>(cs.covered === false ? null : cs.in_coinsurance, getProv(cs, "in_coinsurance"), canonicalLogicalSource, canonicalSourceCount),
                    deductibleApplies: cs.covered === false ? false : cs.in_deductible_applies,
                    // S289 — was hardcoded "" for covered rows, which the /plan
                    // cost matrix + single-variant panel render as an em-dash:
                    // every canonical gap-fill benefit showed "—" in BOTH
                    // network columns while the summary prose above it showed
                    // the real numbers. Same formatters as the user-row path;
                    // canonical rows carry the aligned in_*/out_* columns
                    // (F.0 mig 169), so they apply verbatim.
                    costDescription: cs.covered === false ? "Not covered" : formatCost(cs),
                  },
                  // CF-19c (Session 64): canonical_plan_services now carries OON columns
                  // (mig 071). Populate them when present; null until promotion events fire
                  // post-corroboration to populate canonical OON values from user uploads.
                  outOfNetwork: {
                    copay: maybeDecorate<number | null>(cs.covered === false ? null : (cs.out_copay ?? null), getProv(cs, "out_copay"), canonicalLogicalSource, canonicalSourceCount),
                    coinsurance: maybeDecorate<number | null>(cs.covered === false ? null : (cs.out_coinsurance ?? null), getProv(cs, "out_coinsurance"), canonicalLogicalSource, canonicalSourceCount),
                    deductibleApplies: cs.covered === false ? false : (cs.out_deductible_applies ?? false),
                    costDescription: cs.covered === false ? "Not covered" : formatOonCost(cs, userPlan.plan_type ?? null),
                  },
                  annualLimit: maybeDecorate<string | null>(cs.annual_limit ? String(cs.annual_limit) : null, getProv(cs, "annual_limit"), canonicalLogicalSource, canonicalSourceCount),
                  priorAuthRequired: maybeDecorate<boolean | null>(cs.prior_auth_required, getProv(cs, "prior_auth_required"), canonicalLogicalSource, canonicalSourceCount),
                  penaltyNoPrecert: null,
                },
                covered: cs.covered,
                dataSource: "canonical_plan",
                };
              });
            }
          }

          const allBenefits = [...benefits, ...canonicalGapBenefits];
          const coveredCount = allBenefits.filter((b) => b.covered !== false).length;

          // S202 §9 Surface 2/3: resolve the plan-level prior-auth aggregate cards
          // ("plan-wide" + "by location") and the About-your-plan list from
          // insurance_plans.metadata. Read-only; suppress/dedup against the user's
          // own listed services (those with a cost line carry their PA inline).
          let eocReader: EocReaderSurfaces | undefined;
          if (eocReaderOn) {
            const listedServices: ListedService[] = coveredServices.map((s) => ({
              slug: s.service_catalog?.slug ?? "",
              priorAuthRequired: s.prior_auth_required ?? null,
            }));
            const nameBySlug = new Map<string, string>();
            for (const s of coveredServices) {
              const slug = s.service_catalog?.slug;
              if (slug && s.service_catalog?.name) nameBySlug.set(slug, s.service_catalog.name);
            }
            // Clean labels for off-plan fact slugs (named in the EOC's prior-auth
            // section but lacking a coverage cell) — one read against service_catalog.
            const md = (userPlan.metadata as Record<string, unknown> | null) ?? null;
            const factSlugs = Array.isArray(md?.eoc_prior_auth_facts)
              ? (md!.eoc_prior_auth_facts as { service_slug?: string | null }[])
                  .map((f) => f.service_slug)
                  .filter((x): x is string => !!x && !nameBySlug.has(x))
              : [];
            if (factSlugs.length > 0) {
              const { data: catNames } = await supabase
                .from("service_catalog")
                .select("slug, name")
                .in("slug", [...new Set(factSlugs)]);
              for (const c of catNames ?? []) {
                if (c.slug && c.name) nameBySlug.set(c.slug as string, c.name as string);
              }
            }
            eocReader = resolveEocReaderSurfaces({
              metadata: md,
              listedServices,
              serviceNameBySlug: (slug) => nameBySlug.get(slug) ?? prettifySlug(slug),
            });
          }

          // S288: link-only catalog rows carry no plan-level terms — read them
          // from the canonical so the /plan + dashboard summary tiles don't
          // dash out. canonical_plans keeps the LEGACY names for in-network
          // plan-level terms (deductible_individual / oop_max_individual);
          // only the OON columns use the out_ prefix (mig 192).
          let canonTerms: Record<string, number | null> | null = null;
          if (
            userPlan.canonical_plan_id &&
            userPlan.in_deductible_individual == null &&
            userPlan.in_oop_max_individual == null
          ) {
            const { data: ct } = await supabase
              .from("canonical_plans")
              .select(
                "deductible_individual, oop_max_individual, out_deductible_individual, out_oop_max_individual",
              )
              .eq("id", userPlan.canonical_plan_id)
              .maybeSingle();
            canonTerms = (ct as Record<string, number | null> | null) ?? null;
          }

          return NextResponse.json({
            benefits: allBenefits,
            categoryCounts: {},
            totalBenefits: coveredCount,
            totalNotCovered: allBenefits.length - coveredCount,
            profileComplete: true,
            missingFields: [],
            // S289 — "I use this" ticks live on the active plan row
            // (metadata.used_benefits, LIVE slugs; see lib/plan/benefit-usage).
            // Client hydrates from here; POST /api/plan/benefit-usage toggles.
            // Paths without a plan row omit the field (client defaults to []).
            usedBenefits: readUsedBenefits(userPlan.metadata),
            dataSource: canonicalGapBenefits.length > 0 ? "user_plan_with_canonical" : "user_plan",
            planName: userPlan.plan_name,
            planYear: userPlan.plan_year || null,
            insurancePlanId: userPlan.id,
            canonicalPlanId: userPlan.canonical_plan_id || null,
            planSource: userPlan.source,
            // S202 §9: present only when eoc_reader_resolution_v1 is ON (else absent → byte-identical).
            ...(eocReader ? { eocReader } : {}),
            planSummary: await (async () => {
              let premiumMonthly: number | null = userPlan.premium_total ?? null;
              let premiumSource: string | undefined;
              // County-resolved premium if canonical plan exists
              if (userPlan.canonical_plan_id && profile.county_fips) {
                const { getCountyPremium } = await import("@/lib/plan/county-premium");
                const countyResult = await getCountyPremium(supabase, userPlan.canonical_plan_id, profile.county_fips);
                if (countyResult.premium != null) {
                  premiumMonthly = countyResult.premium;
                  premiumSource = countyResult.source;
                }
              } else if (userPlan.canonical_plan_id && !premiumMonthly) {
                // Fallback: canonical premium without county
                const { getCountyPremium } = await import("@/lib/plan/county-premium");
                const fallbackResult = await getCountyPremium(supabase, userPlan.canonical_plan_id, null);
                if (fallbackResult.premium != null) {
                  premiumMonthly = fallbackResult.premium;
                  premiumSource = fallbackResult.source;
                }
              }
              // Phase 4 Task 4-B: decorate plan-identity fields when decoration context
              // is non-null. Plan-identity reads field_provenance from insurance_plans
              // (mig 063). Premium has NO P-8 provenance (structural data from CMS API,
              // not text-extracted) — passes null entry; logical source = premiumSource
              // (canonical_fallback gets threshold; cms_county/marketplace = trusted).
              const planSource: string = userPlan.source ?? "doc_extraction";
              const premiumLogicalSource: string =
                premiumSource === "canonical_fallback" ? "canonical_fallback" :
                premiumSource ? premiumSource : "cms_marketplace";
              const premiumSourceCount =
                premiumLogicalSource === "canonical_fallback" ? (decoration?.canonicalSourceCount ?? 1) : 1;
              // S288: a canonical-filled value must decorate as canonical data
              // ("canonical_inherited" + the canonical's source count — the
              // same treatment the gap-fill benefit rows get), NOT under the
              // row's own planSource with count 1: the consumer-read filter
              // maps that to a non-visible state and the tiles dash out.
              const pickTerm = (
                own: number | null | undefined,
                canon: number | null | undefined,
                provKey: string,
              ) => {
                if (own == null && canon != null)
                  return maybeDecorate<number | null>(
                    canon,
                    undefined,
                    "canonical_inherited",
                    decoration?.canonicalSourceCount ?? 1,
                  );
                const prov = getProv(userPlan, provKey);
                const provSource = (prov as { source?: string } | undefined)?.source;
                // S319 (Andrew's switch-test find) — on a catalog_match row
                // the USER-CONFIRMED canonical link is the term authority (the
                // profile route's S288 overlay states the contract: "readers
                // resolve them through the canonical link"). The pick REUSES
                // an existing plan row when one matches, so the row can carry
                // an older parse's terms + weak provenance (his: a July
                // doc_extraction at the 0.5 single-source floor) — decorated
                // under the row's own source those rightly fail the cite-grade
                // consumer filter and the tiles dash out, while the canonical
                // says the SAME numbers at library grade. Rule: canonical
                // outranks non-USER provenance here (the S288 decoration the
                // filter already respects); a user's own answer (manual /
                // user_correction / user_initial_entry) still always wins.
                const userAnswered =
                  provSource != null &&
                  ["manual", "user_correction", "user_initial_entry", "card_corroboration"].includes(provSource);
                if (own != null && planSource === "catalog_match" && canon != null && !userAnswered)
                  return maybeDecorate<number | null>(
                    canon,
                    undefined,
                    "canonical_inherited",
                    decoration?.canonicalSourceCount ?? 1,
                  );
                return maybeDecorate<number | null>(own ?? null, prov, planSource, 1);
              };
              return {
                inDeductible: pickTerm(userPlan.in_deductible_individual ?? profile.deductible_individual, canonTerms?.deductible_individual, "in_deductible_individual"),
                outDeductible: pickTerm(userPlan.out_deductible_individual, canonTerms?.out_deductible_individual, "out_deductible_individual"),
                inOopMax: pickTerm(userPlan.in_oop_max_individual ?? profile.oop_max_individual, canonTerms?.oop_max_individual, "in_oop_max_individual"),
                outOopMax: pickTerm(userPlan.out_oop_max_individual, canonTerms?.out_oop_max_individual, "out_oop_max_individual"),
                planType: maybeDecorate<string | null>(userPlan.plan_type, getProv(userPlan, "plan_type"), planSource, 1),
                verificationStatus: userPlan.verification_status,
                premiumMonthly: maybeDecorate<number | null>(premiumMonthly, undefined, premiumLogicalSource, premiumSourceCount),
                premiumSource,
              };
            })(),
          });
        }
      }
    }

    // ── Check for real plan data from catalog ──────────────────────────────
    // Priority 1: User has a matched_plan_id from autocomplete
    // Priority 2: Fuzzy insurer match to verified plan data
    let hasRealPlanData = false;

    // Priority 1: Direct plan match
    if (profile.matched_plan_id) {
      const { data: matchedPlanBenefits } = await supabase
        .from("plan_benefits")
        .select("*")
        .eq("plan_id", profile.matched_plan_id)
        .in("data_status", ["verified", "extracted"]);

      if (matchedPlanBenefits && matchedPlanBenefits.length > 0) {
        hasRealPlanData = true;
        const benefits = matchedPlanBenefits.map((b) => {
          // FE→BE request resolution (feedback_benefits_prose_preserve):
          // plan_benefits rows lack whyUnderutilized in schema; back-fill from
          // BENEFITS_CATALOG by category. First-match semantics — multiple
          // catalog entries share a category, the first one wins. Lossy but
          // better than empty.
          const catalogProse = lookupBenefitProseByCategory(b.benefit_category);
          return {
          benefit: {
            id: b.id,
            category: b.benefit_category,
            title: b.title,
            description: b.description || "",
            whyUnderutilized: catalogProse.whyUnderutilized,
            howToAccess: b.how_to_access || catalogProse.howToAccess || "Contact your insurer for details.",
            hsaFsaEligible: b.hsa_fsa_eligible,
            planTypes: [profile.plan_type || ""],
          },
          categoryLabel: b.benefit_category,
          relevanceNote: "Based on your specific plan",
          relevanceScore: 90,
          isRecommended: true,
          };
        });

        // Fetch plan name for display
        const { data: matchedPlanInfo } = await supabase
          .from("plan_catalog")
          .select("plan_name, plan_type, raw_data, metal_level")
          .eq("id", profile.matched_plan_id)
          .single();

        return NextResponse.json({
          benefits,
          categoryCounts: {},
          totalBenefits: benefits.length,
          profileComplete: true,
          missingFields: [],
          dataSource: "matched_plan",
          planName: matchedPlanInfo?.plan_name || null,
          planSummary: matchedPlanInfo ? {
            inDeductible: (matchedPlanInfo.raw_data as Record<string, unknown>)?.deductible_individual,
            outDeductible: (matchedPlanInfo.raw_data as Record<string, unknown>)?.deductible_individual_oon,
            inOopMax: (matchedPlanInfo.raw_data as Record<string, unknown>)?.oop_max_individual,
            outOopMax: (matchedPlanInfo.raw_data as Record<string, unknown>)?.oop_max_individual_oon,
            planType: matchedPlanInfo.plan_type,
            metalLevel: matchedPlanInfo.metal_level,
            verificationStatus: "cms_matched",
          } : null,
        });
      }

      // Plan matched but no benefits extracted yet — check if we have CMS API data
      const { data: matchedPlan } = await supabase
        .from("plan_catalog")
        .select("raw_data, plan_name, plan_type, sbc_document_url")
        .eq("id", profile.matched_plan_id)
        .single();

      if (matchedPlan?.raw_data?.benefits_summary) {
        hasRealPlanData = true;
        // Use the CMS API structured benefit data
        const cmsBenefits = (matchedPlan.raw_data.benefits_summary as Array<{
          type: string; name: string; covered: boolean; in_network: string;
        }>).filter((b) => b.covered).map((b, i) => ({
          benefit: {
            id: `cms-${i}`,
            category: "general" as const,
            title: b.name,
            description: `Coverage: ${b.in_network || "See plan details"}`,
            whyUnderutilized: "",
            howToAccess: "Contact your insurer for details.",
            hsaFsaEligible: false,
            planTypes: [matchedPlan.plan_type || ""],
          },
          categoryLabel: "Plan Coverage",
          relevanceNote: `From your ${matchedPlan.plan_name} plan`,
          relevanceScore: 85,
          isRecommended: true,
        }));

        return NextResponse.json({
          benefits: cmsBenefits,
          categoryCounts: {},
          totalBenefits: cmsBenefits.length,
          profileComplete: true,
          missingFields: [],
          dataSource: "cms_api",
          planName: matchedPlan.plan_name,
          planSummary: {
            inDeductible: (matchedPlan.raw_data as Record<string, unknown>)?.deductible_individual,
            outDeductible: (matchedPlan.raw_data as Record<string, unknown>)?.deductible_individual_oon,
            inOopMax: (matchedPlan.raw_data as Record<string, unknown>)?.oop_max_individual,
            outOopMax: (matchedPlan.raw_data as Record<string, unknown>)?.oop_max_individual_oon,
            planType: matchedPlan.plan_type,
            verificationStatus: "cms_matched",
          },
        });
      }
    }

    // Priority 2: Fuzzy insurer match
    if (!hasRealPlanData && profile.insurer) {
      const { data: insurerMatch } = await supabase
        .from("insurer_catalog")
        .select("id")
        .or(`name.ilike.%${profile.insurer}%`)
        .limit(1)
        .single();

      if (insurerMatch) {
        const { data: verifiedPlans } = await supabase
          .from("plan_catalog")
          .select("id")
          .eq("insurer_id", insurerMatch.id)
          .eq("data_status", "verified")
          .limit(1);

        if (verifiedPlans && verifiedPlans.length > 0) {
          // We have verified plan data — fetch benefits from the database
          const { data: realBenefits } = await supabase
            .from("plan_benefits")
            .select("*")
            .eq("plan_id", verifiedPlans[0].id)
            .eq("data_status", "verified");

          if (realBenefits && realBenefits.length > 0) {
            hasRealPlanData = true;
            // Return real plan benefits with confidence indicator
            const benefits = realBenefits.map((b) => {
              // FE→BE request resolution (feedback_benefits_prose_preserve):
              // same back-fill as matched_plan_id path above. plan_benefits rows
              // lack whyUnderutilized; category lookup is best-effort.
              const catalogProse = lookupBenefitProseByCategory(b.benefit_category);
              return {
              benefit: {
                id: b.id,
                category: b.benefit_category,
                title: b.title,
                description: b.description || "",
                whyUnderutilized: catalogProse.whyUnderutilized,
                howToAccess: b.how_to_access || catalogProse.howToAccess || "Contact your insurer for details.",
                hsaFsaEligible: b.hsa_fsa_eligible,
                planTypes: [profile.plan_type || ""],
              },
              categoryLabel: b.benefit_category,
              relevanceNote: `Based on your specific ${profile.insurer} plan`,
              relevanceScore: 80,
              isRecommended: true,
              };
            });

            return NextResponse.json({
              benefits,
              categoryCounts: {},
              totalBenefits: benefits.length,
              profileComplete: true,
              missingFields: [],
              dataSource: "verified_plan",
            });
          }
        }
      }
    }

    // ── Fall back to static catalog ───────────────────────────────────
    const result = analyzePlan({
      insurer: profile.insurer || "",
      planType: profile.plan_type || "",
      state: profile.state || "",
      dateOfBirth: profile.date_of_birth || undefined,
      sex: profile.sex || undefined,
      hasDependents,
      hasChildren,
    });

    return NextResponse.json({
      ...result,
      dataSource: hasRealPlanData ? "verified_plan" : "static_catalog",
      insurer: profile.insurer || null,
      planType: profile.plan_type || null,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to analyze plan" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { analyzePlan } from "@/lib/plan/analyzer";
import { createServerClient } from "@/lib/supabase/server";
import { loadDecorationContext, type DecorationContext } from "@/lib/plan/analyze-decoration";
import { decorateFieldFromEntry } from "@/lib/parser/consumer-read";
import type { FieldProvenanceEntry } from "@/lib/parser/field-categories";

export async function POST(request: Request) {
  try {
    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }

    const supabase = createServerClient();

    // Fetch user profile with demographics + plan match
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("insurer, plan_type, state, date_of_birth, sex, dependents, matched_plan_id, plan_source, active_insurance_plan_id, deductible_individual, oop_max_individual, county_fips")
      .eq("user_id", userId)
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
      const { data: userPlan } = await supabase
        .from("insurance_plans")
        .select("*")
        .eq("id", profile.active_insurance_plan_id)
        .single();

      if (userPlan) {
        // Phase 4 Task 4-B: load consumer-read filter decoration context.
        // Returns null when consumer_read_filter_v1 flag is OFF — response stays
        // byte-identical to pre-Phase-4. Returns context object when flag ON;
        // callers thread context through decorateFieldFromEntry() per field.
        const { data: userForFlag } = await supabase
          .from("users")
          .select("email")
          .eq("firebase_uid", userId)
          .single();
        const decoration: DecorationContext | null = await loadDecorationContext(
          supabase,
          userForFlag?.email ?? null,
          userPlan,
        );

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
          });
        }

        const { data: coveredServices } = await supabase
          .from("plan_covered_services")
          .select("*, service_catalog!inner(slug, name, category, merged_into_id)")
          .eq("insurance_plan_id", userPlan.id)
          .is("service_catalog.merged_into_id", null);

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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function formatCost(s: any): string {
          const parts: string[] = [];
          const copay = s.in_copay as number | null;
          const coinsurance = s.in_coinsurance as number | null;
          if (copay != null) parts.push(`$${copay} copay`);
          if (coinsurance != null && coinsurance > 0) parts.push(`${Math.round(coinsurance * 100)}% coinsurance`);
          if (s.in_deductible_applies) parts.push("after deductible");
          if (parts.length === 0 && copay === null && coinsurance === 0) return "No charge";
          if (parts.length === 0) return "Covered";
          return parts.join(", ").replace(/^./, (c: string) => c.toUpperCase());
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function formatOonCost(s: any, planType: string | null): string {
          // Prefer explicit OON description from extraction.
          if (s.out_cost_description) return s.out_cost_description;
          // Fall back to structured OON fields.
          const parts: string[] = [];
          const copay = s.out_copay as number | null;
          const coinsurance = s.out_coinsurance as number | null;
          if (copay != null) parts.push(`$${copay} copay`);
          if (coinsurance != null && coinsurance > 0) parts.push(`${Math.round(coinsurance * 100)}% coinsurance`);
          if (s.out_deductible_applies) parts.push("after deductible");
          if (parts.length > 0) return parts.join(", ").replace(/^./, (c: string) => c.toUpperCase());
          if (copay === 0 && coinsurance === 0) return "No charge";
          // HMO/EPO typically don't cover OON. Signal that instead of an empty em dash.
          const pt = (planType || "").toUpperCase();
          if (pt === "HMO" || pt === "EPO") return "Not covered";
          return "";
        }

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

        if (coveredServices && coveredServices.length > 0) {
          // Reverse slug map: service slug → catalog benefit educational content.
          // S94 B1: keys use canonical 68-slug vocabulary; legacy slug aliases retained
          // defensively for any pre-S94 data still rendering.
          const SLUG_TO_CATALOG: Record<string, string> = {
            // canonical (post-S94)
            pcp_visit: "annual-physical",
            annual_physical: "annual-physical",
            preventive_care: "annual-physical",
            mental_health_outpatient: "therapy-sessions",
            substance_abuse_outpatient: "substance-abuse",
            pt_rehab: "pt-sessions",
            ot_rehab: "ot-sessions",
            speech_therapy: "speech-therapy",
            chiropractic: "chiro-visits",
            acupuncture: "acupuncture",
            telehealth_pcp: "telehealth-primary",
            telehealth_specialist: "telehealth-primary",
            specialist_visit: "cancer-screenings",
            cancer_screening: "cancer-screenings",
            prenatal_visit: "prenatal-care",
            durable_medical_equipment: "breast-pump",
            // legacy aliases (pre-S94 data; safe to remove once S94 backfill complete)
            physical_therapy: "pt-sessions",
            occupational_therapy: "ot-sessions",
            telehealth: "telehealth-primary",
            maternity_prenatal: "prenatal-care",
          };

          // Only build static catalog if we have services that map to it
          const needsCatalog = coveredServices.some((s) => SLUG_TO_CATALOG[s.service_catalog?.slug || ""]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let catalogBenefitMap = new Map<string, any>();
          if (needsCatalog) {
            const catalogResult = analyzePlan({
              insurer: userPlan.insurer_name || profile.insurer || "",
              planType: userPlan.plan_type || profile.plan_type || "",
              state: profile.state || "",
              dateOfBirth: profile.date_of_birth || undefined,
              sex: undefined,
              hasDependents,
              hasChildren,
            });
            catalogBenefitMap = new Map(
              catalogResult.benefits.map((b) => [b.benefit.id, b.benefit])
            );
          }

          // Build a benefit per covered service
          const benefits = coveredServices.map((s) => {
            const slug = s.service_catalog?.slug || "unknown";
            const rawName = s.service_catalog?.name || slug.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
            const name = cleanDescription(rawName);
            const category = s.service_catalog?.category || "other";

            // Find catalog educational content if available
            const catalogId = SLUG_TO_CATALOG[slug];
            const catalogBenefit = catalogId ? catalogBenefitMap.get(catalogId) : undefined;

            const isNotCovered = s.covered === false;
            // Phase 4 Task 4-B: when decoration context is present, wrap P-8-eligible
            // numeric/boolean fields in DecoratedValue<T>. plan_covered_services rows
            // are self-source — sourceCount=1, threshold=0 in consumer-read library
            // for non-canonical sources.
            const rowSource: string = s.source ?? "doc_extraction";
            return {
              serviceSlug: slug,
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
              const gapServices = canonicalServices.filter(
                (cs) => cs.service_slug && !userSlugs.has(cs.service_slug)
              );

              // Phase 4 Task 4-B: canonical gap-fill rows are CROSS-USER source
              // ("canonical_inherited") — subject to multi-source corroboration
              // threshold per Q-P4-3 LOCK. sourceCount = canonical_plans.verification_count
              // (denormalized via mig 066). Field-provenance keys differ from
              // plan_covered_services (canonical schema has copay/coinsurance/etc
              // without in_/out_ prefix; OON columns absent on canonical).
              const canonicalSourceCount = decoration?.canonicalSourceCount ?? 1;
              const canonicalLogicalSource = "canonical_inherited";
              canonicalGapBenefits = gapServices.map((cs) => ({
                benefit: {
                  id: cs.service_slug || cs.id,
                  category: "other",
                  title: cleanDescription((cs.service_slug || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())),
                  description: cs.is_covered === false
                    ? "Not covered under this plan."
                    : [
                        cs.copay != null ? `$${cs.copay} copay` : null,
                        cs.coinsurance != null && cs.coinsurance > 0 ? `${Math.round(cs.coinsurance * 100)}% coinsurance` : null,
                        cs.deductible_applies ? "after deductible" : null,
                      ].filter(Boolean).join(", ") || "Covered",
                  whyUnderutilized: "",
                  howToAccess: cs.is_covered === false ? "" : "Contact your insurer for details.",
                  hsaFsaEligible: false,
                  planTypes: [userPlan.plan_type || ""],
                },
                categoryLabel: "other",
                relevanceNote: "Coverage details from other plan members",
                relevanceScore: 70,
                isRecommended: cs.is_covered !== false,
                costSharing: {
                  inNetwork: {
                    copay: maybeDecorate<number | null>(cs.is_covered === false ? null : cs.copay, getProv(cs, "copay"), canonicalLogicalSource, canonicalSourceCount),
                    coinsurance: maybeDecorate<number | null>(cs.is_covered === false ? null : cs.coinsurance, getProv(cs, "coinsurance"), canonicalLogicalSource, canonicalSourceCount),
                    deductibleApplies: cs.is_covered === false ? false : cs.deductible_applies,
                    costDescription: cs.is_covered === false ? "Not covered" : "",
                  },
                  // CF-19c (Session 64): canonical_plan_services now carries OON columns
                  // (mig 071). Populate them when present; null until promotion events fire
                  // post-corroboration to populate canonical OON values from user uploads.
                  outOfNetwork: {
                    copay: maybeDecorate<number | null>(cs.is_covered === false ? null : (cs.out_copay ?? null), getProv(cs, "out_copay"), canonicalLogicalSource, canonicalSourceCount),
                    coinsurance: maybeDecorate<number | null>(cs.is_covered === false ? null : (cs.out_coinsurance ?? null), getProv(cs, "out_coinsurance"), canonicalLogicalSource, canonicalSourceCount),
                    deductibleApplies: cs.is_covered === false ? false : (cs.out_deductible_applies ?? false),
                    costDescription: cs.is_covered === false ? "Not covered" : "",
                  },
                  annualLimit: maybeDecorate<string | null>(cs.annual_limit ? String(cs.annual_limit) : null, getProv(cs, "annual_limit"), canonicalLogicalSource, canonicalSourceCount),
                  priorAuthRequired: maybeDecorate<boolean | null>(cs.requires_prior_auth, getProv(cs, "requires_prior_auth"), canonicalLogicalSource, canonicalSourceCount),
                  penaltyNoPrecert: null,
                },
                covered: cs.is_covered,
                dataSource: "canonical_plan",
              }));
            }
          }

          const allBenefits = [...benefits, ...canonicalGapBenefits];
          const coveredCount = allBenefits.filter((b) => b.covered !== false).length;

          return NextResponse.json({
            benefits: allBenefits,
            categoryCounts: {},
            totalBenefits: coveredCount,
            totalNotCovered: allBenefits.length - coveredCount,
            profileComplete: true,
            missingFields: [],
            dataSource: canonicalGapBenefits.length > 0 ? "user_plan_with_canonical" : "user_plan",
            planName: userPlan.plan_name,
            planYear: userPlan.plan_year || null,
            insurancePlanId: userPlan.id,
            canonicalPlanId: userPlan.canonical_plan_id || null,
            planSource: userPlan.source,
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
              return {
                inDeductible: maybeDecorate<number | null>(userPlan.in_deductible_individual ?? profile.deductible_individual, getProv(userPlan, "in_deductible_individual"), planSource, 1),
                outDeductible: maybeDecorate<number | null>(userPlan.out_deductible_individual, getProv(userPlan, "out_deductible_individual"), planSource, 1),
                inOopMax: maybeDecorate<number | null>(userPlan.in_oop_max_individual ?? profile.oop_max_individual, getProv(userPlan, "in_oop_max_individual"), planSource, 1),
                outOopMax: maybeDecorate<number | null>(userPlan.out_oop_max_individual, getProv(userPlan, "out_oop_max_individual"), planSource, 1),
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
        const benefits = matchedPlanBenefits.map((b) => ({
          benefit: {
            id: b.id,
            category: b.benefit_category,
            title: b.title,
            description: b.description || "",
            whyUnderutilized: "",
            howToAccess: b.how_to_access || "Contact your insurer for details.",
            hsaFsaEligible: b.hsa_fsa_eligible,
            planTypes: [profile.plan_type || ""],
          },
          categoryLabel: b.benefit_category,
          relevanceNote: "Based on your specific plan",
          relevanceScore: 90,
          isRecommended: true,
        }));

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
            const benefits = realBenefits.map((b) => ({
              benefit: {
                id: b.id,
                category: b.benefit_category,
                title: b.title,
                description: b.description || "",
                whyUnderutilized: "",
                howToAccess: b.how_to_access || "Contact your insurer for details.",
                hsaFsaEligible: b.hsa_fsa_eligible,
                planTypes: [profile.plan_type || ""],
              },
              categoryLabel: b.benefit_category,
              relevanceNote: `Based on your specific ${profile.insurer} plan`,
              relevanceScore: 80,
              isRecommended: true,
            }));

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

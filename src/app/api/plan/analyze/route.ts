import { NextResponse } from "next/server";
import { analyzePlan } from "@/lib/plan/analyzer";
import { createServerClient } from "@/lib/supabase/server";

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
      .select("insurer, plan_type, state, date_of_birth, sex, dependents, matched_plan_id, plan_source, active_insurance_plan_id, deductible_individual, oop_max_individual")
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
        const { data: coveredServices } = await supabase
          .from("plan_covered_services")
          .select("*, service_catalog!inner(slug, name, category, merged_into_id)")
          .eq("insurance_plan_id", userPlan.id)
          .is("service_catalog.merged_into_id", null);

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
        function buildServiceDescription(s: any): string {
          if (s.covered === false) return "Not covered under this plan.";
          const parts: string[] = [];
          if (s.in_cost_description) {
            parts.push(`In-network: ${s.in_cost_description}`);
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
          // Reverse slug map: service slug → catalog benefit educational content
          const SLUG_TO_CATALOG: Record<string, string> = {
            pcp_visit: "annual-physical",
            preventive_care: "annual-physical",
            mental_health_outpatient: "therapy-sessions",
            substance_abuse_outpatient: "substance-abuse",
            physical_therapy: "pt-sessions",
            pt_rehab: "pt-sessions",
            occupational_therapy: "ot-sessions",
            speech_therapy: "speech-therapy",
            chiropractic: "chiro-visits",
            acupuncture: "acupuncture",
            telehealth: "telehealth-primary",
            specialist_visit: "cancer-screenings",
            maternity_prenatal: "prenatal-care",
            durable_medical_equipment: "breast-pump",
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
            const name = s.service_catalog?.name || slug.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
            const category = s.service_catalog?.category || "other";

            // Find catalog educational content if available
            const catalogId = SLUG_TO_CATALOG[slug];
            const catalogBenefit = catalogId ? catalogBenefitMap.get(catalogId) : undefined;

            const isNotCovered = s.covered === false;
            return {
              benefit: {
                id: slug,
                category,
                title: name,
                description: buildServiceDescription(s),
                whyUnderutilized: catalogBenefit?.whyUnderutilized || "",
                howToAccess: isNotCovered ? "" : (catalogBenefit?.howToAccess || "Contact your insurer for details."),
                hsaFsaEligible: isNotCovered ? false : (catalogBenefit?.hsaFsaEligible || false),
                planTypes: [userPlan.plan_type || ""],
              },
              categoryLabel: category,
              relevanceNote: `Your ${userPlan.plan_name || "plan"}: ${isNotCovered ? "Not covered" : formatCost(s)}`,
              relevanceScore: isNotCovered ? 0 : 90,
              isRecommended: !isNotCovered,
              costSharing: {
                inNetwork: {
                  copay: isNotCovered ? null : s.in_copay,
                  coinsurance: isNotCovered ? null : s.in_coinsurance,
                  deductibleApplies: isNotCovered ? false : s.in_deductible_applies,
                  costDescription: isNotCovered ? "Not covered" : (s.in_cost_description || formatCost(s)),
                },
                outOfNetwork: {
                  copay: isNotCovered ? null : s.out_copay,
                  coinsurance: isNotCovered ? null : s.out_coinsurance,
                  deductibleApplies: isNotCovered ? false : s.out_deductible_applies,
                  costDescription: isNotCovered ? "Not covered" : (s.out_cost_description || ""),
                },
                annualLimit: s.annual_limit,
                priorAuthRequired: s.prior_auth_required,
                penaltyNoPrecert: s.penalty_no_precert,
              },
              visitLimit: s.annual_limit,
              priorAuthRequired: s.prior_auth_required,
              covered: s.covered,
              coverageConditions: s.coverage_conditions,
            };
          });

          return NextResponse.json({
            benefits,
            categoryCounts: {},
            totalBenefits: benefits.length,
            profileComplete: true,
            missingFields: [],
            dataSource: "user_plan",
            planName: userPlan.plan_name,
            planSource: userPlan.source,
            planSummary: {
              inDeductible: userPlan.in_deductible_individual ?? profile.deductible_individual,
              outDeductible: userPlan.out_deductible_individual,
              inOopMax: userPlan.in_oop_max_individual ?? profile.oop_max_individual,
              outOopMax: userPlan.out_oop_max_individual,
              planType: userPlan.plan_type,
              verificationStatus: userPlan.verification_status,
            },
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

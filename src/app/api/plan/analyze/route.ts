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
      .select("insurer, plan_type, state, date_of_birth, sex, dependents, matched_plan_id, plan_source, active_insurance_plan_id")
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
          .select("*, service_catalog(slug, name, category)")
          .eq("insurance_plan_id", userPlan.id);

        if (coveredServices && coveredServices.length > 0) {
          // Build a lookup from service slug → cost sharing data
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const costDataBySlug = new Map<string, any>();
          for (const s of coveredServices) {
            const slug = s.service_catalog?.slug;
            if (slug) costDataBySlug.set(slug, s);
          }

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

          // Start with the catalog benefits (rich content) and enrich with plan data
          const catalogResult = analyzePlan({
            insurer: userPlan.insurer_name || profile.insurer || "",
            planType: userPlan.plan_type || profile.plan_type || "",
            state: profile.state || "",
            dateOfBirth: profile.date_of_birth || undefined,
            sex: undefined,
            hasDependents,
            hasChildren,
          });

          // Slug mapping: catalog benefit IDs → service_catalog slugs
          const BENEFIT_SLUG_MAP: Record<string, string[]> = {
            "annual-physical": ["pcp_visit", "preventive_care"],
            "cancer-screenings": ["mammogram", "preventive_care"],
            "vaccinations": ["immunizations"],
            "diabetes-screening": ["lab_work", "preventive_care"],
            "therapy-sessions": ["mental_health_outpatient"],
            "substance-abuse": ["substance_abuse_outpatient"],
            "telehealth-mental": ["telehealth", "mental_health_outpatient"],
            "crisis-services": ["mental_health_outpatient"],
            "dietitian-visits": ["pcp_visit"],
            "diabetes-management": ["pcp_visit"],
            "pt-sessions": ["physical_therapy"],
            "ot-sessions": ["occupational_therapy"],
            "speech-therapy": ["speech_therapy"],
            "chiro-visits": ["chiropractic"],
            "acupuncture": ["acupuncture"],
            "hsa-preventive": ["preventive_care"],
            "fsa-dependent": ["pcp_visit"],
            "telehealth-primary": ["telehealth"],
            "telehealth-specialist": ["telehealth_specialist"],
            "telehealth-urgent": ["urgent_care", "telehealth"],
            "chronic-care-mgmt": ["pcp_visit"],
            "remote-monitoring": ["telehealth"],
            "diabetes-program": ["pcp_visit"],
            "gym-fitness": ["preventive_care"],
            "weight-management": ["preventive_care"],
            "smoking-cessation": ["preventive_care"],
            "prenatal-care": ["maternity_prenatal"],
            "breast-pump": ["dme"],
            "contraception": ["preventive_care"],
            "fertility-assessment": ["specialist_visit"],
            "vision-exam": ["vision_exam"],
            "dental-cleaning": ["dental_cleaning"],
            "hearing-screening": ["hearing_aids"],
          };

          // Enrich catalog benefits with actual cost data
          const enrichedBenefits = catalogResult.benefits.map((ab) => {
            const slugs = BENEFIT_SLUG_MAP[ab.benefit.id] || [];
            let costData = null;
            for (const slug of slugs) {
              if (costDataBySlug.has(slug)) {
                costData = costDataBySlug.get(slug);
                break;
              }
            }

            const costSharing = costData ? {
              inNetwork: {
                copay: costData.in_copay,
                coinsurance: costData.in_coinsurance,
                deductibleApplies: costData.in_deductible_applies,
                costDescription: formatCost(costData),
              },
              outOfNetwork: {
                copay: costData.out_copay,
                coinsurance: costData.out_coinsurance,
                deductibleApplies: costData.out_deductible_applies,
                costDescription: costData.out_cost_description || "",
              },
              annualLimit: costData.annual_limit,
              priorAuthRequired: costData.prior_auth_required,
              penaltyNoPrecert: costData.penalty_no_precert,
            } : undefined;

            return {
              ...ab,
              relevanceNote: costData
                ? `Your ${userPlan.plan_name || "plan"}: ${formatCost(costData)}`
                : ab.relevanceNote,
              costSharing,
            };
          });

          const benefits = enrichedBenefits;

          return NextResponse.json({
            benefits,
            categoryCounts: {},
            totalBenefits: benefits.length,
            profileComplete: true,
            missingFields: [],
            dataSource: "user_plan",
            planName: userPlan.plan_name,
            planSummary: {
              inDeductible: userPlan.in_deductible_individual,
              outDeductible: userPlan.out_deductible_individual,
              inOopMax: userPlan.in_oop_max_individual,
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

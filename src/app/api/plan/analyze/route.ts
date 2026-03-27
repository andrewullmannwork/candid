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
          const benefits = coveredServices
            .filter((s) => s.covered !== false)
            .map((s) => ({
              benefit: {
                id: s.id,
                category: s.service_catalog?.category || "general",
                title: s.service_catalog?.name || "Unknown Service",
                description: s.in_cost_description || s.out_cost_description || "",
                whyUnderutilized: "",
                howToAccess: s.notes || "Contact your insurer for details.",
                hsaFsaEligible: false,
                planTypes: [userPlan.plan_type || ""],
              },
              categoryLabel: s.service_catalog?.category || "General",
              relevanceNote: `From your ${userPlan.plan_name || "uploaded"} plan`,
              relevanceScore: 95,
              isRecommended: true,
              costSharing: {
                inNetwork: {
                  copay: s.in_copay,
                  coinsurance: s.in_coinsurance,
                  deductibleApplies: s.in_deductible_applies,
                  costDescription: s.in_cost_description,
                },
                outOfNetwork: {
                  copay: s.out_copay,
                  coinsurance: s.out_coinsurance,
                  deductibleApplies: s.out_deductible_applies,
                  costDescription: s.out_cost_description,
                },
                annualLimit: s.annual_limit,
                priorAuthRequired: s.prior_auth_required,
                penaltyNoPrecert: s.penalty_no_precert,
              },
            }));

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

        return NextResponse.json({
          benefits,
          categoryCounts: {},
          totalBenefits: benefits.length,
          profileComplete: true,
          missingFields: [],
          dataSource: "matched_plan",
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
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to analyze plan" },
      { status: 500 }
    );
  }
}

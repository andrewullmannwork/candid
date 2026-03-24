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

    // Fetch user profile with demographics
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("insurer, plan_type, state, date_of_birth, sex, dependents")
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

    // ── Check for real plan data first ──────────────────────────────────
    // If we have verified plan_benefits for this user's insurer, use those
    // instead of the static catalog.
    let hasRealPlanData = false;
    if (profile.insurer) {
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

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

/** Extract and verify the Firebase ID token from the Authorization header */
async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const idToken = authHeader.slice(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    return decoded;
  } catch {
    return null;
  }
}

/** GET /api/profile — load the current user's profile + active insurance plan */
export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  // Fetch active insurance plan if linked
  let insurancePlan = null;
  let coveredServices = null;
  if (profile?.active_insurance_plan_id) {
    const { data: plan } = await supabase
      .from("insurance_plans")
      .select("*")
      .eq("id", profile.active_insurance_plan_id)
      .single();
    insurancePlan = plan;

    if (plan) {
      const { data: services } = await supabase
        .from("plan_covered_services")
        .select("*, service_catalog(slug, name, category)")
        .eq("insurance_plan_id", plan.id);
      coveredServices = services;
    }
  }

  return NextResponse.json({
    profile: profile || null,
    insurancePlan,
    coveredServices,
  });
}

/** POST /api/profile — save/update the current user's profile (partial updates supported) */
export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    insurer,
    plan_type,
    plan_name,
    state,
    group_number,
    member_id,
    // Legacy field names (backward compat with old frontend)
    deductible_individual,
    oop_max_individual,
    // New expanded field names
    in_deductible_individual,
    in_deductible_family,
    in_oop_max_individual,
    in_oop_max_family,
    out_deductible_individual,
    out_deductible_family,
    out_oop_max_individual,
    out_oop_max_family,
    copay_primary,
    copay_specialist,
    copay_er,
    copay_urgent_care,
    copay_rx,
    coinsurance_pct,
    primary_concern,
    insurance_card_path,
    date_of_birth,
    sex,
    phone,
    dependents,
    matched_plan_id,
    plan_source,
  } = body;

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Build update object — only include defined keys so partial saves don't overwrite existing data
  const update: Record<string, unknown> = { user_id: user.id };
  if (insurer !== undefined) update.insurer = insurer || null;
  if (plan_type !== undefined) update.plan_type = plan_type || null;
  if (plan_name !== undefined) update.plan_name = plan_name || null;
  if (state !== undefined) update.state = state || null;
  if (group_number !== undefined) update.group_number = group_number || null;
  if (member_id !== undefined) update.member_id = member_id || null;
  // Map expanded cost fields to legacy profile columns (until schema consolidation)
  const dedInd = in_deductible_individual ?? deductible_individual;
  const oopInd = in_oop_max_individual ?? oop_max_individual;
  // Numeric fields: preserve 0, only null-ify undefined/empty-string
  const toNum = (v: unknown) => (v === "" || v == null ? null : v);
  if (dedInd !== undefined) update.deductible_individual = toNum(dedInd);
  if (oopInd !== undefined) update.oop_max_individual = toNum(oopInd);
  if (copay_primary !== undefined) update.copay_primary = toNum(copay_primary);
  if (copay_specialist !== undefined) update.copay_specialist = toNum(copay_specialist);
  if (copay_er !== undefined) update.copay_er = toNum(copay_er);
  if (coinsurance_pct !== undefined) update.coinsurance_pct = toNum(coinsurance_pct);
  if (primary_concern !== undefined) update.primary_concern = primary_concern || null;
  if (insurance_card_path !== undefined) update.insurance_card_path = insurance_card_path || null;
  if (date_of_birth !== undefined) {
    if (date_of_birth) {
      const dob = new Date(date_of_birth + "T00:00:00");
      const now = new Date();
      if (isNaN(dob.getTime()) || dob > now) {
        return NextResponse.json({ error: "Invalid date of birth" }, { status: 400 });
      }
      const age = now.getFullYear() - dob.getFullYear() -
        (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate()) ? 1 : 0);
      if (age < 18) {
        return NextResponse.json({ error: "Must be at least 18 years old" }, { status: 400 });
      }
    }
    update.date_of_birth = date_of_birth || null;
  }
  if (sex !== undefined) update.sex = sex || null;
  if (phone !== undefined) update.phone = phone || null;
  if (matched_plan_id !== undefined) update.matched_plan_id = matched_plan_id || null;
  if (plan_source !== undefined) update.plan_source = plan_source || null;
  if (dependents !== undefined) {
    try {
      update.dependents = typeof dependents === "string" ? JSON.parse(dependents) : dependents;
    } catch {
      update.dependents = null;
    }
  }

  const { error } = await supabase
    .from("profiles")
    .upsert(update, { onConflict: "user_id" });

  if (error) {
    console.error("Profile save error:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  // ── Dual-write: sync plan data to insurance_plans ─────────────────────────
  // When plan-related fields are submitted, also write to the normalized tables
  const hasPlanData = plan_name !== undefined || deductible_individual !== undefined
    || copay_primary !== undefined || coinsurance_pct !== undefined
    || matched_plan_id !== undefined || insurer !== undefined;

  if (hasPlanData) {
    try {
      // Check if user already has an active insurance plan
      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("active_insurance_plan_id")
        .eq("user_id", user.id)
        .single();

      const planUpdate: Record<string, unknown> = {
        user_id: user.id,
        source: "manual",
        is_active: true,
      };

      if (plan_name !== undefined) planUpdate.plan_name = plan_name || null;
      if (insurer !== undefined) planUpdate.insurer_name = insurer || null;
      if (plan_type !== undefined) planUpdate.plan_type = plan_type || null;
      if (state !== undefined) planUpdate.state = state || null;
      if (group_number !== undefined) planUpdate.group_number = group_number || null;
      if (member_id !== undefined) planUpdate.member_id = member_id || null;
      // Map expanded cost fields to insurance_plans columns
      if (dedInd !== undefined) planUpdate.in_deductible_individual = toNum(dedInd);
      if (in_deductible_family !== undefined) planUpdate.in_deductible_family = toNum(in_deductible_family);
      if (oopInd !== undefined) planUpdate.in_oop_max_individual = toNum(oopInd);
      if (in_oop_max_family !== undefined) planUpdate.in_oop_max_family = toNum(in_oop_max_family);
      if (out_deductible_individual !== undefined) planUpdate.out_deductible_individual = toNum(out_deductible_individual);
      if (out_deductible_family !== undefined) planUpdate.out_deductible_family = toNum(out_deductible_family);
      if (out_oop_max_individual !== undefined) planUpdate.out_oop_max_individual = toNum(out_oop_max_individual);
      if (out_oop_max_family !== undefined) planUpdate.out_oop_max_family = toNum(out_oop_max_family);
      if (coinsurance_pct !== undefined) planUpdate.in_coinsurance_default = coinsurance_pct ? coinsurance_pct / 100 : null;
      if (matched_plan_id !== undefined) planUpdate.matched_catalog_plan_id = matched_plan_id || null;
      if (plan_source !== undefined) {
        // Map plan_source to a valid source if it's a recognized value
        const validSources = ["sbc_upload", "plan_doc_upload", "catalog_match", "manual", "insurance_card"];
        if (plan_source && validSources.includes(plan_source)) {
          planUpdate.source = plan_source;
        }
      }

      if (existingProfile?.active_insurance_plan_id) {
        // Update existing plan
        await supabase
          .from("insurance_plans")
          .update(planUpdate)
          .eq("id", existingProfile.active_insurance_plan_id);
      } else {
        // Create new plan
        const { data: newPlan } = await supabase
          .from("insurance_plans")
          .insert(planUpdate)
          .select("id")
          .single();

        if (newPlan) {
          // Link to profile
          await supabase
            .from("profiles")
            .update({ active_insurance_plan_id: newPlan.id })
            .eq("user_id", user.id);

          // Create plan_covered_services rows for copays
          await syncCopayServices(supabase, newPlan.id, { copay_primary, copay_specialist, copay_er, copay_urgent_care, copay_rx });
        }
      }

      // If updating existing plan, also sync copays
      if (existingProfile?.active_insurance_plan_id && (copay_primary !== undefined || copay_specialist !== undefined || copay_er !== undefined || copay_urgent_care !== undefined || copay_rx !== undefined)) {
        await syncCopayServices(supabase, existingProfile.active_insurance_plan_id, { copay_primary, copay_specialist, copay_er, copay_urgent_care, copay_rx });
      }
    } catch (err) {
      // Non-critical — don't fail the profile save
      console.warn("Insurance plan dual-write failed:", err);
    }
  }

  // ── Insurer catalog matching ─────────────────────────────────────────────
  if (insurer && insurer !== "Other") {
    try {
      const { data: catalogEntries } = await supabase
        .from("insurer_catalog")
        .select("id, name, aliases");

      if (catalogEntries) {
        const normalizedInput = insurer.toLowerCase().trim();
        const match = catalogEntries.find((entry) => {
          if (entry.name.toLowerCase() === normalizedInput) return true;
          if (entry.aliases?.some((alias: string) => alias.toLowerCase() === normalizedInput)) return true;
          if (entry.name.toLowerCase().includes(normalizedInput)) return true;
          if (normalizedInput.includes(entry.name.toLowerCase())) return true;
          return entry.aliases?.some((alias: string) =>
            alias.toLowerCase().includes(normalizedInput) || normalizedInput.includes(alias.toLowerCase())
          );
        });

        if (!match) {
          const { data: existingQueue } = await supabase
            .from("insurer_discovery_queue")
            .select("id")
            .eq("insurer_name_raw", insurer)
            .eq("status", "pending")
            .limit(1);

          if (!existingQueue || existingQueue.length === 0) {
            await supabase.from("insurer_discovery_queue").insert({
              insurer_name_raw: insurer,
              requested_by: user.id,
              source: "profile",
              status: "pending",
            });
          }
        }
      }
    } catch (err) {
      console.warn("Insurer catalog matching failed:", err);
    }
  }

  return NextResponse.json({ success: true });
}

// ── Helper: sync copay fields to plan_covered_services ─────────────────────

type SupabaseClient = ReturnType<typeof createServerClient>;

async function syncCopayServices(
  supabase: SupabaseClient,
  insurancePlanId: string,
  copays: { copay_primary?: number; copay_specialist?: number; copay_er?: number; copay_urgent_care?: number; copay_rx?: number }
) {
  const copayMap: Record<string, number | undefined> = {
    pcp_visit: copays.copay_primary,
    specialist_visit: copays.copay_specialist,
    er_visit: copays.copay_er,
    urgent_care: copays.copay_urgent_care,
    generic_rx_tier1: copays.copay_rx,
  };

  for (const [slug, copay] of Object.entries(copayMap)) {
    if (copay === undefined) continue;

    // Look up service_catalog ID by slug
    const { data: service } = await supabase
      .from("service_catalog")
      .select("id")
      .eq("slug", slug)
      .single();

    if (!service) continue;

    // Upsert the covered service row
    await supabase
      .from("plan_covered_services")
      .upsert(
        {
          insurance_plan_id: insurancePlanId,
          service_id: service.id,
          place_of_service: "any",
          in_copay: copay,
          source: "manual",
          confidence: 1,
        },
        { onConflict: "insurance_plan_id,service_id,place_of_service" }
      );
  }
}

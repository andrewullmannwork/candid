import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped, selectOwnedChildren, upsertOwnedChildren } from "@/lib/security/user-scoped";
import { matchInsurerCatalog } from "@/lib/plan/insurer-match";
import { findOrCreateCanonicalPlan } from "@/lib/plan/canonical-match";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { PLAN_COVERED_ONCONFLICT, type PlanCoverageRow } from "@/lib/plan/coverage-targeting";

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

  const { data: profile } = await userScoped(supabase, user.id)
    .table("profiles")
    .select("*")
    .single();

  // Fetch active insurance plan if linked
  let insurancePlan = null;
  let coveredServices = null;
  if (profile?.active_insurance_plan_id) {
    const { data: plan } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .select("*")
      .eq("id", profile.active_insurance_plan_id)
      .single();
    insurancePlan = plan;

    if (plan) {
      coveredServices = await selectOwnedChildren(
        supabase,
        user.id,
        "plan_covered_services",
        [plan.id],
        "*, service_catalog(slug, name, category)",
      );
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

  // ── Handle canonical match confirmation from card scan UI ────────────────
  if (body.action === "confirm_canonical_match" && body.canonicalPlanId) {
    const supabase = createServerClient();
    const { data: u } = await supabase.from("users").select("id").eq("firebase_uid", decoded.uid).single();
    if (!u) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { data: profile } = await userScoped(supabase, u.id).table("profiles").select("active_insurance_plan_id").single();
    if (!profile?.active_insurance_plan_id) {
      return NextResponse.json({ error: "No active plan" }, { status: 400 });
    }

    try {
      const { confirmCanonicalMatch } = await import("@/lib/plan/canonical-match");
      await confirmCanonicalMatch(supabase, profile.active_insurance_plan_id, body.canonicalPlanId);
      return NextResponse.json({ success: true, canonicalPlanId: body.canonicalPlanId });
    } catch (err) {
      console.error("[canonical-plan] Confirm failed:", err);
      return NextResponse.json({ error: "Failed to confirm canonical match" }, { status: 500 });
    }
  }

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
    // Address / county (migration 026)
    address_line1,
    address_line2,
    city,
    zip_code,
    county_fips,
    county_name,
    // Plan switch override (card scan mismatch confirmed by user)
    force_plan_switch,
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

  // Numeric fields: preserve 0, only null-ify undefined/empty-string
  const toNum = (v: unknown) => (v === "" || v == null ? null : v);
  const dedInd = in_deductible_individual ?? deductible_individual;
  const oopInd = in_oop_max_individual ?? oop_max_individual;
  const isCardScanRequest = plan_source === "insurance_card";

  let pendingCanonicalMatch: { canonicalPlanId: string; matchedPlanName: string; confidence: number; sourceCount: number; insurerName: string } | null = null;

  // ── Pre-check: detect plan changes BEFORE saving to profile ─────────────
  // For card scans, we must check first so "Keep current plan" doesn't pollute the DB

  // Guard: card scan with no insurer extracted — warn user if they already have a plan
  if (isCardScanRequest && !force_plan_switch && !insurer) {
    const { data: preProfile } = await userScoped(supabase, user.id)
      .table("profiles").select("active_insurance_plan_id").single();
    if (preProfile?.active_insurance_plan_id) {
      const { data: existPlan } = await userScoped(supabase, user.id)
        .table("insurance_plans").select("insurer_name").eq("id", preProfile.active_insurance_plan_id).single();
      if (existPlan?.insurer_name) {
        return NextResponse.json({
          success: true,
          planMismatch: {
            type: "missing_insurer" as const,
            existingInsurer: existPlan.insurer_name,
            newInsurer: "Unknown",
            existingPlanName: undefined,
            newPlanName: plan_name || undefined,
          },
        });
      }
    }
  }

  if (isCardScanRequest && !force_plan_switch && insurer) {
    const { data: preCheckProfile } = await userScoped(supabase, user.id)
      .table("profiles")
      .select("active_insurance_plan_id, plan_name, group_number")
      .single();

    if (preCheckProfile?.active_insurance_plan_id) {
      const { data: existingPlanCheck } = await userScoped(supabase, user.id)
        .table("insurance_plans")
        .select("insurer_name, plan_name, group_number")
        .eq("id", preCheckProfile.active_insurance_plan_id)
        .single();

      if (existingPlanCheck?.insurer_name) {
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const existingInsurerNorm = normalize(existingPlanCheck.insurer_name);
        const incomingInsurerNorm = normalize(insurer);
        const insurerMatches = existingInsurerNorm && incomingInsurerNorm &&
          (existingInsurerNorm.includes(incomingInsurerNorm) || incomingInsurerNorm.includes(existingInsurerNorm));

        if (!insurerMatches) {
          // Different insurer — full mismatch
          return NextResponse.json({
            success: true,
            planMismatch: {
              type: "different_insurer" as const,
              existingInsurer: existingPlanCheck.insurer_name,
              newInsurer: insurer,
              existingPlanName: existingPlanCheck.plan_name || undefined,
              newPlanName: plan_name || undefined,
            },
          });
        }

        // Same insurer — check if plan details differ (T1.6)
        if (insurerMatches && (plan_name || group_number)) {
          const existingPlanNorm = existingPlanCheck.plan_name ? normalize(existingPlanCheck.plan_name) : "";
          const incomingPlanNorm = plan_name ? normalize(plan_name) : "";
          const existingGroupNorm = existingPlanCheck.group_number ? normalize(existingPlanCheck.group_number) : "";
          const incomingGroupNorm = group_number ? normalize(group_number) : "";

          const planNameMatches = !incomingPlanNorm || !existingPlanNorm ||
            existingPlanNorm.includes(incomingPlanNorm) || incomingPlanNorm.includes(existingPlanNorm);
          const groupMatches = !incomingGroupNorm || !existingGroupNorm ||
            existingGroupNorm === incomingGroupNorm;

          // If both plan name AND group number differ, this is likely a different plan from the same insurer
          if (!planNameMatches && !groupMatches) {
            return NextResponse.json({
              success: true,
              planMismatch: {
                type: "same_insurer_different_plan" as const,
                existingInsurer: existingPlanCheck.insurer_name,
                newInsurer: insurer,
                existingPlanName: existingPlanCheck.plan_name || undefined,
                newPlanName: plan_name || undefined,
              },
            });
          }
          // If only one differs, it's ambiguous — could be a card replacement or a plan change
          if (!planNameMatches || !groupMatches) {
            return NextResponse.json({
              success: true,
              planMismatch: {
                type: "same_insurer_uncertain" as const,
                existingInsurer: existingPlanCheck.insurer_name,
                newInsurer: insurer,
                existingPlanName: existingPlanCheck.plan_name || undefined,
                newPlanName: plan_name || undefined,
              },
            });
          }
        }
      }
    }
  }

  // Build update object — only include defined keys so partial saves don't overwrite existing data
  const update: Record<string, unknown> = { user_id: user.id };
  if (insurer !== undefined) update.insurer = insurer || null;
  if (plan_type !== undefined) update.plan_type = plan_type || null;
  if (plan_name !== undefined) update.plan_name = plan_name || null;
  if (state !== undefined) update.state = state || null;
  if (group_number !== undefined) update.group_number = group_number || null;
  if (member_id !== undefined) update.member_id = member_id || null;
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
  // Address / county fields
  if (address_line1 !== undefined) update.address_line1 = address_line1 || null;
  if (address_line2 !== undefined) update.address_line2 = address_line2 || null;
  if (city !== undefined) update.city = city || null;
  if (zip_code !== undefined) update.zip_code = zip_code || null;
  if (county_fips !== undefined) update.county_fips = county_fips || null;
  if (county_name !== undefined) update.county_name = county_name || null;
  if (dependents !== undefined) {
    try {
      update.dependents = typeof dependents === "string" ? JSON.parse(dependents) : dependents;
    } catch {
      update.dependents = null;
    }
  }

  const { error } = await userScoped(supabase, user.id)
    .table("profiles")
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
      const { data: existingProfile } = await userScoped(supabase, user.id)
        .table("profiles")
        .select("active_insurance_plan_id")
        .single();

      const isCardScan = plan_source === "insurance_card";

      // CF-25 (Session 73, S71) — orphan-discovery for active insurance_plans rows
      // when profile.active_insurance_plan_id is null. The smart-skip path on a
      // fresh SBC upload calls profiles.UPDATE to set the pointer, but if no
      // profile row existed at upload time the UPDATE silently no-ops (no rows
      // matched). Result: an orphan is_active=true SBC-extracted row with
      // cite-grade provenance, plus a profile that thinks the user has no plan.
      // When the user then fills the onboarding form, the else-branch below
      // INSERTs a manual plan with is_active=true → two active rows + the
      // profile points at the manual one (no provenance, no badges).
      //
      // Fix: before deciding insert-vs-update, check for any orphan active row.
      // If found, repoint the profile to it and treat it as the existing plan.
      // The user's form values then flow through the update branch +
      // isFormAfterDoc preserves SBC cost data while updating identity fields.
      if (existingProfile && !existingProfile.active_insurance_plan_id) {
        const { data: orphanedActive } = await userScoped(supabase, user.id)
          .table("insurance_plans")
          .select("id")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (orphanedActive) {
          existingProfile.active_insurance_plan_id = orphanedActive.id;
          await userScoped(supabase, user.id)
            .table("profiles")
            .update({ active_insurance_plan_id: orphanedActive.id });
          console.log(`[profile] CF-25 orphan-discovery: repointed profile.active_insurance_plan_id → ${orphanedActive.id} for user ${user.id}`);
        }
      }

      // Fetch existing plan source for isFormAfterDoc detection
      let existingPlan: { insurer_name: string | null; source: string | null } | null = null;
      if (existingProfile?.active_insurance_plan_id) {
        const { data: plan } = await userScoped(supabase, user.id)
          .table("insurance_plans")
          .select("insurer_name, source")
          .eq("id", existingProfile.active_insurance_plan_id)
          .single();
        existingPlan = plan;
      }

      // If force_plan_switch, deactivate old plan before creating new one
      if (force_plan_switch && existingProfile?.active_insurance_plan_id) {
        await userScoped(supabase, user.id)
          .table("insurance_plans")
          .update({ is_active: false })
          .eq("id", existingProfile.active_insurance_plan_id);
        // Clear the reference so the code below creates a new plan
        existingProfile.active_insurance_plan_id = null;
        // Clear stale profile plan fields (all cost/plan fields; personal info preserved)
        const { error: clearErr } = await userScoped(supabase, user.id)
          .table("profiles")
          .update({
            active_insurance_plan_id: null,
            insurer: null, plan_name: null, plan_type: null, state: null,
            group_number: null, member_id: null,
            deductible_individual: null, oop_max_individual: null,
            copay_primary: null, copay_specialist: null, copay_er: null,
            coinsurance_pct: null,
            matched_plan_id: null, plan_source: null,
          });
        if (clearErr) {
          console.error("[profile] force_plan_switch profile clear failed:", clearErr.message);
        }
      }

      {
        // ── Form-after-doc merge: only update identity fields, preserve benefit data ──
        // CF-25 (Session 73, S71) — broadened from isCardAfterDoc to isFormAfterDoc.
        // Both card scans AND manual onboarding-form submissions are now treated as
        // identity-update-only when an existing plan came from a doc upload (SBC or
        // plan_document). Doc-extracted values carry cite-grade Pattern P-8 provenance;
        // manual-form / card values do not. If user wants to override doc values they
        // use /api/plan/field (inline-edit), which writes user_correction provenance
        // with confidence=1.0 — that's the strong-signal override path.
        const existingIsFromDoc = existingPlan?.source === "sbc_upload" || existingPlan?.source === "plan_doc_upload";
        const isFormAfterDoc = existingProfile?.active_insurance_plan_id && existingIsFromDoc;

        let planUpdate: Record<string, unknown>;

        if (isFormAfterDoc) {
          // Form (card scan or manual) after a doc upload: only update identity fields.
          // Do NOT overwrite cost fields — doc data has cite-grade provenance.
          planUpdate = { user_id: user.id };
          if (insurer !== undefined) planUpdate.insurer_name = insurer || null;
          if (plan_name !== undefined) planUpdate.plan_name = plan_name || null;
          if (plan_type !== undefined) planUpdate.plan_type = plan_type || null;
          if (state !== undefined) planUpdate.state = state || null;
          if (group_number !== undefined) planUpdate.group_number = group_number || null;
          if (member_id !== undefined) planUpdate.member_id = member_id || null;
          // Don't overwrite deductibles, OOP, copays, coinsurance from doc-extracted values
        } else {
          // Normal flow: write all fields
          planUpdate = {
            user_id: user.id,
            source: isCardScan ? "insurance_card" : "manual",
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
          if (matched_plan_id !== undefined) {
            planUpdate.matched_catalog_plan_id = matched_plan_id || null;
            // Look up hios_id from plan_catalog for county-aware resolution
            if (matched_plan_id) {
              try {
                const { data: catalogPlan } = await supabase
                  .from("plan_catalog")
                  .select("hios_id")
                  .eq("id", matched_plan_id)
                  .single();
                if (catalogPlan?.hios_id) {
                  planUpdate.hios_id = catalogPlan.hios_id;
                }
              } catch { /* non-critical */ }
            }
          }
          if (plan_source !== undefined) {
            // Map plan_source to a valid source if it's a recognized value
            const validSources = ["sbc_upload", "plan_doc_upload", "catalog_match", "manual", "insurance_card"];
            if (plan_source && validSources.includes(plan_source)) {
              planUpdate.source = plan_source;
            }
          }
        }

        if (existingProfile?.active_insurance_plan_id) {
          // Update existing plan
          await userScoped(supabase, user.id)
            .table("insurance_plans")
            .update(planUpdate)
            .eq("id", existingProfile.active_insurance_plan_id);
        } else {
          // CF-25 (Session 73, S71) defense-in-depth — orphan-discovery above
          // should have repointed if any active rows existed, but a race
          // (concurrent SBC upload between discovery and insert) could still
          // leave one. Deactivate any other active rows before inserting.
          // Mirrors extraction-dedup.ts:508-512.
          await userScoped(supabase, user.id)
            .table("insurance_plans")
            .update({ is_active: false })
            .eq("is_active", true);

          // Create new plan
          const { data: newPlan } = await userScoped(supabase, user.id)
            .table("insurance_plans")
            .insert({ ...planUpdate, source: isCardScan ? "insurance_card" : "manual", is_active: true })
            .select("id")
            .single();

          if (newPlan) {
            // Link to profile
            await userScoped(supabase, user.id)
              .table("profiles")
              .update({ active_insurance_plan_id: newPlan.id });

            // Track the new plan ID for canonical matching below
            if (existingProfile) existingProfile.active_insurance_plan_id = newPlan.id;

            // Create plan_covered_services rows for copays
            await syncCopayServices(supabase, user.id, newPlan.id, { copay_primary, copay_specialist, copay_er, copay_urgent_care, copay_rx });
          }
        }

        // If updating existing plan, also sync copays (skip for card-after-doc — SBC copays are more complete)
        if (!isFormAfterDoc && existingProfile?.active_insurance_plan_id && (copay_primary !== undefined || copay_specialist !== undefined || copay_er !== undefined || copay_urgent_care !== undefined || copay_rx !== undefined)) {
          await syncCopayServices(supabase, user.id, existingProfile.active_insurance_plan_id, { copay_primary, copay_specialist, copay_er, copay_urgent_care, copay_rx });
        }

        // ── Canonical plan matching for card scans ────────────────────────────
        // When card scan creates/updates a plan, try to match it to a canonical plan
        if (isCardScan && insurer && plan_name) {
          try {
            const canonicalEnabled = await isFeatureEnabled("canonical_plans");
            if (canonicalEnabled) {
              const insurerMatch = await matchInsurerCatalog(supabase, insurer);
              if (insurerMatch) {
                const activePlanId = existingProfile?.active_insurance_plan_id; // Uses newPlan.id if just created
                // Only attempt canonical matching if we have a plan ID
                if (activePlanId) {
                  const { data: currentPlan } = await userScoped(supabase, user.id)
                    .table("insurance_plans")
                    .select("canonical_plan_id")
                    .eq("id", activePlanId)
                    .single();

                  // Skip if already linked to a canonical plan
                  if (!currentPlan?.canonical_plan_id) {
                    const canonicalResult = await findOrCreateCanonicalPlan(supabase, {
                      insurerId: insurerMatch.id,
                      planName: plan_name,
                      planType: plan_type || undefined,
                      state: state || undefined,
                      groupNumber: group_number || undefined,
                    });

                    if (!canonicalResult.needsConfirmation) {
                      // High confidence — auto-link
                      await userScoped(supabase, user.id)
                        .table("insurance_plans")
                        .update({ canonical_plan_id: canonicalResult.canonicalPlanId })
                        .eq("id", activePlanId);
                    } else {
                      // Medium confidence — return for user confirmation
                      pendingCanonicalMatch = {
                        canonicalPlanId: canonicalResult.canonicalPlanId,
                        matchedPlanName: canonicalResult.matchedPlanName || plan_name,
                        confidence: canonicalResult.confidence,
                        sourceCount: canonicalResult.sourceCount || 1,
                        insurerName: insurerMatch.name,
                      };
                    }
                  }
                }
              }
            }
          } catch (canonicalErr) {
            console.warn("Canonical plan matching failed (non-critical):", canonicalErr);
          }
        }
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

  return NextResponse.json({
    success: true,
    ...(pendingCanonicalMatch ? { pendingCanonicalMatch } : {}),
  });
}

// ── Helper: sync copay fields to plan_covered_services ─────────────────────

type SupabaseClient = ReturnType<typeof createServerClient>;

async function syncCopayServices(
  supabase: SupabaseClient,
  userId: string,
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

  // Resolve each slug → service_catalog id, then write all copay rows through
  // upsertOwnedChildren so the parent insurance_plan ownership is verified once
  // (B1 child-write primitive) — the raw .from("plan_covered_services") the lint
  // bans lives only inside the security layer. The fk (insurance_plan_id) is
  // stamped by the primitive, so it is omitted from each row here.
  // S190 (thesaurus T4 × B9 #183 seam): each row carries the 4-col cell identity — the
  // Pick<PlanCoverageRow, …> typing makes a missing place_of_service/component a compile
  // error (mig 157 re-keys the table 4-col), and the conflict key is the shared
  // PLAN_COVERED_ONCONFLICT constant. Route-level coverage writes use the B9 ownership
  // primitive; applyPlanCoverageCell stays the sanctioned writer in lib/parser code.
  const rows: Array<
    Pick<PlanCoverageRow, "service_id" | "place_of_service" | "component"> & Record<string, unknown>
  > = [];
  for (const [slug, copay] of Object.entries(copayMap)) {
    if (copay === undefined) continue;

    // Look up service_catalog ID by slug
    const { data: service } = await supabase
      .from("service_catalog")
      .select("id")
      .eq("slug", slug)
      .single();

    if (!service) continue;

    rows.push({
      service_id: service.id,
      place_of_service: "any",
      component: "global",
      in_copay: copay,
      source: "manual",
      confidence: 1,
    });
  }

  if (rows.length > 0) {
    await upsertOwnedChildren(supabase, userId, "plan_covered_services", insurancePlanId, rows, {
      onConflict: PLAN_COVERED_ONCONFLICT,
    });
  }
}

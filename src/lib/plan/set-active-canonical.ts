/**
 * setActiveCanonicalPlan — THE shared persistence core for "the user picked a
 * plan from Candid's canonical library" (S288 plan-flow unification).
 *
 * Extracted verbatim from POST /api/plan/set-active (bugbash Stretch 1) so
 * every search-select surface persists through ONE path:
 *   - /api/plan/set-active (the original route — /plan "Change plan")
 *   - onboarding step 2 "Search for your plan" (S288)
 *   - /api/profile dual-write when the legacy wizard submits a canonical
 *     matched_plan_id (S288 — replaces the dead matched_catalog_plan_id write)
 *
 * LINK-ONLY, USER-SCOPED. Deliberately NOT confirmCanonicalMatch(): a dropdown
 * pick is NOT corroboration (Pattern 1 #14) — we only WRITE the user's own
 * rows: insurance_plans (link + identity, source='catalog_match') + profiles
 * (repoint + clear stale cost/match fields). No canonical-table writes.
 *
 * Cost-share terms deliberately stay OFF the user row — readers resolve them
 * through the canonical link (coverage-loader per-service; the S288 canonical
 * fallback in cost-share/accumulator plan-terms loaders).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";

export type SetActiveCanonicalResult =
  | { ok: true; insurancePlanId: string; cardCleared: boolean }
  | { ok: false; status: number; error: string };

const normalizeInsurer = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function setActiveCanonicalPlan(
  supabase: SupabaseClient,
  userId: string,
  canonicalPlanId: string,
): Promise<SetActiveCanonicalResult> {
  // ── Read canonical identity (server-trusted; never trust client-sent fields).
  // insurer name lives on insurer_catalog (canonical_plans.insurer_id FK). Two
  // plain reads instead of a PostgREST embed to avoid 42703 typing ambiguity. ─
  const { data: canonical } = await supabase
    .from("canonical_plans")
    .select("id, plan_name, plan_type, state, plan_year, insurer_id")
    .eq("id", canonicalPlanId)
    .maybeSingle();
  if (!canonical) {
    return { ok: false, status: 404, error: "Plan not found" };
  }
  let insurerName: string | null = null;
  if (canonical.insurer_id) {
    const { data: insurerRow } = await supabase
      .from("insurer_catalog")
      .select("name")
      .eq("id", canonical.insurer_id)
      .maybeSingle();
    insurerName = (insurerRow?.name as string | null) ?? null;
  }

  // Identity written to both insurance_plans + profiles. source='catalog_match'
  // (NOT a user-upload source) so the /plan card shows honest canonical-grade
  // provenance — never a false "User Verified" badge.
  const identity = {
    canonical_plan_id: canonicalPlanId,
    insurer_name: insurerName,
    plan_name: canonical.plan_name,
    plan_type: canonical.plan_type,
    state: canonical.state,
    plan_year: canonical.plan_year,
    source: "catalog_match" as const,
  };

  // ── Card-preservation decision (S288, e3e finding) ─────────────────────────
  // "A confirmed switch clears the other half" was designed for CHANGING an
  // established pair — not for signup ASSEMBLY, where the card was typed
  // seconds before the plan was selected and clearing it reads as data loss.
  // Preserve the card IDs (member/group) when:
  //   - ASSEMBLY: the prior active row is just the card's manual/card stub
  //     (or nothing) — the user is building the pair, not switching plans; or
  //   - the prior insurer MATCHES the selected plan's insurer (same-insurer
  //     plan change — the card isn't stale).
  // Clear them only on a real cross-insurer switch, and REPORT it
  // (cardCleared) so the client mirrors the truth instead of showing a card
  // that silently stopped existing server-side.
  const { data: priorProfile } = await userScoped(supabase, userId)
    .table("profiles")
    .select("insurer, member_id, group_number, active_insurance_plan_id")
    .maybeSingle();
  let priorActiveSource: string | null = null;
  if (priorProfile?.active_insurance_plan_id) {
    const { data: priorActive } = await userScoped(supabase, userId)
      .table("insurance_plans")
      .select("source")
      .eq("id", priorProfile.active_insurance_plan_id)
      .maybeSingle();
    priorActiveSource = (priorActive?.source as string | null) ?? null;
  }
  const assembly =
    priorActiveSource === null || priorActiveSource === "manual" || priorActiveSource === "insurance_card";
  const priorInsurerNorm = priorProfile?.insurer ? normalizeInsurer(priorProfile.insurer as string) : "";
  const newInsurerNorm = insurerName ? normalizeInsurer(insurerName) : "";
  const insurerMatches =
    !!priorInsurerNorm &&
    !!newInsurerNorm &&
    (priorInsurerNorm.includes(newInsurerNorm) || newInsurerNorm.includes(priorInsurerNorm));
  const preserveCard = assembly || insurerMatches;
  const keptMemberId = preserveCard ? ((priorProfile?.member_id as string | null) ?? null) : null;
  const keptGroupNumber = preserveCard ? ((priorProfile?.group_number as string | null) ?? null) : null;
  const cardCleared =
    !preserveCard && (priorProfile?.member_id != null || priorProfile?.group_number != null);

  // ── Dedup: reuse an existing owned row already linked to this canonical plan
  // (re-selecting the same plan should reactivate, not duplicate). ────────────
  const { data: existing } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .select("id")
    .eq("canonical_plan_id", canonicalPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Single-active-plan guard: deactivate ALL the user's active rows first
  // (mirrors /api/profile force_plan_switch + extraction-dedup).
  const { error: deactivateErr } = await userScoped(supabase, userId)
    .table("insurance_plans")
    .update({ is_active: false })
    .eq("is_active", true);
  if (deactivateErr) {
    console.error("[set-active-canonical] deactivate failed:", deactivateErr.message);
    return { ok: false, status: 500, error: "Could not set plan" };
  }

  // Preserved card IDs ride onto the plan row too (they describe the user's
  // enrollment in THIS plan once the pair is coherent).
  const cardCarry =
    keptMemberId != null || keptGroupNumber != null
      ? { member_id: keptMemberId, group_number: keptGroupNumber }
      : {};

  let activePlanId: string;
  if (existing?.id) {
    const { error: reactivateErr } = await userScoped(supabase, userId)
      .table("insurance_plans")
      .update({ ...identity, ...cardCarry, is_active: true })
      .eq("id", existing.id);
    if (reactivateErr) {
      console.error("[set-active-canonical] reactivate failed:", reactivateErr.message);
      return { ok: false, status: 500, error: "Could not set plan" };
    }
    activePlanId = existing.id as string;
  } else {
    const { data: inserted, error: insertErr } = await userScoped(supabase, userId)
      .table("insurance_plans")
      .insert({ ...identity, ...cardCarry, user_id: userId, is_active: true })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      console.error("[set-active-canonical] insert failed:", insertErr?.message);
      return { ok: false, status: 500, error: "Could not set plan" };
    }
    activePlanId = inserted.id as string;
  }

  // ── Repoint profile + set identity + CLEAR stale cost/match fields ─────────
  // analyze resolves the active plan's cost-share from canonical_plan_services
  // (via canonical_plan_id), so the profile's old per-plan cost fields must be
  // cleared. matched_plan_id is cleared so the prior plan_catalog match can't
  // shadow the new canonical plan in analyze Priority 1.
  const { error: profileErr } = await userScoped(supabase, userId)
    .table("profiles")
    .update({
      active_insurance_plan_id: activePlanId,
      insurer: insurerName,
      plan_name: canonical.plan_name,
      plan_type: canonical.plan_type,
      state: canonical.state,
      plan_source: "catalog_match",
      matched_plan_id: null,
      // S288 (e3e): card IDs survive assembly + same-insurer switches; they
      // clear only on a real cross-insurer switch (cardCleared reports it).
      group_number: keptGroupNumber,
      member_id: keptMemberId,
      deductible_individual: null,
      oop_max_individual: null,
      copay_primary: null,
      copay_specialist: null,
      copay_er: null,
      coinsurance_pct: null,
    });
  if (profileErr) {
    console.error("[set-active-canonical] profile repoint failed:", profileErr.message);
    return { ok: false, status: 500, error: "Could not set plan" };
  }

  return { ok: true, insurancePlanId: activePlanId, cardCleared };
}

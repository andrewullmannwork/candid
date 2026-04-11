/**
 * Canonical Plan Matching
 *
 * Finds or creates a canonical_plans row for a given document upload.
 * Matching priority:
 *   1. group_number exact match (strongest — same employer plan)
 *   2. plan_name + insurer normalized match
 *   3. hios_id exact match (CMS marketplace plans)
 *
 * Confidence thresholds:
 *   >= 0.9 → auto-link (no user confirmation needed)
 *   0.7–0.9 → needs user confirmation before linking
 *   < 0.7 → no match, create new canonical plan
 */

import type { SupabaseClient } from "@supabase/supabase-js";
// normalizeInsurerName available from "./matcher" if needed for future enhancements

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CanonicalMatchInput {
  insurerId: string;
  planName: string;
  planType?: string;
  state?: string;
  planYear?: number;
  groupNumber?: string;
  hiosId?: string;
  deductible?: number;
  oopMax?: number;
}

export interface CanonicalMatchResult {
  canonicalPlanId: string;
  isNew: boolean;
  confidence: number;
  needsConfirmation: boolean;
  matchedPlanName?: string;
  matchedInsurerName?: string;
  sourceCount?: number;
}

interface CanonicalPlanRow {
  id: string;
  insurer_id: string;
  plan_name: string;
  plan_type: string | null;
  state: string | null;
  plan_year: number | null;
  group_number: string | null;
  hios_id: string | null;
  deductible_individual: number | null;
  oop_max_individual: number | null;
  confidence_score: number;
  source_count: number;
}

// ── Matching ───────────────────────────────────────────────────────────────────

/**
 * Find an existing canonical plan or create a new one.
 * Returns the canonical plan ID, whether it was newly created,
 * the match confidence, and whether user confirmation is needed.
 */
export async function findOrCreateCanonicalPlan(
  supabase: SupabaseClient,
  input: CanonicalMatchInput
): Promise<CanonicalMatchResult> {
  const planYear = input.planYear || new Date().getFullYear();

  // Step 1: Try group_number exact match (strongest signal)
  if (input.groupNumber) {
    const { data: groupMatch } = await supabase
      .from("canonical_plans")
      .select("*")
      .eq("insurer_id", input.insurerId)
      .eq("group_number", input.groupNumber)
      .eq("plan_year", planYear)
      .limit(1)
      .single();

    if (groupMatch) {
      console.log(`[canonical-plan] Group number exact match: ${groupMatch.plan_name} (${groupMatch.id})`);
      await incrementSourceCount(supabase, groupMatch.id, groupMatch.source_count, groupMatch.confidence_score);
      return {
        canonicalPlanId: groupMatch.id,
        isNew: false,
        confidence: 0.95,
        needsConfirmation: false, // group_number match is very high confidence
        matchedPlanName: groupMatch.plan_name,
        sourceCount: groupMatch.source_count + 1,
      };
    }
  }

  // Step 2: Try hios_id exact match (CMS marketplace plans)
  if (input.hiosId) {
    const { data: hiosMatch } = await supabase
      .from("canonical_plans")
      .select("*")
      .eq("hios_id", input.hiosId)
      .limit(1)
      .single();

    if (hiosMatch) {
      console.log(`[canonical-plan] HIOS ID exact match: ${hiosMatch.plan_name} (${hiosMatch.id})`);
      await incrementSourceCount(supabase, hiosMatch.id, hiosMatch.source_count, hiosMatch.confidence_score);
      return {
        canonicalPlanId: hiosMatch.id,
        isNew: false,
        confidence: 0.95,
        needsConfirmation: false,
        matchedPlanName: hiosMatch.plan_name,
        sourceCount: hiosMatch.source_count + 1,
      };
    }
  }

  // Step 3: Fuzzy match by insurer + plan_name + state + year
  const { data: candidates } = await supabase
    .from("canonical_plans")
    .select("*")
    .eq("insurer_id", input.insurerId)
    .eq("plan_year", planYear);

  if (candidates && candidates.length > 0) {
    const scored = candidates
      .map((c: CanonicalPlanRow) => ({
        plan: c,
        score: scoreCandidate(input, c),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      const confidence = best.score;

      if (confidence >= 0.7) {
        console.log(`[canonical-plan] Fuzzy match (${confidence.toFixed(2)}): ${best.plan.plan_name} (${best.plan.id})`);

        if (confidence >= 0.9) {
          // High confidence — auto-link
          await incrementSourceCount(supabase, best.plan.id, best.plan.source_count, best.plan.confidence_score);
          return {
            canonicalPlanId: best.plan.id,
            isNew: false,
            confidence,
            needsConfirmation: false,
            matchedPlanName: best.plan.plan_name,
            sourceCount: best.plan.source_count + 1,
          };
        }

        // Medium confidence — needs user confirmation
        return {
          canonicalPlanId: best.plan.id,
          isNew: false,
          confidence,
          needsConfirmation: true,
          matchedPlanName: best.plan.plan_name,
          sourceCount: best.plan.source_count,
        };
      }
    }
  }

  // Step 4: No match — create new canonical plan
  console.log(`[canonical-plan] No match found, creating new canonical plan: ${input.planName}`);
  const newPlan = await createCanonicalPlan(supabase, input, planYear);

  return {
    canonicalPlanId: newPlan.id,
    isNew: true,
    confidence: 0.5, // single-source confidence
    needsConfirmation: false,
    matchedPlanName: input.planName,
    sourceCount: 1,
  };
}

/**
 * Confirm a pending canonical match — link the user's plan and merge services.
 */
export async function confirmCanonicalMatch(
  supabase: SupabaseClient,
  insurancePlanId: string,
  canonicalPlanId: string
): Promise<void> {
  // Link insurance_plan to canonical
  await supabase
    .from("insurance_plans")
    .update({ canonical_plan_id: canonicalPlanId })
    .eq("id", insurancePlanId);

  // Increment source count
  const { data: canonical } = await supabase
    .from("canonical_plans")
    .select("source_count, confidence_score")
    .eq("id", canonicalPlanId)
    .single();

  if (canonical) {
    await incrementSourceCount(supabase, canonicalPlanId, canonical.source_count, canonical.confidence_score);
  }

  // Merge user's plan_covered_services into canonical_plan_services
  await mergeServicesIntoCanonical(supabase, insurancePlanId, canonicalPlanId);

  console.log(`[canonical-plan] Confirmed match: insurance_plan=${insurancePlanId} → canonical=${canonicalPlanId}`);
}

/**
 * Reject a pending canonical match — create a new canonical plan for this user.
 * Decreases the rejected plan's confidence score.
 */
export async function rejectCanonicalMatch(
  supabase: SupabaseClient,
  insurancePlanId: string,
  rejectedCanonicalPlanId: string
): Promise<string> {
  // Decrease confidence of the rejected canonical plan
  const { data: rejected } = await supabase
    .from("canonical_plans")
    .select("confidence_score")
    .eq("id", rejectedCanonicalPlanId)
    .single();

  if (rejected) {
    const newScore = Math.max(0, (rejected.confidence_score || 0.5) - 0.05);
    await supabase
      .from("canonical_plans")
      .update({ confidence_score: newScore, updated_at: new Date().toISOString() })
      .eq("id", rejectedCanonicalPlanId);
    console.log(`[canonical-plan] Rejection penalty: ${rejectedCanonicalPlanId} confidence → ${newScore.toFixed(2)}`);
  }

  // Get the user's plan data to create a new canonical plan
  const { data: userPlan } = await supabase
    .from("insurance_plans")
    .select("insurer_name, plan_name, plan_type, in_deductible_individual, in_oop_max_individual")
    .eq("id", insurancePlanId)
    .single();

  if (!userPlan) {
    throw new Error(`Insurance plan ${insurancePlanId} not found`);
  }

  // Resolve insurer_id
  const { matchInsurerCatalog } = await import("./insurer-match");
  const insurer = await matchInsurerCatalog(supabase, userPlan.insurer_name || "");
  if (!insurer) {
    throw new Error(`Could not resolve insurer for: ${userPlan.insurer_name}`);
  }

  // Get user profile for state
  const { data: planWithUser } = await supabase
    .from("insurance_plans")
    .select("user_id")
    .eq("id", insurancePlanId)
    .single();

  let state: string | undefined;
  if (planWithUser) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("state")
      .eq("user_id", planWithUser.user_id)
      .single();
    state = profile?.state || undefined;
  }

  const newCanonical = await createCanonicalPlan(supabase, {
    insurerId: insurer.id,
    planName: userPlan.plan_name || "Unknown Plan",
    planType: userPlan.plan_type || undefined,
    state,
    deductible: userPlan.in_deductible_individual || undefined,
    oopMax: userPlan.in_oop_max_individual || undefined,
  }, new Date().getFullYear());

  // Link and merge
  await supabase
    .from("insurance_plans")
    .update({ canonical_plan_id: newCanonical.id })
    .eq("id", insurancePlanId);

  await mergeServicesIntoCanonical(supabase, insurancePlanId, newCanonical.id);

  console.log(`[canonical-plan] Rejected ${rejectedCanonicalPlanId}, created new canonical: ${newCanonical.id}`);
  return newCanonical.id;
}

// ── Scoring ────────────────────────────────────────────────────────────────────

function scoreCandidate(input: CanonicalMatchInput, candidate: CanonicalPlanRow): number {
  let score = 0;
  let maxScore = 0;

  // Plan name similarity (weight: 40%)
  if (input.planName && candidate.plan_name) {
    maxScore += 40;
    const inputClean = cleanPlanName(input.planName);
    const candidateClean = cleanPlanName(candidate.plan_name);

    if (inputClean === candidateClean) {
      score += 40;
    } else {
      const sim = trigramSimilarity(inputClean, candidateClean);
      score += sim * 40;
    }
  }

  // State match (weight: 20%)
  if (input.state && candidate.state) {
    maxScore += 20;
    if (input.state.toLowerCase() === candidate.state.toLowerCase()) {
      score += 20;
    }
  }

  // Plan type match (weight: 15%)
  if (input.planType && candidate.plan_type) {
    maxScore += 15;
    if (normalizePlanType(input.planType) === normalizePlanType(candidate.plan_type)) {
      score += 15;
    }
  }

  // Cost proximity — deductible (weight: 15%)
  if (input.deductible && candidate.deductible_individual) {
    maxScore += 15;
    const ratio = Math.abs(input.deductible - candidate.deductible_individual) / candidate.deductible_individual;
    if (ratio <= 0.1) score += 15;
    else if (ratio <= 0.25) score += 7.5;
  }

  // Cost proximity — OOP max (weight: 10%)
  if (input.oopMax && candidate.oop_max_individual) {
    maxScore += 10;
    const ratio = Math.abs(input.oopMax - candidate.oop_max_individual) / candidate.oop_max_individual;
    if (ratio <= 0.1) score += 10;
    else if (ratio <= 0.25) score += 5;
  }

  if (maxScore === 0) return 0;
  return score / maxScore;
}

function cleanPlanName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // Remove state codes like "IN-022", "CA-001"
    .replace(/\b[A-Z]{2}-\d{3,}\b/gi, "")
    // Remove years
    .replace(/\b20\d{2}\b/g, "")
    // Remove parenthesized suffixes
    .replace(/\(.*?\)/g, "")
    // Remove metal levels
    .replace(/\b(bronze|silver|gold|platinum|catastrophic)\b/gi, "")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlanType(type: string): string {
  const map: Record<string, string> = {
    oap: "PPO", cdhp: "HDHP", pos: "POS", "pos ii": "POS",
    hmo: "HMO", ppo: "PPO", epo: "EPO", hdhp: "HDHP",
  };
  return map[type.toLowerCase().trim()] || type.toUpperCase().trim();
}

/** Trigram similarity (0-1) between two strings. */
function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return 1;

  const triA = makeTrigrams(la);
  const triB = makeTrigrams(lb);
  if (triA.size === 0 || triB.size === 0) return 0;

  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  return intersection / Math.max(triA.size, triB.size);
}

function makeTrigrams(s: string): Set<string> {
  const result = new Set<string>();
  const padded = `  ${s} `;
  for (let i = 0; i < padded.length - 2; i++) {
    result.add(padded.slice(i, i + 3));
  }
  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function createCanonicalPlan(
  supabase: SupabaseClient,
  input: CanonicalMatchInput,
  planYear: number
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("canonical_plans")
    .insert({
      insurer_id: input.insurerId,
      plan_name: input.planName,
      plan_type: input.planType || null,
      state: input.state || null,
      plan_year: planYear,
      group_number: input.groupNumber || null,
      hios_id: input.hiosId || null,
      deductible_individual: input.deductible || null,
      oop_max_individual: input.oopMax || null,
      confidence_score: 0.5,
      source_count: 1,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create canonical plan: ${error?.message || "unknown"}`);
  }

  return { id: data.id };
}

async function incrementSourceCount(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  currentCount: number,
  currentScore: number
): Promise<void> {
  const newCount = currentCount + 1;
  // Confidence increases with more sources: 0.5 → 0.625 → 0.708 → 0.75 → ...
  // Formula: 1 - (0.5 / source_count)
  const newScore = Math.min(0.95, 1 - 0.5 / newCount);

  await supabase
    .from("canonical_plans")
    .update({
      source_count: newCount,
      confidence_score: Math.max(currentScore, newScore),
      updated_at: new Date().toISOString(),
    })
    .eq("id", canonicalPlanId);
}

/**
 * Merge a user's plan_covered_services into canonical_plan_services.
 * Uses upsert — keeps higher confidence row on conflict.
 */
async function mergeServicesIntoCanonical(
  supabase: SupabaseClient,
  insurancePlanId: string,
  canonicalPlanId: string
): Promise<void> {
  // Fetch user's covered services
  const { data: userServices } = await supabase
    .from("plan_covered_services")
    .select("service_id, concept_id, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, annual_limit_value, confidence, source, place_of_service")
    .eq("insurance_plan_id", insurancePlanId);

  if (!userServices || userServices.length === 0) return;

  // Get service slugs
  const serviceIds = [...new Set(userServices.map((s) => s.service_id))];
  const { data: services } = await supabase
    .from("service_catalog")
    .select("id, slug")
    .in("id", serviceIds);

  const idToSlug = new Map<string, string>();
  for (const s of services || []) {
    idToSlug.set(s.id, s.slug);
  }

  const canonicalInserts = userServices
    .filter((s) => idToSlug.has(s.service_id))
    .map((s) => ({
      canonical_plan_id: canonicalPlanId,
      concept_id: s.concept_id || null,
      service_slug: idToSlug.get(s.service_id)!,
      copay: s.in_copay,
      coinsurance: s.in_coinsurance,
      is_covered: s.covered !== false,
      requires_prior_auth: s.prior_auth_required || false,
      requires_referral: false,
      deductible_applies: s.in_deductible_applies !== false,
      annual_limit: s.annual_limit_value || null,
      visit_limit: null,
      coverage_rules: {},
      confidence: s.confidence || 0.5,
      source: s.source || "user_upload",
    }));

  if (canonicalInserts.length > 0) {
    const { error } = await supabase
      .from("canonical_plan_services")
      .upsert(canonicalInserts, { onConflict: "canonical_plan_id,service_slug" });

    if (error) {
      console.error("[canonical-plan] Failed to merge services:", error);
    } else {
      console.log(`[canonical-plan] Merged ${canonicalInserts.length} services into canonical plan ${canonicalPlanId}`);
    }
  }
}

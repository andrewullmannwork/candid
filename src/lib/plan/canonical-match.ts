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
import { normalizeCoinsuranceForStorage } from "@/lib/billing/coinsurance";
import { recordCanonicalMatchDecision } from "./canonical-match-telemetry";
// normalizeInsurerName available from "./matcher" if needed for future enhancements

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CanonicalMatchInput {
  insurerId: string;
  planName: string;
  altPlanName?: string; // Fallback plan name (e.g., from profile/card scan) for improved matching
  planType?: string;
  state?: string;
  planYear?: number;
  groupNumber?: string;
  hiosId?: string;
  deductible?: number;
  oopMax?: number;
  // CF-63 RC-4 (S128): ACA metal tier from SBC plan-identity. Used at INSERT
  // time only — matching dimension addition is RC-3 territory (separate PR).
  metalTier?: string | null;
  // Ing-K Phase 1 (S129): document + insurance_plan context for decision
  // telemetry. Optional so existing call sites (e.g., reject-canonical-match
  // recursive call) continue to compile; populated by upload-flow call sites
  // (process-plan.ts) so admin can group decisions by upload.
  documentId?: string | null;
  insurancePlanId?: string | null;
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
  metal_level: string | null;
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
      await recordCanonicalMatchDecision(supabase, {
        documentId: input.documentId,
        insurancePlanId: input.insurancePlanId,
        stepMatched: "group_number",
        bestScore: null,
        candidateCount: 1,
        matchedCanonicalId: groupMatch.id,
        rejectedTopCandidateId: null,
        input,
        reason: "group_number exact match",
      });
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
      await recordCanonicalMatchDecision(supabase, {
        documentId: input.documentId,
        insurancePlanId: input.insurancePlanId,
        stepMatched: "hios_id",
        bestScore: null,
        candidateCount: 1,
        matchedCanonicalId: hiosMatch.id,
        rejectedTopCandidateId: null,
        input,
        reason: "hios_id exact match",
      });
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

  const candidateCount = candidates?.length ?? 0;
  let scoredTopCandidateId: string | null = null;
  let scoredTopScore: number | null = null;

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
      scoredTopCandidateId = best.plan.id;
      scoredTopScore = confidence;

      if (confidence >= 0.7) {
        console.log(`[canonical-plan] Fuzzy match (${confidence.toFixed(2)}): ${best.plan.plan_name} (${best.plan.id})`);

        if (confidence >= 0.9) {
          // High confidence — auto-link
          await incrementSourceCount(supabase, best.plan.id, best.plan.source_count, best.plan.confidence_score);
          await recordCanonicalMatchDecision(supabase, {
            documentId: input.documentId,
            insurancePlanId: input.insurancePlanId,
            stepMatched: "fuzzy_auto",
            bestScore: confidence,
            candidateCount,
            matchedCanonicalId: best.plan.id,
            rejectedTopCandidateId: null,
            input,
            reason: `fuzzy auto-link (score ${confidence.toFixed(3)} >= 0.9)`,
          });
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
        await recordCanonicalMatchDecision(supabase, {
          documentId: input.documentId,
          insurancePlanId: input.insurancePlanId,
          stepMatched: "fuzzy_needs_confirmation",
          bestScore: confidence,
          candidateCount,
          matchedCanonicalId: best.plan.id,
          rejectedTopCandidateId: null,
          input,
          reason: `fuzzy needs user confirmation (score ${confidence.toFixed(3)} in 0.7-0.9 range)`,
        });
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

  // Telemetry: capture WHY no match (the Ing-K diagnostic surface).
  //  - candidate_count=0 → root cause A (plan_year filter excluded everything)
  //  - candidate_count>0 + best_score=null → all candidates scored zero
  //  - candidate_count>0 + best_score in 0.5-0.7 → near-miss (root cause B/C/D)
  //  - candidate_count>0 + best_score below 0.5 → no real candidate
  let createNewReason: string;
  if (candidateCount === 0) {
    createNewReason = `plan_year filter zero candidates (insurer_id=${input.insurerId}, plan_year=${planYear})`;
  } else if (scoredTopScore === null) {
    createNewReason = `${candidateCount} candidate(s) all scored zero (no shared dimensions)`;
  } else if (scoredTopScore >= 0.5) {
    createNewReason = `fuzzy top ${scoredTopScore.toFixed(3)} below 0.7 threshold (near-miss; ${candidateCount} candidate(s))`;
  } else {
    createNewReason = `fuzzy top ${scoredTopScore.toFixed(3)} below 0.5 (${candidateCount} candidate(s); no real match)`;
  }
  await recordCanonicalMatchDecision(supabase, {
    documentId: input.documentId,
    insurancePlanId: input.insurancePlanId,
    stepMatched: "create_new",
    bestScore: scoredTopScore,
    candidateCount,
    matchedCanonicalId: newPlan.id,
    rejectedTopCandidateId: scoredTopCandidateId,
    input,
    reason: createNewReason,
  });

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
 *
 * ⚠ SECURITY CONTRACT (B9 B1.2, S190): the caller MUST pass an `insurancePlanId`
 * the authenticated user OWNS. This accessor does not re-scope the
 * `insurance_plans` write by `user_id` (no userId in scope here), so a foreign id
 * would mutate another user's plan. Both current callers satisfy the contract:
 *   - api/profile (confirm_canonical_match): id = the user's own
 *     profile.active_insurance_plan_id, read via userScoped.
 *   - api/documents/status (POST confirm_canonical_match): the handler 403s
 *     unless authUser.id === docOwner.user_id before this runs.
 * Defense-in-depth (scope this write inside the layer irrespective of caller) is
 * tracked for the systematic lint-to-`src/lib` pass — see
 * plans/findings/b9_remediation_playbook.md.
 */
export async function confirmCanonicalMatch(
  supabase: SupabaseClient,
  insurancePlanId: string,
  canonicalPlanId: string
): Promise<void> {
  // Link insurance_plan to canonical. NOTE: not userScoped-wrapped — see the
  // SECURITY CONTRACT above (caller passes an owned insurancePlanId).
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

  // Ing-J (S127) — use findOrCreateCanonicalPlan instead of bare
  // createCanonicalPlan so we don't violate uq_canonical_plan_identity
  // when a canonical for this exact (insurer, plan_name, plan_year)
  // already exists (e.g., another user already uploaded the same plan).
  // The dedup path returns the existing canonical (incrementing its
  // source_count via Pattern 1 #3 corroboration); the create path only
  // fires when no canonical matches. Honors the rejection by penalizing
  // the rejected canonical's confidence (above) while still letting
  // legitimate dedup happen for the user's actually-different plan.
  const planYear = new Date().getFullYear();
  const matchInput = {
    insurerId: insurer.id,
    planName: userPlan.plan_name || "Unknown Plan",
    planType: userPlan.plan_type || undefined,
    state,
    deductible: userPlan.in_deductible_individual || undefined,
    oopMax: userPlan.in_oop_max_individual || undefined,
  };

  const matchResult = await findOrCreateCanonicalPlan(supabase, {
    ...matchInput,
    planYear,
  });

  let newCanonicalId: string;
  let outcomeDetail: string;
  if (matchResult.canonicalPlanId === rejectedCanonicalPlanId) {
    // Defensive: findOrCreateCanonicalPlan scored the rejected canonical
    // highest again (fuzzy match still wins even after the 0.05 confidence
    // penalty). Honor the user's rejection by force-creating a new canonical.
    // Degenerate case: rejected canonical's identity tuple == user's plan
    // identity → uq_canonical_plan_identity blocks the INSERT and we
    // re-throw rather than silently bind to the rejected canonical.
    console.warn(
      `[canonical-plan] findOrCreate returned rejected canonical ${rejectedCanonicalPlanId} again; honoring rejection via force-create`,
    );
    const forced = await createCanonicalPlan(supabase, matchInput, planYear);
    newCanonicalId = forced.id;
    outcomeDetail = `force-created ${forced.id} (rejection honored over fuzzy re-match)`;
  } else {
    newCanonicalId = matchResult.canonicalPlanId;
    outcomeDetail = matchResult.isNew
      ? `created new ${newCanonicalId} (no fuzzy match)`
      : `linked to existing ${newCanonicalId} (isNew=false, confidence=${matchResult.confidence.toFixed(2)}, source_count++)`;
  }

  // Link and merge
  await supabase
    .from("insurance_plans")
    .update({ canonical_plan_id: newCanonicalId })
    .eq("id", insurancePlanId);

  await mergeServicesIntoCanonical(supabase, insurancePlanId, newCanonicalId);

  console.log(`[canonical-plan] Rejected ${rejectedCanonicalPlanId}: ${outcomeDetail}`);
  return newCanonicalId;
}

// ── Scoring ────────────────────────────────────────────────────────────────────

function scoreCandidate(input: CanonicalMatchInput, candidate: CanonicalPlanRow): number {
  let score = 0;
  let maxScore = 0;

  // Plan name similarity (weight: 40%)
  // Try both primary plan name and altPlanName (from profile/card), take the better score
  if (candidate.plan_name && (input.planName || input.altPlanName)) {
    maxScore += 40;
    const candidateClean = cleanPlanName(candidate.plan_name);
    let bestNameScore = 0;

    for (const name of [input.planName, input.altPlanName].filter(Boolean) as string[]) {
      const inputClean = cleanPlanName(name);
      if (inputClean === candidateClean) {
        bestNameScore = 40;
        break;
      }
      const sim = trigramSimilarity(inputClean, candidateClean);
      bestNameScore = Math.max(bestNameScore, sim * 40);
    }
    score += bestNameScore;
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

export function cleanPlanName(name: string): string {
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
      // CF-63 RC-2 (S128): use nullish coalescing to preserve $0 deductible /
      // $0 OOP values. `||` treats 0 as falsy → coerces legitimate Gold /
      // Platinum $0-deductible plans to NULL.
      deductible_individual: input.deductible ?? null,
      oop_max_individual: input.oopMax ?? null,
      // CF-63 RC-4 (S128): write metal_level on canonical creation. RC-2's
      // `?? null` semantics not needed here because metalTier is a string
      // (no falsy-but-meaningful values like 0).
      metal_level: input.metalTier ?? null,
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
      coinsurance: normalizeCoinsuranceForStorage(s.in_coinsurance),
      is_covered: s.covered !== false,
      requires_prior_auth: s.prior_auth_required || false,
      requires_referral: false,
      deductible_applies: s.in_deductible_applies !== false,
      // CF-63 RC-2 (S128): nullish coalescing preserves $0 annual limits.
      annual_limit: s.annual_limit_value ?? null,
      visit_limit: null,
      coverage_rules: {},
      confidence: s.confidence || 0.5,
      source: s.source || "user_upload",
    }));

  if (canonicalInserts.length > 0) {
    const { error } = await supabase
      .from("canonical_plan_services")
      // S167 Thesaurus (mig 147): the unique key is now 4-col
      // (canonical_plan_id, service_slug, place_of_service, component). These inserts omit
      // place_of_service/component → they take the column DEFAULTs ('any'/'global'); user-side
      // pos/component threading lands in Phase 1 (plan_covered_services has no component column yet).
      .upsert(canonicalInserts, { onConflict: "canonical_plan_id,service_slug,place_of_service,component" });

    if (error) {
      console.error("[canonical-plan] Failed to merge services:", error);
    } else {
      console.log(`[canonical-plan] Merged ${canonicalInserts.length} services into canonical plan ${canonicalPlanId}`);
    }
  }
}

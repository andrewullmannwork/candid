/**
 * Claim Matching — links related documents (EOB + itemized bill for same service).
 *
 * After a claim is created, checks for existing claims from the same user with:
 * - Similar date_of_service (within 7 days)
 * - Same or similar provider name
 * If found, links them via claim_group_id. UI shows grouped claims together.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function matchRelatedClaims(
  supabase: SupabaseClient,
  params: {
    claimId: string;
    userId: string;
    dateOfService: string | null;
    providerName: string | null;
  }
): Promise<{ groupId: string | null }> {
  const { claimId, userId, dateOfService, providerName } = params;

  if (!dateOfService) return { groupId: null };

  // Look for existing claims within 7 days of the same service date
  const serviceDate = new Date(dateOfService);
  const minDate = new Date(serviceDate);
  minDate.setDate(minDate.getDate() - 7);
  const maxDate = new Date(serviceDate);
  maxDate.setDate(maxDate.getDate() + 7);

  const { data: candidates } = await supabase
    .from("claims")
    .select("id, claim_group_id, date_of_service, metadata")
    .eq("user_id", userId)
    .neq("id", claimId)
    .gte("date_of_service", minDate.toISOString().split("T")[0])
    .lte("date_of_service", maxDate.toISOString().split("T")[0]);

  if (!candidates || candidates.length === 0) return { groupId: null };

  // Find a match by provider name (fuzzy: case-insensitive contains)
  const normalizedProvider = providerName?.toLowerCase().trim() || "";

  for (const candidate of candidates) {
    if (!normalizedProvider) {
      // No provider name — match on date proximity only if within 1 day
      const dayDiff = Math.abs(serviceDate.getTime() - new Date(candidate.date_of_service).getTime()) / (1000 * 60 * 60 * 24);
      if (dayDiff <= 1) {
        return await linkClaims(supabase, claimId, candidate);
      }
      continue;
    }

    const candidateProvider = (
      (candidate.metadata as Record<string, unknown>)?.provider as Record<string, unknown>
    )?.name as string | undefined;

    if (!candidateProvider) continue;

    const normalizedCandidate = candidateProvider.toLowerCase().trim();

    // Match: one contains the other, or they share 3+ consecutive words
    if (
      normalizedProvider.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedProvider) ||
      shareWords(normalizedProvider, normalizedCandidate, 2)
    ) {
      return await linkClaims(supabase, claimId, candidate);
    }
  }

  return { groupId: null };
}

function shareWords(a: string, b: string, minShared: number): boolean {
  const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  return shared >= minShared;
}

async function linkClaims(
  supabase: SupabaseClient,
  newClaimId: string,
  existingClaim: { id: string; claim_group_id: string | null }
): Promise<{ groupId: string }> {
  // Use existing group ID or generate a new UUID
  const groupId = existingClaim.claim_group_id || crypto.randomUUID();

  // Update both claims
  await supabase.from("claims").update({ claim_group_id: groupId }).eq("id", newClaimId);
  if (!existingClaim.claim_group_id) {
    await supabase.from("claims").update({ claim_group_id: groupId }).eq("id", existingClaim.id);
  }

  console.log(`[claim-matching] Linked claim ${newClaimId} to group ${groupId}`);
  return { groupId };
}

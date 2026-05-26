/**
 * Canonical-match decision telemetry (Ing-K Phase 1, S129).
 *
 * Writes one row to `canonical_match_decisions` per findOrCreateCanonicalPlan
 * exit. Zero behavior change — purely observability for diagnosing the
 * "same SBC uploaded twice creates new canonical" bug surfaced during S127
 * Ing-J smoke.
 *
 * All writes are non-fatal (try/catch wrap at call sites); telemetry failure
 * must NEVER block canonical-match itself.
 *
 * Phase 2 (next session) will ship a targeted matching fix based on the
 * observed PROD distribution of failure modes captured here.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CanonicalMatchInput } from "./canonical-match";

export type CanonicalMatchStep =
  | "group_number"
  | "hios_id"
  | "fuzzy_auto"
  | "fuzzy_needs_confirmation"
  | "create_new";

export interface CanonicalMatchDecisionRecord {
  documentId?: string | null;
  insurancePlanId?: string | null;
  stepMatched: CanonicalMatchStep;
  bestScore?: number | null;
  candidateCount: number;
  matchedCanonicalId: string;
  rejectedTopCandidateId?: string | null;
  input: CanonicalMatchInput;
  reason: string;
}

/**
 * Mirror of `cleanPlanName` in canonical-match.ts. Kept inline (not exported
 * from that file) so the telemetry signature is computed against the SAME
 * normalization the matcher uses. If canonical-match.ts cleanPlanName ever
 * changes, this must change in lockstep.
 */
function cleanPlanNameForSignature(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\b[A-Z]{2}-\d{3,}\b/gi, "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\b(bronze|silver|gold|platinum|catastrophic)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * sha256(insurer_id + '|' + cleanPlanName(plan_name) + '|' + plan_year).
 *
 * Two uploads of the same SBC should produce the same signature. Admin
 * queries GROUP BY input_signature to surface "this signature produced N
 * canonicals" (the Ing-K bug pattern).
 */
export function computeInputSignature(input: CanonicalMatchInput): string {
  const planYear = input.planYear || new Date().getFullYear();
  const cleanName = cleanPlanNameForSignature(input.planName || "");
  const seed = `${input.insurerId}|${cleanName}|${planYear}`;
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * Write one decision row. Non-fatal — logs on failure but never throws.
 *
 * Callers wrap this in fire-and-forget pattern (no await) when latency is
 * critical, OR await when they need to verify telemetry landed (typically
 * in tests).
 */
export async function recordCanonicalMatchDecision(
  supabase: SupabaseClient,
  record: CanonicalMatchDecisionRecord,
): Promise<void> {
  try {
    const signature = computeInputSignature(record.input);

    const { error } = await supabase.from("canonical_match_decisions").insert({
      document_id: record.documentId ?? null,
      insurance_plan_id: record.insurancePlanId ?? null,
      input_signature: signature,
      step_matched: record.stepMatched,
      best_score: record.bestScore ?? null,
      candidate_count: record.candidateCount,
      matched_canonical_id: record.matchedCanonicalId,
      rejected_top_candidate_id: record.rejectedTopCandidateId ?? null,
      input_payload: {
        insurerId: record.input.insurerId,
        planName: record.input.planName,
        altPlanName: record.input.altPlanName ?? null,
        planType: record.input.planType ?? null,
        state: record.input.state ?? null,
        planYear: record.input.planYear ?? null,
        groupNumber: record.input.groupNumber ?? null,
        hiosId: record.input.hiosId ?? null,
        deductible: record.input.deductible ?? null,
        oopMax: record.input.oopMax ?? null,
        metalTier: record.input.metalTier ?? null,
      },
      reason: record.reason,
    });

    if (error) {
      console.warn(
        `[canonical-match-telemetry] insert failed (non-fatal): ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[canonical-match-telemetry] unexpected error (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

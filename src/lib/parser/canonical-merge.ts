/**
 * Atomic upsert with field_provenance shallow-merge per Pattern P-8 contract.
 *
 * Wraps mig 064 PL/pgSQL function `upsert_canonical_services_with_merge` which
 * holds pg_advisory_xact_lock per canonical_plan_id to serialize concurrent
 * writers (Bundle PR #1, Session 55, audit item #13).
 *
 * Replaces the prior `supabase.from("canonical_plan_services").upsert(...)`
 * pattern at process-plan.ts canonical-write site. Only this code path needs the
 * merge treatment — other writes to canonical_plan_services (admin tools, seed
 * migrations) are not concurrent with user uploads.
 *
 * Within-field citation diversity (sources array per field) deferred to Phase 4
 * Subplan with consumer-read filter design.
 */

import type { createServerClient } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface CanonicalServiceInsert {
  canonical_plan_id: string;
  concept_id: string | null;
  service_slug: string;
  copay: number | null;
  coinsurance: number | null;
  is_covered: boolean;
  requires_prior_auth: boolean;
  requires_referral: boolean;
  deductible_applies: boolean;
  annual_limit: number | null;
  visit_limit: number | null;
  coverage_rules: Record<string, unknown>;
  confidence: number;
  source: string;
  field_provenance?: Record<string, unknown>;
}

export interface UpsertResult {
  error: { message: string } | null;
}

export async function upsertCanonicalServicesWithMerge(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  inserts: CanonicalServiceInsert[],
): Promise<UpsertResult> {
  if (inserts.length === 0) return { error: null };

  const { error } = await supabase.rpc("upsert_canonical_services_with_merge", {
    p_canonical_plan_id: canonicalPlanId,
    p_inserts: inserts,
  });

  if (error) {
    return { error: { message: error.message } };
  }
  return { error: null };
}

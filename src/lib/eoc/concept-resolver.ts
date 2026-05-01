/**
 * Concept resolver — Pattern 1 #1 admin gate for EOC parser unknown billing codes.
 *
 * Per Phase 3.1A Subplan Q-P3.1A-5 LOCK + DR-3.1A-B execution:
 * - When EOC parser extracts (billing_code, billing_code_type) → check `concepts`
 * - MATCH: return concept_id + service_slug → caller writes to plan_covered_services
 * - NO MATCH: UPSERT into concept_admin_review_queue (mig 061) → admin gates promotion
 *
 * Vocabulary mapping: billing_code_type → vocabulary_id seeded in mig 019:
 *   CPT → 'CPT', HCPCS → 'HCPCS', NDC → 'NDC', REV → 'REV', DRG → 'DRG'
 */

import type { createServerClient } from "@/lib/supabase/server";
import type { SourceExcerptVerified, ExtractionMethod } from "../parser/types";

type SupabaseClient = ReturnType<typeof createServerClient>;

export type BillingCodeType = "CPT" | "HCPCS" | "NDC" | "REV" | "DRG";

export interface UnknownConceptInput {
  sourceDocId: string;
  proposedByUserId: string; // users.id (UUID)
  billingCode: string;
  billingCodeType: BillingCodeType;
  proposedConceptLabel: string | null;
  proposedServiceSlug: string | null;
  sourceExcerpt: string;
  sourceExcerptVerified: SourceExcerptVerified;
  sourceExcerptExtractionMethod: ExtractionMethod;
  sourceSectionHint: string;
  sourceSectionVerified: boolean;
  contextExtract: string;
}

export interface ConceptMatch {
  matched: true;
  conceptId: string;
  serviceSlug: string | null;
}

export interface ConceptUnknown {
  matched: false;
  queueRowId: string;
  isNew: boolean;
}

export type ResolveConceptResult = ConceptMatch | ConceptUnknown;

/**
 * Look up a (billing_code, billing_code_type) in the concepts table.
 * Returns the first match if found; null otherwise.
 *
 * Note: concepts.concept_code is case-sensitive. CPT codes are 5 digits (no case);
 * HCPCS Level II starts with uppercase letter; NDC has hyphens; REV is 4 digits;
 * DRG is 3 digits. Caller normalizes (trim + upper for HCPCS) before lookup.
 */
async function findConcept(
  supabase: SupabaseClient,
  billingCode: string,
  billingCodeType: BillingCodeType,
): Promise<{ conceptId: string; serviceSlug: string | null } | null> {
  const { data, error } = await supabase
    .from("concepts")
    .select("id, concept_code")
    .eq("vocabulary_id", billingCodeType)
    .eq("concept_code", billingCode)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  // Look up associated service_slug via concept → service_catalog mapping if exists.
  // For v1: best-effort lookup; service_slug may be null and consumer falls back.
  // Service_catalog.slug is the canonical join key for plan_covered_services.
  // Phase 5+ may add a concept_id FK to service_catalog; for now we look up by concept_code.
  const { data: serviceMatch } = await supabase
    .from("service_catalog")
    .select("slug")
    .eq("slug", billingCode.toLowerCase()) // best-effort match (most service_catalog slugs are descriptive)
    .limit(1)
    .maybeSingle();

  return {
    conceptId: data.id,
    serviceSlug: serviceMatch?.slug ?? null,
  };
}

/**
 * UPSERT a row in concept_admin_review_queue. Idempotency via UNIQUE constraint on
 * (source_doc_id, proposed_billing_code, proposed_billing_code_type) per mig 061.
 */
async function enqueueUnknownConcept(
  supabase: SupabaseClient,
  input: UnknownConceptInput,
): Promise<{ queueRowId: string; isNew: boolean }> {
  // Use UPSERT pattern: insert; on conflict update context_extract + updated_at.
  const row = {
    source_doc_id: input.sourceDocId,
    proposed_by_user_id: input.proposedByUserId,
    proposed_billing_code: input.billingCode,
    proposed_billing_code_type: input.billingCodeType,
    proposed_concept_label: input.proposedConceptLabel,
    proposed_service_slug: input.proposedServiceSlug,
    source_excerpt: input.sourceExcerpt,
    source_excerpt_verified: input.sourceExcerptVerified,
    source_excerpt_extraction_method: input.sourceExcerptExtractionMethod,
    source_section_hint: input.sourceSectionHint,
    source_section_verified: input.sourceSectionVerified,
    context_extract: input.contextExtract,
    status: "pending" as const,
  };

  const { data, error } = await supabase
    .from("concept_admin_review_queue")
    .upsert(row, {
      onConflict: "source_doc_id,proposed_billing_code,proposed_billing_code_type",
      ignoreDuplicates: false, // we want to update context_extract on conflict
    })
    .select("id, created_at, updated_at")
    .single();

  if (error || !data) {
    throw new Error(`enqueueUnknownConcept upsert failed: ${error?.message ?? "no data returned"}`);
  }

  // isNew if created_at exactly equals updated_at (BEFORE UPDATE trigger sets
  // updated_at = NOW() on conflict-update, so any updated row diverges to microsecond
  // precision; INSERT-only rows have both fields set to the same default NOW()).
  const isNew = data.created_at === data.updated_at;

  return { queueRowId: data.id, isNew };
}

/**
 * Main entry: resolve a billing code to either an existing concept (write-through) or
 * the admin queue (write-blocked until admin promotes).
 *
 * Normalizes the billing code per type conventions (HCPCS uppercase letter; trim).
 */
export async function resolveOrEnqueueConcept(
  supabase: SupabaseClient,
  input: UnknownConceptInput,
): Promise<ResolveConceptResult> {
  const normalized = normalizeBillingCode(input.billingCode, input.billingCodeType);
  const inputNormalized = { ...input, billingCode: normalized };

  const match = await findConcept(supabase, normalized, input.billingCodeType);
  if (match) {
    return { matched: true, conceptId: match.conceptId, serviceSlug: match.serviceSlug };
  }

  const enqueued = await enqueueUnknownConcept(supabase, inputNormalized);
  return { matched: false, ...enqueued };
}

/**
 * Per-type normalization. CPT/REV/DRG: digits only. HCPCS L2: uppercase letter +
 * digits. NDC: preserve hyphens. Trim whitespace in all cases.
 */
function normalizeBillingCode(code: string, type: BillingCodeType): string {
  const trimmed = code.trim();
  switch (type) {
    case "CPT":
    case "REV":
    case "DRG":
      return trimmed;
    case "HCPCS":
      // HCPCS L2 codes: letter (uppercase) + 4 digits. Force uppercase letter.
      return trimmed.toUpperCase();
    case "NDC":
      // Preserve hyphens; just trim.
      return trimmed;
  }
}

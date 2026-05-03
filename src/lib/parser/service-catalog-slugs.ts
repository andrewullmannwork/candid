/**
 * Service catalog slug validator + admin queue enqueuer — Pattern 1 #1 admin gate
 * for slug growth.
 *
 * Bundle PR #1 / Session 55 — audit item #8 (slug catalog drift across parsers).
 *
 * USAGE
 * 1. Call `loadValidServiceSlugs(supabase)` once per parse-document operation.
 * 2. For each Haiku-emitted slug, check membership in the returned Set.
 * 3. If unknown → call `enqueueUnknownServiceSlug(supabase, input)` so admin can
 *    review + promote to service_catalog. NEVER drop silently — that breaks the
 *    flywheel (USER A + USER B mentioning the same out-of-catalog service is a
 *    promotion signal we'd otherwise lose to warnings JSONB).
 *
 * RATIONALE FOR service_catalog OVER STANDARD_SLUGS
 * SBC parser uses STANDARD_SLUGS (51 SBC-curated slugs from Common Medical Events
 * table). EOC content is broader — discusses services not on SBC's Common Medical
 * Events page (specialty mental health, transplant, infertility, etc.) but
 * present in service_catalog via mig 010/031/etc. Validating EOC against
 * STANDARD_SLUGS would over-prune legitimate slugs. service_catalog is the
 * broader DB-truth vocabulary; STANDARD_SLUGS is a curated subset for the SBC
 * Haiku prompt.
 *
 * Future consumers (Phase 3.4 plan_document Haiku-first migration; Phase 4
 * consumer-read filter) should use this same helper.
 */

import type { createServerClient } from "@/lib/supabase/server";
import type { SourceExcerptVerified, ExtractionMethod } from "./types";

type SupabaseClient = ReturnType<typeof createServerClient>;

export async function loadValidServiceSlugs(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug")
    .is("merged_into_id", null);

  if (error || !data) {
    // Defensive: empty set means all slugs treated as invalid → all writes
    // blocked + enqueued. Caller logs warning. Avoids silent acceptance of
    // unvalidated slugs on DB error.
    return new Set();
  }

  return new Set(data.map((r: { slug: string }) => r.slug));
}

export type ParserSource = "sbc" | "eoc" | "plan_document" | "eob" | "card" | "manual";

export interface UnknownSlugInput {
  sourceDocId: string;
  proposedByUserId: string | null;
  parserSource: ParserSource;
  proposedServiceSlug: string;
  proposedServiceLabel?: string | null;
  proposedCategory?: string | null;
  sourceExcerpt: string;
  sourceExcerptVerified: SourceExcerptVerified;
  sourceExcerptExtractionMethod: ExtractionMethod;
  sourceSectionHint: string;
  sourceSectionVerified: boolean;
  contextExtract?: string | null;
}

export interface EnqueueResult {
  queueRowId: string;
  isNew: boolean;
}

/**
 * Pattern 1 #1 admin gate: enqueue an unknown service slug for admin promotion to
 * service_catalog. Idempotent on (source_doc_id, proposed_service_slug) per mig 065
 * UNIQUE constraint — re-emitting the same slug from the same doc updates context
 * rather than duplicating.
 */
export async function enqueueUnknownServiceSlug(
  supabase: SupabaseClient,
  input: UnknownSlugInput,
): Promise<EnqueueResult> {
  const row = {
    source_doc_id: input.sourceDocId,
    proposed_by_user_id: input.proposedByUserId,
    parser_source: input.parserSource,
    proposed_service_slug: input.proposedServiceSlug,
    proposed_service_label: input.proposedServiceLabel ?? null,
    proposed_category: input.proposedCategory ?? null,
    source_excerpt: input.sourceExcerpt,
    source_excerpt_verified: input.sourceExcerptVerified,
    source_excerpt_extraction_method: input.sourceExcerptExtractionMethod,
    source_section_hint: input.sourceSectionHint,
    source_section_verified: input.sourceSectionVerified,
    context_extract: input.contextExtract ?? null,
    status: "pending" as const,
  };

  const { data, error } = await supabase
    .from("service_catalog_admin_review_queue")
    .upsert(row, {
      onConflict: "source_doc_id,proposed_service_slug",
      ignoreDuplicates: false, // we want to update context_extract on conflict
    })
    .select("id, created_at, updated_at")
    .single();

  if (error || !data) {
    throw new Error(`enqueueUnknownServiceSlug upsert failed: ${error?.message ?? "no data returned"}`);
  }

  // isNew if created_at exactly equals updated_at (BEFORE UPDATE trigger sets
  // updated_at = NOW() on conflict-update, so any updated row diverges to
  // microsecond precision; INSERT-only rows have both fields set to the same
  // default NOW()).
  const isNew = data.created_at === data.updated_at;
  return { queueRowId: data.id, isNew };
}

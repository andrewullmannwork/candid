/**
 * SBC slug validator + admin queue routing (Pattern 1 #1 admin gate).
 *
 * Per Q-P3.2-8 LOCK: SBC parser uses STANDARD_SLUGS curated vocabulary in Haiku
 * prompt. Validation step here re-asserts post-extraction in case Haiku emits
 * out-of-vocabulary slugs despite the prompt constraint.
 *
 * Bundle PR #1 / Session 55 — closes the v1.5+ TODO that originally lived here:
 * unknown slugs now route to service_catalog_admin_review_queue (mig 065) for
 * admin promotion to service_catalog. Prior behavior dropped silently to
 * warnings — anti-flywheel; foundational ingestion pattern requires growing the
 * catalog from observed parse output, not pruning.
 *
 * BACKWARD COMPATIBILITY
 * `enqueueContext` is OPTIONAL. When absent (e.g., parse-harness which has no
 * doc context), behavior falls back to drop-with-warning (legacy). When present
 * (production parse path with supabase + documentId + userId), unknowns are
 * enqueued. Validation outcome (validServices + droppedSlugs) is unchanged.
 *
 * The validation step still drops unknowns from validServices regardless of
 * queueing — they CANNOT land in canonical_plan_services until admin promotes
 * the slug. Queueing is a side effect for admin discovery, not a write path
 * directly.
 */

import type { createServerClient } from "@/lib/supabase/server";
import type { SBCHaikuService } from "./types";
import { STANDARD_SLUGS } from "./haiku-prompts/common-medical-events";
import { enqueueUnknownServiceSlug } from "@/lib/parser/service-catalog-slugs";

type SupabaseClient = ReturnType<typeof createServerClient>;

const STANDARD_SLUG_SET = new Set(STANDARD_SLUGS);

export interface SlugValidationResult {
  validServices: SBCHaikuService[];
  droppedSlugs: string[];
  warnings: string[];
}

export interface SlugEnqueueContext {
  supabase: SupabaseClient;
  documentId: string;
  proposedByUserId: string | null;
  // Source section the SBC parser was processing (e.g., "common_medical_events").
  // Carried through to the queue row for admin context.
  sectionHint: string;
}

/**
 * Validate Haiku-emitted service slugs against STANDARD_SLUGS curated vocabulary.
 *
 * - Known slugs pass through unchanged.
 * - Unknown slugs are dropped from validServices AND optionally enqueued to
 *   service_catalog_admin_review_queue for admin promotion (when enqueueContext
 *   is provided).
 *
 * Async because enqueueing is a DB INSERT. When enqueueContext is null, this
 * function does no I/O and resolves synchronously to the legacy drop-with-warning
 * result.
 */
export async function validateServiceSlugs(
  services: SBCHaikuService[],
  enqueueContext: SlugEnqueueContext | null = null,
): Promise<SlugValidationResult> {
  const validServices: SBCHaikuService[] = [];
  const droppedSlugs: string[] = [];
  const warnings: string[] = [];

  for (const svc of services) {
    if (STANDARD_SLUG_SET.has(svc.serviceSlug)) {
      validServices.push(svc);
      continue;
    }
    droppedSlugs.push(svc.serviceSlug);

    if (!enqueueContext) {
      // Legacy fallback (e.g., parse-harness): no doc context, just warn.
      warnings.push(`unknown_slug_post_extraction:${svc.serviceSlug}`);
      continue;
    }

    // Pattern 1 #1 admin gate: enqueue for admin promotion to service_catalog.
    try {
      const { isNew } = await enqueueUnknownServiceSlug(enqueueContext.supabase, {
        sourceDocId: enqueueContext.documentId,
        proposedByUserId: enqueueContext.proposedByUserId,
        parserSource: "sbc",
        proposedServiceSlug: svc.serviceSlug,
        proposedServiceLabel: svc.patternP8?.source_excerpt?.slice(0, 200) ?? null,
        proposedCategory: null,
        sourceExcerpt: svc.patternP8?.source_excerpt ?? "",
        sourceExcerptVerified: svc.patternP8?.source_excerpt_verified ?? "not_found",
        sourceExcerptExtractionMethod: svc.patternP8?.source_excerpt_extraction_method ?? "pdftotext",
        sourceSectionHint: svc.patternP8?.source_section_hint ?? enqueueContext.sectionHint,
        sourceSectionVerified: svc.patternP8?.source_section_verified ?? false,
        contextExtract: null,
      });
      warnings.push(
        isNew
          ? `unknown_slug_enqueued_new:${svc.serviceSlug}`
          : `unknown_slug_enqueued_existing:${svc.serviceSlug}`,
      );
    } catch (err) {
      // Non-fatal: queueing failure shouldn't block the parse. Surface as warning.
      warnings.push(
        `unknown_slug_enqueue_failed:${svc.serviceSlug}:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { validServices, droppedSlugs, warnings };
}

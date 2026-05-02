/**
 * SBC slug validator (lightweight Pattern 1 #1 admin gate analog).
 *
 * Per Q-P3.2-8 LOCK: SBC parser uses STANDARD_SLUGS curated vocabulary in Haiku
 * prompt. Validation step here re-asserts post-extraction in case Haiku emits
 * out-of-vocabulary slugs despite the prompt constraint.
 *
 * v1 scope: drop unknown slugs + log warning. v1.5+ may route unknowns to admin
 * review queue (analogous to Phase 3.1A `concept_admin_review_queue` for billing
 * codes; SBC slugs are service catalog entries, not billing codes — separate table).
 *
 * No-op for slugs that ARE in STANDARD_SLUGS — they pass through unchanged.
 */

import type { SBCHaikuService } from "./types";
import { STANDARD_SLUGS } from "./haiku-prompts/common-medical-events";

const STANDARD_SLUG_SET = new Set(STANDARD_SLUGS);

export interface SlugValidationResult {
  validServices: SBCHaikuService[];
  droppedSlugs: string[];
  warnings: string[];
}

export function validateServiceSlugs(services: SBCHaikuService[]): SlugValidationResult {
  const validServices: SBCHaikuService[] = [];
  const droppedSlugs: string[] = [];
  const warnings: string[] = [];

  for (const svc of services) {
    if (STANDARD_SLUG_SET.has(svc.serviceSlug)) {
      validServices.push(svc);
    } else {
      droppedSlugs.push(svc.serviceSlug);
      warnings.push(`unknown_slug_post_extraction:${svc.serviceSlug}`);
    }
  }

  return { validServices, droppedSlugs, warnings };
}

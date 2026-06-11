/**
 * EOC content-type routing decision (Service Thesaurus P2 — T2).
 *
 * PURE FUNCTION: given an extracted `medical_necessity` criterion + context, decide WHICH store it goes
 * to. No DB, no Haiku. The live router (`process-eoc`) executes the decision; the T5 eval harness calls
 * the SAME function read-only to report routing distribution — so the eval validates the shipped decision,
 * not a copy ([[feedback_calibration_independence]]).
 *
 * Flag discipline (T2 Decision 1, Andrew-approved S182): `eoc_prose_prior_auth_v1` gates the ENTIRE
 * type-based divergence. Flag OFF → every fact behaves exactly as post-D1 (valid slug → coverage_rules,
 * unknown → admin enqueue, no slug → drop) — a clean, byte-identical rollback. Flag ON → route by type.
 *
 * Only `pa_column` is a user-visible write, and ONLY a service-specific `prior_auth`+`requires` with a
 * resolved slug and confidence ≥ floor reaches it. Everything uncertain (waived, axis-scoped, no slug,
 * low-confidence) is CAPTURED in the structured `eoc_prior_auth_facts[]` record — never silently dropped,
 * never wrongly surfaced. The pre-launch reader-resolution block applies the axis/carve-out facts later.
 */
import type { MedicalNecessityContentType, PriorAuthPolarity } from "./types";
import { canonicalizeSlug } from "@/lib/plan_doc/thesaurus-routing";

/** The destination stores a criterion can route to. */
export type RouteStore =
  | "coverage_rules" //       clinical criterion (or, flag-OFF, everything with a valid slug)
  | "pa_column" //            prior_auth · requires · service-specific · slug-resolved · conf≥floor → user-visible
  | "pa_facts" //             prior_auth captured-not-surfaced (waived / axis / no-slug / low-conf / uncertain)
  | "admin_metadata" //       admin_provision → insurance_plans.metadata.eoc_coverage_provisions[]
  | "enqueue_unknown_slug" // Pattern 1 #1 admin gate for an unknown slug (today's behavior, preserved)
  | "drop"; //                no slug hint (today's behavior for null-slug criteria)

export interface RouteDecision {
  store: RouteStore;
  /** Machine reason — feeds non-fire telemetry (Ship Gate G7) + the routing fixture. */
  reason: string;
}

/** The minimal criterion shape the decision reads (MedicalNecessityCriterion satisfies it structurally). */
export interface RoutableCriterion {
  type: MedicalNecessityContentType;
  pa_polarity: PriorAuthPolarity | null;
  place_of_service: string | null;
  service_slug_hint: string | null;
  type_confidence: number | null;
}

export interface RouteContext {
  /** `eoc_prose_prior_auth_v1` state. OFF → byte-identical post-D1 routing. */
  flagOn: boolean;
  /** type_confidence floor for the user-visible `pa_column` write (flag config; default 0.7). */
  confidenceFloor: number;
  /** Live `service_catalog` slugs (post-rename). Passed in so the function stays pure/DB-free. */
  validSlugs: Set<string>;
  /** dead→live slug rename map (Step B). */
  renameMap: Map<string, string>;
}

/**
 * Decide the destination store for one criterion. Pure; correct-by-construction (a `waived` or uncertain
 * prior_auth can NEVER reach `pa_column`; an `admin_provision` can NEVER reach `coverage_rules` when ON).
 */
export function routeCriterion(c: RoutableCriterion, ctx: RouteContext): RouteDecision {
  const canonSlug = c.service_slug_hint ? canonicalizeSlug(c.service_slug_hint, ctx.renameMap) : null;
  const slugValid = canonSlug !== null && ctx.validSlugs.has(canonSlug);
  const slugUnknown = canonSlug !== null && !slugValid;

  // ── Flag OFF → byte-identical post-D1 (the rollback state): type is ignored. ──
  if (!ctx.flagOn) {
    if (!canonSlug) return { store: "drop", reason: "flag_off_no_slug" };
    if (slugUnknown) return { store: "enqueue_unknown_slug", reason: "flag_off_unknown_slug" };
    return { store: "coverage_rules", reason: "flag_off_valid_slug" };
  }

  // ── Flag ON → route by content type. ──
  if (c.type === "admin_provision") {
    return { store: "admin_metadata", reason: "admin_provision" };
  }

  if (c.type === "prior_auth") {
    // Waived or uncertain polarity → capture, NEVER the user-visible column (fail-toward-safe).
    if (c.pa_polarity !== "requires") {
      return { store: "pa_facts", reason: `pa_${c.pa_polarity ?? "uncertain"}` };
    }
    // requires, but axis-scoped or no resolvable service → structured record (reader-resolution applies later).
    if (c.place_of_service) return { store: "pa_facts", reason: "pa_requires_axis" };
    if (!slugValid) return { store: "pa_facts", reason: "pa_requires_no_slug" };
    // requires + service-specific + resolved slug → confidence-gate the user-visible write.
    if ((c.type_confidence ?? 0) < ctx.confidenceFloor) {
      return { store: "pa_facts", reason: "pa_requires_low_conf" };
    }
    return { store: "pa_column", reason: "pa_requires_service_specific" };
  }

  // ── clinical_criterion (and the fail-toward-today default) → today's coverage_rules path. ──
  if (!canonSlug) return { store: "drop", reason: "clinical_no_slug" };
  if (slugUnknown) return { store: "enqueue_unknown_slug", reason: "clinical_unknown_slug" };
  return { store: "coverage_rules", reason: "clinical_valid_slug" };
}

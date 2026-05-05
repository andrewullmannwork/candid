/**
 * Consumer-Read Filter — Pattern P-8 + Pattern 1 #4 enforcement at display layer.
 *
 * Phase 4 Task 4-A (Session 55+). Closes audit items #6 + #10 + #14 + interim #4.
 *
 * THE PROBLEM
 * Phases 3.1B → 3.2 → 3.2.1 → Bundle PR #1 built per-field source provenance
 * (Pattern P-8) + admin promotion queue (Pattern 1 #1). Bundle PR #1 confirmed
 * empirically that ZERO consumer code reads `field_provenance` — Pattern P-8 is
 * unenforced at display. Plan page renders deductible/copay regardless of whether
 * the parser captured a verifiable excerpt; dispute letter quotes plan terms
 * without P-8 verification; "(estimated)" tag fires only for premium when
 * `premiumSource === 'canonical_fallback'`.
 *
 * THE SOLUTION
 * Pure-function library exposing predicates + decorators. Caller (API routes,
 * UI components) passes per-field provenance + confidence + source + sourceCount;
 * library returns a 4-state DisplayState + a tooltip key per Q-P4-1 LOCK.
 *
 * SELF-SOURCE vs CROSS-USER
 * Pattern 1 #4 ("multi-source corroboration threshold") applies to CROSS-USER
 * data (canonical inheritance, canonical fallback, provider attestations) NOT
 * to a user reading their OWN uploaded data. Single-source data on the user's
 * own profile renders as "verified" if cite-grade; the corroboration threshold
 * only gates promotion to canonical and cross-user display.
 *
 * Per-source corroboration thresholds (Session 55):
 *   - canonical_inherited / canonical_fallback → P1 #4 default (3 distinct users;
 *     configurable via feature_flags.pattern1_corroboration_threshold per Q-P4-3)
 *   - provider_submitted → 2 distinct user corroborations (provider attestation
 *     needs user validation; Pattern 1 hard rule clarification Session 55)
 *   - All other sources (admin_verified, user_correction, doc_extraction on
 *     user's own row, card_corroboration, bill_observed, cms_marketplace, etc.)
 *     → no corroboration required (self or trusted)
 *
 * CANONICAL PUSH SEMANTICS
 * When canonical hits its threshold, the `canonical_inherited` rows on every
 * user's `plan_covered_services` automatically render as "verified" via the
 * P1 #4 check here — without code changes downstream. Push is implicit because
 * the inheritance pattern (process-plan.ts) updates inherited rows when
 * canonical changes, and this library reads the live row state.
 *
 * IMPORTANT FOR API CALLERS (Task 4-B integration):
 *   When fetching `canonical_inherited` rows from `plan_covered_services`, the
 *   API MUST join `canonical_plan_services.verification_count` to populate the
 *   `sourceCount` argument here — otherwise canonical-corroborated values will
 *   be misclassified as low-corroboration and render as "estimated".
 */

import type { PatternP8Provenance } from "./verify-source-excerpts";
import type { FieldProvenanceEntry, SourceProvenance } from "./field-categories";

// 4-state vocabulary per Q-P4-1 LOCK (collapsed `verified` + `corroborated` from
// the original 5-state proposal; tooltip differentiates the two paths to verified).
export type DisplayState = "verified" | "estimated" | "unverified" | "hidden";

// Reasons surface to UI as tooltip keys (Q-DR-4A-2 LOCK = enum, not literal text;
// caller maps to UI string for i18n boundary).
export type DisplayStateReason =
  // verified family
  | "p8_cite_grade_corroborated"      // both: cite-grade + multi-source
  | "p8_cite_grade_self_source"       // self-source with citation
  | "corroborated_multi_user"         // multi-source, no citation
  // estimated family
  | "self_source_no_cite"             // user's own upload but P-8 verifier failed
  | "cross_user_below_threshold"      // canonical/provider data; not enough corroborators yet
  | "canonical_fallback"              // county/CMS marketplace fallback
  | "ocr_unverifiable"                // scanned doc; verifier honest about limitation
  | "low_confidence"                  // confidence < 0.5
  // unverified family
  | "haiku_not_found"                 // parser flagged not_found — likely hallucination (re-parse may recover)
  | "verbatim_absent_searched_all"    // Phase 4.0.5: deterministic — verifier searched ALL
                                      //   non-DO_NOT_EXTRACT sections + value not in document.
                                      //   Re-parse won't help; user needs different/more complete doc.
  // hidden family
  | "do_not_extract_section";         // boilerplate (e.g., glossary, footer legalese)

// Sources that require cross-user corroboration before they render as verified.
// All other sources are self/trusted; sourceCount=1 is sufficient for verified
// (paired with cite-grade per Q-P4-4 LOCK).
const CROSS_USER_DEFAULT_SOURCES = new Set<string>(["canonical_inherited", "canonical_fallback"]);
const PROVIDER_ATTESTATION_SOURCE = "provider_submitted";
const PROVIDER_ATTESTATION_THRESHOLD = 2;

/**
 * Returns the per-source corroboration threshold (number of distinct users required
 * to lift the source's data to "verified" via multi-user corroboration).
 *
 * Returns 0 for self/trusted sources (no corroboration required for verified).
 * Caller passes the configured default for cross-user defaults; provider_submitted
 * has its own hardcoded threshold (Pattern 1 clarification Session 55: providers
 * are not authoritative until 2 user uploads corroborate).
 */
export function corroborationThreshold(source: string, configuredDefault: number): number {
  if (CROSS_USER_DEFAULT_SOURCES.has(source)) return configuredDefault;
  if (source === PROVIDER_ATTESTATION_SOURCE) return PROVIDER_ATTESTATION_THRESHOLD;
  return 0;
}

/**
 * Pattern P-8 hard rule predicate (citation-grade test).
 * Returns true iff:
 *   - provenance is non-null
 *   - source_excerpt_verified === 'verified' (parser confirmed verbatim match in doc)
 *   - source_section_verified === true (excerpt found within Haiku-claimed section)
 *   - source_section_hint does NOT end with '_DO_NOT_EXTRACT' (not boilerplate)
 */
export function isCitationGrade(provenance: PatternP8Provenance | null | undefined): boolean {
  if (!provenance) return false;
  if (provenance.source_excerpt_verified !== "verified") return false;
  if (!provenance.source_section_verified) return false;
  if (provenance.source_section_hint.endsWith("_DO_NOT_EXTRACT")) return false;
  return true;
}

export interface DisplayStateInput {
  /** Pattern P-8 source provenance from `field_provenance.{field}` JSONB. Null for legacy/pre-Phase-3 rows. */
  provenance: PatternP8Provenance | null | undefined;
  /** Per-row or per-field confidence (0-1). */
  confidence: number;
  /** Distinct user count contributing to this value. For canonical_inherited rows,
   *  caller MUST pass canonical_plan_services.verification_count (joined upstream),
   *  not the user's own row count. */
  sourceCount: number;
  /** SourceProvenance value (or surface-specific value like "canonical_inherited"
   *  or "canonical_fallback"). Determines whether corroboration is required. */
  source: SourceProvenance | string;
  /** Multi-source corroboration threshold for cross-user sources. Caller reads
   *  feature_flags.pattern1_corroboration_threshold per Q-P4-3 LOCK and passes
   *  here. Self/trusted sources ignore this value (threshold = 0 for them). */
  multiSourceThreshold: number;
}

export interface DisplayStateResult {
  state: DisplayState;
  reason: DisplayStateReason;
}

/**
 * Derive the display state for a single value per Q-P4-1 LOCK (4-state) +
 * Q-P4-4 LOCK (P-8 + P1 #4 as orthogonal axes; UI composes via tooltip).
 *
 * Tier order: hidden > verified > unverified > estimated (default).
 * Tier 0 (hidden): DO_NOT_EXTRACT trumps everything (boilerplate is always hidden).
 * Tier 1 (verified): cite-grade OR sufficient corroboration → verified.
 * Tier 2 (unverified): parser-flagged not_found → unverified (likely hallucination).
 * Tier 3 (estimated): everything else, with reason indicating sub-state.
 */
export function getDisplayState(input: DisplayStateInput): DisplayStateResult {
  const { provenance, confidence, sourceCount, source, multiSourceThreshold } = input;

  // Tier 0: DO_NOT_EXTRACT section trumps everything (boilerplate that happened
  // to verify is still boilerplate).
  if (provenance?.source_section_hint?.endsWith("_DO_NOT_EXTRACT")) {
    return { state: "hidden", reason: "do_not_extract_section" };
  }

  const citeGrade = isCitationGrade(provenance);
  const requiredCount = corroborationThreshold(source, multiSourceThreshold);
  // Self/trusted sources (requiredCount === 0) are auto-corroborated.
  // Cross-user sources need sourceCount >= configured threshold.
  const corroborated = requiredCount === 0 || sourceCount >= requiredCount;

  // Tier 1: verified — cite-grade OR sufficient corroboration.
  if (citeGrade && corroborated && requiredCount > 0) {
    return { state: "verified", reason: "p8_cite_grade_corroborated" };
  }
  if (citeGrade) {
    // Self-source with cite or cross-user with cite (corroboration may not be met yet
    // but cite-grade alone is sufficient for trust per Pattern P-8).
    return { state: "verified", reason: "p8_cite_grade_self_source" };
  }
  if (corroborated && requiredCount > 0) {
    // Cross-user data, no cite, but enough corroborators.
    return { state: "verified", reason: "corroborated_multi_user" };
  }

  // Tier 2: unverified — parser explicitly flagged not_found OR verbatim_absent.
  // verbatim_absent is the Phase 4.0.5 deterministic state (parser searched ALL
  // non-DO_NOT_EXTRACT sections + value still not found). Both render as
  // `unverified` but with different reason codes for UX (re-parse may help on
  // not_found; only doc-replace helps on verbatim_absent).
  if (provenance?.source_excerpt_verified === "verbatim_absent") {
    return { state: "unverified", reason: "verbatim_absent_searched_all" };
  }
  if (provenance?.source_excerpt_verified === "not_found") {
    return { state: "unverified", reason: "haiku_not_found" };
  }

  // Tier 3: estimated — everything else, categorized by reason.
  // Cross-user, below threshold takes precedence over generic single_source label.
  if (requiredCount > 0 && sourceCount < requiredCount) {
    if (source === "canonical_fallback") {
      return { state: "estimated", reason: "canonical_fallback" };
    }
    return { state: "estimated", reason: "cross_user_below_threshold" };
  }

  // Self-source variations
  if (provenance?.source_excerpt_verified === "ocr_unverifiable") {
    return { state: "estimated", reason: "ocr_unverifiable" };
  }
  if (confidence < 0.5) {
    return { state: "estimated", reason: "low_confidence" };
  }

  // Default: self-source with provenance but neither cite-grade nor flagged.
  return { state: "estimated", reason: "self_source_no_cite" };
}

/**
 * Decoration wrapper for UI consumption. Wraps a value with display metadata
 * + the source excerpt (when available) for citation tooltip rendering.
 *
 * Phase 4.0.5: `searchedSectionsCount` carries the parser-level dispatched-section
 * count for the field. UI uses it to pick the affordance shape (2-button "Re-check"
 * when incomplete; 1-button "Upload" when complete or undefined per Q-P4.0.5-7
 * forward-only commitment). Undefined for legacy rows or fields without P-8.
 */
export interface DecoratedValue<T> {
  value: T;
  state: DisplayState;
  reason: DisplayStateReason;
  hasExcerpt: boolean;
  excerpt: string | null;
  searchedSectionsCount?: number;
}

export function decorateForDisplay<T>(value: T, input: DisplayStateInput): DecoratedValue<T> {
  const { state, reason } = getDisplayState(input);
  const excerpt = input.provenance?.source_excerpt ?? null;
  return {
    value,
    state,
    reason,
    hasExcerpt: !!excerpt && excerpt.length > 0,
    excerpt,
  };
}

/**
 * Aggregate multiple per-field display states into a single row-level state.
 * Used by plan/page.tsx benefit rows (which have copay + coinsurance + priorAuth +
 * annualLimit decorated fields). Picks the worst signal — the user is shown the
 * weakest link so they know which row needs scrutiny.
 *
 * Tier order (worst → best for surfacing): unverified > estimated > verified
 * Returns null when no decorated fields are present (flag OFF or all hidden).
 *
 * Lives in consumer-read.ts (not display-state.tsx) so smoke tests can exercise
 * it without importing React / next/link from the UI layer.
 */
export function aggregateRowState(states: Array<DisplayState | null>): DisplayState | null {
  const visible = states.filter((s): s is DisplayState => s !== null && s !== "hidden");
  if (visible.length === 0) return null;
  if (visible.some((s) => s === "unverified")) return "unverified";
  if (visible.some((s) => s === "estimated")) return "estimated";
  return "verified";
}

/**
 * Runtime type guard for `T | DecoratedValue<T>` consumer-side branching.
 *
 * Use case (Phase 4 Tasks 4-D + 4-E): API responses carry `T` when
 * `consumer_read_filter_v1` flag is OFF and `DecoratedValue<T>` when ON.
 * UI components branch via this guard rather than threading flag state through
 * every render path — preserves byte-identical legacy rendering when flag OFF
 * and unlocks DisplayStateBadge + SourceQuote rendering when flag ON.
 *
 * Checks for the three discriminator keys (`value`, `state`, `reason`) — a bare
 * `{ value: 30 }` object would otherwise false-positive. Picks `reason` over
 * `excerpt` because excerpt is nullable; reason is always present on a real
 * DecoratedValue.
 */
export function isDecoratedValue<T = unknown>(v: unknown): v is DecoratedValue<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "state" in v &&
    "reason" in v
  );
}

/**
 * Extract a `PatternP8Provenance` (5 required keys) from a `FieldProvenanceEntry`
 * (storage shape with all 5 keys optional). Returns null when any key is missing.
 *
 * Use case (Phase 4 Task 4-B / API layer): consumer-side code reading
 * `field_provenance.{field}` JSONB has FieldProvenanceEntry on hand but
 * `getDisplayState()` requires the strict 5-required PatternP8Provenance contract.
 * This bridge prevents undefined-key crashes (e.g., `source_section_hint.endsWith`
 * would throw on undefined) and treats partial-P8 entries as "no P-8" for display
 * purposes — partial provenance is not citation-grade by definition.
 */
export function extractPatternP8FromEntry(
  entry: FieldProvenanceEntry | null | undefined,
): PatternP8Provenance | null {
  if (!entry) return null;
  if (
    entry.source_excerpt === undefined ||
    entry.source_excerpt_verified === undefined ||
    entry.source_excerpt_extraction_method === undefined ||
    entry.source_section_hint === undefined ||
    entry.source_section_verified === undefined
  ) {
    return null;
  }
  return {
    source_excerpt: entry.source_excerpt,
    source_excerpt_verified: entry.source_excerpt_verified,
    source_excerpt_extraction_method: entry.source_excerpt_extraction_method,
    source_section_hint: entry.source_section_hint,
    source_section_verified: entry.source_section_verified,
  };
}

/**
 * High-level API helper: decorate a single field given its raw value + the
 * stored FieldProvenanceEntry + per-source corroboration context. Bundles
 * extractPatternP8FromEntry + decorateForDisplay so API code stays terse.
 *
 * If `entry` is null/undefined, falls back to a "self-source no provenance"
 * shape using the value's source argument (caller passes source explicitly,
 * e.g., 'cms_marketplace' for premium fields without P-8 storage).
 */
export function decorateFieldFromEntry<T>(
  value: T,
  entry: FieldProvenanceEntry | null | undefined,
  context: {
    sourceCount: number;
    source: SourceProvenance | string;
    multiSourceThreshold: number;
    /** Override confidence when entry is null (e.g., premium fields without P-8). Default 0.5. */
    fallbackConfidence?: number;
  },
): DecoratedValue<T> {
  const provenance = extractPatternP8FromEntry(entry);
  const confidence = entry?.confidence ?? context.fallbackConfidence ?? 0.5;
  const decorated = decorateForDisplay(value, {
    provenance,
    confidence,
    sourceCount: context.sourceCount,
    source: context.source,
    multiSourceThreshold: context.multiSourceThreshold,
  });
  // Phase 4.0.5: carry section-coverage count to UI for VerifyAffordance shape decision.
  if (entry?.searched_sections !== undefined) {
    decorated.searchedSectionsCount = entry.searched_sections.length;
  }
  return decorated;
}

/**
 * Pattern 1 #4 row-level decoration helper for API layer (Task 4-B).
 * Adds displayState + displayReason fields per row WITHOUT dropping rows
 * (Q-DR-4A-3 LOCK = decorate-not-drop). Callers downstream filter by state
 * if they need to hide low-trust rows.
 */
export function decorateRowsWithDisplayState<
  T extends {
    confidence: number;
    sourceCount: number;
    source: SourceProvenance | string;
    provenance?: PatternP8Provenance | null;
  },
>(
  rows: T[],
  multiSourceThreshold: number,
): Array<T & { displayState: DisplayState; displayReason: DisplayStateReason }> {
  return rows.map((row) => {
    const { state, reason } = getDisplayState({
      provenance: row.provenance ?? null,
      confidence: row.confidence,
      sourceCount: row.sourceCount,
      source: row.source,
      multiSourceThreshold,
    });
    return { ...row, displayState: state, displayReason: reason };
  });
}

/**
 * Tooltip text mapping for the UI layer per Q-DR-4A-2 LOCK + user direction
 * Session 55 ("playful, transparent about origin, invitation to participate").
 *
 * Caller (UI component) imports this map for default en-US strings; future
 * i18n replaces this with a t() function call keyed on DisplayStateReason.
 */
export const DISPLAY_STATE_TOOLTIP_EN: Record<DisplayStateReason, string> = {
  // verified family
  p8_cite_grade_corroborated:
    "Verified — exact quote from your document plus other Candid users back this up.",
  p8_cite_grade_self_source:
    "Verified from your uploaded document. Waiting to confirm across other Candid users — your upload helps grow the community knowledge.",
  corroborated_multi_user:
    "Confirmed by multiple Candid users on this plan.",

  // estimated family
  self_source_no_cite:
    "Based on your uploaded document. Waiting to confirm across other Candid users — pop back later as more folks chime in.",
  cross_user_below_threshold:
    "Sourced from other Candid users on this plan — still gathering enough confirmations to be sure. Upload your own SBC to help verify.",
  canonical_fallback:
    "Estimated from public marketplace data. Upload your SBC for the real story.",
  ocr_unverifiable:
    "Pulled from a scanned document — we couldn't fully verify the exact wording. Worth double-checking your plan papers.",
  low_confidence:
    "Best estimate — the parser wasn't very confident here. Please verify against your plan documents.",

  // unverified family
  haiku_not_found:
    "We extracted this but couldn't find a matching quote in the source — please verify against your plan documents before relying on it.",
  verbatim_absent_searched_all:
    "We searched every section of your plan document and couldn't find this value verbatim. Try uploading a more complete plan document (full EOC, not just an SBC).",

  // hidden family (no tooltip needed; UI doesn't render the value or badge)
  do_not_extract_section:
    "(hidden — boilerplate section)",
};

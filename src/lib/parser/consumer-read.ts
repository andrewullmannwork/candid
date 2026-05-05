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

// 6-state vocabulary per Session 64 (CF-19) — extends the original 4-state contract
// with three distinct verified-family tiers visible to the user:
//   - "candid_verified"      → fully green        (Pattern 1 #3 cross-user corroborated)
//   - "document_verified"    → dark green border  (Pattern P-8 cite-grade from THIS user's doc)
//   - "found_in_document"    → light green border (extracted from THIS user's doc; verbatim
//                              absent — parser searched comprehensively but couldn't quote)
// And the existing trio:
//   - "estimated"            → amber              (value present from non-cite source)
//   - "unverified"           → rose               (parser flagged not_found before exhaustive search)
//   - "hidden"               → nothing rendered   (DO_NOT_EXTRACT boilerplate)
//
// Aggregation order (worst → best for surfacing weakest signal at category level):
//   unverified → estimated → found_in_document → document_verified → candid_verified → hidden
export type DisplayState =
  | "candid_verified"
  | "document_verified"
  | "found_in_document"
  | "estimated"
  | "unverified"
  | "hidden";

// Reasons surface to UI as tooltip keys (Q-DR-4A-2 LOCK = enum, not literal text;
// caller maps to UI string for i18n boundary).
export type DisplayStateReason =
  // candid_verified family — full green (Pattern 1 #3 cross-user corroboration met)
  | "p8_cite_grade_corroborated"          // cite-grade + multi-source (best signal)
  | "corroborated_multi_user"             // multi-source, no citation
  | "inherited_canonical_corroborated"    // CF-19a: canonical-inherited row + canonical's verification_count >= threshold
  // document_verified family — dark green border (Pattern P-8 cite-grade from THIS user's doc)
  | "p8_cite_grade_self_source"           // self-source with verbatim citation (single-user evidence verified)
  // found_in_document family — light green border (extracted from THIS user's doc; verbatim absent / parser searched comprehensively)
  | "verbatim_absent_searched_all"        // Phase 4.0.5: parser searched ALL non-DO_NOT_EXTRACT sections; value extracted but verbatim not located
  | "found_in_doc_no_cite"                // CF-19 (Session 64): provenance exists with source=doc_extraction* but cite-grade not achieved (e.g., section_verified=false)
  // estimated family — amber (value present but not extracted from this user's doc OR awaiting corroboration)
  | "self_source_no_cite"                 // user's own upload but P-8 verifier failed AND not yet classified as found_in_document (legacy fallback)
  | "cross_user_below_threshold"          // canonical/provider data; not enough corroborators yet
  | "canonical_fallback"                  // county/CMS marketplace fallback
  | "inherited_canonical_pre_corroboration" // CF-19a: canonical-inherited row but verification_count < threshold (community knowledge still gathering)
  | "ocr_unverifiable"                    // scanned doc; verifier honest about limitation
  | "low_confidence"                      // confidence < 0.5
  // unverified family — rose (parser flagged not_found before exhaustive search; re-parse may recover)
  | "haiku_not_found"                     // parser flagged not_found — likely hallucination (re-parse may help)
  // hidden family
  | "do_not_extract_section";             // boilerplate (e.g., glossary, footer legalese)

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
 * Derive the display state for a single value per CF-19 (Session 64) 6-state vocabulary.
 *
 * Tier order (most specific first; first match wins):
 *   Tier 0: hidden                — DO_NOT_EXTRACT trumps everything (boilerplate)
 *   Tier 1: candid_verified       — Pattern 1 #3 cross-user corroboration met (with or without cite-grade)
 *   Tier 2: document_verified     — Pattern P-8 cite-grade from THIS user's doc (single-user evidence)
 *   Tier 3: found_in_document     — extracted from user's doc, verbatim absent OR no cite-grade
 *   Tier 4: unverified            — parser flagged not_found before exhaustive search (likely hallucination)
 *   Tier 5: estimated             — everything else (canonical_fallback / inherited / cross_user / ocr / low confidence)
 */
export function getDisplayState(input: DisplayStateInput): DisplayStateResult {
  const { provenance, confidence, sourceCount, source, multiSourceThreshold } = input;

  // Tier 0: DO_NOT_EXTRACT section trumps everything.
  if (provenance?.source_section_hint?.endsWith("_DO_NOT_EXTRACT")) {
    return { state: "hidden", reason: "do_not_extract_section" };
  }

  const citeGrade = isCitationGrade(provenance);
  const requiredCount = corroborationThreshold(source, multiSourceThreshold);
  // Cross-user sources need sourceCount >= configured threshold.
  // Self/trusted sources (requiredCount === 0) skip the corroboration ladder entirely
  // — they're either cite-grade (Document Verified) or self-source-no-cite (Found in Document / Estimated).
  const meetsCrossUserThreshold = requiredCount > 0 && sourceCount >= requiredCount;

  // Tier 1: candid_verified — Pattern 1 #3 corroboration met
  if (citeGrade && meetsCrossUserThreshold) {
    return { state: "candid_verified", reason: "p8_cite_grade_corroborated" };
  }
  if (meetsCrossUserThreshold) {
    // Cross-user corroboration met without cite-grade. Distinguish canonical_inherited
    // (smart-skip path; community-corroborated AND populated on user's row from canonical)
    // from generic corroborated_multi_user (e.g., provider_submitted attestations).
    if (source === "canonical_inherited" || source === "canonical_fallback") {
      return { state: "candid_verified", reason: "inherited_canonical_corroborated" };
    }
    return { state: "candid_verified", reason: "corroborated_multi_user" };
  }

  // Tier 2: document_verified — Pattern P-8 cite-grade from user's own doc
  if (citeGrade) {
    // Self-source with cite-grade — single-user evidence verified verbatim.
    // (Cross-user with cite-grade but below threshold also lands here; tooltip
    // surfaces the path. Once corroboration meets threshold it promotes to Tier 1.)
    return { state: "document_verified", reason: "p8_cite_grade_self_source" };
  }

  // Tier 3: found_in_document — extracted from user's doc but no cite-grade
  // verbatim_absent: parser searched ALL non-DO_NOT_EXTRACT sections deterministically
  // (Phase 4.0.5). Promoted from "unverified" to "found_in_document" per Session 64
  // user direction — the parser IS confident it came from the doc; we just couldn't
  // quote it back exactly. Strongest signal short of cite-grade.
  if (provenance?.source_excerpt_verified === "verbatim_absent") {
    return { state: "found_in_document", reason: "verbatim_absent_searched_all" };
  }
  // Provenance exists with a doc-extraction source but cite-grade predicate failed
  // (e.g., section_verified=false because excerpt landed in wrong section, or P-8 sub-keys
  // partially populated). This is "the parser found this in your doc but the verifier
  // wasn't satisfied" — still worth Found in Document treatment over Estimated.
  if (
    provenance &&
    (source === "doc_extraction" || source === "doc_extraction_eoc") &&
    provenance.source_excerpt_verified === "verified"
    // (When verified=true but section_verified=false, we land here. Cite-grade
    // requires both. So this branch fires when section misattribution drops cite-grade
    // but the verbatim DID match.)
  ) {
    return { state: "found_in_document", reason: "found_in_doc_no_cite" };
  }

  // Tier 4: unverified — parser flagged not_found (early-exit; likely hallucination).
  // verbatim_absent already routed above (different state per Session 64).
  if (provenance?.source_excerpt_verified === "not_found") {
    return { state: "unverified", reason: "haiku_not_found" };
  }

  // Tier 5: estimated — everything else, categorized by reason.

  // Cross-user data below threshold (canonical_inherited / canonical_fallback /
  // provider_submitted / etc with sourceCount < requiredCount).
  if (requiredCount > 0 && sourceCount < requiredCount) {
    if (source === "canonical_inherited") {
      return { state: "estimated", reason: "inherited_canonical_pre_corroboration" };
    }
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

  // Default: self-source with no provenance OR provenance without doc-extraction source.
  // Includes legacy rows (pre-mig-063 with field_provenance='{}') + corroborated-source-but-
  // single-source-with-no-cite cases.
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
 * Used by plan/page.tsx benefit rows + category headers + summary card.
 * Picks the worst signal — the user is shown the weakest link so they know
 * which row needs scrutiny.
 *
 * Tier order (worst → best for surfacing):
 *   unverified > estimated > found_in_document > document_verified > candid_verified
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
  if (visible.some((s) => s === "found_in_document")) return "found_in_document";
  if (visible.some((s) => s === "document_verified")) return "document_verified";
  return "candid_verified";
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
 *
 * CF-19a (Session 64) — source-threading hole closed:
 * Per-field source from `entry.source` takes precedence over the row-level
 * `context.source` argument when present. This is critical for smart-skip
 * inheritance: when extraction-dedup writes provenance entries with
 * `source: 'canonical_inherited'`, the row-level source on insurance_plans
 * may still read 'sbc_upload' (the user did upload an SBC; that's accurate
 * for the upload event, not the value origin). The per-field source carries
 * the value-origin signal that consumer-read needs for cross-user threshold
 * routing — independent of the upload-event source.
 *
 * Engineering NS #1 (single code path) honored: callers don't need to know
 * which source took effect — they pass row-level source as the fallback;
 * helper resolves precedence.
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
  // CF-19a: per-field entry source takes precedence over caller's row-level source.
  const effectiveSource = entry?.source ?? context.source;
  const decorated = decorateForDisplay(value, {
    provenance,
    confidence,
    sourceCount: context.sourceCount,
    source: effectiveSource,
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
  // candid_verified family — fully green (Pattern 1 #3 corroborated by Candid community)
  p8_cite_grade_corroborated:
    "Candid Verified — exact quote from your document plus other Candid users on this plan back it up.",
  corroborated_multi_user:
    "Candid Verified — confirmed by multiple Candid users on this plan.",
  inherited_canonical_corroborated:
    "Candid Verified — multiple Candid users have uploaded the same plan and confirmed this value.",

  // document_verified family — dark green border (Pattern P-8 cite-grade from THIS user's doc)
  p8_cite_grade_self_source:
    "Document Verified — we found this value verbatim in your uploaded document. Waiting on other Candid users to corroborate before this becomes Candid Verified.",

  // found_in_document family — light green border (extracted from user's doc; verbatim not located OR no cite-grade)
  verbatim_absent_searched_all:
    "Found in Document — we searched every section of your plan document and the value is in there, but we couldn't pinpoint the exact quote. Trustworthy but not citation-grade for dispute letters.",
  found_in_doc_no_cite:
    "Found in Document — extracted from your uploaded document, but we couldn't fully verify the exact wording matched the section. Worth double-checking before citing in a dispute.",

  // estimated family — amber (value present but not from user's doc, awaiting corroboration, etc.)
  self_source_no_cite:
    "Estimated — based on your uploaded document but we don't have full provenance metadata. Re-upload to refresh.",
  cross_user_below_threshold:
    "Estimated — sourced from other Candid users on this plan; still gathering enough confirmations to be sure. Upload your own SBC to help verify.",
  canonical_fallback:
    "Estimated — drawn from public marketplace data, not your document. Upload your SBC for the real story.",
  inherited_canonical_pre_corroboration:
    "Estimated — value comes from another Candid user's upload of this plan. We're still gathering enough confirmations to elevate to Candid Verified. Upload your full plan document for a verified citation.",
  ocr_unverifiable:
    "Estimated — pulled from a scanned document; we couldn't fully verify the exact wording. Worth double-checking against your plan papers.",
  low_confidence:
    "Estimated — the parser wasn't very confident here. Please verify against your plan documents.",

  // unverified family — rose (parser flagged not_found before exhaustive search; re-parse may help)
  haiku_not_found:
    "Unverified — we extracted this but couldn't find a matching quote in the source. Re-parse may recover it; otherwise verify against your plan documents.",

  // hidden family (no tooltip needed; UI doesn't render the value or badge)
  do_not_extract_section:
    "(hidden — boilerplate section)",
};

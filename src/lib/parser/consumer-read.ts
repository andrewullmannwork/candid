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

// 4-state user-facing vocabulary per CF-19 (Session 64, v2 — user direction simplification):
//   - "candid_verified"  → fully green     (Pattern 1 #3 corroboration met — community-confirmed)
//   - "verified"         → green outline   (extracted from user's uploaded document; cite-grade
//                                           or non-cite-grade — collapsed for user; backend
//                                           distinguishes via reason for dispute-letter logic)
//   - "estimated"        → amber + upload-CTA (data from non-doc source — CMS marketplace, card
//                                              match, canonical below threshold; user should
//                                              upload SBC for the real story)
//   - "hidden"           → no render        (boilerplate, parser failures, OCR failures, missing
//                                            data — page-level banner shows when parser_failure
//                                            reason is present on any field)
//
// Aggregation order (worst → best): hidden → estimated → verified → candid_verified
//   (hidden filtered out as boilerplate; doesn't contribute to category badge).
//
// **Backend distinction preserved**: cite-grade vs non-cite-grade lives in DisplayStateReason
// (`from_user_document_cite_grade` vs `from_user_document_no_cite`) — dispute letter logic
// reads the reason, not the state, to decide blockquote rendering. CF-20 (Session 65 fast-follow)
// will add a re-parse-on-cite-grade-fail prompt when user clicks "Generate dispute letter"
// against a `from_user_document_no_cite` field.
// Session 72 v3 — 4 active states + hidden:
//   candid_verified → "Verified"      (≥3 users corroborated; only solid-green badge)
//   user_verified   → "User Verified" (your SBC/plan_doc parse, OR you typed/confirmed
//                                       via inline-edit / card scan / profile form —
//                                       i.e., anything where YOU contributed the value)
//   community       → "Community"     (canonical from another user's parse, sub-3 corroborated)
//   public_data     → "Public Data"   (CMS bulk ingest / state APCDs / NPPES — no user parse)
//   hidden          → no badge        (boilerplate / parser failure → page-level banner)
//
// v3 collapse rationale (Session 72 same-day evolution): "Upload" + "User Verified"
// both signal "the user is the source"; merging them gives the user one consistent
// signal whenever their own data backs a value. Backend `reason` codes still
// preserve the cite-grade vs no-cite distinction inside the user_verified state
// so dispute-letter logic can gate blockquotes on from_user_document_cite_grade only.
export type DisplayState =
  | "candid_verified"
  | "user_verified"
  | "community"
  | "public_data"
  | "hidden";

// Reasons surface to UI as tooltip keys + backend routing keys. Richer than
// states so backend logic (affordance routing, dispute-letter cite-grade
// gating, sample-state detection) can differentiate fields that share a badge.
export type DisplayStateReason =
  // candid_verified
  | "community_corroborated"              // ≥3 distinct users on the canonical confirm this value (Pattern 1 #3 met)
  // upload (from THIS user's own document)
  | "from_user_document_cite_grade"       // Pattern P-8 cite-grade — load-bearing for dispute letter blockquotes
  | "from_user_document_no_cite"          // Doc-extracted but verbatim absent OR section misattribution; CF-20 re-parse on dispute-letter trigger
  // community (canonical entry derived from another user's parse, sub-3)
  | "canonical_below_threshold"           // Canonical exists but verification_count < threshold
  | "provider_attestation_below_threshold" // Provider portal data with <2 user corroborations (Phase 4.5b territory) — folded into Community
  // public_data (CMS / state APCD / NPPES bulk ingest, no user-doc backing yet)
  | "cms_marketplace"                     // CMS public-marketplace data (county-resolved premium, plan-catalog match from card scan)
  // user_verified (caller explicitly entered/confirmed)
  | "user_correction"                     // User typed value via /api/plan/field inline-edit
  | "card_scan"                           // Extracted from a user's insurance card scan (member ID, group #, plan name)
  // hidden — no value rendered
  | "parser_failure"                      // Parser hallucination, OCR failure, low confidence, or null provenance
  | "boilerplate";                        // DO_NOT_EXTRACT section

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
 * Derive the display state for a single value per CF-19 v2 (Session 64) 4-state vocabulary.
 *
 * Tier order (most specific first; first match wins):
 *   Tier 0: hidden            — DO_NOT_EXTRACT boilerplate (reason = "boilerplate")
 *   Tier 1: candid_verified   — Pattern 1 #3 corroboration met (≥ threshold distinct users)
 *   Tier 2: verified          — Extracted from user's own document (cite-grade OR no-cite;
 *                                backend reason distinguishes for dispute-letter logic)
 *   Tier 3: estimated         — Non-doc source: CMS marketplace, canonical below threshold,
 *                                provider attestation below threshold. Paired with upload CTA.
 *   Tier 4: hidden            — Parser failure (hallucination / OCR / low-confidence / null
 *                                provenance) — page-level error banner fires.
 */
export function getDisplayState(input: DisplayStateInput): DisplayStateResult {
  const { provenance, confidence, sourceCount, source, multiSourceThreshold } = input;

  // Tier 0: boilerplate trumps everything.
  if (provenance?.source_section_hint?.endsWith("_DO_NOT_EXTRACT")) {
    return { state: "hidden", reason: "boilerplate" };
  }

  const citeGrade = isCitationGrade(provenance);
  const requiredCount = corroborationThreshold(source, multiSourceThreshold);
  const meetsCrossUserThreshold = requiredCount > 0 && sourceCount >= requiredCount;

  // Tier 1: Verified — ≥3 distinct users corroborated (Pattern 1 #3 met).
  // Trumps everything else regardless of source.
  if (meetsCrossUserThreshold) {
    return { state: "candid_verified", reason: "community_corroborated" };
  }

  // Tier 2: User Verified — caller explicitly typed/confirmed the value.
  // Sources here are authoritative-by-direct-action: inline-edit (user_correction)
  // or card scan (card_scan). No corroboration needed.
  if (source === "user_correction") {
    return { state: "user_verified", reason: "user_correction" };
  }
  if (source === "card_scan") {
    return { state: "user_verified", reason: "card_scan" };
  }

  // Tier 3: User Verified (your-document branch) — extracted from THIS user's
  // uploaded plan document (cite-grade OR no-cite; backend reason distinguishes
  // for dispute-letter logic). Merged with the user-typed branch into the same
  // visible state per Session 72 v3 — "you contributed this value either way."
  if (citeGrade) {
    return { state: "user_verified", reason: "from_user_document_cite_grade" };
  }
  if (
    provenance?.source_excerpt_verified === "verbatim_absent" ||
    (provenance &&
      (source === "doc_extraction" || source === "doc_extraction_eoc") &&
      provenance.source_excerpt_verified === "verified")
  ) {
    return { state: "user_verified", reason: "from_user_document_no_cite" };
  }

  // Tier 4: Community — canonical entry derived from another user's parse on
  // this canonical, not yet ≥3-user corroborated. provider_attestation also
  // folds in here (provider portal data sub-2-corroboration).
  if (requiredCount > 0 && sourceCount < requiredCount) {
    if (source === "canonical_inherited") {
      return { state: "community", reason: "canonical_below_threshold" };
    }
    if (source === "canonical_fallback") {
      return { state: "public_data", reason: "cms_marketplace" };
    }
    return { state: "community", reason: "provider_attestation_below_threshold" };
  }

  // Tier 5: Public Data — pure CMS marketplace source (no canonical inheritance,
  // no doc parse). Card-scan + plan-catalog lookup before SBC upload typically.
  if (source === "cms_marketplace") {
    return { state: "public_data", reason: "cms_marketplace" };
  }

  // Tier 6: Hidden — parser failure (hallucination / OCR limit / low-confidence
  // / null provenance). Page-level banner aggregates → one re-upload CTA, not N
  // hidden values per row.
  return { state: "hidden", reason: "parser_failure" };
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
 * Picks the worst signal so the user sees the weakest link.
 *
 * Tier order (worst → best for surfacing):
 * Session 72 v3 worst-to-best ordering:
 *   public_data < community < user_verified < candid_verified
 * "Verified" trumps everything (gold-standard cross-user signal). Hidden
 * filters out (boilerplate / parser_failure → page-level banner). Returns
 * null when no decorated fields are present (flag OFF or all hidden).
 */
/**
 * Session 72 helpers — centralize common state-equality patterns so the
 * 4-state vocabulary doesn't force every caller to enumerate states inline.
 */

/** Any state that should render a value + badge to the user (everything except "hidden"). */
export function isVisibleState(s: DisplayState | null | undefined): boolean {
  return s != null && s !== "hidden";
}

/** States that should pair with an "Upload your plan document" CTA to improve
 *  the signal — Community + Public Data both lack the user's own contribution.
 *  Verified + User Verified don't need an upload CTA. */
export function needsUploadCTA(s: DisplayState | null | undefined): boolean {
  return s === "community" || s === "public_data";
}

/** Values where the user (or aggregated users) is the source of trust — covers
 *  Verified (≥3 users), User Verified (your doc OR your own typed/confirmed
 *  value), and Community (someone else's parse on this canonical). Public Data
 *  is the only "no human in the loop" state. */
export function isDocumentBacked(s: DisplayState | null | undefined): boolean {
  return s === "candid_verified" || s === "user_verified" || s === "community";
}

export function aggregateRowState(states: Array<DisplayState | null>): DisplayState | null {
  const visible = states.filter((s): s is DisplayState => s !== null && s !== "hidden");
  if (visible.length === 0) return null;
  // Worst → best: public_data → community → user_verified → candid_verified.
  // Row badge surfaces the worst-quality cell so the user sees the weakest link.
  if (visible.some((s) => s === "public_data")) return "public_data";
  if (visible.some((s) => s === "community")) return "community";
  if (visible.some((s) => s === "user_verified")) return "user_verified";
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
  // Verified — solid green: ≥3 users corroborated (Pattern 1 #3 met)
  community_corroborated:
    "Verified — multiple Candid users on this plan have confirmed this value.",

  // User Verified (your-document branch) — green border, white fill: from THIS user's own document parse
  from_user_document_cite_grade:
    "User Verified — pulled directly from your uploaded plan document with a verbatim citation.",
  from_user_document_no_cite:
    "User Verified — extracted from your uploaded plan document. (We couldn't pinpoint the exact verbatim quote yet, so this isn't citation-grade for dispute letters.)",

  // Community — green border, white fill: canonical entry from another user's parse, sub-3
  canonical_below_threshold:
    "Community — extracted from another Candid user's plan document on this canonical. Once a few more users confirm, this is promoted to Verified.",
  provider_attestation_below_threshold:
    "Community — provider-reported data still being corroborated. Upload your plan document to check it against your real plan.",

  // Public Data — green border, white fill: CMS bulk ingest, no user-doc backing yet
  cms_marketplace:
    "Public Data — sourced from CMS marketplace and other public datasets, based on your insurance card. Upload your plan document to confirm against your real plan.",

  // User Verified — green border, white fill: caller explicitly typed/confirmed
  user_correction:
    "User Verified — you typed this value yourself.",
  card_scan:
    "User Verified — extracted from your insurance card scan and confirmed.",

  // Hidden — page-level banner handles parser_failure
  parser_failure:
    "We couldn't fully extract this from your document.",
  boilerplate:
    "(hidden — boilerplate section)",
};

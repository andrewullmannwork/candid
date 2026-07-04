/**
 * S94 B5 — fallback + sanity-gate helpers for the post-OCR classification step
 * in the process-chunk route. Gated by the classifier_haiku_regex_fallback_v1
 * feature flag (see mig 104 + src/lib/config/classifier-fallback-config.ts).
 *
 * Two helpers:
 *
 *   applyHaikuFallback() — when Haiku returns source='haiku_unavailable',
 *   optionally re-classify with the regex classifier on FULL OCR text rather
 *   than silently using the user's pick. The regex classifier on full OCR has
 *   strictly more text to score from than the quick-classify 2-page sample,
 *   so its verdict is meaningfully different from (and more reliable than)
 *   the upload-time signal.
 *
 *   applyBillParserSanityGate() — last line of defense before processBillDocument
 *   fires. Even if the resolver decided the effective type is a bill, refuse if
 *   the document is structurally an SBC — detected via the shared, hardened
 *   `scanForSbcMarkers` (11 ACA-standardized template markers). Catches the
 *   case where (a) Haiku failed, (b) regex agreed with the user's wrong pick,
 *   and (c) the bill parser would otherwise hallucinate CPT codes from SBC page
 *   numbers and addresses. NOTE: page count is deliberately NOT a signal here —
 *   legitimate EOBs/bills run long (a 16-page Kaiser EOB carries a glossary,
 *   OOP tables, and per-claim detail) while carrying ZERO SBC markers, so the
 *   prior page-count heuristic hard-rejected valid bills. SBC markers are the
 *   only reliable bill-vs-SBC discriminator (SBCs: 10/11; EOBs: 0/11 empirically).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyDocument,
  type ClassifiedDocType,
} from "@/lib/classifier";
import {
  loadClassifierFallbackConfig,
  type ClassifierFallbackConfig,
} from "@/lib/config/classifier-fallback-config";
import type { HaikuClassification } from "@/lib/classifier/haiku-classify";
import {
  PICKER_TYPES,
  getDocTypeClass,
} from "@/lib/classifier/doc-type-vocabulary";
import { scanForSbcMarkers } from "@/lib/billing/sbc-marker-scan";

export {
  PICKER_TYPES,
  getDocTypeClass,
  type DocTypeClass,
} from "@/lib/classifier/doc-type-vocabulary";

const BILL_TYPES = new Set(["eob", "itemized_bill"]);

/**
 * Decide whether the upload pipeline should HALT and ask the user to confirm
 * the doc type before parsing.
 *
 * Halt fires only when ALL of:
 *   1. Both `userPick` and `classifierVerdict` are types that the 2-card upload
 *      picker can present (PICKER_TYPES). If the classifier returned 'other',
 *      'insurance_card', 'eoc', or another type the picker doesn't render, the
 *      modal can't show a meaningful choice — we skip the halt and let
 *      downstream safety nets (B4 SBC marker scan + `isHealthcareDocument`
 *      check + bill-parser sanity gate) handle it.
 *   2. Their equivalence classes differ (bill vs plan_doc). Intra-class
 *      disagreement (user=plan_document + classifier=sbc) is not user-
 *      actionable because both route through unified_plan_doc_parser_v1 in
 *      PROD — the user would see two buttons that do the same thing.
 *
 * Replaces the older `isCrossClassDisagreement` helper. The rename makes the
 * intent explicit: the function answers "should we halt?" rather than the
 * narrower "are these in different classes?" — the answer is "no" in cases
 * where classes differ but one side is non-picker-renderable (e.g., 'other').
 *
 * See `scripts/test-shouldHaltForUserConfirmation.ts` for the test matrix
 * including the false-positive cases this version closes.
 */
export function shouldHaltForUserConfirmation(
  userPick: string | null | undefined,
  classifierVerdict: string | null | undefined,
): boolean {
  if (!userPick || !classifierVerdict) return false;
  if (!PICKER_TYPES.has(userPick)) return false;
  if (!PICKER_TYPES.has(classifierVerdict)) return false;
  return getDocTypeClass(userPick) !== getDocTypeClass(classifierVerdict);
}

export interface HaikuFallbackResult {
  classification: HaikuClassification;
  /** Set when the regex classifier overrode the haiku_unavailable verdict. */
  fellBackToRegex: boolean;
  /** The config that was loaded (cached so callers can reuse it). */
  config: ClassifierFallbackConfig;
}

/**
 * If the Haiku classifier was unavailable AND the flag is on, re-run the regex
 * classifier on the FULL OCR text and return its verdict in place of the user's
 * pick. Otherwise pass the original classification through unchanged.
 */
export async function applyHaikuFallback(args: {
  supabase: SupabaseClient;
  classification: HaikuClassification;
  ocrText: string;
  fileName: string;
  userType: string;
}): Promise<HaikuFallbackResult> {
  const { supabase, classification, ocrText, fileName, userType } = args;
  const config = await loadClassifierFallbackConfig(supabase);

  if (
    classification.source !== "haiku_unavailable" ||
    !config.enabled ||
    config.haiku_failure_fallback !== "regex"
  ) {
    return { classification, fellBackToRegex: false, config };
  }

  const regex = classifyDocument({
    text: ocrText,
    fileName,
    userSelectedType: userType,
  });

  if (regex.confidence === 0) {
    return { classification, fellBackToRegex: false, config };
  }

  console.log(
    `[classifier-fallback] Haiku unavailable; regex on full OCR → ${regex.classifiedType}@${regex.confidence.toFixed(2)} (user pick was ${userType})`,
  );

  return {
    classification: {
      classifiedType: regex.classifiedType as ClassifiedDocType as HaikuClassification["classifiedType"],
      confidence: regex.confidence,
      isHealthcareDocument: regex.classifiedType !== "other",
      source: "haiku_unavailable",
    },
    fellBackToRegex: true,
    config,
  };
}

export interface SanityGateVerdict {
  blocked: boolean;
  reason: string | null;
  matchedSbcPhrases: string[];
  pageCount: number | null;
}

/**
 * Refuse to run the bill parser if the document is structurally an SBC.
 * Triggered when effectiveType is in BILL_TYPES and the flag is enabled.
 *
 * Blocks ONLY on positive SBC structural evidence — `scanForSbcMarkers` (the
 * shared, hardened detector: 11 ACA-standardized template markers). Blocks when
 * >= `config.sanity_gate_sbc_phrase_count` markers match (default 2; multi-marker
 * agreement is hard to explain away as noise).
 *
 * Page count is deliberately NOT a signal. The prior heuristic (pageCount >=
 * min_pages OR phrase_count) hard-rejected legitimately long bills/EOBs — a
 * 16-page Kaiser EOB (glossary + OOP tables + per-claim detail) carries ZERO SBC
 * markers yet tripped the page-count arm. Empirically (7 real SBC fixtures + a
 * real EOB): SBCs match 10/11 markers regardless of length (8–370 pp); EOBs
 * match 0/11. `matchedSbcPhrases` now carries the matched marker NAMES.
 *
 * This unifies the gate with the parser-side `scanForSbcMarkers` defense in
 * `haiku-bill-parser.ts` — one detector, no divergent SBC lists.
 *
 * Caller is responsible for translating a blocked verdict into the appropriate
 * documents row update + user-visible error.
 */
export async function applyBillParserSanityGate(args: {
  config: ClassifierFallbackConfig;
  effectiveType: string;
  ocrText: string;
  pageCount: number | null;
}): Promise<SanityGateVerdict> {
  const { config, effectiveType, ocrText, pageCount } = args;

  if (!BILL_TYPES.has(effectiveType)) {
    return { blocked: false, reason: null, matchedSbcPhrases: [], pageCount };
  }

  if (!config.enabled || !config.sanity_gate_enabled) {
    return { blocked: false, reason: null, matchedSbcPhrases: [], pageCount };
  }

  const scan = scanForSbcMarkers(ocrText, config.sanity_gate_sbc_phrase_count);

  if (!scan.isLikelySbc) {
    return {
      blocked: false,
      reason: null,
      matchedSbcPhrases: scan.matchedMarkers,
      pageCount,
    };
  }

  const reason = `Document looks like an SBC, not a bill (${scan.matchedMarkers.length}/${scan.totalMarkersChecked} SBC markers: ${scan.matchedMarkers.join(", ")}). Please re-upload using the "Plan summary" card, or upload an itemized bill / EOB instead.`;

  return {
    blocked: true,
    reason,
    matchedSbcPhrases: scan.matchedMarkers,
    pageCount,
  };
}

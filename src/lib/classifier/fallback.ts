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
 *   fires. Even if the resolver decided the effective type is a bill, refuse
 *   if the document has too many pages OR matches too many SBC-specific
 *   phrases. Catches the case where (a) Haiku failed, (b) regex agreed with
 *   the user's wrong pick, and (c) the bill parser would otherwise hallucinate
 *   CPT codes from SBC page numbers and addresses.
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

const BILL_TYPES = new Set(["eob", "itemized_bill"]);

/**
 * Doc-type equivalence classes for confirmation-modal eligibility.
 *
 * The 2-card upload picker presents the user with "Bill" and "Plan Document"
 * — and "Plan Document" intentionally encompasses sbc, eoc, plan_document,
 * and employer_plan_booklet. Because unified_plan_doc_parser_v1 routes all
 * plan-doc-class verdicts through the same parser in PROD, an intra-class
 * disagreement (e.g., user=plan_document + regex=sbc) is meaningless to the
 * user and would just produce confusing "What is this?" modals that ask them
 * to choose between two buttons that do the same thing downstream.
 *
 * The confirmation halt + modal should ONLY fire for CROSS-class disagreement:
 *   - user=bill + regex=sbc/eoc/plan_document  (the original S94 B5 trigger)
 *   - user=plan_document + regex=eob/itemized_bill  (the inverse)
 *
 * The bill-parser sanity gate is unaffected — it triggers on document content
 * (page count, SBC phrases) regardless of which class the resolver picked.
 */
export type DocTypeClass = "bill" | "plan_doc" | "card" | "other";

export function getDocTypeClass(type: string | null | undefined): DocTypeClass {
  if (type === "eob" || type === "itemized_bill") return "bill";
  if (
    type === "sbc" ||
    type === "plan_document" ||
    type === "eoc" ||
    type === "employer_plan_booklet" ||
    type === "plan_cert_summary"
  ) {
    return "plan_doc";
  }
  if (type === "insurance_card") return "card";
  return "other";
}

export function isCrossClassDisagreement(
  userPick: string | null | undefined,
  classifierVerdict: string | null | undefined,
): boolean {
  return getDocTypeClass(userPick) !== getDocTypeClass(classifierVerdict);
}

// SBC-specific phrases with high specificity. These appear on the standardized
// CMS template and are extremely unlikely to appear on an itemized bill or EOB.
// Each entry is a regex tested against OCR text; matches contribute to the
// sanity gate's phrase count.
const SBC_HIGH_SPECIFICITY_PHRASES: RegExp[] = [
  /summary\s+of\s+benefits\s+and\s+coverage/i,
  /common\s+medical\s+events?/i,
  /excluded\s+services?\s*(?:&|and)\s*other\s+covered\s+services/i,
  /services\s+you\s+may\s+need/i,
  /what\s+you\s+will\s+pay/i,
  /minimum\s+essential\s+coverage/i,
  /minimum\s+value\s+standard/i,
  /coverage\s+examples?/i,
  /the\s+plan\s+would\s+be\s+responsible/i,
  /total\s+example\s+cost/i,
];

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
 * Refuse to run the bill parser if the document looks structurally like an SBC.
 * Triggered when effectiveType is in BILL_TYPES and the flag is enabled. Two
 * independent OR-gated conditions:
 *   - pageCount >= config.sanity_gate_min_pages (default 10) — bills are
 *     typically 1-3 pages; 10+ pages is a strong contradiction.
 *   - matched SBC phrase count >= config.sanity_gate_sbc_phrase_count
 *     (default 2) — multi-phrase agreement is hard to explain away as noise.
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

  const matchedPhrases: string[] = [];
  for (const pattern of SBC_HIGH_SPECIFICITY_PHRASES) {
    const m = ocrText.match(pattern);
    if (m) matchedPhrases.push(m[0]);
  }

  const pageCountTrips =
    typeof pageCount === "number" && pageCount >= config.sanity_gate_min_pages;
  const phraseCountTrips =
    matchedPhrases.length >= config.sanity_gate_sbc_phrase_count;

  if (!pageCountTrips && !phraseCountTrips) {
    return {
      blocked: false,
      reason: null,
      matchedSbcPhrases: matchedPhrases,
      pageCount,
    };
  }

  const tripped: string[] = [];
  if (pageCountTrips) tripped.push(`pageCount=${pageCount} >= ${config.sanity_gate_min_pages}`);
  if (phraseCountTrips) {
    tripped.push(
      `sbc_phrases=${matchedPhrases.length} >= ${config.sanity_gate_sbc_phrase_count}`,
    );
  }

  const reason = `Document looks like an SBC, not a bill (${tripped.join(", ")}). Please re-upload using the "Plan summary" card, or upload an itemized bill / EOB instead.`;

  return {
    blocked: true,
    reason,
    matchedSbcPhrases: matchedPhrases,
    pageCount,
  };
}

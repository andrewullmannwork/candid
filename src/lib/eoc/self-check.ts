/**
 * Verbatim self-check loop for EOC Pattern P-8 source_excerpt fields per
 * Phase 3.1A.1 Subplan + DR-3.1A.1-B-4 LOCK.
 *
 * Iteration-2 contingency. Fires when env var `EOC_SELF_CHECK_ENABLED=true`.
 *
 * Flow:
 *   1. Walk EOCParseResult tree; find fields with source_excerpt_verified='not_found'
 *      AND non-empty source_excerpt (Haiku tried; verifier rejected).
 *   2. For each: re-prompt Haiku with the section text + failed excerpt + corrective
 *      instruction. Haiku returns either a corrected verbatim substring OR empty
 *      ("cannot quote verbatim").
 *   3. Replace source_excerpt with corrected value. Caller re-runs verifier to
 *      refresh source_excerpt_verified + source_section_verified.
 *
 * Cost containment: only fires on verifier failures (~5-15 per EOC at v1 baseline);
 * each call is small (~500-2000 input tokens + tiny output). Estimated +$0.02-0.05/EOC.
 *
 * NO new feature flag, NO new migration — env var only during iteration; production
 * default state hardcoded at session close per DR-3.1A.1-B-4.
 */

import { callHaikuWithCache } from "./haiku-prompts/_shared";
import type { SectionRanges } from "../parser/types";
import type { EOCParseResult, EOCSectionHint, PatternP8Provenance } from "./types";

const SELF_CHECK_SYSTEM_PROMPT = `You are correcting a source_excerpt that failed verbatim verification. The previously-emitted excerpt is NOT a character-for-character substring of the source text. Either:
  (a) Emit a CORRECTED verbatim ≤200-char substring that appears EXACTLY in the source text below.
  (b) Confirm you cannot quote verbatim by returning empty string "".

Return ONLY this JSON object (no preamble, no markdown fences):
{
  "corrected_excerpt": "<verbatim substring OR empty string>",
  "haiku_confidence": <0.0-1.0>
}`;

interface SelfCheckResponse {
  corrected_excerpt?: string;
  haiku_confidence?: number;
}

interface OneCheckResult {
  corrected: string;
  confidence: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  warnings: string[];
}

async function selfCheckOne(failedExcerpt: string, sectionText: string): Promise<OneCheckResult> {
  const userContent = `Failed excerpt:\n"${failedExcerpt}"\n\nSource text section:\n${sectionText}`;
  const result = await callHaikuWithCache<SelfCheckResponse>({
    systemPrompt: SELF_CHECK_SYSTEM_PROMPT,
    userContent,
    sectionLabel: "self_check",
  });
  return {
    corrected: typeof result.data.corrected_excerpt === "string" ? result.data.corrected_excerpt.slice(0, 200) : "",
    confidence: typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : 0,
    cost: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    warnings: result.warnings,
  };
}

export interface SelfCheckSummary {
  warnings: string[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  attemptedCount: number;
  recoveredCount: number;
  confirmedEmptyCount: number;
  stillFailedCount: number;
}

export function isSelfCheckEnabled(): boolean {
  return process.env.EOC_SELF_CHECK_ENABLED === "true";
}

/**
 * Walk the verified EOCParseResult tree and self-check each 'not_found' excerpt.
 * Mutates the result in-place with corrected excerpts; caller re-runs verifier
 * (verifyEOCSourceExcerpts) to refresh verified flags.
 *
 * Cost included in result.total_cost_usd. Hard cap check left to caller.
 */
export async function selfCheckExcerpts(
  preliminaryResult: EOCParseResult,
  rawDocText: string,
  sectionRanges: SectionRanges,
): Promise<{ updatedResult: EOCParseResult; summary: SelfCheckSummary }> {
  const summary: SelfCheckSummary = {
    warnings: [],
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    attemptedCount: 0,
    recoveredCount: 0,
    confirmedEmptyCount: 0,
    stillFailedCount: 0,
  };

  // Deep clone sections to avoid mutating caller input.
  const sections: EOCParseResult["sections"] = JSON.parse(JSON.stringify(preliminaryResult.sections));

  const getSectionText = (hint: EOCSectionHint): string | null => {
    const ranges = sectionRanges[hint];
    if (!ranges || ranges.length === 0) return null;
    const r = ranges[0];
    return rawDocText.slice(r.start, r.end);
  };

  const correctOne = async (
    item: PatternP8Provenance & { haiku_confidence?: number },
    sectionText: string,
    fieldPath: string,
  ): Promise<void> => {
    if (item.source_excerpt_verified !== "not_found" || !item.source_excerpt) return;
    summary.attemptedCount++;
    try {
      const sc = await selfCheckOne(item.source_excerpt, sectionText);
      summary.totalCostUsd += sc.cost;
      summary.totalInputTokens += sc.inputTokens;
      summary.totalOutputTokens += sc.outputTokens;
      summary.warnings.push(...sc.warnings);

      if (sc.corrected === "") {
        item.source_excerpt = "";
        item.haiku_confidence = sc.confidence;
        summary.warnings.push(`self_check_confirmed_empty:${fieldPath}`);
        summary.confirmedEmptyCount++;
      } else if (rawDocText.includes(sc.corrected)) {
        item.source_excerpt = sc.corrected;
        item.haiku_confidence = sc.confidence;
        summary.warnings.push(`self_check_recovered:${fieldPath}`);
        summary.recoveredCount++;
      } else {
        summary.warnings.push(`self_check_still_failed:${fieldPath}`);
        summary.stillFailedCount++;
      }
    } catch (err) {
      summary.warnings.push(`self_check_error:${fieldPath}:${err instanceof Error ? err.message : String(err)}`);
      summary.stillFailedCount++;
    }
  };

  // Array sections
  if (sections.prior_auth_codes) {
    const text = getSectionText("prior_auth_codes");
    if (text) {
      for (let i = 0; i < sections.prior_auth_codes.data.codes.length; i++) {
        await correctOne(sections.prior_auth_codes.data.codes[i], text, `prior_auth_codes[${i}]`);
      }
    }
  }
  if (sections.medical_necessity) {
    const text = getSectionText("medical_necessity");
    if (text) {
      for (let i = 0; i < sections.medical_necessity.data.criteria.length; i++) {
        await correctOne(sections.medical_necessity.data.criteria[i], text, `medical_necessity[${i}]`);
      }
    }
  }
  if (sections.definitions) {
    const text = getSectionText("definitions");
    if (text) {
      for (let i = 0; i < sections.definitions.data.definitions.length; i++) {
        await correctOne(sections.definitions.data.definitions[i], text, `definitions[${i}]`);
      }
    }
  }

  // Single-block sections
  if (sections.appeals_procedures) {
    const text = getSectionText("appeals_procedures");
    if (text) await correctOne(sections.appeals_procedures.data, text, "appeals_procedures");
  }
  if (sections.cob_rules) {
    const text = getSectionText("cob_rules");
    if (text) await correctOne(sections.cob_rules.data, text, "cob_rules");
  }
  if (sections.eligibility_rules) {
    const text = getSectionText("eligibility_rules");
    if (text) await correctOne(sections.eligibility_rules.data, text, "eligibility_rules");
  }

  const updatedResult: EOCParseResult = {
    ...preliminaryResult,
    sections,
    warnings: [...preliminaryResult.warnings, ...summary.warnings],
    total_cost_usd: preliminaryResult.total_cost_usd + summary.totalCostUsd,
    total_input_tokens: preliminaryResult.total_input_tokens + summary.totalInputTokens,
    total_output_tokens: preliminaryResult.total_output_tokens + summary.totalOutputTokens,
  };

  return { updatedResult, summary };
}

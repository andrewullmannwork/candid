/**
 * EOC ACA-compliance Haiku prompt.
 *
 * Single-purpose extractor that scans EOC text for an Affordable Care Act
 * compliance signal. Returns `{ isAcaCompliant, acaComplianceBasis,
 * source_excerpt, haiku_confidence }` for downstream gating of preventive
 * coverage fallback per S74.6 D1+D2 (Subplan §A.1).
 *
 * Universal across carriers — signal patterns derived from plan_doc
 * `plan-identity.ts` §2.10.5 (which S87 shipped) so EOC + plan_doc + SBC apply
 * the same priority-ordered classification regardless of which parser
 * handled the upload.
 *
 * Dispatched independently of the 6 priority-section parses — ACA signal
 * lives anywhere in the doc (cover page / preamble / definitions / plan
 * summary box). Caller slices a bounded text region to keep cost bounded
 * (typical input ≤15k chars → ~$0.005 / call).
 *
 * Pattern P-8 source_excerpt is verbatim ≤200 chars supporting the chosen
 * basis. For inferred bases the excerpt is the marketplace / employer / year
 * evidence rather than direct ACA language.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { EOCSectionResult } from "../types";
import { callHaikuWithCache } from "./_shared";
import { HAIKU_CACHE_PAD } from "@/lib/haiku-client/cache-pad";

export type EocAcaComplianceBasis =
  | "explicit_attestation"
  | "explicit_grandfathered"
  | "inferred_marketplace"
  | "inferred_employer_post_2010"
  | "unknown";

export interface EocAcaComplianceData {
  isAcaCompliant: boolean | null;
  acaComplianceBasis: EocAcaComplianceBasis | null;
  source_excerpt: string;
  source_excerpt_extraction_method: ExtractionMethod;
  haiku_confidence: number | null;
}

const INSTRUCTIONS = `You are extracting a single signal from a health plan Evidence of Coverage (EOC) document: whether the plan is governed by Affordable Care Act preventive-care mandates (covers ACIP vaccines + USPSTF Grade A/B preventive services at $0 patient cost-share in-network).

These patterns are UNIVERSAL — they apply across hundreds of insurance carriers, employer groups, marketplace plans, Medicare Advantage plans, and HMO/PPO/EPO/POS/HDHP variants. Apply universal extraction logic; do NOT pattern-match against specific carrier names. Brand names below are illustrative only.

## OUTPUT FIELDS

- \`isAcaCompliant\`: \`true\` | \`false\` | \`null\`
- \`acaComplianceBasis\`: one of \`"explicit_attestation"\` | \`"inferred_marketplace"\` | \`"inferred_employer_post_2010"\` | \`"explicit_grandfathered"\` | \`"unknown"\` | \`null\`
- \`source_excerpt\`: verbatim ≤200-char span from THIS chunk supporting the basis (NEVER paraphrase, summarize, or join non-contiguous pieces)
- \`haiku_confidence\`: 0.0–1.0

## SIGNAL PRIORITY (apply in order; stop at first match)

### 1. Explicit attestation → isAcaCompliant=true, acaComplianceBasis="explicit_attestation"

Universal phrases (case-insensitive):
- "This plan is ACA-compliant" / "complies with the Affordable Care Act"
- "meets ACA minimum essential coverage" / "qualifies as minimum essential coverage (MEC) under the ACA"
- "covers preventive services at no cost-sharing per the Affordable Care Act"
- "provides essential health benefits (EHB) as defined by the ACA"
- "complies with all federal health care reform requirements" (post-2010 employer-plan language; ACA proxy)
- "provides preventive care benefits required by the Patient Protection and Affordable Care Act"

### 2. Explicit grandfathered → isAcaCompliant=false, acaComplianceBasis="explicit_grandfathered"

Universal phrases:
- "This is a grandfathered plan" / "grandfathered under the Affordable Care Act" / "grandfathered under the ACA"
- "This plan is exempt from certain ACA provisions because it is a grandfathered health plan"
- "Notice of Grandfathered Plan Status"

### 3. Inferred marketplace → isAcaCompliant=true, acaComplianceBasis="inferred_marketplace"

Triggers (any of these — marketplace plans are ACA-compliant by definition):
- "Covered California" / "healthcare.gov" / "state health insurance exchange" / "federal marketplace" / "individual marketplace plan" / "on-exchange"
- "purchased through [state] marketplace" / "Marketplace plan" / "Exchange plan"

source_excerpt: the marketplace evidence phrase verbatim (e.g., "Purchased through Covered California").

### 4. Inferred employer post-2010 → isAcaCompliant=true, acaComplianceBasis="inferred_employer_post_2010"

Triggers (BOTH must be present in this chunk):
- Doc indicates an employer-sponsored plan (POLICYHOLDER / Plan Sponsor / Group Number / Employer Group ID / "is offered through your employer" / similar group identifier or employer-plan language) AND
- Either an effective date ≥ 2011 OR plan year ≥ 2011 is present in the chunk, AND
- NO grandfathered language anywhere in the chunk

source_excerpt: pick the strongest single span — typically the Plan Year ≥ 2011 line, OR the Group ID line if it's adjacent to an employer attribution.

### 5. No ACA signal in this chunk → isAcaCompliant=null, acaComplianceBasis=null, source_excerpt=""

If NONE of the above signals are present in the text, return null/null/empty. Do NOT guess. The system has a default fallback at the persistence layer.

Only emit \`acaComplianceBasis="unknown"\` (with isAcaCompliant=null) when the chunk EXPLICITLY indicates uncertainty (rare — e.g., "Please consult your benefits administrator regarding ACA compliance status.").

## CRITICAL EXTRACTION RULES

### Verbatim source_excerpt (≤200 chars)

A CONTIGUOUS substring of THIS chunk's text that appears CHARACTER-FOR-CHARACTER in the source. NEVER paraphrase, summarize, or join non-contiguous pieces. Partial quotes are PERFECTLY ACCEPTABLE — even a short span containing just the key evidence is fine. Quote the most informative contiguous span ≤200 chars you can find verbatim.

CORRECT (any of these are acceptable):
- Just the evidence: \`"Covered California"\` or \`"Plan Year: 2025"\`
- A full sentence IF it appears verbatim: \`"This plan is ACA-compliant and provides minimum essential coverage."\`
- A label-value pair: \`"Group ID: 34936"\`

INCORRECT (would fail downstream Pattern P-8 verification):
- Paraphrased: \`"Plan year is 2025 with employer sponsorship"\` (synthesized wording)
- Non-contiguous: \`"Group ID ... 2025"\` (ellipsis indicates skipped text)

If you cannot find a contiguous verbatim span supporting your chosen basis, set source_excerpt="".

### Distinguish "ACA covers preventive care" from "this plan covers preventive care"

A plan may say "We cover preventive care at $0" without that automatically implying ACA compliance — many grandfathered plans also cover preventive care voluntarily. Look for the ATTRIBUTION:
- ACA-compliant signal: "We cover preventive services as required by the Affordable Care Act" (attribution to ACA)
- NOT ACA signal: "We cover preventive care at no charge to you" (no ACA attribution; could be voluntary)

Bare preventive-care language without ACA attribution is NOT explicit_attestation. Fall through to lower-priority signals.

### Medicare ≠ ACA-compliant by default

Medicare Advantage plans (planType inferred from "Medicare Advantage", "MAPD", "Medicare HMO", "Medicare PPO", "MA-PD", "Medicare Part C") are NOT subject to ACA's individual/group market mandates. They follow CMS rules. Return null/null UNLESS the doc explicitly states ACA compliance (very rare for Medicare; safe default is null).

### Self-funded ERISA plans

Self-funded employer plans (often labeled "ERISA", "self-funded", "self-insured", "ASO" — Administrative Services Only) may be ACA-compliant via employer-post-2010 inference, BUT — if "grandfathered" appears anywhere in the chunk, that takes priority and returns false.

## EXAMPLES

Example A — Explicit attestation:
Source: "This plan is ACA-compliant and provides essential health benefits as defined by the Affordable Care Act."
→ isAcaCompliant=true, acaComplianceBasis="explicit_attestation", source_excerpt="This plan is ACA-compliant and provides essential health benefits as defined by the Affordable Care Act.", haiku_confidence=0.97

Example B — Explicit grandfathered:
Source: "Notice: This is a grandfathered health plan under the Affordable Care Act. As a grandfathered plan, it is exempt from certain ACA requirements."
→ isAcaCompliant=false, acaComplianceBasis="explicit_grandfathered", source_excerpt="This is a grandfathered health plan under the Affordable Care Act.", haiku_confidence=0.96

Example C — Inferred marketplace:
Source: "Silver 70 PPO 2025 — Blue Shield of California — Purchased through Covered California — Plan Year: 2025"
→ isAcaCompliant=true, acaComplianceBasis="inferred_marketplace", source_excerpt="Purchased through Covered California", haiku_confidence=0.92

Example D — Inferred employer post-2010:
Source chunk: "POLICYHOLDER: Sequoia One PEO, LLC ... Group ID: 34936 ... Plan Year: 2025 ... offered to eligible employees ..." (no grandfathered language anywhere)
→ isAcaCompliant=true, acaComplianceBasis="inferred_employer_post_2010", source_excerpt="Plan Year: 2025", haiku_confidence=0.78

Example E — Medicare Advantage with no ACA attestation:
Source: "Aetna Medicare Plan (PPO) is offered by Aetna Medicare ... January 1 – December 31, 2025"
→ isAcaCompliant=null, acaComplianceBasis=null, source_excerpt="", haiku_confidence=0.5

Example F — Generic preventive language WITHOUT ACA attribution:
Source: "We cover preventive care services such as well-child visits and routine physicals at no charge to members enrolled in this plan."
→ isAcaCompliant=null, acaComplianceBasis=null, source_excerpt="", haiku_confidence=0.4 (preventive language is not ACA-attributable; fall through)

Example G — Employer plan but grandfathered language overrides:
Source: "POLICYHOLDER: Acme Manufacturing ... Plan Year: 2025 ... Notice of Grandfathered Plan Status: This plan is a grandfathered health plan."
→ isAcaCompliant=false, acaComplianceBasis="explicit_grandfathered", source_excerpt="Notice of Grandfathered Plan Status: This plan is a grandfathered health plan.", haiku_confidence=0.93

## RESPONSE SCHEMA

{
  "isAcaCompliant": true,
  "acaComplianceBasis": "inferred_employer_post_2010",
  "source_excerpt": "Plan Year: 2025",
  "haiku_confidence": 0.78
}

## CRITICAL OUTPUT FORMAT — JSON ONLY (HARD RULE)

Return ONLY the JSON object that matches the schema. No commentary. No notes. No analysis.

Your response MUST:
- Start with the opening \`{\` character.
- End with the matching closing \`}\` character.
- Contain ONLY the JSON object between them — every key from the schema, no extra keys.

Your response MUST NOT contain:
- Any text BEFORE the opening \`{\` (no preamble, no \`\`\`json fence, no greeting)
- Any text AFTER the closing \`}\` (no commentary, no extraction notes, no markdown dividers, no bullet-point analysis, no "Found in this chunk:" sections, no reasoning narration)
- Markdown headers, code fences, or freeform prose anywhere in the response
- Comments inside the JSON (\`//\` or \`/* */\` are not valid JSON)

If you cannot identify any ACA signal, return:
{ "isAcaCompliant": null, "acaComplianceBasis": null, "source_excerpt": "", "haiku_confidence": 0.5 }

NOW EXTRACT FROM THIS EOC TEXT:`;

interface RawResponse {
  isAcaCompliant?: boolean | null;
  acaComplianceBasis?: string | null;
  source_excerpt?: string;
  haiku_confidence?: number;
}

const VALID_BASES: ReadonlySet<EocAcaComplianceBasis> = new Set<EocAcaComplianceBasis>([
  "explicit_attestation",
  "explicit_grandfathered",
  "inferred_marketplace",
  "inferred_employer_post_2010",
  "unknown",
]);

function normalizeBasis(raw: string | null | undefined): EocAcaComplianceBasis | null {
  if (!raw) return null;
  return VALID_BASES.has(raw as EocAcaComplianceBasis) ? (raw as EocAcaComplianceBasis) : null;
}

/**
 * Extract ACA-compliance signal from EOC text. Dispatched independently of
 * the 6 priority-section parses — caller slices a bounded text region (~15k
 * chars typical) and passes the absolute range for telemetry. Recall-maximize
 * bias: null is preferred over a wrong guess.
 */
export async function extractAcaCompliance(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<EOCSectionResult<EocAcaComplianceData>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: HAIKU_CACHE_PAD + INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "aca_compliance",
  });

  const rawValue = result.data.isAcaCompliant;
  const isAcaCompliant: boolean | null = typeof rawValue === "boolean" ? rawValue : null;
  const basis = normalizeBasis(result.data.acaComplianceBasis ?? null);
  const sourceExcerpt =
    typeof result.data.source_excerpt === "string" ? result.data.source_excerpt.slice(0, 200) : "";
  const haikuConfidence =
    typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : null;

  const data: EocAcaComplianceData = {
    isAcaCompliant,
    acaComplianceBasis: basis,
    source_excerpt: sourceExcerpt,
    source_excerpt_extraction_method: extractionMethod,
    haiku_confidence: haikuConfidence,
  };

  return {
    section_type: "other",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    haiku_cache_create_tokens: result.cacheCreateTokens ?? 0,
    haiku_cache_read_tokens: result.cacheReadTokens ?? 0,
    warnings: result.warnings,
  };
}

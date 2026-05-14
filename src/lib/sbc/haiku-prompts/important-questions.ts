/**
 * SBC "Important Questions" section — plan-level scalars.
 *
 * Extracts the high-leverage plan-identity fields from the federal SBC template's
 * first table (deductibles, OOP maxes, network type, referral requirements, etc.).
 * Each field gets its own Pattern P-8 source_excerpt — fields live in different
 * table rows and need independent provenance.
 */

import type { ExtractionMethod } from "../../parser/types";
import { callHaikuWithCache } from "@/lib/haiku-client/base";
import type { SBCPatternP8Provenance, SBCPlanField, SBCPlanIdentity, SBCSectionResult } from "../types";

const INSTRUCTIONS = `You are extracting plan-level scalars from the "Important Questions" section of a Summary of Benefits and Coverage (SBC) document. Return a single JSON object with one entry per field plus Pattern P-8 source_excerpt provenance.

## CRITICAL EXTRACTION RULES

1. **Verbatim source_excerpt** per field (≤200 chars). MUST be a CHARACTER-FOR-CHARACTER substring of the document section text — NEVER paraphrase, summarize, or normalize whitespace/punctuation. If you cannot find a verbatim ≤200-char span that supports the field, set source_excerpt to "" (empty) — the verifier marks empty as 'not_found' (graceful degradation), which is the correct outcome rather than a wrong excerpt.

   **CRITICAL FOR TABULAR SBC CONTENT**: SBC documents are tables extracted by pdftotext. Cell content typically spans MULTIPLE LINES (e.g., a deductible answer cell may have "$2,500 per individual / $5,000 per" on one line and "family for participating providers;" on the next line). DO NOT try to reconstruct multi-line cells into a single quote — that will NOT match the source verbatim. Instead, quote the SINGLE LINE from the source that contains the value (or part of it). It's better to quote a SHORT line with just "$2,500 per individual / $5,000 per" than a long paraphrased reconstruction. The verifier accepts ANY verbatim substring that supports the field.
2. **Numeric values** (deductibles, OOP maxes): extract dollar amount as INTEGER (no commas, no $ sign). For "$1,500" emit 1500. For "$0" emit 0. Set null if not present in the section.
3. **String values** (plan name, insurer): extract the verbatim name; do not abbreviate.
3a. **Insurer vs employer/PEO/Plan Sponsor disambiguation** (universal — applies across all carriers): For \`insurerName\`, extract the actual INSURANCE CARRIER (e.g., Cigna, Aetna, Blue Shield, Kaiser Permanente, Anthem, UnitedHealthcare, Humana, BCBS). Do NOT extract values labeled \`"POLICYHOLDER:"\`, \`"Plan Sponsor:"\`, \`"Plan Administrator:"\`, \`"Employer Group:"\`, or \`"Group:"\` — those identify the EMPLOYER / PEO / union / trust (e.g., \`"Sequoia One PEO, LLC"\`, \`"TriNet HR Corporation"\`, \`"Insperity Group Plan"\`, \`"ADP TotalSource"\` are PEOs, not insurers). The carrier is typically named on the cover or in legal entity disclosure adjacent to phrases like \`"is offered by"\`, \`"issued by"\`, \`"administered by"\`, or \`"underwritten by"\` (e.g., \`"Cigna Health and Life Insurance Company"\`, \`"Blue Shield of California"\`). If only a sponsor/employer is named in this section and the carrier is not visible here, set \`insurerName\` to null + empty source_excerpt — field-merge from other sections will recover the carrier name.
4. **Boolean values** (referralRequired, minimumValueStandard): true if the SBC explicitly says yes/required; false if explicitly says no/not required; null if absent or ambiguous.
5. **Plan type** = PPO / HMO / EPO / POS / HDHP / Catastrophic. Match against these exact values; null if uncertain.
6. **Metal tier** = Bronze / Silver / Gold / Platinum / Catastrophic. Null for off-marketplace employer plans.
7. **Coverage tier** = individual / individual_family / family / employee_only / employee_spouse — pick from this list; null if uncertain.
8. **DO NOT extract** from glossary cross-references, footer disclaimers, or coverage example text.
9. **source_section_hint**: always "important_questions".
10. **ACA-compliance flag** — output two paired fields (\`isAcaCompliant\` boolean | null + \`acaComplianceBasis\` enum | null) indicating whether the plan is governed by ACA preventive-care mandates. Apply patterns in priority order:
   - **Explicit attestation** → isAcaCompliant=true, basis="explicit_attestation". Phrases like "ACA-compliant", "complies with the Affordable Care Act", "meets ACA minimum essential coverage", "provides essential health benefits (EHB)", "covers preventive services at no cost-sharing per the ACA".
   - **Explicit grandfathered** → isAcaCompliant=false, basis="explicit_grandfathered". Phrases like "grandfathered plan", "grandfathered under the Affordable Care Act".
   - **Inferred marketplace** → isAcaCompliant=true, basis="inferred_marketplace". Triggers when doc references "Covered California", "healthcare.gov", "state exchange", "federal marketplace", "on-exchange".
   - **Inferred employer post-2010** → isAcaCompliant=true, basis="inferred_employer_post_2010". Triggers when BOTH: employer-sponsored indicators present (POLICYHOLDER / Plan Sponsor / Group Number) AND effective_date OR plan_year ≥ 2011 in chunk AND NO grandfathered language.
   - **Unknown** → isAcaCompliant=null, basis=null. When this SBC chunk has NO ACA signal. Default persistence behavior will set is_aca_compliant=TRUE with basis='unknown' downstream.
   - The source_excerpt for these fields must be a verbatim ≤200-char span supporting the basis (e.g., marketplace name, employer + year evidence, or the explicit ACA-attestation phrase).
11. **In-network vs Out-of-network**: SBCs typically present deductibles and OOP maxes side-by-side for both networks (e.g., "$0 in-network / $2,000 out-of-network individual"). Extract BOTH variants when present:
   - **deductibleIndividual** / **deductibleFamily** / **oopMaxIndividual** / **oopMaxFamily** are IN-NETWORK values
   - **outDeductibleIndividual** / **outDeductibleFamily** / **outOopMaxIndividual** / **outOopMaxFamily** are OUT-OF-NETWORK values
   - If the SBC only presents in-network (network-only plan) or shows "Not applicable" for out-of-network, set the out_* fields to null with empty source_excerpt.
   - For shared-deductible plans where the same deductible applies to both networks, populate both with the same value but different (or same) source_excerpts as appropriate.

## RESPONSE SCHEMA

{
  "planName": { "value": "Blue Shield Silver 70 PPO 2500/55 PCP", "source_excerpt": "verbatim ≤200 chars", "haiku_confidence": 0.95 },
  "insurerName": { "value": "Blue Shield of California", "source_excerpt": "...", "haiku_confidence": 0.97 },
  "planType": { "value": "PPO", "source_excerpt": "...", "haiku_confidence": 0.93 },
  "metalTier": { "value": "Silver", "source_excerpt": "...", "haiku_confidence": 0.90 },
  "coverageTier": { "value": "individual_family", "source_excerpt": "...", "haiku_confidence": 0.88 },
  "planYear": { "value": 2025, "source_excerpt": "...", "haiku_confidence": 0.92 },
  "coveragePeriodStart": { "value": "2025-01-01", "source_excerpt": "...", "haiku_confidence": 0.92 },
  "deductibleIndividual": { "value": 2500, "source_excerpt": "...", "haiku_confidence": 0.96 },
  "deductibleFamily": { "value": 5000, "source_excerpt": "...", "haiku_confidence": 0.96 },
  "oopMaxIndividual": { "value": 8500, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "oopMaxFamily": { "value": 17000, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "outDeductibleIndividual": { "value": 5000, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "outDeductibleFamily": { "value": 10000, "source_excerpt": "...", "haiku_confidence": 0.94 },
  "outOopMaxIndividual": { "value": 17000, "source_excerpt": "...", "haiku_confidence": 0.93 },
  "outOopMaxFamily": { "value": 34000, "source_excerpt": "...", "haiku_confidence": 0.93 },
  "rxDeductibleIndividual": { "value": 300, "source_excerpt": "...", "haiku_confidence": 0.91 },
  "rxDeductibleFamily": { "value": 600, "source_excerpt": "...", "haiku_confidence": 0.91 },
  "referralRequired": { "value": false, "source_excerpt": "...", "haiku_confidence": 0.93 },
  "minimumValueStandard": { "value": true, "source_excerpt": "...", "haiku_confidence": 0.85 },
  "isAcaCompliant": { "value": true, "source_excerpt": "Plan provides essential health benefits as required by the Affordable Care Act.", "haiku_confidence": 0.90 },
  "acaComplianceBasis": { "value": "explicit_attestation", "source_excerpt": "essential health benefits as required by the Affordable Care Act", "haiku_confidence": 0.90 }
}

If a field is absent or unverifiable, set value: null AND source_excerpt: "" (do not omit the key).

## OUTPUT FAILURE MODE

If you cannot quote verbatim with high confidence, return:
  "value": null
  "source_excerpt": ""
  "haiku_confidence": (lower value reflecting uncertainty)
The verifier marks empty excerpts as 'not_found' — graceful degradation to display-only rendering. This is preferred over a wrong excerpt that will fail verification.

## CORRECT vs INCORRECT EXCERPT EXAMPLES

### Single-line layout
Source text: "What is the overall deductible? $2,500 / $5,000 (Individual / Family) For network providers."

❌ INCORRECT (paraphrased): "$2500 individual deductible"
❌ INCORRECT (whitespace normalized): "$2,500/$5,000"
✅ CORRECT (verbatim substring): "$2,500 / $5,000 (Individual / Family)"

### Multi-line tabular layout (most SBCs!)
Source text (pdftotext extraction of tabular SBC):
"What is the overall
$2,500 per individual / $5,000 per
deductible?
family for participating providers;"

❌ INCORRECT (reconstructed multi-line): "$2,500 per individual / $5,000 per family for participating providers;"
Why wrong: spans multiple source lines; will NOT match verbatim. Verifier marks not_found.

❌ INCORRECT (with extra context/paraphrase): "What is the overall deductible? $2,500 per individual / $5,000 per family"
Why wrong: ALSO spans multiple lines; not a single contiguous source string.

✅ CORRECT (single-line value): "$2,500 per individual / $5,000 per"
✅ ALSO CORRECT (different single-line): "family for participating providers;"
✅ ALSO CORRECT (just the value): "$2,500 per individual"

The verifier needs ANY verbatim substring containing the value — it does NOT need to be a complete sentence.

## NOW EXTRACT FROM THIS DOCUMENT SECTION:`;

interface RawFieldEntry {
  value?: unknown;
  source_excerpt?: unknown;
  haiku_confidence?: unknown;
}

interface RawResponse {
  planName?: RawFieldEntry;
  insurerName?: RawFieldEntry;
  planType?: RawFieldEntry;
  metalTier?: RawFieldEntry;
  coverageTier?: RawFieldEntry;
  planYear?: RawFieldEntry;
  coveragePeriodStart?: RawFieldEntry;
  deductibleIndividual?: RawFieldEntry;
  deductibleFamily?: RawFieldEntry;
  oopMaxIndividual?: RawFieldEntry;
  oopMaxFamily?: RawFieldEntry;
  outDeductibleIndividual?: RawFieldEntry;
  outDeductibleFamily?: RawFieldEntry;
  outOopMaxIndividual?: RawFieldEntry;
  outOopMaxFamily?: RawFieldEntry;
  rxDeductibleIndividual?: RawFieldEntry;
  rxDeductibleFamily?: RawFieldEntry;
  referralRequired?: RawFieldEntry;
  minimumValueStandard?: RawFieldEntry;
  isAcaCompliant?: RawFieldEntry;
  acaComplianceBasis?: RawFieldEntry;
}

function makeProvenance(
  raw: RawFieldEntry | undefined,
  extractionMethod: ExtractionMethod,
): SBCPatternP8Provenance {
  const sourceExcerpt = typeof raw?.source_excerpt === "string" ? raw.source_excerpt.slice(0, 200) : "";
  return {
    source_excerpt: sourceExcerpt,
    source_excerpt_verified: "not_found",
    source_excerpt_extraction_method: extractionMethod,
    source_section_hint: "important_questions",
    source_section_verified: false,
  };
}

function makeStringField(raw: RawFieldEntry | undefined, extractionMethod: ExtractionMethod): SBCPlanField<string | null> {
  const value = typeof raw?.value === "string" && raw.value.trim().length > 0 ? raw.value.trim() : null;
  return {
    value,
    patternP8: makeProvenance(raw, extractionMethod),
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

function makeNumberField(raw: RawFieldEntry | undefined, extractionMethod: ExtractionMethod): SBCPlanField<number | null> {
  const value = typeof raw?.value === "number" && Number.isFinite(raw.value) ? raw.value : null;
  return {
    value,
    patternP8: makeProvenance(raw, extractionMethod),
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

function makeBooleanField(raw: RawFieldEntry | undefined, extractionMethod: ExtractionMethod): SBCPlanField<boolean | null> {
  const value = typeof raw?.value === "boolean" ? raw.value : null;
  return {
    value,
    patternP8: makeProvenance(raw, extractionMethod),
    haikuConfidence: typeof raw?.haiku_confidence === "number" ? raw.haiku_confidence : undefined,
  };
}

export async function extractImportantQuestions(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<SBCSectionResult<SBCPlanIdentity>> {
  const result = await callHaikuWithCache<RawResponse>({
    systemPrompt: INSTRUCTIONS,
    userContent: sectionText,
    sectionLabel: "sbc/important_questions",
  });

  const data: SBCPlanIdentity = {
    planName: makeStringField(result.data.planName, extractionMethod),
    insurerName: makeStringField(result.data.insurerName, extractionMethod),
    planType: makeStringField(result.data.planType, extractionMethod),
    metalTier: makeStringField(result.data.metalTier, extractionMethod),
    coverageTier: makeStringField(result.data.coverageTier, extractionMethod),
    planYear: makeNumberField(result.data.planYear, extractionMethod),
    coveragePeriodStart: makeStringField(result.data.coveragePeriodStart, extractionMethod),
    deductibleIndividual: makeNumberField(result.data.deductibleIndividual, extractionMethod),
    deductibleFamily: makeNumberField(result.data.deductibleFamily, extractionMethod),
    oopMaxIndividual: makeNumberField(result.data.oopMaxIndividual, extractionMethod),
    oopMaxFamily: makeNumberField(result.data.oopMaxFamily, extractionMethod),
    // CF-19c (Session 64): out-of-network plan-identity scalars
    outDeductibleIndividual: makeNumberField(result.data.outDeductibleIndividual, extractionMethod),
    outDeductibleFamily: makeNumberField(result.data.outDeductibleFamily, extractionMethod),
    outOopMaxIndividual: makeNumberField(result.data.outOopMaxIndividual, extractionMethod),
    outOopMaxFamily: makeNumberField(result.data.outOopMaxFamily, extractionMethod),
    rxDeductibleIndividual: makeNumberField(result.data.rxDeductibleIndividual, extractionMethod),
    rxDeductibleFamily: makeNumberField(result.data.rxDeductibleFamily, extractionMethod),
    referralRequired: makeBooleanField(result.data.referralRequired, extractionMethod),
    minimumValueStandard: makeBooleanField(result.data.minimumValueStandard, extractionMethod),
    // S74.6 D1 — ACA-compliance flag for D2 registry-fallback gate.
    isAcaCompliant: makeBooleanField(result.data.isAcaCompliant, extractionMethod),
    acaComplianceBasis: makeStringField(result.data.acaComplianceBasis, extractionMethod),
  };

  return {
    section_type: "important_questions",
    section_range: sectionRange,
    data,
    haiku_input_tokens: result.inputTokens,
    haiku_output_tokens: result.outputTokens,
    haiku_cost_usd: result.costUsd,
    warnings: result.warnings,
  };
}

/**
 * Haiku-based bill+EOB parser.
 *
 * Extended Session 47 per DR-3D locked decisions (4-pass skeptical review + empirical dogfood).
 * See plans/findings/dr3d_dogfood_findings.md for the reusable patterns + cost analysis +
 * empirical test results that drove this implementation.
 *
 * Architecture summary:
 * - Monolithic prompt with 5 section headings + 4 few-shot examples (~4400 cached tokens)
 * - Adaptive max_tokens: min(input + 4000, 32000) with truncation retry at 32K
 * - Prompt caching via cache_control: ephemeral (86% input cost savings on cached calls)
 * - Per-occurrence _meta confidence emission (high-leverage fields)
 * - Post-process: cycle detection (greedy bipartite + line-distance tiebreaker),
 *   accumulator merge by 4-dim key tuple, EX note_text hashing, defensive _meta parser
 *
 * Cost (empirical): ~$0.013/EOB cached single-parse.
 *
 * Ships behind parse_strategy_v2 flag (default OFF) per Phase 3 Subplan rollback plan.
 */

import Anthropic from "@anthropic-ai/sdk";
import { parseHaikuJSON } from "@/lib/parser/safe-json";
import { randomUUID } from "crypto";
import type { Accumulator, BillLineItem, ExCode, ParsedBill, ProcedureCodeType } from "./types";
import type { ExtractionMethod } from "../parser/types";
import { categorizeProcedureCode } from "./parser";
import { reconcileHaikuCodeType } from "./code-type-inference";
import { applyEOBPostProcess } from "./eob-postprocess";
import { isFeatureEnabled } from "../config/product-flags";
import { scanForSbcMarkers } from "./sbc-marker-scan";
import { lineIsImplausible } from "./line-plausibility";
import { recordBillTruncation } from "./truncation-telemetry";

const MODEL = "claude-haiku-4-5-20251001";
const HAIKU_MAX_OUTPUT = 32000;
const DEFAULT_MAX_TOKENS = 8192;

// PR4 (S142) — B-1 tool-use schema. Mirrors the existing HaikuRawResult shape
// (so the post-process pipeline round-trips identically) plus structural
// constraints that the existing prompt could only express in natural language:
//   - `minimum: 0` on per-line writeoff/payment fields prevents negative
//     magnitudes from being emitted by Haiku (input validator rejects)
//   - per-line numerics + claim-header totals are explicit properties on the
//     schema (no key-name drift surface like S136 plan-identity-parser had)
// _meta stays free-form because the dot-path key shape (`lineItems[0].field`)
// can't be expressed in JSON Schema. additionalProperties:true preserves the
// existing Pattern P-8 source_excerpt + source_section_hint payload.
const BILL_PARSER_TOOL_NAME = "emit_parsed_bill";

// PR4 (S142) — tool description acts as the model's primary guidance under
// tool_use mode (more attended to than user-message prompt text). Restate the
// load-bearing rules so the model honors them even when it weights the schema
// more heavily than INSTRUCTIONS.
const BILL_PARSER_TOOL_DESCRIPTION = [
  "Emit the structured parsed bill in a single call. ALL extraction goes into the tool input — do not narrate or emit free-form text.",
  "",
  "POSITIVE-MAGNITUDE RULE (mirrors INSTRUCTIONS Rule #13): ins_adjusted, insurance_paid, patient_paid, denied_amount (except reversal lines), contract_discount, provider_adjusted, member_copay, member_coinsurance, member_applied_to_deductible, total_ins_adjusted, total_insurance_paid, total_patient_paid are POSITIVE MAGNITUDES. Strip literal minus-sign formatting (e.g., \"-$109.68\" → 109.68). The only legitimate negatives are billed_amount and denied_amount on adjustment-reversal cycle lines (per Rule #5).",
  "",
  "DERIVATION RULE (mirrors INSTRUCTIONS Rule #13b — CRITICAL for dispute pipeline): when the bill shows allowed_amount per line but no explicit 'Insurance adjusted' / 'Plan discount' / 'Contractual adjustment' column, you MUST compute ins_adjusted = max(0, billed_amount - allowed_amount) per line AND aggregate the header total: total_ins_adjusted = sum(per-line ins_adjusted). Same applies to patient_responsibility derivation when allowed + insurance_paid are shown: patient_responsibility = max(0, allowed_amount - insurance_paid). Do NOT emit null/0 for these fields when the inputs to the derivation are present — that loses data the downstream dispute pipeline needs to cite specific lines.",
  "",
  "INVARIANT CHECK (every line): billed_amount ≈ ins_adjusted + provider_adjusted + insurance_paid + patient_responsibility (sometimes ± denied/contract_discount). Use this to validate your extraction. If the math doesn't close, re-read the columns rather than guess. Schema accepts null only when the value is genuinely absent from the bill AND cannot be derived from sibling fields.",
  "",
  "PER-LINE BREAKDOWN (mirrors INSTRUCTIONS Rule #13a): populate per-line numeric fields for EVERY line when the bill shows per-line columns OR when derivation applies. Header-only emission is for aggregate-only bills (rare).",
].join("\n");

const BILL_PARSER_TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["service_date", "lineItems", "totals"],
  properties: {
    claim_number: { type: ["string", "null"] },
    external_claim_number: { type: ["string", "null"] },
    eob_date: { type: ["string", "null"], description: "ISO YYYY-MM-DD when EOB was issued; null if not shown." },
    service_date: { type: "string", description: "ISO YYYY-MM-DD primary date of service." },
    network_status: {
      type: ["string", "null"],
      enum: ["in_network", "out_of_network", "tiered", "unknown", null],
    },
    provider: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        npi: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
      },
    },
    patient: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        memberId: { type: ["string", "null"] },
        groupNumber: { type: ["string", "null"] },
      },
    },
    insurer: {
      type: ["object", "null"],
      properties: {
        name: { type: ["string", "null"] },
        planName: { type: ["string", "null"] },
        accountNumber: { type: ["string", "null"] },
      },
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        required: ["line_number_in_eob", "description", "billed_amount"],
        properties: {
          line_number_in_eob: { type: "string", description: "Verbatim EOB line label, e.g. '0100' or '1'." },
          service_date: { type: ["string", "null"], description: "ISO YYYY-MM-DD; defaults to claim service_date if line doesn't show one." },
          description: { type: "string", description: "Provider's exact description text. Never AMA/CPT canonical text." },
          procedure_code: { type: ["string", "null"], description: "CPT/HCPCS/REV/DRG/NDC/G/CAT_II code as printed; no synthesis." },
          procedureCodeType: {
            type: ["string", "null"],
            enum: ["CPT", "HCPCS_L2", "REV", "DRG", "NDC", "G_CODE", "CAT_II", null],
          },
          modifier: { type: ["string", "null"] },
          quantity: { type: ["number", "null"], minimum: 0 },
          // PR4 B-3 — billed_amount may carry negative on adjustment-reversal
          // lines (Rule #5); no minimum constraint here.
          billed_amount: { type: "number" },
          allowed_amount: { type: ["number", "null"] },
          // PR4 B-3 — denied_amount may carry negative on reversal lines.
          denied_amount: { type: ["number", "null"], description: "Amount explicitly DENIED on this line (distinct from $0 paid). May be negative ONLY on adjustment-reversal cycle lines per Rule #5." },
          contract_discount: { type: ["number", "null"], minimum: 0, description: "Insurer-negotiated discount, distinct from generic adjustments. Positive magnitude." },
          ins_adjusted: {
            type: ["number", "null"],
            minimum: 0,
            description:
              "Contractual writeoff per line (positive magnitude — strip literal minus-sign formatting). DERIVATION (CRITICAL): when the line shows allowed_amount but no explicit 'Insurance adjusted' / 'Plan discount' / 'Contractual adjustment' column, you MUST compute ins_adjusted = max(0, billed_amount - allowed_amount). Do NOT emit null in that case. Example: billed=$705, allowed=$563.81, insurance_paid=$563.81 → ins_adjusted = $705 - $563.81 = $141.19. Only emit null/0 when (a) allowed_amount is also null AND no explicit column shown, OR (b) billed equals allowed (no writeoff — legitimate zero).",
          },
          provider_adjusted: { type: ["number", "null"], minimum: 0, description: "Provider write-off (e.g., 'Provider adjusted' column). Positive magnitude. Distinct from ins_adjusted (which is insurer-contractual)." },
          insurance_paid: { type: ["number", "null"], minimum: 0, description: "Insurer ACTUAL PAYMENT to provider for this line (positive magnitude). NOT the writeoff (that's ins_adjusted). Often equals allowed_amount when insurer pays 100% of allowed (e.g., post-deductible covered service)." },
          patient_responsibility: {
            type: ["number", "null"],
            minimum: 0,
            description:
              "Total user share assigned by insurer for this line (positive magnitude). DERIVATION: when the line shows billed + allowed + insurance_paid but no explicit 'Patient owes' / 'Patient responsibility' column, compute patient_responsibility = max(0, allowed_amount - insurance_paid). Do NOT confuse with patient_paid (= what the user has actually paid out of pocket; distinct field). Set to 0 when allowed equals insurance_paid (insurer covered 100% of allowed).",
          },
          patient_paid: { type: ["number", "null"], minimum: 0, description: "Patient out-of-pocket already paid on this line (from 'Paid [date] -$X' footer lines or per-line patient-payment column). Positive magnitude. DISTINCT from patient_responsibility (= total assigned share). Often null on EOBs that report only insurer-side processing without remittance data." },
          member_copay: { type: ["number", "null"], minimum: 0 },
          member_coinsurance: { type: ["number", "null"], minimum: 0 },
          member_applied_to_deductible: { type: ["number", "null"], minimum: 0 },
          cob_allowed: { type: ["number", "null"] },
          cob_paid: { type: ["number", "null"], minimum: 0 },
          cob_payer_id: { type: ["string", "null"] },
          tax_paid: { type: ["number", "null"], minimum: 0 },
          interest_paid: { type: ["number", "null"], minimum: 0 },
          claim_line_status: {
            type: ["string", "null"],
            enum: ["paid", "not_paid", "pending", "denied", "adjusted", null],
          },
          paid_date: { type: ["string", "null"] },
          network_status: {
            type: ["string", "null"],
            enum: ["in_network", "out_of_network", "tiered", "unknown", null],
          },
          rendering_provider_npi: { type: ["string", "null"] },
          rendering_provider_name: { type: ["string", "null"] },
          carc_codes: { type: "array", items: { type: "string" } },
          rarc_codes: { type: "array", items: { type: "string" } },
          ex_codes: {
            type: "array",
            items: {
              type: "object",
              required: ["code", "note_text"],
              properties: {
                code: { type: "string" },
                note_text: { type: "string", description: "Verbatim text from Notes/Legend section." },
              },
            },
          },
        },
      },
    },
    accumulators: {
      type: "array",
      items: {
        type: "object",
        required: ["benefit_year", "network_tier", "accumulator_type", "is_individual"],
        properties: {
          benefit_year: { type: "string" },
          network_tier: { type: "string", enum: ["in_network", "out_of_network", "tiered", "unknown"] },
          accumulator_type: { type: "string", enum: ["medical", "rx", "dental", "vision", "combined", "mental_health"] },
          is_individual: { type: "boolean" },
          deductible_applied: { type: ["number", "null"], minimum: 0 },
          deductible_max: { type: ["number", "null"], minimum: 0 },
          oop_applied: { type: ["number", "null"], minimum: 0 },
          oop_max: { type: ["number", "null"], minimum: 0 },
          copays_applied: { type: ["number", "null"], minimum: 0 },
          coinsurance_applied: { type: ["number", "null"], minimum: 0 },
        },
      },
    },
    totals: {
      type: "object",
      required: ["total_billed"],
      properties: {
        total_billed: { type: "number", minimum: 0 },
        total_allowed: { type: ["number", "null"] },
        total_insurance_paid: { type: ["number", "null"], minimum: 0 },
        total_patient_responsibility: { type: ["number", "null"], minimum: 0 },
        total_patient_paid: { type: ["number", "null"], minimum: 0 },
        total_denied: { type: ["number", "null"] },
        total_contract_discount: { type: ["number", "null"], minimum: 0 },
        total_ins_adjusted: { type: ["number", "null"], minimum: 0 },
        total_provider_adjusted: { type: ["number", "null"], minimum: 0 },
      },
    },
    _meta: {
      type: ["object", "null"],
      description: "Pattern P-8 per-field provenance. Keys are dot-paths like 'lineItems[0].denied_amount'. Each value has confidence + source_excerpt + source_section_hint.",
      additionalProperties: true,
    },
  },
} as const;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[haiku-bill-parser] ANTHROPIC_API_KEY not set");
    return null;
  }
  return new Anthropic({ apiKey, timeout: 60000, maxRetries: 2 });
}

// Pattern 1 from dr3d_dogfood_findings.md: adaptive max_tokens
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function adaptiveMaxTokens(inputTokens: number): number {
  return Math.min(inputTokens + 4000, HAIKU_MAX_OUTPUT);
}

function parseJSON(text: string): unknown {
  // S94 B1 — delegate to shared parseHaikuJSON which handles trailing reasoning
  // text + code fences + balanced-block extraction + jsonrepair fallback. The
  // older greedy-regex fallback `/\{[\s\S]*\}/` was non-balanced (matches across
  // multiple objects); the balanced-block extractor in safe-json correctly
  // walks brace depth respecting string literals.
  return parseHaikuJSON(text);
}

interface HaikuRawResult {
  claim_number?: string;
  external_claim_number?: string;
  eob_date?: string;
  service_date?: string;
  serviceDate?: string; // tolerate both styles
  network_status?: ParsedBill["network_status"];
  provider?: { name?: string; npi?: string; address?: string };
  patient?: { name?: string; memberId?: string; member_id?: string; groupNumber?: string; group_number?: string };
  insurer?: { name?: string; planName?: string; plan_name?: string; accountNumber?: string; account_number?: string };
  lineItems?: Array<Record<string, unknown>>;
  line_items?: Array<Record<string, unknown>>;
  accumulators?: Accumulator[];
  totals?: Record<string, number>;
  _meta?: unknown;
}

// DR-3D Q-DR-3D-1: monolithic prompt with 5 section headings + 4 few-shot examples
// (padded to ~4400 tokens to clear Haiku 4.5 cache threshold).
// DR-3D Q-DR-3D-4: explicit accumulator merge instruction.
// DR-3D Q-DR-3D-6: per-occurrence _meta emission instruction.
const INSTRUCTIONS = `You are extracting structured data from a medical bill or Explanation of Benefits (EOB) document. Return a single JSON object matching the schema below. Extract ONLY from the claim adjudication tables (line-item rows with amounts) and accumulator/deductible information sections. DO NOT extract from appeal rights sections, claim processing legalese, fraud disclaimers, glossary definitions, or "Notice for Arizona Residents"-style state-specific notices.

## CRITICAL EXTRACTION RULES

1. **Verbatim text**: Extract the provider's EXACT description text for each line item. Never use AMA/CPT descriptions.
2. **Code identification by COLUMN HEADER context**: If a code appears under a column labeled "Reason Code" or "Adjustment Reason", extract as carc_codes. If under "Remark Code" or "Remittance Advice", extract as rarc_codes. If under "Explanation Code", "EX Code", "See notes", or insurer-specific labels (Cigna A-codes, Anthem M-codes), extract as ex_codes WITH the corresponding note_text from the Notes section. If unsure, default to ex_codes with note_text.
3. **EX codes ALWAYS include note_text**: The same code letter (e.g., "A1") may mean different things in different EOBs from the same insurer. ALWAYS extract the full note_text from the EOB's Notes/Legend section. CARC and RARC are industry-standard enumerated codes; code-only is sufficient.
4. **Dollar amounts vs codes**: Dollar amounts have $ signs or appear in money columns. A 5-digit number like "95004" next to a procedure column is a CODE, not an amount. Lines with $0.00 charges are tracking/quality codes — still extract them.
5. **Adjustment reversal lines**: Extract lines verbatim with their EOB-shown line numbers (e.g., "0100", "0101") in line_number_in_eob. DO NOT attempt to detect reversal cycles — that happens in post-processing. Just extract every line including ones with negative amounts.
6. **Dates**: ISO format YYYY-MM-DD.
7. **Missing fields**: If a field is not present in the document, omit it (do not guess).
8. **Accumulator extraction (CRITICAL — merge by key tuple)**: Emit EXACTLY ONE entry per unique (benefit_year, network_tier, accumulator_type, is_individual) tuple. When EOB shows separate sentences for deductible AND out-of-pocket for the same bucket (e.g., "$30 toward $500 in-network individual deductible" AND "$200 toward $3000 in-network individual OOP"), MERGE them into a SINGLE accumulator entry. DO NOT emit separate entries — that creates duplicate keys. Distinct buckets (in-network + out-of-network, individual + family, current + prior year) get distinct entries. **MULTI-YEAR EMISSION (CRITICAL)**: When the document shows accumulator values for MULTIPLE benefit years (e.g., a 2026 snapshot AND a 2018 prior-year carryover), emit ONE entry per (benefit_year, network_tier, accumulator_type, is_individual) tuple — INCLUDING the prior-year entries. Do not collapse prior-year snapshots into the current-year entry; do not silently skip prior-year data. Each year is a distinct bucket.
9. **Per-occurrence _meta emission (CRITICAL)**: Emit a _meta confidence entry for EVERY OCCURRENCE of high-leverage fields. For an 8-line EOB, emit 8 separate _meta entries for lineItems[N].denied_amount (one per line, even if values repeat). For 4 accumulator buckets, emit 4 separate _meta entries for accumulators[N].deductible_applied.
10. **Cycle detection signals**: Preserve verbatim line_number_in_eob if shown. If insurer doesn't number lines (e.g., Cigna), use sequential "1", "2", "3".
11. **Rendering provider** (per-line): If the EOB or bill shows a rendering provider (the individual professional who delivered the service) distinct from the facility provider, populate rendering_provider_npi + rendering_provider_name on the line item. Facility-level provider goes on top-level provider field.
12. **Procedure code type discriminator**: Set procedureCodeType based on format: 5-digit numeric = "CPT"; letter+4digit (e.g., J7298) = "HCPCS_L2"; 4-digit revenue = "REV"; 3-digit numeric DRG = "DRG"; 11-digit NDC = "NDC"; G+4digit = "G_CODE"; 4-digit ending in F = "CAT_II".
13. **Adjustment splits** (CRITICAL — never conflate with insurance_paid): "Ins adjusted" / "Insurance adjusted" / "Contractual adjustment" / "Plan discount" is a CONTRACTUAL WRITEOFF — the amount the insurer negotiates down before paying. It is NOT money paid to the provider. Put it in ins_adjusted (per-line) AND total_ins_adjusted (header). "Ins paid" / "Insurance paid" / "Plan paid" is the insurer's ACTUAL PAYMENT to the provider — put it in insurance_paid (per-line) AND total_insurance_paid (header). On Providence-style bills these are TWO DIFFERENT LINES in the totals box. "Provider adjusted" / "Provider write-off" goes in provider_adjusted. Lump-sum unsplit adjustments still go in the adjustments field. **Invariant check**: billed_amount ≈ ins_adjusted + provider_adjusted + insurance_paid + patient_responsibility (sometimes ± denied/contract_discount). If the math doesn't close, re-read the totals labels rather than dump everything into insurance_paid. **POSITIVE-MAGNITUDE RULE (PR4 / S142 — CRITICAL)**: ins_adjusted, insurance_paid, patient_paid, denied_amount, contract_discount, provider_adjusted, member_copay, member_coinsurance, member_applied_to_deductible, and ALL their header-total counterparts (total_ins_adjusted, total_insurance_paid, total_patient_paid, etc.) are STORED AS POSITIVE MAGNITUDES. Many EOBs display writeoff / payment columns with literal "-$X" formatting (deduction-as-negative display convention; e.g., "Insurance adjusted: -$109.68" means a $109.68 writeoff). When you see this literal minus-sign formatting, STRIP THE SIGN and store the magnitude (109.68). Negative values in these fields are invalid input. The only fields that may legitimately carry a negative value are billed_amount and denied_amount on adjustment-reversal cycle lines (per Rule #5 — reversal lines preserve their original sign so the post-process cycle detector can pair them). Reversal-cycle lines are the only exception.

13a. **Per-line breakdown extraction (PR4 / S142 — CRITICAL for dispute pipeline)**: When the bill's claim-adjudication table shows per-line columns for "Insurance paid", "Insurance adjusted", "Plan paid", "Plan discount", or "Patient paid", populate the corresponding per-line numeric fields (insurance_paid, ins_adjusted, patient_paid) for EVERY line — do not emit header-only totals and leave per-line fields empty. The downstream dispute-letter pipeline needs per-line numerics to cite specific lines in the dispute body (header totals are insufficient for line-level dispute strength). If the bill's table genuinely doesn't include the column (e.g., aggregate-only EOB; header totals appear but no per-line breakdown), omit the per-line field — DO NOT invent a number. The persist verifier checks: |sum(per_line.X) - total.X| <= max(0.01, total.X * 0.001). If your per-line values don't sum to the header total within tolerance, re-read the table rather than guess.

13b. **DERIVATION rule for ins_adjusted (PR4 / S142 — CRITICAL)**: When the bill shows BOTH "Billed" and "Allowed" (or "Eligible amount" / "Approved amount" / "Plan-allowed") columns per line, but does NOT show an explicit "Insurance adjusted" / "Contractual adjustment" / "Plan discount" column, you MUST compute the per-line writeoff as: ins_adjusted = max(0, billed_amount - allowed_amount). This is the contractual amount the insurer negotiates down (provider billed X, insurer says only Y is allowed, writeoff = X - Y). Apply per line AND aggregate the header total: total_ins_adjusted = sum(per-line ins_adjusted). DO NOT emit null or 0 for ins_adjusted when allowed_amount is present and billed_amount > allowed_amount — that loses data the dispute pipeline needs. Example: L1 billed=$705, allowed=$563.81, insurance_paid=$563.81, patient_owes=$0 → ins_adjusted = $705 - $563.81 = $141.19 per line; sum across 8 lines yields total_ins_adjusted accordingly. If billed_amount equals allowed_amount (no writeoff), ins_adjusted = 0 is correct (and that's a real signal, not an omission).

14. **Patient out-of-pocket payments** (CRITICAL — distinct from patient_responsibility): If the bill shows "Paid [date] -$X" / "Patient payment" / "Amount paid" entries near the bottom (e.g., "Paid Jun 27, 2025 -$292.41"), these represent money the PATIENT has already paid out of pocket. Sum them into total_patient_paid (header). If a per-line patient-payment is shown, also populate patient_paid on the line item. DO NOT lump these into insurance_paid. They reduce the remaining balance (Total Due) but do NOT change the patient's assigned patient_responsibility (which is the total share assigned regardless of when it's paid).
15. **Citation-grade source provenance (Pattern P-8 — CRITICAL)**: For each high-leverage field's _meta entry (see field list below), include TWO additional sub-keys alongside 'confidence':
   - 'source_excerpt' (≤200 chars): the exact verbatim text from the document that supports this extraction. MUST appear character-for-character in the document text. If you can't quote a verbatim ≤200-char excerpt, omit this field rather than paraphrase.
   - 'source_section_hint' (one of: "claim_header", "line_items_table", "denial_codes_section", "accumulator_block", "appeal_rights_DO_NOT_EXTRACT", "glossary_DO_NOT_EXTRACT", "footer_legalese_DO_NOT_EXTRACT", "other"): which section of the document the excerpt was pulled from.

   Example:
     "_meta": {
       "lineItems[0].deniedAmount": {
         "confidence": 0.95,
         "source_excerpt": "Service not reimbursable. Denied $245.00.",
         "source_section_hint": "line_items_table"
       }
     }

   CRITICAL: NEVER extract data values from sections marked '_DO_NOT_EXTRACT' (appeal rights, glossary, footer legalese). If you find yourself wanting to pull data from those sections, suppress the field entirely. Tagging a field's source as '*_DO_NOT_EXTRACT' is a self-reported hallucination admission and the field will be flagged for review.

## OUTPUT JSON SCHEMA

{
  "claim_number": "string?",
  "eob_date": "YYYY-MM-DD?",
  "service_date": "YYYY-MM-DD",
  "network_status": "in_network | out_of_network | tiered | unknown",
  "provider": { "name": "string", "npi": "string?", "address": "string?" },
  "patient": { "name": "string", "memberId": "string?", "groupNumber": "string?" },
  "insurer": { "name": "string?", "planName": "string?", "accountNumber": "string?" },
  "lineItems": [
    {
      "line_number_in_eob": "string",
      "service_date": "YYYY-MM-DD",
      "description": "string",
      "procedure_code": "string?",
      "procedureCodeType": "CPT | HCPCS_L2 | REV | DRG | NDC | G_CODE | CAT_II",
      "modifier": "string?",
      "quantity": 1,
      "billed_amount": 0,
      "allowed_amount": 0,
      "denied_amount": 0,
      "contract_discount": 0,
      "ins_adjusted": 0,
      "provider_adjusted": 0,
      "insurance_paid": 0,
      "patient_responsibility": 0,
      "patient_paid": 0,
      "member_copay": 0,
      "member_coinsurance": 0,
      "member_applied_to_deductible": 0,
      "cob_allowed": 0,
      "cob_paid": 0,
      "cob_payer_id": "string?",
      "tax_paid": 0,
      "interest_paid": 0,
      "claim_line_status": "paid | not_paid | pending | denied | adjusted",
      "paid_date": "YYYY-MM-DD?",
      "network_status": "in_network | out_of_network | tiered | unknown",
      "rendering_provider_npi": "string?",
      "rendering_provider_name": "string?",
      "carc_codes": [],
      "rarc_codes": [],
      "ex_codes": [{ "code": "string", "note_text": "verbatim text from Notes section" }]
    }
  ],
  "accumulators": [
    {
      "benefit_year": "2026",
      "network_tier": "in_network | out_of_network | tiered | unknown",
      "accumulator_type": "medical | rx | dental | vision | combined | mental_health",
      "is_individual": true,
      "deductible_applied": 0,
      "deductible_max": 0,
      "oop_applied": 0,
      "oop_max": 0,
      "copays_applied": 0,
      "coinsurance_applied": 0
    }
  ],
  "totals": {
    "total_billed": 0,
    "total_allowed": 0,
    "total_insurance_paid": 0,
    "total_patient_responsibility": 0,
    "total_patient_paid": 0,
    "total_denied": 0,
    "total_contract_discount": 0,
    "total_ins_adjusted": 0,
    "total_provider_adjusted": 0
  },
  "_meta": {
    "claim_number": { "confidence": 0.95, "source_excerpt": "Claim Number: ABC123", "source_section_hint": "claim_header" },
    "lineItems[0].denied_amount": { "confidence": 0.85, "source_excerpt": "Denied $50.00", "source_section_hint": "line_items_table" }
  }
}

High-leverage _meta fields (emit per occurrence WITH source_excerpt + source_section_hint per Rule #14): claim_number, eob_date, network_status, lineItems[*].denied_amount, lineItems[*].claim_line_status, lineItems[*].carc_codes, lineItems[*].rarc_codes, lineItems[*].ex_codes[*].note_text, lineItems[*].member_copay, lineItems[*].member_coinsurance, lineItems[*].member_applied_to_deductible, accumulators[*].deductible_applied, accumulators[*].oop_applied.

## EXAMPLE 1 — Simple 1-line paid claim

Input excerpt:
Claim # 1234567 / Service date: 01/15/2026 / Provider: Dr Smith / IN NETWORK
Line 0100  01/15/26  OFFICE VISIT  99213    Billed $200  Allowed $80  Copay $30  Plan paid $50  Code: B1
Total: $200 billed, $80 allowed, $50 paid, $30 owed
What I need to know for next claim: $30/$500 in-network individual deductible 2026
Notes: B1 - PATIENT COPAY APPLIED PER PLAN BENEFIT.

Output:
{
  "claim_number": "1234567",
  "service_date": "2026-01-15",
  "network_status": "in_network",
  "provider": { "name": "Dr Smith" },
  "patient": {},
  "insurer": {},
  "lineItems": [{
    "line_number_in_eob": "0100",
    "service_date": "2026-01-15",
    "description": "OFFICE VISIT",
    "procedure_code": "99213",
    "procedureCodeType": "CPT",
    "billed_amount": 200,
    "allowed_amount": 80,
    "insurance_paid": 50,
    "member_copay": 30,
    "claim_line_status": "paid",
    "network_status": "in_network",
    "carc_codes": [],
    "rarc_codes": [],
    "ex_codes": [{ "code": "B1", "note_text": "PATIENT COPAY APPLIED PER PLAN BENEFIT." }]
  }],
  "accumulators": [{
    "benefit_year": "2026",
    "network_tier": "in_network",
    "accumulator_type": "combined",
    "is_individual": true,
    "deductible_applied": 30,
    "deductible_max": 500
  }],
  "totals": { "total_billed": 200, "total_allowed": 80, "total_insurance_paid": 50, "total_patient_responsibility": 30 },
  "_meta": {
    "claim_number": { "confidence": 0.98, "source_excerpt": "Claim # 1234567", "source_section_hint": "claim_header" },
    "lineItems[0].claim_line_status": { "confidence": 0.92, "source_excerpt": "Plan paid $50", "source_section_hint": "line_items_table" },
    "lineItems[0].member_copay": { "confidence": 0.95, "source_excerpt": "Copay $30", "source_section_hint": "line_items_table" },
    "lineItems[0].ex_codes[0].note_text": { "confidence": 0.97, "source_excerpt": "B1 - PATIENT COPAY APPLIED PER PLAN BENEFIT.", "source_section_hint": "denial_codes_section" },
    "accumulators[0].deductible_applied": { "confidence": 0.90, "source_excerpt": "$30/$500 in-network individual deductible 2026", "source_section_hint": "accumulator_block" }
  }
}

## EXAMPLE 2 — Multi-line with adjustment-reversal cycle (Ambetter-style)

Input excerpt:
Claim # T153CC874265 / Service date: 04/03/2019 / STATE IMAGING CO / In-Network
Line  Date     Description    Billed     Allowed  Denied   Plan Paid  EX  CARC  RARC
0100  04/03/19 MRI 73221      1,128.20   0.00     1,128.20 0.00       A1  197   N572
0101  04/03/19 MRI 73221      -1,128.20  0.00     -1,128.20 0.00      A1  197   N572
0102  04/03/19 MRI 73221      1,128.20   203.13   0.00     203.13     JU  45

Output (excerpt — extract every line verbatim; cycle pairing happens in post-process):
{
  "lineItems": [
    { "line_number_in_eob": "0100", "service_date": "2019-04-03", "description": "MRI 73221", "procedure_code": "73221", "procedureCodeType": "CPT", "billed_amount": 1128.20, "denied_amount": 1128.20, "claim_line_status": "denied", "carc_codes": ["197"], "rarc_codes": ["N572"], "ex_codes": [{"code": "A1", "note_text": "Coding error - resubmit with proper diagnosis codes"}] },
    { "line_number_in_eob": "0101", "service_date": "2019-04-03", "description": "MRI 73221", "procedure_code": "73221", "billed_amount": -1128.20, "denied_amount": -1128.20, "claim_line_status": "adjusted", "carc_codes": ["197"], "rarc_codes": ["N572"], "ex_codes": [{"code": "A1", "note_text": "Coding error - resubmit with proper diagnosis codes"}] },
    { "line_number_in_eob": "0102", "service_date": "2019-04-03", "description": "MRI 73221", "procedure_code": "73221", "billed_amount": 1128.20, "allowed_amount": 203.13, "insurance_paid": 203.13, "claim_line_status": "paid", "carc_codes": ["45"], "ex_codes": [{"code": "JU", "note_text": "Allowed amount adjustment per contract pricing"}] }
  ]
}

## EXAMPLE 3 — CORRECT vs INCORRECT accumulator merging

Input excerpt:
You've met $30 toward your $500 in-network individual deductible for 2026
You've met $200 toward your $3,000 in-network individual out of pocket for 2026
You've met $0 toward your $1,500 out-of-network individual deductible for 2026
You've met $0 toward your $6,000 out-of-network individual out of pocket for 2026

CORRECT (one entry per (year, tier, type, individual), deductible AND oop merged):
{
  "accumulators": [
    { "benefit_year": "2026", "network_tier": "in_network", "accumulator_type": "combined", "is_individual": true, "deductible_applied": 30, "deductible_max": 500, "oop_applied": 200, "oop_max": 3000 },
    { "benefit_year": "2026", "network_tier": "out_of_network", "accumulator_type": "combined", "is_individual": true, "deductible_applied": 0, "deductible_max": 1500, "oop_applied": 0, "oop_max": 6000 }
  ]
}

INCORRECT (DO NOT EMIT — duplicate keys, separate entries):
{
  "accumulators": [
    { "benefit_year": "2026", "network_tier": "in_network", "is_individual": true, "deductible_applied": 30, "deductible_max": 500 },
    { "benefit_year": "2026", "network_tier": "in_network", "is_individual": true, "oop_applied": 200, "oop_max": 3000 }
  ]
}

## EXAMPLE 4 — Per-occurrence _meta emission with citation-grade source provenance (multi-line EOB)

For an EOB with 3 denied line items, emit _meta for EVERY line WITH source_excerpt + source_section_hint:

{
  "lineItems": [
    { "line_number_in_eob": "1", "denied_amount": 50, "claim_line_status": "denied" },
    { "line_number_in_eob": "2", "denied_amount": 75, "claim_line_status": "denied" },
    { "line_number_in_eob": "3", "denied_amount": 25, "claim_line_status": "denied" }
  ],
  "_meta": {
    "lineItems[0].denied_amount": { "confidence": 0.97, "source_excerpt": "Line 1  Denied $50", "source_section_hint": "line_items_table" },
    "lineItems[0].claim_line_status": { "confidence": 0.95, "source_excerpt": "Line 1  Denied $50", "source_section_hint": "line_items_table" },
    "lineItems[1].denied_amount": { "confidence": 0.97, "source_excerpt": "Line 2  Denied $75", "source_section_hint": "line_items_table" },
    "lineItems[1].claim_line_status": { "confidence": 0.95, "source_excerpt": "Line 2  Denied $75", "source_section_hint": "line_items_table" },
    "lineItems[2].denied_amount": { "confidence": 0.97, "source_excerpt": "Line 3  Denied $25", "source_section_hint": "line_items_table" },
    "lineItems[2].claim_line_status": { "confidence": 0.95, "source_excerpt": "Line 3  Denied $25", "source_section_hint": "line_items_table" }
  }
}

## EXAMPLE 5 — Negative-column EOB (Providence-style writeoff display) — positive-magnitude rule (PR4 / S142)

Some EOBs display writeoff / payment columns with literal minus-sign-dollar (e.g. "-$X") formatting to indicate a deduction:

Input excerpt:
Claim # f2c36497 / Service date: 12/12/2022 / Swedish Medical Group / IN NETWORK
Line  Date     Description       Code   Billed    Ins adjusted   Ins paid    Patient owes
1     12/12/22 OFFICE VISIT      99214  312.00    -109.68        -59.92      142.40
2     12/12/22 URINE DRUG TEST   80305  89.00     -31.15         -17.09      40.76
3     12/12/22 PREVENTIVE EXAM   99385  403.00    -218.04        -118.65     66.31
Totals: $804 billed, -$358.87 ins adjusted, -$195.66 ins paid, $249.47 patient owes

Output (CRITICAL — strip the literal minus-sign formatting; store positive magnitudes; per-line populated AND header totals; math closes per Rule #13 invariant):
{
  "claim_number": "f2c36497",
  "service_date": "2022-12-12",
  "network_status": "in_network",
  "provider": { "name": "Swedish Medical Group" },
  "patient": {},
  "insurer": {},
  "lineItems": [
    { "line_number_in_eob": "1", "service_date": "2022-12-12", "description": "OFFICE VISIT", "procedure_code": "99214", "procedureCodeType": "CPT", "billed_amount": 312.00, "ins_adjusted": 109.68, "insurance_paid": 59.92, "patient_responsibility": 142.40, "claim_line_status": "paid", "network_status": "in_network", "carc_codes": [], "rarc_codes": [], "ex_codes": [] },
    { "line_number_in_eob": "2", "service_date": "2022-12-12", "description": "URINE DRUG TEST", "procedure_code": "80305", "procedureCodeType": "CPT", "billed_amount": 89.00, "ins_adjusted": 31.15, "insurance_paid": 17.09, "patient_responsibility": 40.76, "claim_line_status": "paid", "network_status": "in_network", "carc_codes": [], "rarc_codes": [], "ex_codes": [] },
    { "line_number_in_eob": "3", "service_date": "2022-12-12", "description": "PREVENTIVE EXAM", "procedure_code": "99385", "procedureCodeType": "CPT", "billed_amount": 403.00, "ins_adjusted": 218.04, "insurance_paid": 118.65, "patient_responsibility": 66.31, "claim_line_status": "paid", "network_status": "in_network", "carc_codes": [], "rarc_codes": [] }
  ],
  "totals": {
    "total_billed": 804.00,
    "total_ins_adjusted": 358.87,
    "total_insurance_paid": 195.66,
    "total_patient_responsibility": 249.47
  }
}

INCORRECT (DO NOT EMIT — literal sign preserved; downstream math inflates):
{
  "lineItems": [
    { "line_number_in_eob": "1", "ins_adjusted": -109.68, "insurance_paid": -59.92, "patient_responsibility": 142.40 }
  ],
  "totals": { "total_ins_adjusted": -358.87, "total_insurance_paid": -195.66 }
}

Sanity-check the math on every line: billed_amount = ins_adjusted + insurance_paid + patient_responsibility (± denied / contract_discount). Line 1: 312 = 109.68 + 59.92 + 142.40 ✓. Line 2: 89 = 31.15 + 17.09 + 40.76 ✓. Line 3: 403 = 218.04 + 118.65 + 66.31 ✓. If the math doesn't close with positive magnitudes, re-read the columns rather than flip signs.

## NOW EXTRACT FROM THIS DOCUMENT:`;

/**
 * Parse a bill or EOB using Haiku. Falls back to null on failure.
 * EOB-mode triggers post-process: cycle detection, accumulator merge, EX hash, _meta parse.
 */
export async function parseBillWithHaiku(
  ocrText: string,
  documentId: string,
  userId: string,
  billType: "eob" | "itemized_bill",
  // Pattern P-8 (Phase 3.1B) — drives source_excerpt verification path. Default
  // 'pdftotext' since most uploads come through pdftotext extraction. Callers
  // running OCR on image-only PDFs should pass 'ocr' explicitly so verification
  // returns 'ocr_unverifiable' rather than 'not_found' on misses.
  extractionMethod: ExtractionMethod = "pdftotext",
): Promise<ParsedBill | null> {
  // S94 B4 Fix #1b — SBC marker scan. Refuse to parse documents that look
  // like an SBC (Summary of Benefits and Coverage). User-uploaded SBCs
  // mis-routed through the bill picker cause Haiku to hallucinate CPT
  // codes from ZIP codes, P.O. boxes, and phone numbers. Doc-type resolver
  // hardening (s94-b5) addresses routing; this is parser-side defense-in-
  // depth. See migrations/106_bill_parser_hardening_flags.sql for the
  // motivating incident.
  if (await isFeatureEnabled("bill_parser_sbc_marker_scan")) {
    const scan = scanForSbcMarkers(ocrText);
    if (scan.isLikelySbc) {
      console.warn(
        `[haiku-bill-parser] Refused: SBC-like document (${scan.matchedMarkers.length}/${scan.totalMarkersChecked} markers: ${scan.matchedMarkers.join(", ")})`
      );
      return null;
    }
  }

  const client = getClient();
  if (!client) return null;

  const inputTokens = estimateTokens(INSTRUCTIONS + ocrText);
  const maxTokens = adaptiveMaxTokens(inputTokens);

  // PR4 (S142) — B-1 tool-use branch. When `bill_parser_tool_use_v1` is ON
  // (default OFF in PROD; emergency revert via flag flip), the parser hands
  // off to the tool-use code path. Legacy raw-JSON code path below stays
  // untouched bit-for-bit so we have a known-good fallback during PR4 soak.
  // Both paths return ParsedBill of the same shape; downstream callers
  // (persist) can't tell which path produced the result without checking the
  // flag separately + threading parserPath through.
  const toolUseEnabled = await isFeatureEnabled("bill_parser_tool_use_v1");
  if (toolUseEnabled) {
    return parseBillWithHaikuToolUse(
      client,
      ocrText,
      documentId,
      userId,
      billType,
      extractionMethod,
      inputTokens,
      maxTokens,
    );
  }

  try {
    let response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
          { type: "text", text: "\n\n" + ocrText },
        ],
      }],
    });

    // Truncation detection + retry at HAIKU_MAX_OUTPUT
    if (response.stop_reason === "max_tokens" && maxTokens < HAIKU_MAX_OUTPUT) {
      console.warn(`[haiku-bill-parser] Output truncated at ${maxTokens}; retrying at ${HAIKU_MAX_OUTPUT}`);
      response = await client.messages.create({
        model: MODEL,
        max_tokens: HAIKU_MAX_OUTPUT,
        temperature: 0,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
            { type: "text", text: "\n\n" + ocrText },
          ],
        }],
      });
      if (response.stop_reason === "max_tokens") {
        console.error(`[haiku-bill-parser] Output truncated even at ${HAIKU_MAX_OUTPUT}; document too large`);
        // Bills-E.1 telemetry (S133) — capture the failure event for admin visibility
        // before returning null. Non-fatal: never throws. See truncation-telemetry.ts.
        await recordBillTruncation({
          documentId,
          userId,
          billType,
          inputTokensEstimate: inputTokens,
          maxTokensAttempted: HAIKU_MAX_OUTPUT,
          ocrTextLength: ocrText.length,
        });
        return null;
      }
    }

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    let result: HaikuRawResult;
    try {
      result = parseJSON(text) as HaikuRawResult;
    } catch {
      // Phase 3.1B reliability fix: retry once on stochastic JSON parse failure.
      // Haiku is non-deterministic; ~16% of EOB parses had malformed JSON in the
      // session_49_phase31b_p8_baseline run. Retry-once mitigates Class A failures.
      // DR-3C 3-parse voting will replace this when wired in Phase 3.2.
      console.warn("[haiku-bill-parser] JSON parse failed; retrying once (stochastic Haiku mitigation)");
      const retryResponse = await client.messages.create({
        model: MODEL,
        max_tokens: HAIKU_MAX_OUTPUT, // retry at max budget; the failed call may have been near limit
        temperature: 0,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
            { type: "text", text: "\n\n" + ocrText },
          ],
        }],
      });
      const retryText = retryResponse.content[0].type === "text" ? retryResponse.content[0].text : "";
      try {
        result = parseJSON(retryText) as HaikuRawResult;
        console.log("[haiku-bill-parser] retry succeeded");
      } catch (retryErr) {
        console.error("[haiku-bill-parser] retry also failed; giving up");
        throw retryErr;
      }
    }

    if (!result || !Array.isArray(result.lineItems ?? result.line_items)) {
      console.error("[haiku-bill-parser] Invalid response structure");
      return null;
    }

    const rawLineItems = result.lineItems ?? result.line_items ?? [];
    const claimServiceDate = result.service_date ?? result.serviceDate ?? new Date().toISOString().split("T")[0];

    const arithmeticGuardEnabled = await isFeatureEnabled("bill_parser_arithmetic_check");

    const lineItems: BillLineItem[] = rawLineItems.map((item, idx) => {
      const procedureCode = String(item.procedure_code ?? item.procedureCode ?? "");
      const billedAmount = Number(item.billed_amount ?? item.billedAmount ?? 0);
      const lineServiceDate = String(item.service_date ?? item.serviceDate ?? claimServiceDate);
      return {
        lineNumber: idx + 1,
        line_number_in_eob: item.line_number_in_eob ? String(item.line_number_in_eob) : undefined,
        procedureCode,
        procedureCodeType: reconcileHaikuCodeType(
          procedureCode,
          (item.procedureCodeType ?? item.procedure_code_type) as ProcedureCodeType | undefined,
        ),
        revenueCode: item.revenue_code as string | undefined ?? item.revenueCode as string | undefined,
        description: String(item.description ?? "Medical service"),
        category: procedureCode ? categorizeProcedureCode(procedureCode) : "Medical Service",
        serviceDate: lineServiceDate,
        quantity: Number(item.quantity ?? 1),
        billedAmount,
        allowedAmount: numOrUndef(item.allowed_amount ?? item.allowedAmount),
        insurancePaid: numOrUndef(item.insurance_paid ?? item.insurancePaid),
        patientResponsibility: numOrUndef(item.patient_responsibility ?? item.patientResponsibility),
        patient_paid: numOrUndef(item.patient_paid ?? item.patientPaid),
        adjustments: numOrUndef(item.adjustments),
        modifier: item.modifier as string | undefined,

        // DR-3D EOB fields
        paid_date: item.paid_date as string | undefined,
        claim_line_status: item.claim_line_status as BillLineItem["claim_line_status"],
        denied_amount: numOrUndef(item.denied_amount),
        contract_discount: numOrUndef(item.contract_discount),
        ins_adjusted: numOrUndef(item.ins_adjusted),
        provider_adjusted: numOrUndef(item.provider_adjusted),
        cob_allowed: numOrUndef(item.cob_allowed),
        cob_paid: numOrUndef(item.cob_paid),
        cob_payer_id: item.cob_payer_id as string | undefined,
        tax_paid: numOrUndef(item.tax_paid),
        interest_paid: numOrUndef(item.interest_paid),
        member_copay: numOrUndef(item.member_copay),
        member_coinsurance: numOrUndef(item.member_coinsurance),
        member_applied_to_deductible: numOrUndef(item.member_applied_to_deductible),
        network_status: (item.network_status ?? result.network_status) as BillLineItem["network_status"],
        carc_codes: Array.isArray(item.carc_codes) ? (item.carc_codes as string[]) : undefined,
        rarc_codes: Array.isArray(item.rarc_codes) ? (item.rarc_codes as string[]) : undefined,
        ex_codes: Array.isArray(item.ex_codes) ? (item.ex_codes as ExCode[]) : undefined,
        rendering_provider_npi: item.rendering_provider_npi as string | undefined,
        rendering_provider_name: item.rendering_provider_name as string | undefined,
      };
    });

    // S94 B4 Fix #3 — drop line items that violate basic arithmetic
    // plausibility (insurance paid >10x billed, patient owes >20x billed,
    // $0 billed with $5k+ allocated). Catches Haiku hallucinations where
    // dollar amounts are pulled from boilerplate text rather than tabular
    // line items.
    const filteredLineItems = arithmeticGuardEnabled
      ? lineItems.filter((li) => {
          const check = lineIsImplausible(li);
          if (check.dropped) {
            console.warn(`[haiku-bill-parser] Dropped line ${li.lineNumber} (code=${li.procedureCode}): ${check.reason}`);
          }
          return !check.dropped;
        })
      : lineItems;

    const totals = result.totals ?? {};
    const parsedBill: ParsedBill = {
      id: randomUUID(),
      documentId,
      userId,
      billType,
      provider: {
        name: result.provider?.name ?? "Unknown Provider",
        npi: result.provider?.npi,
        address: result.provider?.address,
      },
      patient: {
        name: result.patient?.name ?? "Unknown",
        memberId: result.patient?.memberId ?? result.patient?.member_id,
        groupNumber: result.patient?.groupNumber ?? result.patient?.group_number,
      },
      insurer: result.insurer
        ? {
            name: result.insurer.name ?? "",
            planName: result.insurer.planName ?? result.insurer.plan_name,
            accountNumber: result.insurer.accountNumber ?? result.insurer.account_number,
          }
        : undefined,
      serviceDate: claimServiceDate,
      lineItems: filteredLineItems,
      totals: {
        totalBilled: numOrZero(totals.total_billed) || filteredLineItems.reduce((s, li) => s + li.billedAmount, 0),
        totalAllowed: numOrUndef(totals.total_allowed),
        totalInsurancePaid: numOrUndef(totals.total_insurance_paid),
        totalPatientResponsibility: numOrUndef(totals.total_patient_responsibility),
        totalPatientPaid: numOrUndef(totals.total_patient_paid ?? totals.totalPatientPaid),
        totalAdjustments: numOrUndef(totals.total_adjustments),
        totalDenied: numOrUndef(totals.total_denied),
        totalContractDiscount: numOrUndef(totals.total_contract_discount),
        totalInsAdjusted: numOrUndef(totals.total_ins_adjusted),
        totalProviderAdjusted: numOrUndef(totals.total_provider_adjusted),
      },
      rawText: ocrText,
      confidence: 0.85, // baseline; per-field confidence is in extractionMeta
      parseErrors: [],

      // EOB-only fields
      external_claim_number: (result.claim_number ?? result.external_claim_number) as string | undefined,
      eob_date: result.eob_date,
      network_status: result.network_status,
      accumulators: Array.isArray(result.accumulators) ? result.accumulators : undefined,
      parserPath: "raw_json",
    };

    // Apply post-process pipeline (cycle detection + accumulator merge + EX hash + _meta parse + Pattern P-8 verification)
    if (billType === "eob") {
      const post = applyEOBPostProcess(parsedBill, result._meta, {
        rawDocText: ocrText,
        extractionMethod,
      });
      console.log(
        `[haiku-bill-parser] post-process: ${post.pairsFound} reversal pair(s); accumulators ${post.accumulatorsChanged ? "merged" : "ok"}; ${post.metaWarnings.length} meta warning(s); ${post.accumulatorWarnings.length} accumulator warning(s); ${post.excerptVerificationWarnings.length} excerpt warning(s); ${post.sectionRangesFound} section range(s) found`
      );
      const allWarnings = [...post.metaWarnings, ...post.accumulatorWarnings, ...post.excerptVerificationWarnings];
      if (allWarnings.length) {
        parsedBill.parseErrors.push(...allWarnings);
      }
    }

    console.log(
      `[haiku-bill-parser] Extracted ${lineItems.length} line items, total billed $${parsedBill.totals.totalBilled}; usage in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
    );
    return parsedBill;
  } catch (err) {
    console.error("[haiku-bill-parser] Extraction failed:", err);
    return null;
  }
}

function numOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

function numOrZero(v: unknown): number {
  return numOrUndef(v) ?? 0;
}

// ---------------------------------------------------------------------------
// PR4 (S142) — B-1 tool-use code path. Activated when
// `bill_parser_tool_use_v1` flag is ON. Returns a ParsedBill of identical
// shape to the legacy parseBillWithHaiku raw-JSON path so persist + audit
// can consume either source. Schema validation lives at the Anthropic API
// layer (via input_schema on the tool definition) — this is the structural
// fix for the S136 schema-key-drift class-of-bug + the B-1 enforcement
// surface for per-line numeric `minimum: 0` constraint.
// ---------------------------------------------------------------------------
async function parseBillWithHaikuToolUse(
  client: Anthropic,
  ocrText: string,
  documentId: string,
  userId: string,
  billType: "eob" | "itemized_bill",
  extractionMethod: ExtractionMethod,
  inputTokens: number,
  maxTokens: number,
): Promise<ParsedBill | null> {
  try {
    let response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      tools: [
        {
          name: BILL_PARSER_TOOL_NAME,
          description: BILL_PARSER_TOOL_DESCRIPTION,
          input_schema: BILL_PARSER_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          cache_control: { type: "ephemeral" },
        },
      ],
      tool_choice: { type: "tool", name: BILL_PARSER_TOOL_NAME },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
          { type: "text", text: "\n\n" + ocrText },
        ],
      }],
    });

    if (response.stop_reason === "max_tokens" && maxTokens < HAIKU_MAX_OUTPUT) {
      console.warn(`[haiku-bill-parser:tool] Output truncated at ${maxTokens}; retrying at ${HAIKU_MAX_OUTPUT}`);
      response = await client.messages.create({
        model: MODEL,
        max_tokens: HAIKU_MAX_OUTPUT,
        temperature: 0,
        tools: [
          {
            name: BILL_PARSER_TOOL_NAME,
            description: BILL_PARSER_TOOL_DESCRIPTION,
            input_schema: BILL_PARSER_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
            cache_control: { type: "ephemeral" },
          },
        ],
        tool_choice: { type: "tool", name: BILL_PARSER_TOOL_NAME },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
            { type: "text", text: "\n\n" + ocrText },
          ],
        }],
      });
      if (response.stop_reason === "max_tokens") {
        console.error(`[haiku-bill-parser:tool] Output truncated even at ${HAIKU_MAX_OUTPUT}; document too large`);
        await recordBillTruncation({
          documentId,
          userId,
          billType,
          inputTokensEstimate: inputTokens,
          maxTokensAttempted: HAIKU_MAX_OUTPUT,
          ocrTextLength: ocrText.length,
        });
        return null;
      }
    }

    // Tool-use response: model emits a `tool_use` content block with `input`
    // already-parsed-JSON. No parseHaikuJSON needed; the API validated the
    // shape against BILL_PARSER_TOOL_INPUT_SCHEMA before returning.
    const toolUseBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      console.error("[haiku-bill-parser:tool] No tool_use block in response");
      return null;
    }
    const result = toolUseBlock.input as HaikuRawResult;
    if (!result || !Array.isArray(result.lineItems ?? result.line_items)) {
      console.error("[haiku-bill-parser:tool] Invalid tool input shape");
      return null;
    }

    const rawLineItems = result.lineItems ?? result.line_items ?? [];
    const claimServiceDate = result.service_date ?? result.serviceDate ?? new Date().toISOString().split("T")[0];
    const arithmeticGuardEnabled = await isFeatureEnabled("bill_parser_arithmetic_check");

    const lineItems: BillLineItem[] = rawLineItems.map((item, idx) => {
      const procedureCode = String(item.procedure_code ?? item.procedureCode ?? "");
      const billedAmount = Number(item.billed_amount ?? item.billedAmount ?? 0);
      const lineServiceDate = String(item.service_date ?? item.serviceDate ?? claimServiceDate);
      return {
        lineNumber: idx + 1,
        line_number_in_eob: item.line_number_in_eob ? String(item.line_number_in_eob) : undefined,
        procedureCode,
        procedureCodeType: reconcileHaikuCodeType(
          procedureCode,
          (item.procedureCodeType ?? item.procedure_code_type) as ProcedureCodeType | undefined,
        ),
        revenueCode: (item.revenue_code as string | undefined) ?? (item.revenueCode as string | undefined),
        description: String(item.description ?? "Medical service"),
        category: procedureCode ? categorizeProcedureCode(procedureCode) : "Medical Service",
        serviceDate: lineServiceDate,
        quantity: Number(item.quantity ?? 1),
        billedAmount,
        allowedAmount: numOrUndef(item.allowed_amount ?? item.allowedAmount),
        insurancePaid: numOrUndef(item.insurance_paid ?? item.insurancePaid),
        patientResponsibility: numOrUndef(item.patient_responsibility ?? item.patientResponsibility),
        patient_paid: numOrUndef(item.patient_paid ?? item.patientPaid),
        adjustments: numOrUndef(item.adjustments),
        modifier: item.modifier as string | undefined,
        paid_date: item.paid_date as string | undefined,
        claim_line_status: item.claim_line_status as BillLineItem["claim_line_status"],
        denied_amount: numOrUndef(item.denied_amount),
        contract_discount: numOrUndef(item.contract_discount),
        ins_adjusted: numOrUndef(item.ins_adjusted),
        provider_adjusted: numOrUndef(item.provider_adjusted),
        cob_allowed: numOrUndef(item.cob_allowed),
        cob_paid: numOrUndef(item.cob_paid),
        cob_payer_id: item.cob_payer_id as string | undefined,
        tax_paid: numOrUndef(item.tax_paid),
        interest_paid: numOrUndef(item.interest_paid),
        member_copay: numOrUndef(item.member_copay),
        member_coinsurance: numOrUndef(item.member_coinsurance),
        member_applied_to_deductible: numOrUndef(item.member_applied_to_deductible),
        network_status: (item.network_status ?? result.network_status) as BillLineItem["network_status"],
        carc_codes: Array.isArray(item.carc_codes) ? (item.carc_codes as string[]) : undefined,
        rarc_codes: Array.isArray(item.rarc_codes) ? (item.rarc_codes as string[]) : undefined,
        ex_codes: Array.isArray(item.ex_codes) ? (item.ex_codes as ExCode[]) : undefined,
        rendering_provider_npi: item.rendering_provider_npi as string | undefined,
        rendering_provider_name: item.rendering_provider_name as string | undefined,
      };
    });

    const filteredLineItems = arithmeticGuardEnabled
      ? lineItems.filter((li) => {
          const check = lineIsImplausible(li);
          if (check.dropped) {
            console.warn(`[haiku-bill-parser:tool] Dropped line ${li.lineNumber} (code=${li.procedureCode}): ${check.reason}`);
          }
          return !check.dropped;
        })
      : lineItems;

    const totals = result.totals ?? {};
    const parsedBill: ParsedBill = {
      id: randomUUID(),
      documentId,
      userId,
      billType,
      provider: {
        name: result.provider?.name ?? "Unknown Provider",
        npi: result.provider?.npi,
        address: result.provider?.address,
      },
      patient: {
        name: result.patient?.name ?? "Unknown",
        memberId: result.patient?.memberId ?? result.patient?.member_id,
        groupNumber: result.patient?.groupNumber ?? result.patient?.group_number,
      },
      insurer: result.insurer
        ? {
            name: result.insurer.name ?? "",
            planName: result.insurer.planName ?? result.insurer.plan_name,
            accountNumber: result.insurer.accountNumber ?? result.insurer.account_number,
          }
        : undefined,
      serviceDate: claimServiceDate,
      lineItems: filteredLineItems,
      totals: {
        totalBilled: numOrZero(totals.total_billed) || filteredLineItems.reduce((s, li) => s + li.billedAmount, 0),
        totalAllowed: numOrUndef(totals.total_allowed),
        totalInsurancePaid: numOrUndef(totals.total_insurance_paid),
        totalPatientResponsibility: numOrUndef(totals.total_patient_responsibility),
        totalPatientPaid: numOrUndef(totals.total_patient_paid ?? totals.totalPatientPaid),
        totalAdjustments: numOrUndef(totals.total_adjustments),
        totalDenied: numOrUndef(totals.total_denied),
        totalContractDiscount: numOrUndef(totals.total_contract_discount),
        totalInsAdjusted: numOrUndef(totals.total_ins_adjusted),
        totalProviderAdjusted: numOrUndef(totals.total_provider_adjusted),
      },
      rawText: ocrText,
      confidence: 0.85,
      parseErrors: [],
      external_claim_number: (result.claim_number ?? result.external_claim_number) as string | undefined,
      eob_date: result.eob_date,
      network_status: result.network_status,
      accumulators: Array.isArray(result.accumulators) ? result.accumulators : undefined,
      parserPath: "tool_use",
    };

    if (billType === "eob") {
      const post = applyEOBPostProcess(parsedBill, result._meta, {
        rawDocText: ocrText,
        extractionMethod,
      });
      console.log(
        `[haiku-bill-parser:tool] post-process: ${post.pairsFound} reversal pair(s); accumulators ${post.accumulatorsChanged ? "merged" : "ok"}; ${post.metaWarnings.length} meta warning(s); ${post.accumulatorWarnings.length} accumulator warning(s); ${post.excerptVerificationWarnings.length} excerpt warning(s); ${post.sectionRangesFound} section range(s) found`
      );
      const allWarnings = [...post.metaWarnings, ...post.accumulatorWarnings, ...post.excerptVerificationWarnings];
      if (allWarnings.length) {
        parsedBill.parseErrors.push(...allWarnings);
      }
    }

    console.log(
      `[haiku-bill-parser:tool] Extracted ${lineItems.length} line items, total billed $${parsedBill.totals.totalBilled}; usage in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
    );
    return parsedBill;
  } catch (err) {
    console.error("[haiku-bill-parser:tool] Extraction failed:", err);
    return null;
  }
}

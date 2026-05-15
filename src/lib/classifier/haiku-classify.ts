/**
 * Haiku-powered document classification.
 * Replaces the regex classifier for authoritative classification
 * in the chunked processing pipeline.
 *
 * Uses the first ~3,000 chars of OCR text — fast and cheap (~$0.001/call).
 *
 * S94 B5: on JSON parse failure, return `source: 'haiku_unavailable'` so the
 * caller (process-chunk route) can decide whether to fall back to the regex
 * classifier on full OCR or to the user's pick. Previously, the catch block
 * silently returned the user's pick — which masked a misclassified SBC and
 * let the bill parser hallucinate CPT codes from page numbers. See mig 104.
 *
 * Uses parseHaikuJSON (S94 B1's shared balanced-block + jsonrepair helper).
 */

import Anthropic from "@anthropic-ai/sdk";
import { parseHaikuJSON } from "@/lib/parser/safe-json";

const VALID_TYPES = ["sbc", "plan_document", "eoc", "eob", "itemized_bill", "insurance_card", "other"] as const;
type DocType = typeof VALID_TYPES[number];

export type ClassifySource = "haiku" | "haiku_unavailable";

export interface HaikuClassification {
  classifiedType: DocType;
  confidence: number;
  isHealthcareDocument: boolean;
  source: ClassifySource;
}

export async function classifyWithHaiku(
  ocrText: string,
  fileName: string,
  userSelectedType?: string
): Promise<HaikuClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[haiku-classify] No API key — signaling haiku_unavailable");
    return {
      classifiedType: (userSelectedType as DocType) || "other",
      confidence: 0.5,
      isHealthcareDocument: true,
      source: "haiku_unavailable",
    };
  }

  const client = new Anthropic({ apiKey });
  const sample = ocrText.slice(0, 3000);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `Classify this document. Is it a healthcare/insurance document? If yes, what type?

Types:
- "sbc" — Summary of Benefits and Coverage (standardized 8-page ACA-mandated summary)
- "plan_document" — Plan certificate, benefits booklet, or short benefits summary (typically 10-50 pages); LACKS the section-richness of an EOC
- "eoc" — Evidence of Coverage / Member Handbook (full regulatory plan document, typically 100-300 pages, with multiple priority sections: Prior Authorization Code List, Medical Necessity Criteria, Internal/External Appeals Procedures, Coordination of Benefits, Eligibility/COBRA/Special Enrollment, Definitions). Distinguishing signals from plan_document: longer (30+ pages of OCR text), has prior-auth code tables, has formal medical necessity criteria sections, ERISA SPD or Knox-Keene phrasing
- "eob" — Explanation of Benefits (post-claim statement from insurer)
- "itemized_bill" — Itemized medical bill with procedure codes
- "insurance_card" — Insurance ID card
- "other" — Not a healthcare document

File name: ${fileName}
${userSelectedType ? `User said this is: ${userSelectedType}` : ""}

Return ONLY a JSON object: { "type": "...", "confidence": 0.0-1.0, "isHealthcare": true/false }

Document text (first 3000 chars):
${sample}`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // S94 B5 — parse failure → haiku_unavailable so fallback in process-chunk
    // can re-classify on full OCR text instead of silently trusting user pick.
    // parseHaikuJSON (S94 B1) handles balanced-block extraction + jsonrepair.
    let result: { type?: string; confidence?: number; isHealthcare?: boolean };
    try {
      result = parseHaikuJSON<{ type?: string; confidence?: number; isHealthcare?: boolean }>(text);
    } catch (parseErr) {
      console.error(
        `[haiku-classify] parseHaikuJSON failed. Raw response (first 200 chars): ${text.slice(0, 200)} — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
      return {
        classifiedType: (userSelectedType as DocType) || "other",
        confidence: 0.5,
        isHealthcareDocument: true,
        source: "haiku_unavailable",
      };
    }

    const docType: DocType = (result.type && (VALID_TYPES as readonly string[]).includes(result.type))
      ? (result.type as DocType)
      : "other";

    console.log(`[haiku-classify] type=${docType} confidence=${result.confidence} isHealthcare=${result.isHealthcare}`);

    return {
      classifiedType: docType,
      confidence: result.confidence ?? 0.8,
      isHealthcareDocument: result.isHealthcare ?? true,
      source: "haiku",
    };
  } catch (err) {
    console.error("[haiku-classify] Classification failed:", err);
    return {
      classifiedType: (userSelectedType as DocType) || "other",
      confidence: 0.5,
      isHealthcareDocument: true,
      source: "haiku_unavailable",
    };
  }
}

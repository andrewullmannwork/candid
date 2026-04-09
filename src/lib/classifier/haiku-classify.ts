/**
 * Haiku-powered document classification.
 * Replaces the regex classifier for authoritative classification
 * in the chunked processing pipeline.
 *
 * Uses the first ~2,000 chars of OCR text — fast and cheap (~$0.001/call).
 */

import Anthropic from "@anthropic-ai/sdk";

const VALID_TYPES = ["sbc", "plan_document", "eob", "itemized_bill", "insurance_card", "other"] as const;
type DocType = typeof VALID_TYPES[number];

interface HaikuClassification {
  classifiedType: DocType;
  confidence: number;
  isHealthcareDocument: boolean;
}

export async function classifyWithHaiku(
  ocrText: string,
  fileName: string,
  userSelectedType?: string
): Promise<HaikuClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[haiku-classify] No API key — falling back to user-selected type");
    return {
      classifiedType: (userSelectedType as DocType) || "other",
      confidence: 0.5,
      isHealthcareDocument: true,
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
- "sbc" — Summary of Benefits and Coverage (standardized 8-page document)
- "plan_document" — Full plan certificate or benefits booklet (detailed, often 30+ pages)
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
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const result = JSON.parse(jsonStr);

    const docType = VALID_TYPES.includes(result.type) ? result.type as DocType : "other";

    console.log(`[haiku-classify] type=${docType} confidence=${result.confidence} isHealthcare=${result.isHealthcare}`);

    return {
      classifiedType: docType,
      confidence: result.confidence ?? 0.8,
      isHealthcareDocument: result.isHealthcare ?? true,
    };
  } catch (err) {
    console.error("[haiku-classify] Classification failed:", err);
    return {
      classifiedType: (userSelectedType as DocType) || "other",
      confidence: 0.5,
      isHealthcareDocument: true,
    };
  }
}

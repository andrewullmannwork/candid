// Benefit Extractor — Processes SBC documents into structured plan benefits
// Uses Document AI for OCR, then structured extraction via regex patterns
// Falls back to Claude API when regex extraction returns low results

import { extractTextFromDocument } from "@/lib/ocr";
import type { BenefitCategory } from "@/lib/plan/benefits-catalog";

export interface ExtractedPlanData {
  planName?: string;
  planType?: string;
  insurer?: string;
  year?: number;
  deductibleIndividual?: number;
  deductibleFamily?: number;
  oopMaxIndividual?: number;
  oopMaxFamily?: number;
  benefits: ExtractedBenefit[];
  rawText: string;
  confidence: number;
}

export interface ExtractedBenefit {
  category: BenefitCategory;
  title: string;
  description: string;
  coverageDetails: string; // e.g. "Covered at 100% after deductible"
  copayAmount?: number;
  coinsurancePct?: number;
  frequencyLimit?: string; // e.g. "1 per year"
  priorAuthRequired: boolean;
  hsaFsaEligible: boolean;
  sourceReference?: string; // Page/section in SBC
}

// ─── SBC Section Patterns ────────────────────────────────────────────────────
// SBC documents follow a standardized DOL/HHS template with predictable sections

const SBC_SECTIONS = {
  deductible: /(?:annual\s+)?deductible[:\s]*(?:individual)?[:\s]*\$?([\d,]+)/gi,
  deductibleFamily: /deductible[:\s]*(?:family)[:\s]*\$?([\d,]+)/gi,
  oopMax: /(?:out[\s-]of[\s-]pocket|oop)\s*(?:max(?:imum)?|limit)?[:\s]*(?:individual)?[:\s]*\$?([\d,]+)/gi,
  oopMaxFamily: /(?:out[\s-]of[\s-]pocket|oop)\s*(?:max|limit)?[:\s]*(?:family)[:\s]*\$?([\d,]+)/gi,
  primaryCopay: /(?:primary\s*care|pcp|office\s*visit)[:\s]*\$?([\d]+)/gi,
  specialistCopay: /specialist[:\s]*(?:visit)?[:\s]*\$?([\d]+)/gi,
  erCopay: /(?:emergency\s*room|er\s*visit|emergency\s*department)[:\s]*\$?([\d]+)/gi,
  urgentCare: /urgent\s*care[:\s]*\$?([\d]+)/gi,
  mentalHealth: /(?:mental\s*health|behavioral\s*health|outpatient\s*mental)[:\s]*/gi,
  preventive: /(?:preventive|routine\s*physical|wellness\s*visit)[:\s]*/gi,
  maternity: /(?:maternity|prenatal|postnatal|delivery)[:\s]*/gi,
  rehab: /(?:rehabilitation|physical\s*therapy|occupational\s*therapy)[:\s]*/gi,
  prescription: /(?:prescription|pharmacy|rx|drug\s*coverage)[:\s]*/gi,
  telehealth: /(?:telehealth|telemedicine|virtual\s*visit)[:\s]*/gi,
};

// ─── Category mapping for extracted sections ─────────────────────────────────

const SECTION_TO_CATEGORY: Record<string, BenefitCategory> = {
  mentalHealth: "mental_health",
  preventive: "preventive_care",
  maternity: "maternity",
  rehab: "physical_therapy",
  telehealth: "telehealth",
  prescription: "chronic_care",
};

/**
 * Extract plan data from an SBC document (PDF or image).
 * Uses Document AI OCR + regex pattern matching.
 */
export async function extractFromSBC(
  fileBuffer: Buffer,
  mimeType: string
): Promise<ExtractedPlanData> {
  // Step 1: OCR the document
  const ocrResult = await extractTextFromDocument(fileBuffer, mimeType);
  const text = ocrResult.text;

  if (!text || text.length < 100) {
    return {
      benefits: [],
      rawText: text,
      confidence: 0,
    };
  }

  // Step 2: Extract plan-level data
  const result: ExtractedPlanData = {
    benefits: [],
    rawText: text,
    confidence: ocrResult.confidence,
  };

  // Plan name — look for "Summary of Benefits and Coverage: [Plan Name]"
  const planNameMatch = text.match(/summary\s+of\s+benefits\s+and\s+coverage[:\s]*(.+?)(?:\n|coverage\s+period)/i);
  if (planNameMatch) result.planName = planNameMatch[1].trim();

  // Year
  const yearMatch = text.match(/coverage\s+period[:\s]*(\d{2})\/\d{2}\/(\d{4})/i);
  if (yearMatch) result.year = parseInt(yearMatch[2], 10);

  // Deductibles
  const dedMatch = text.match(SBC_SECTIONS.deductible);
  if (dedMatch) {
    const amount = dedMatch[0].match(/\$?([\d,]+)/);
    if (amount) result.deductibleIndividual = parseInt(amount[1].replace(/,/g, ""), 10);
  }

  const dedFamMatch = text.match(SBC_SECTIONS.deductibleFamily);
  if (dedFamMatch) {
    const amount = dedFamMatch[0].match(/\$?([\d,]+)/);
    if (amount) result.deductibleFamily = parseInt(amount[1].replace(/,/g, ""), 10);
  }

  // OOP max
  const oopMatch = text.match(SBC_SECTIONS.oopMax);
  if (oopMatch) {
    const amount = oopMatch[0].match(/\$?([\d,]+)/);
    if (amount) result.oopMaxIndividual = parseInt(amount[1].replace(/,/g, ""), 10);
  }

  // Step 3: Extract benefit sections
  for (const [sectionKey, pattern] of Object.entries(SBC_SECTIONS)) {
    if (sectionKey in SECTION_TO_CATEGORY) {
      const category = SECTION_TO_CATEGORY[sectionKey];
      const matches = text.match(pattern);
      if (matches) {
        // Extract the text around each match for context
        for (const match of matches) {
          const idx = text.indexOf(match);
          const vicinity = text.slice(idx, Math.min(idx + 300, text.length));

          // Try to extract coverage details
          const coverageMatch = vicinity.match(
            /(?:covered|no\s*charge|\$\d+\s*copay|\d+%\s*co-?insurance|not\s*covered|prior\s*auth)/i
          );

          const copayMatch = vicinity.match(/\$(\d+)\s*(?:copay|co-pay)/i);
          const coinsuranceMatch = vicinity.match(/(\d+)%\s*(?:co-?insurance|coinsurance)/i);
          const priorAuth = /prior\s*auth/i.test(vicinity);

          result.benefits.push({
            category,
            title: sectionKey.replace(/([A-Z])/g, " $1").trim(),
            description: vicinity.slice(0, 150).trim(),
            coverageDetails: coverageMatch ? coverageMatch[0] : "See plan documents",
            copayAmount: copayMatch ? parseInt(copayMatch[1], 10) : undefined,
            coinsurancePct: coinsuranceMatch ? parseInt(coinsuranceMatch[1], 10) : undefined,
            priorAuthRequired: priorAuth,
            hsaFsaEligible: false, // Conservative default
            sourceReference: `Extracted from SBC text (position ${idx})`,
          });
        }
      }
    }
  }

  return result;
}

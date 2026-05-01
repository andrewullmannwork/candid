// Document type classifier — keyword/regex scoring to auto-detect document type
// Runs on OCR text output and returns predicted type with confidence

export type ClassifiedDocType =
  | "eob"
  | "itemized_bill"
  | "sbc"
  | "insurance_card"
  | "plan_document"
  | "eoc" // Phase 3.1A — Evidence of Coverage (full regulatory plan doc; section-aware Haiku extraction)
  | "other";

export interface ClassificationResult {
  classifiedType: ClassifiedDocType;
  confidence: number; // 0-1
  signals: ClassificationSignals;
  mismatch: boolean; // true if classifiedType !== userSelectedType
}

export interface ClassificationSignals {
  matchedKeywords: string[];
  scoreBreakdown: Record<ClassifiedDocType, number>;
  textLength: number;
}

// ── Keyword patterns per document type ─────────────────────────────────────────

interface SignalPattern {
  pattern: RegExp;
  weight: number;
  label: string;
}

const SBC_SIGNALS: SignalPattern[] = [
  { pattern: /summary\s+of\s+benefits\s+and\s+coverage/i, weight: 30, label: "SBC title" },
  { pattern: /what\s+you\s+will\s+pay/i, weight: 15, label: "What You Will Pay" },
  { pattern: /common\s+medical\s+event/i, weight: 15, label: "Common Medical Event" },
  { pattern: /important\s+questions/i, weight: 10, label: "Important Questions" },
  { pattern: /coverage\s+examples?/i, weight: 10, label: "Coverage Examples" },
  { pattern: /in[- ]network\s+provider/i, weight: 8, label: "In-Network Provider" },
  { pattern: /out[- ]of[- ]network\s+provider/i, weight: 8, label: "Out-of-Network Provider" },
  { pattern: /overall\s+deductible/i, weight: 8, label: "Overall Deductible" },
  { pattern: /out[- ]of[- ]pocket\s+limit/i, weight: 6, label: "Out-of-Pocket Limit" },
  { pattern: /services\s+you\s+may\s+need/i, weight: 10, label: "Services You May Need" },
  { pattern: /excluded\s+services/i, weight: 8, label: "Excluded Services" },
  { pattern: /minimum\s+essential\s+coverage/i, weight: 8, label: "Minimum Essential Coverage" },
  { pattern: /minimum\s+value\s+standard/i, weight: 6, label: "Minimum Value Standard" },
  { pattern: /coverage\s+period[:\s]*\d{2}\/\d{2}\/\d{4}/i, weight: 10, label: "Coverage Period" },
  { pattern: /plan\s+type[:\s]*(hmo|ppo|epo|pos|oap|hdhp)/i, weight: 8, label: "Plan Type" },
];

const EOB_SIGNALS: SignalPattern[] = [
  { pattern: /explanation\s+of\s+benefits/i, weight: 30, label: "EOB title" },
  { pattern: /this\s+is\s+not\s+a\s+bill/i, weight: 25, label: "This is not a bill" },
  { pattern: /claim\s+number/i, weight: 12, label: "Claim Number" },
  { pattern: /amount\s+billed/i, weight: 10, label: "Amount Billed" },
  { pattern: /plan\s+paid/i, weight: 10, label: "Plan Paid" },
  { pattern: /your\s+responsibility/i, weight: 8, label: "Your Responsibility" },
  { pattern: /allowed\s+amount/i, weight: 8, label: "Allowed Amount" },
  { pattern: /date\s+of\s+service/i, weight: 6, label: "Date of Service" },
  { pattern: /provider\s+name/i, weight: 4, label: "Provider Name" },
  { pattern: /patient\s+name/i, weight: 4, label: "Patient Name" },
  { pattern: /coinsurance/i, weight: 3, label: "Coinsurance" },
  { pattern: /deductible\s+applied/i, weight: 6, label: "Deductible Applied" },
  { pattern: /member\s+id/i, weight: 4, label: "Member ID" },
];

const ITEMIZED_BILL_SIGNALS: SignalPattern[] = [
  { pattern: /itemized\s+(?:statement|bill)/i, weight: 25, label: "Itemized Statement" },
  { pattern: /\b\d{5}(?:\s*[-–]\s*\d{2})?\b/g, weight: 8, label: "CPT code (5-digit)" }, // CPT codes
  { pattern: /total\s+charges/i, weight: 12, label: "Total Charges" },
  { pattern: /amount\s+due/i, weight: 10, label: "Amount Due" },
  { pattern: /statement\s+date/i, weight: 8, label: "Statement Date" },
  { pattern: /patient\s+account/i, weight: 8, label: "Patient Account" },
  { pattern: /\bNPI[:\s]*\d{10}\b/i, weight: 10, label: "NPI number" },
  { pattern: /revenue\s+code/i, weight: 10, label: "Revenue Code" },
  { pattern: /\b0\d{3}\b/g, weight: 4, label: "Revenue code (4-digit)" },
  { pattern: /service\s+description/i, weight: 6, label: "Service Description" },
  { pattern: /quantity/i, weight: 3, label: "Quantity" },
  { pattern: /balance\s+(?:due|forward)/i, weight: 8, label: "Balance Due" },
  { pattern: /insurance\s+payment/i, weight: 6, label: "Insurance Payment" },
];

const INSURANCE_CARD_SIGNALS: SignalPattern[] = [
  { pattern: /member\s*id/i, weight: 15, label: "Member ID" },
  { pattern: /group\s*(?:#|number|no)/i, weight: 15, label: "Group Number" },
  { pattern: /rx\s*bin/i, weight: 20, label: "Rx BIN" },
  { pattern: /rx\s*pcn/i, weight: 20, label: "Rx PCN" },
  { pattern: /payer\s*id/i, weight: 15, label: "Payer ID" },
  { pattern: /copay/i, weight: 5, label: "Copay" },
  { pattern: /plan\s*code/i, weight: 10, label: "Plan Code" },
];

const PLAN_DOC_SIGNALS: SignalPattern[] = [
  { pattern: /certificate\s+of\s+(?:coverage|insurance)/i, weight: 25, label: "Certificate of Coverage" },
  { pattern: /table\s+of\s+contents/i, weight: 12, label: "Table of Contents" },
  { pattern: /covered\s+expenses/i, weight: 10, label: "Covered Expenses" },
  { pattern: /exclusions,?\s+expenses?\s+not\s+covered/i, weight: 15, label: "Exclusions section" },
  { pattern: /coordination\s+of\s+benefits/i, weight: 10, label: "Coordination of Benefits" },
  { pattern: /cobra\s+continuation/i, weight: 8, label: "COBRA" },
  { pattern: /erisa\s+required\s+information/i, weight: 12, label: "ERISA info" },
  { pattern: /prior\s+authorization/i, weight: 6, label: "Prior Authorization" },
  { pattern: /benefit\s+highlights/i, weight: 10, label: "Benefit Highlights" },
  { pattern: /the\s+schedule/i, weight: 6, label: "The Schedule" },
  { pattern: /policyholder/i, weight: 8, label: "Policyholder" },
  { pattern: /group\s+policy/i, weight: 8, label: "Group Policy" },
];

// Phase 3.1A — EOC signals discriminate from plan_document via section-richness +
// length signals. EOCs are typically 100-300 pages with multiple priority sections;
// plan_documents are shorter (30-100 pages) with less section structure. Section
// vocabulary signals get higher weight than plan_document equivalents.
const EOC_SIGNALS: SignalPattern[] = [
  { pattern: /evidence\s+of\s+coverage/i, weight: 30, label: "Evidence of Coverage" },
  { pattern: /member\s+handbook/i, weight: 25, label: "Member Handbook" },
  { pattern: /prior\s+authorization\s+(?:code\s+)?(?:list|requirements)/i, weight: 20, label: "PA Code List" },
  { pattern: /medical\s+necessity\s+(?:criteria|guidelines|requirements)/i, weight: 18, label: "Medical Necessity Criteria" },
  { pattern: /medically\s+necessary\s+(?:criteria|services)/i, weight: 15, label: "Medically Necessary" },
  { pattern: /internal\s+(?:and\s+external\s+)?(?:review|appeal)/i, weight: 12, label: "Internal/External Review" },
  { pattern: /independent\s+review\s+organization/i, weight: 10, label: "IRO" },
  { pattern: /grievance\s+procedures/i, weight: 8, label: "Grievance Procedures" },
  { pattern: /qualifying\s+(?:life\s+)?event/i, weight: 8, label: "Qualifying Life Event" },
  { pattern: /special\s+enrollment\s+period/i, weight: 8, label: "Special Enrollment" },
  { pattern: /knox[- ]keene/i, weight: 12, label: "Knox-Keene (CA HMO)" },
  { pattern: /summary\s+plan\s+description/i, weight: 15, label: "SPD (ERISA)" },
];

// ── Classification engine ──────────────────────────────────────────────────────

function scorePatterns(text: string, patterns: SignalPattern[]): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];

  for (const { pattern, weight, label } of patterns) {
    // For global patterns (CPT codes, revenue codes), count matches
    if (pattern.global) {
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        // Cap at 5 matches to avoid over-weighting
        score += weight * Math.min(matches.length, 5);
        matched.push(`${label} (x${matches.length})`);
      }
    } else {
      if (pattern.test(text)) {
        score += weight;
        matched.push(label);
      }
    }
  }

  return { score, matched };
}

/**
 * Classify a document based on its OCR text content.
 * Returns the predicted document type, confidence, and matched signals.
 */
export function classifyDocument(input: {
  text: string;
  fileName?: string;
  userSelectedType?: string;
}): ClassificationResult {
  const { text, fileName, userSelectedType } = input;
  const matchedKeywords: string[] = [];

  // Score each document type
  const sbcResult = scorePatterns(text, SBC_SIGNALS);
  const eobResult = scorePatterns(text, EOB_SIGNALS);
  const billResult = scorePatterns(text, ITEMIZED_BILL_SIGNALS);
  const cardResult = scorePatterns(text, INSURANCE_CARD_SIGNALS);
  const planDocResult = scorePatterns(text, PLAN_DOC_SIGNALS);
  const eocResult = scorePatterns(text, EOC_SIGNALS);

  const scoreBreakdown: Record<ClassifiedDocType, number> = {
    sbc: sbcResult.score,
    eob: eobResult.score,
    itemized_bill: billResult.score,
    insurance_card: cardResult.score,
    plan_document: planDocResult.score,
    eoc: eocResult.score,
    other: 0,
  };

  // Insurance card heuristic: very short text is a strong signal
  if (text.length < 500 && cardResult.score > 0) {
    scoreBreakdown.insurance_card += 30;
  }

  // EOC heuristic: long documents (≥30K chars ≈ 30+ pages OCR'd) with section-rich
  // signals are high-confidence EOC. Short docs with only "Evidence of Coverage" title
  // could be promotional summaries — don't promote without supporting section signals.
  if (text.length >= 30000 && eocResult.score >= 30) {
    scoreBreakdown.eoc += 20;
  }

  // File name hints
  if (fileName) {
    const fn = fileName.toLowerCase();
    if (/sbc|summary.of.benefits/i.test(fn)) scoreBreakdown.sbc += 15;
    if (/eob|explanation.of.benefits/i.test(fn)) scoreBreakdown.eob += 15;
    if (/itemized|bill|statement/i.test(fn)) scoreBreakdown.itemized_bill += 15;
    if (/card|id.card/i.test(fn)) scoreBreakdown.insurance_card += 15;
    if (/plan|certificate|benefits/i.test(fn)) scoreBreakdown.plan_document += 10;
    if (/\beoc\b|evidence.of.coverage|member.handbook/i.test(fn)) scoreBreakdown.eoc += 15;
  }

  // Collect all matched keywords
  matchedKeywords.push(
    ...sbcResult.matched,
    ...eobResult.matched,
    ...billResult.matched,
    ...cardResult.matched,
    ...planDocResult.matched,
    ...eocResult.matched,
  );

  // Find winner
  const entries = Object.entries(scoreBreakdown) as [ClassifiedDocType, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = entries[0];
  const secondScore = entries[1]?.[1] ?? 0;

  // Confidence: how much the top score dominates
  const totalScore = entries.reduce((sum, [, s]) => sum + s, 0);
  const confidence = totalScore > 0
    ? Math.min(topScore / totalScore, 1)
    : 0;

  // If no signals at all, classify as "other"
  const classifiedType = topScore === 0 ? "other" : topType;

  // Check mismatch
  const mismatch = userSelectedType
    ? classifiedType !== userSelectedType && classifiedType !== "other"
    : false;

  return {
    classifiedType,
    confidence: Math.round(confidence * 100) / 100,
    signals: {
      matchedKeywords,
      scoreBreakdown,
      textLength: text.length,
    },
    mismatch,
  };
}

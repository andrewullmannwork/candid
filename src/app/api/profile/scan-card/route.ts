import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { extractTextFromDocument } from "@/lib/ocr";
import { matchPlan, normalizeInsurerName } from "@/lib/plan/matcher";
import { createServerClient } from "@/lib/supabase/server";
import type { MatchResult } from "@/lib/plan/matcher";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export interface InsuranceCardFields {
  insurer?: string;
  planName?: string;
  planType?: string;
  groupNumber?: string;
  memberId?: string;
  copayPrimary?: number;
  copaySpecialist?: number;
  copayEr?: number;
  copayUrgentCare?: number;
  copayRx?: number;
  deductibleIndividual?: number;
  oopMaxIndividual?: number;
  coinsurancePct?: number;
  rxBin?: string;
  rxPcn?: string;
  rxGroup?: string;
  networkName?: string;
  rawText: string;
}

// ── Insurer detection ──────────────────────────────────────────────────────────

const INSURER_PATTERNS: [RegExp, string][] = [
  // Major nationals
  [/united\s*health(?:care)?|uhc\b/i, "UnitedHealthcare"],
  [/anthem/i, "Anthem / Blue Cross Blue Shield"],
  [/blue\s*cross(?:\s*(?:and|&)\s*blue\s*shield)?|bcbs/i, "Anthem / Blue Cross Blue Shield"],
  [/cigna/i, "Cigna"],
  [/aetna/i, "Aetna"],
  [/kaiser\s*permanente|kaiser\b/i, "Kaiser Permanente"],
  [/humana/i, "Humana"],
  [/molina/i, "Molina Healthcare"],
  [/oscar\s*health/i, "Oscar Health"],
  // Regional BCBS affiliates
  [/florida\s*blue/i, "Anthem / Blue Cross Blue Shield"],
  [/horizon\s*(?:bcbs|blue)/i, "Anthem / Blue Cross Blue Shield"],
  [/highmark/i, "Anthem / Blue Cross Blue Shield"],
  [/independence\s*blue/i, "Anthem / Blue Cross Blue Shield"],
  [/carefirst/i, "Anthem / Blue Cross Blue Shield"],
  [/regence/i, "Anthem / Blue Cross Blue Shield"],
  [/premera/i, "Anthem / Blue Cross Blue Shield"],
  [/wellmark/i, "Anthem / Blue Cross Blue Shield"],
  [/excellus/i, "Anthem / Blue Cross Blue Shield"],
  // Centene family
  [/centene|ambetter|wellcare/i, "Centene"],
  [/health\s*net/i, "Centene"],
  // Others
  [/hcsc|health\s*care\s*service/i, "HCSC"],
  [/medica\b/i, "Medica"],
  [/harvard\s*pilgrim|point32/i, "Harvard Pilgrim"],
  [/bright\s*health/i, "Bright Health"],
  [/priority\s*health/i, "Priority Health"],
  [/tricare/i, "TRICARE"],
  [/cigna/i, "Cigna"],
];

// ── Plan type detection ────────────────────────────────────────────────────────

const PLAN_TYPE_PATTERNS: [RegExp, string][] = [
  [/\bHMO\b/i, "HMO"],
  [/\bPPO\b/i, "PPO"],
  [/\bEPO\b/i, "EPO"],
  [/\bHDHP\b/i, "HDHP"],
  [/\bOAP\b/i, "PPO"],         // Open Access Plus → PPO family
  [/\bPOS\b(?:\s*II)?/i, "PPO"], // POS / POS II
  [/\bCDHP\b/i, "HDHP"],       // Consumer Directed
  [/open\s*access\s*plus/i, "PPO"],
  [/choice\s*plus/i, "PPO"],
  [/medicare\s*advantage/i, "Medicare Advantage"],
  [/\bmedicare\b/i, "Medicare"],
  [/\bmedicaid\b/i, "Medicaid"],
];

// ── OCR text normalization ─────────────────────────────────────────────────────

function normalizeOcrText(text: string): string {
  return text
    // Normalize unicode dashes and quotes
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    // Strip common OCR pipe artifacts
    .replace(/\|/g, "l")
    // Normalize whitespace (but preserve newlines)
    .replace(/[^\S\n]+/g, " ")
    // Remove stray single characters that are OCR noise
    .replace(/(?<=\s)[|!\\](?=\s)/g, "")
    .trim();
}

// ── Dollar amount extraction ───────────────────────────────────────────────────

function extractDollarAmounts(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const idx = text.search(pattern);
      // Search a wider vicinity — labels and values may be separated
      const vicinity = text.slice(Math.max(0, idx - 30), idx + 150);
      // Match dollar amounts, handling "$XX/$YY" dual formats and comma-separated thousands
      const dollarMatch = vicinity.match(/\$\s*([\d,]{1,7}(?:\.\d{2})?)/);
      if (dollarMatch) {
        return parseFloat(dollarMatch[1].replace(/,/g, ""));
      }
      // Also try bare numbers near the pattern
      const bareMatch = vicinity.match(/(?:^|\s)(\d{1,5}(?:\.\d{2})?)(?:\s|$)/);
      if (bareMatch) {
        const val = parseFloat(bareMatch[1]);
        if (val > 0 && val < 50000) return val; // Sanity check
      }
    }
  }
  return undefined;
}

/**
 * Extract dual copay amounts like "$25/$50" or "$25 / $50"
 * Returns [primary, secondary] or undefined.
 */
function extractDualCopay(text: string, vicinity: string): [number, number] | undefined {
  const match = vicinity.match(/\$\s*(\d{1,4})\s*\/\s*\$?\s*(\d{1,4})/);
  if (match) {
    return [parseFloat(match[1]), parseFloat(match[2])];
  }
  return undefined;
}

// ── Main parser ────────────────────────────────────────────────────────────────

function parseInsuranceCard(rawText: string): InsuranceCardFields {
  const text = normalizeOcrText(rawText);
  const result: InsuranceCardFields = { rawText };

  // ── Insurer ──────────────────────────────────────────────────────────────
  for (const [pattern, name] of INSURER_PATTERNS) {
    if (pattern.test(text)) {
      result.insurer = name;
      break;
    }
  }

  // ── Plan type ────────────────────────────────────────────────────────────
  for (const [pattern, type] of PLAN_TYPE_PATTERNS) {
    if (pattern.test(text)) {
      result.planType = type;
      break;
    }
  }

  // ── Plan name ────────────────────────────────────────────────────────────
  // Try multiple patterns for plan name extraction
  const planNamePatterns = [
    /(?:plan\s*(?:name)?[:\s]+)([A-Za-z0-9 \-+/()]+?)(?:\n|$)/i,
    /(?:benefit\s*plan[:\s]+)([A-Za-z0-9 \-+/()]+?)(?:\n|$)/i,
    // Common plan name patterns that appear on cards
    /\b((?:Choice|Select|Premier|Preferred|Basic|Standard|Classic|Advantage|Essential|Complete)\s*(?:Plus|Pro|Gold|Silver|Bronze|Platinum)?(?:\s*(?:PPO|HMO|EPO|POS|OAP|HDHP))?)\b/i,
    /\b(Open\s*Access\s*Plus(?:\s*\w+)?)\b/i,
  ];

  for (const pattern of planNamePatterns) {
    const match = text.match(pattern);
    if (match) {
      result.planName = match[1].trim();
      break;
    }
  }

  // ── Group number ─────────────────────────────────────────────────────────
  const groupPatterns = [
    /(?:group\s*(?:no?\.?|number|#|id)?[:\s]+)([A-Z0-9\-]+)/i,
    /(?:grp\.?\s*(?:no?\.?|#)?[:\s]+)([A-Z0-9\-]+)/i,
    /(?:group\s*id[:\s]+)([A-Z0-9\-]+)/i,
  ];

  for (const pattern of groupPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.groupNumber = match[1].trim();
      break;
    }
  }

  // ── Member ID ────────────────────────────────────────────────────────────
  const memberPatterns = [
    /(?:member\s*(?:id|no?\.?|number|#)?[:\s]+)([A-Z0-9\-]+)/i,
    /(?:subscriber\s*(?:id|no?\.?|number|#)?[:\s]+)([A-Z0-9\-]+)/i,
    /(?:id\s*(?:no?\.?|#)?[:\s]+)([A-Z0-9\-]{5,})/i,
    /(?:identification\s*(?:no?\.?|number|#)?[:\s]+)([A-Z0-9\-]+)/i,
    // UHC-style: U followed by 9 digits
    /\b(U\d{9})\b/,
    // Generic: long alphanumeric string near "member" or "id" on card
    /(?:member|subscriber)\s*\n?\s*([A-Z0-9\-]{6,20})/i,
  ];

  for (const pattern of memberPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.memberId = match[1].trim();
      break;
    }
  }

  // ── Rx fields ────────────────────────────────────────────────────────────
  const rxBinMatch = text.match(/(?:rx\s*)?bin[:\s]+(\d{6})/i);
  if (rxBinMatch) result.rxBin = rxBinMatch[1];

  const rxPcnMatch = text.match(/pcn[:\s]+([A-Z0-9]+)/i);
  if (rxPcnMatch) result.rxPcn = rxPcnMatch[1];

  const rxGroupMatch = text.match(/rx\s*(?:group|grp)[:\s]+([A-Z0-9]+)/i);
  if (rxGroupMatch) result.rxGroup = rxGroupMatch[1];

  // ── Network name ─────────────────────────────────────────────────────────
  const networkMatch = text.match(/(?:network[:\s]+)([A-Za-z0-9 \-]+?)(?:\n|$)/i);
  if (networkMatch) result.networkName = networkMatch[1].trim();

  // ── Copay amounts ────────────────────────────────────────────────────────

  // Check for dual copay format first: "Copay $25/$50" or "PCP/Spec $25/$50"
  const dualCopayMatch = text.match(
    /(?:copay|co-pay|office)\s*(?:visit)?[:\s]*\$\s*(\d{1,4})\s*\/\s*\$?\s*(\d{1,4})/i
  );
  if (dualCopayMatch) {
    result.copayPrimary = parseFloat(dualCopayMatch[1]);
    result.copaySpecialist = parseFloat(dualCopayMatch[2]);
  } else {
    // Individual copay extraction
    result.copayPrimary = extractDollarAmounts(text, [
      /(?:primary\s*care|pcp|office\s*visit|physician|primary)[:\s]*/i,
      /(?:copay|co-pay)[:\s]*(?:primary|pcp)?/i,
    ]);

    result.copaySpecialist = extractDollarAmounts(text, [
      /specialist[:\s]*/i,
      /spec(?:ialty)?\s*(?:copay|co-pay)?[:\s]*/i,
      /spc[:\s]*/i,
    ]);
  }

  result.copayEr = extractDollarAmounts(text, [
    /(?:emergency|emergency\s*room|er|e\.r\.)[:\s]*/i,
  ]);

  result.copayUrgentCare = extractDollarAmounts(text, [
    /(?:urgent\s*care|uc)[:\s]*/i,
  ]);

  result.copayRx = extractDollarAmounts(text, [
    /(?:rx|prescription|pharmacy|drug)[:\s]*/i,
    /(?:generic|tier\s*1)[:\s]*/i,
  ]);

  result.deductibleIndividual = extractDollarAmounts(text, [
    /(?:individual\s*)?deductible[:\s]*/i,
    /ded(?:uctible)?[:\s]*/i,
  ]);

  result.oopMaxIndividual = extractDollarAmounts(text, [
    /(?:out[\s-]*of[\s-]*pocket|oop)\s*(?:max(?:imum)?)?[:\s]*/i,
    /(?:max(?:imum)?\s*out[\s-]*of[\s-]*pocket)[:\s]*/i,
  ]);

  // ── Coinsurance ──────────────────────────────────────────────────────────
  const coinsuranceMatch = text.match(/coinsurance[:\s]*(\d{1,3})\s*%/i);
  if (coinsuranceMatch) {
    result.coinsurancePct = parseInt(coinsuranceMatch[1], 10);
  }

  // ── Second pass: loose patterns for missing critical fields ──────────────
  // If insurer still missing, try detecting from member ID format
  if (!result.insurer && result.memberId) {
    if (/^U\d{9}$/.test(result.memberId)) {
      result.insurer = "UnitedHealthcare";
    } else if (/^W\d{9}$/.test(result.memberId)) {
      result.insurer = "Anthem / Blue Cross Blue Shield";
    }
  }

  // If member ID still missing, look for any long alphanumeric sequence (7+ chars)
  // that isn't already captured as group number or rx fields
  if (!result.memberId) {
    const captured = new Set([
      result.groupNumber, result.rxBin, result.rxPcn, result.rxGroup,
    ].filter(Boolean));

    const longIds = text.match(/\b([A-Z0-9]{7,20})\b/gi);
    if (longIds) {
      for (const id of longIds) {
        if (!captured.has(id) && !/^\d{5}$/.test(id)) { // Skip zip codes
          result.memberId = id;
          break;
        }
      }
    }
  }

  return result;
}

/** POST /api/profile/scan-card — OCR an insurance card and extract structured fields */
export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    const isHeic = /\.(heic|heif)$/i.test(file.name);
    if (!allowedTypes.includes(file.type) && !isHeic) {
      return NextResponse.json(
        { error: "File must be a PDF or image (JPEG, PNG, WebP, HEIC)" },
        { status: 400 }
      );
    }

    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    }

    let buffer = Buffer.from(await file.arrayBuffer());
    let ocrMimeType = file.type;

    // HEIC is not supported by Google Document AI — convert to JPEG first
    // Uses heic-convert (pure JS, works on Vercel serverless — no native deps)
    if (isHeic || file.type === "image/heic" || file.type === "image/heif") {
      try {
        const heicConvert = (await import("heic-convert")).default;
        const jpegBuffer = await heicConvert({
          buffer: new Uint8Array(buffer),
          format: "JPEG",
          quality: 0.9,
        });
        buffer = Buffer.from(jpegBuffer);
        ocrMimeType = "image/jpeg";
        console.log("[scan-card] HEIC→JPEG conversion OK, size:", buffer.length);
      } catch (convErr) {
        console.error("[scan-card] HEIC conversion failed:", convErr);
        return NextResponse.json(
          { error: "Could not process HEIC image. Try taking a screenshot or converting to JPEG first." },
          { status: 400 }
        );
      }
    }

    const ocrResult = await extractTextFromDocument(buffer, ocrMimeType);
    const fields = parseInsuranceCard(ocrResult.text);

    // Log raw OCR text for debugging (helps diagnose future card scan failures)
    console.log("[scan-card] OCR text length:", ocrResult.text.length, "| Extracted insurer:", fields.insurer || "NONE", "| Member ID:", fields.memberId || "NONE");

    // Calculate extraction confidence based on key fields found
    const keyFields = [fields.insurer, fields.memberId, fields.groupNumber, fields.planType];
    const foundCount = keyFields.filter(Boolean).length;
    const extractionConfidence = foundCount / keyFields.length;

    // Attempt plan matching if we have enough data
    let planMatches: MatchResult[] = [];
    if (fields.insurer || fields.planName) {
      try {
        const supabase = createServerClient();
        planMatches = await matchPlan(supabase, {
          insurerName: fields.insurer,
          planName: fields.planName,
          planType: fields.planType,
          deductible: fields.deductibleIndividual,
          oopMax: fields.oopMaxIndividual,
        }, { limit: 3, minConfidence: 0.3 });
      } catch (matchErr) {
        console.error("[scan-card] Plan matching error:", matchErr);
        // Non-fatal — still return extracted fields
      }
    }

    return NextResponse.json({
      fields,
      confidence: extractionConfidence,
      ocrConfidence: ocrResult.confidence,
      planMatches: planMatches.map((m) => ({
        planId: m.planId,
        planName: m.planName,
        insurerName: m.insurerName,
        confidence: m.confidence,
        matchedSignals: m.matchedSignals,
        deductible: m.plan.raw_data?.deductible_individual,
        oopMax: m.plan.raw_data?.oop_max_individual,
        metalLevel: m.plan.metal_level,
        planType: m.plan.plan_type,
      })),
    });
  } catch (err) {
    console.error("Insurance card scan error:", err);
    return NextResponse.json({ error: "Failed to scan card" }, { status: 500 });
  }
}

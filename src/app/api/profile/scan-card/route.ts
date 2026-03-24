import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { extractTextFromDocument } from "@/lib/ocr";

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
  deductibleIndividual?: number;
  oopMaxIndividual?: number;
  coinsurancePct?: number;
  rawText: string;
}

const INSURER_PATTERNS: [RegExp, string][] = [
  [/aetna/i, "Aetna"],
  [/anthem|blue\s*cross|bcbs/i, "Anthem / Blue Cross Blue Shield"],
  [/cigna/i, "Cigna"],
  [/humana/i, "Humana"],
  [/kaiser/i, "Kaiser Permanente"],
  [/molina/i, "Molina Healthcare"],
  [/oscar/i, "Oscar Health"],
  [/united\s*health/i, "UnitedHealthcare"],
];

const PLAN_TYPE_PATTERNS: [RegExp, string][] = [
  [/\bHMO\b/i, "HMO"],
  [/\bPPO\b/i, "PPO"],
  [/\bEPO\b/i, "EPO"],
  [/\bHDHP\b/i, "HDHP"],
  [/medicare\s+advantage/i, "Medicare Advantage"],
  [/\bmedicare\b/i, "Medicare"],
  [/\bmedicaid\b/i, "Medicaid"],
];

function extractDollarAmount(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Find the dollar amount near this match
      const idx = text.search(pattern);
      const vicinity = text.slice(Math.max(0, idx - 20), idx + 100);
      const dollarMatch = vicinity.match(/\$?\s*(\d{1,4}(?:\.\d{2})?)/);
      if (dollarMatch) {
        return parseFloat(dollarMatch[1]);
      }
    }
  }
  return undefined;
}

function parseInsuranceCard(text: string): InsuranceCardFields {
  const result: InsuranceCardFields = { rawText: text };

  // Insurer
  for (const [pattern, name] of INSURER_PATTERNS) {
    if (pattern.test(text)) {
      result.insurer = name;
      break;
    }
  }

  // Plan type
  for (const [pattern, type] of PLAN_TYPE_PATTERNS) {
    if (pattern.test(text)) {
      result.planType = type;
      break;
    }
  }

  // Plan name — look for lines near "plan" keyword
  const planNameMatch = text.match(/(?:plan\s*(?:name)?[:\s]+)([A-Za-z0-9 \-+]+?)(?:\n|$)/i);
  if (planNameMatch) {
    result.planName = planNameMatch[1].trim();
  }

  // Group number
  const groupMatch = text.match(/(?:group\s*(?:no?|number|#)?[:\s]+)([A-Z0-9\-]+)/i);
  if (groupMatch) {
    result.groupNumber = groupMatch[1].trim();
  }

  // Member ID
  const memberMatch = text.match(/(?:member\s*(?:id|no?|number|#)?|id\s*#?)[:\s]+([A-Z0-9\-]+)/i);
  if (memberMatch) {
    result.memberId = memberMatch[1].trim();
  }

  // Copay amounts — search for common label patterns
  result.copayPrimary = extractDollarAmount(text, [
    /(?:primary\s*care|pcp|office\s*visit|physician)[:\s]*/i,
    /(?:copay|co-pay)[:\s]*(?:primary)?/i,
  ]);

  result.copaySpecialist = extractDollarAmount(text, [
    /specialist[:\s]*/i,
    /spc[:\s]*/i,
  ]);

  result.copayEr = extractDollarAmount(text, [
    /(?:emergency|er|e\.r\.)[:\s]*/i,
  ]);

  result.deductibleIndividual = extractDollarAmount(text, [
    /(?:individual\s*)?deductible[:\s]*/i,
  ]);

  result.oopMaxIndividual = extractDollarAmount(text, [
    /(?:out[\s-]of[\s-]pocket|oop)\s*(?:max(?:imum)?)?[:\s]*/i,
  ]);

  // Coinsurance percentage
  const coinsuranceMatch = text.match(/coinsurance[:\s]*(\d{1,3})\s*%/i);
  if (coinsuranceMatch) {
    result.coinsurancePct = parseInt(coinsuranceMatch[1], 10);
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

    const buffer = Buffer.from(await file.arrayBuffer());
    const ocrResult = await extractTextFromDocument(buffer, file.type);
    const fields = parseInsuranceCard(ocrResult.text);

    return NextResponse.json({ fields, confidence: ocrResult.confidence });
  } catch (err) {
    console.error("Insurance card scan error:", err);
    return NextResponse.json({ error: "Failed to scan card" }, { status: 500 });
  }
}

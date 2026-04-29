// SBC Parser — extracts structured plan data from SBC OCR text
// Produces insurance_plans + plan_covered_services records
// SBCs follow a standardized federal DOL/HHS template

import type { InsurancePlanInsert, PlanCoveredServiceInsert } from "@/lib/supabase/types";

export interface SBCParseResult {
  plan: Partial<InsurancePlanInsert>;
  services: SBCParsedService[];
  confidence: number;
  parseWarnings: string[];
}

export interface SBCParsedService {
  serviceSlug: string;
  placeOfService: string;
  inCopay: number | null;
  inCoinsurance: number | null;
  inDeductibleApplies: boolean | null;
  inCopayWaiverCondition: string | null;
  inCostDescription: string;
  outCopay: number | null;
  outCoinsurance: number | null;
  outDeductibleApplies: boolean | null;
  outCostDescription: string;
  oonPaidAtInNetwork: boolean;
  annualLimit: string | null;
  annualLimitValue: number | null;
  priorAuthRequired: boolean | null;
  penaltyNoPrecert: number | null;
  covered: boolean;
  coverageConditions: string | null;
  supplyLimitDays: number | null;
  homeDeliveryCopay: number | null;
  stepTherapyRequired: boolean | null;
  notes: string | null;
  confidence: number;
  // Phase 4.5 — direct-quote citation data for dispute letter evidence block.
  // Populated when the extractor captures the verbatim SBC passage that
  // supports this service's copay/coinsurance values. Nullable for legacy rows.
  sourceExcerpt?: string | null;
  sourcePage?: number | null;
}

// Phase 6.1 — extracted appeals contact block from SBC / plan document back pages.
// Flows into insurer-appeals-upsert so the crowdsourced registry stays fresh.
export interface SBCParsedAppealsContact {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  sourceExcerpt: string | null;
  sourcePage: number | null;
  confidence: number;
}

// ── Helper: parse dollar amounts ─────────────────────────────────────────────

function parseDollar(text: string): number | null {
  const m = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

function parsePercent(text: string): number | null {
  const m = text.match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) / 100 : null;
}

// ── Helper: extract cost sharing from a cell description ─────────────────────

interface CostSharing {
  copay: number | null;
  coinsurance: number | null;
  deductibleApplies: boolean | null;
  copayWaiverCondition: string | null;
  rawDescription: string;
}

function parseCostSharing(text: string): CostSharing {
  const raw = text.trim();
  const result: CostSharing = {
    copay: null,
    coinsurance: null,
    deductibleApplies: null,
    copayWaiverCondition: null,
    rawDescription: raw,
  };

  if (!raw || /not\s+covered/i.test(raw)) {
    return result;
  }

  // "No charge" = 100% covered. Cost is zero, but the deductible may still apply
  // when the SBC qualifies "no charge" with "after deductible has been met".
  if (/no\s+charge/i.test(raw)) {
    result.copay = 0;
    result.coinsurance = 0;
    if (/(?:after|then|plus)\s+(?:[\w\s]+?\s+)?deductible/i.test(raw)) {
      result.deductibleApplies = true;
    } else {
      result.deductibleApplies = false;
    }
    return result;
  }

  // Extract copay: "$20 copay/visit", "$250 copay/visit"
  const copayMatch = raw.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*(?:copay|co-pay)/i);
  if (copayMatch) {
    result.copay = parseFloat(copayMatch[1].replace(/,/g, ""));
  }

  // Extract coinsurance: "10% coinsurance", "30% coinsurance"
  const coinsMatch = raw.match(/(\d+)\s*%\s*(?:coinsurance|co-insurance)/i);
  if (coinsMatch) {
    result.coinsurance = parseInt(coinsMatch[1], 10) / 100;
  }

  // Check deductible applies
  if (/deductible\s+(?:does\s+)?not\s+apply/i.test(raw)) {
    result.deductibleApplies = false;
  } else if (/(?:after|then|plus)\s+.*deductible/i.test(raw) || /deductible.*(?:then|plus)/i.test(raw)) {
    result.deductibleApplies = true;
  } else if (/plan\s+deductible/i.test(raw)) {
    result.deductibleApplies = true;
  }

  // Copay waiver condition: "waived if admitted"
  const waiverMatch = raw.match(/(?:copay\s+)?(?:is\s+)?waived\s+if\s+(\w+)/i);
  if (waiverMatch) {
    result.copayWaiverCondition = `waived if ${waiverMatch[1]}`;
  }

  return result;
}

// ── SBC service mapping: SBC row text → service_catalog slug ─────────────────

interface ServiceMapping {
  patterns: RegExp[];
  slug: string;
  placeOfService?: string;
}

const SBC_SERVICE_MAPPINGS: ServiceMapping[] = [
  // Office visits
  { patterns: [/primary\s+care\s+visit/i, /primary\s+care.*injury\s+or\s+illness/i], slug: "pcp_visit" },
  { patterns: [/specialist\s+visit/i], slug: "specialist_visit" },
  { patterns: [/preventive\s+care/i, /screening.*immunization/i], slug: "preventive_care" },
  // Tests
  { patterns: [/diagnostic\s+test/i, /x-ray.*blood\s+work/i], slug: "diagnostic_test" },
  { patterns: [/imaging/i, /CT.*PET.*MRI/i, /advanced.*imaging/i], slug: "advanced_imaging" },
  // Rx
  { patterns: [/generic\s+drugs?\s*\(?tier\s*1/i], slug: "generic_rx_tier1", placeOfService: "retail_pharmacy" },
  { patterns: [/preferred\s+brand\s+drugs?\s*\(?tier\s*2/i], slug: "preferred_brand_rx_tier2", placeOfService: "retail_pharmacy" },
  { patterns: [/non[- ]preferred.*drugs?\s*\(?tier\s*3/i], slug: "non_preferred_rx_tier3", placeOfService: "retail_pharmacy" },
  { patterns: [/specialty\s+drugs?\s*\(?tier\s*4/i], slug: "specialty_rx_tier4", placeOfService: "retail_pharmacy" },
  // Surgery
  { patterns: [/facility\s+fee.*(?:ambulatory|surgery)/i, /outpatient.*facility/i], slug: "outpatient_surgery_facility" },
  { patterns: [/physician.*(?:surgeon|surgery)\s+fee/i], slug: "outpatient_surgery_physician" },
  // Emergency
  { patterns: [/emergency\s+room/i, /emergency.*care/i], slug: "er_visit" },
  { patterns: [/emergency\s+(?:medical\s+)?transport/i, /ambulance/i], slug: "emergency_transport_ground" },
  { patterns: [/urgent\s+care/i], slug: "urgent_care" },
  // Hospital
  { patterns: [/facility\s+fee.*hospital\s+room/i, /hospital\s+stay.*facility/i, /inpatient.*facility/i], slug: "inpatient_facility" },
  { patterns: [/physician.*(?:surgeon)?\s+fees?$/i, /hospital\s+stay.*physician/i, /inpatient.*physician/i], slug: "inpatient_physician" },
  // Mental health
  { patterns: [/mental\s+health.*outpatient/i, /behavioral\s+health.*outpatient/i, /outpatient\s+(?:mental|behavioral)/i], slug: "mental_health_outpatient" },
  { patterns: [/mental\s+health.*inpatient/i, /behavioral\s+health.*inpatient/i, /inpatient\s+(?:mental|behavioral)/i], slug: "mental_health_inpatient" },
  { patterns: [/substance\s+(?:abuse|use)/i], slug: "substance_abuse_outpatient" },
  // Pregnancy
  { patterns: [/office\s+visits?\s*$/i, /prenatal/i, /maternity.*office/i], slug: "prenatal_visit" },
  { patterns: [/childbirth.*delivery.*facility/i, /delivery\s+facility/i], slug: "delivery_facility" },
  { patterns: [/childbirth.*delivery.*professional/i, /delivery\s+professional/i], slug: "delivery_professional" },
  // Recovery
  { patterns: [/rehabilitation/i, /physical.*speech.*(?:hearing|occupational)/i], slug: "pt_rehab" },
  { patterns: [/habilitation/i], slug: "habilitation" },
  { patterns: [/skilled\s+nursing/i], slug: "skilled_nursing" },
  { patterns: [/home\s+health/i], slug: "home_health" },
  // Other
  { patterns: [/durable\s+medical\s+equipment/i], slug: "durable_medical_equipment" },
  { patterns: [/hospice/i], slug: "hospice_inpatient" },
  { patterns: [/children.*eye\s+exam/i], slug: "childrens_eye_exam" },
  { patterns: [/children.*glasses/i], slug: "childrens_glasses" },
  { patterns: [/children.*dental/i], slug: "childrens_dental" },
  { patterns: [/chiropractic/i], slug: "chiropractic" },
  { patterns: [/acupuncture/i], slug: "acupuncture" },
];

// SBC section headers, cost fragments, and layout text that should never be services
const SBC_NON_SERVICE_TERMS = new Set([
  "what you will pay", "you will pay the least", "you will pay the most",
  "in-network provider", "innetwork provider", "out-of-network provider", "outofnetwork provider",
  "in network provider", "out of network provider",
  "limitations exceptions", "limitations exceptions other important information",
  "important information", "other important information",
  "cost sharing", "cost share amounts", "cost sharing deductibles",
  "deductibles", "copayments", "coinsurance", "no charge",
  "professional services", "outpatient services", "inpatient services",
  "if you need immediate", "if you have a hospital stay",
  "if you need mental health", "behavioral health or",
  "what you will pay for", "common medical event", "common medical events",
  "services you may need", "your cost if you use",
  "summary of benefits", "summary of benefits and coverage",
  "plan deductible", "plan provisions", "plan administration",
  "general provisions", "how the plan works", "coverage period",
  "who can i contact", "questions", "definitions",
  "does not apply", "deductible does not apply",
  "precertification", "preauthorization", "prior authorization",
  "limits", "for drugs in the cigna patient", "assurance program you may pay less",
  "than the noted retail or home delivery", "work",
  "services", "room", "plus 10 coinsurance",
]);

// Patterns that indicate cost fragments, not services
const SBC_NON_SERVICE_PATTERNS = [
  /^\d+\s*coinsurance/i,          // "10 coinsurance", "30 coinsurance"
  /^\d+\s*copay/i,                // "20 copayvisit", "50 copayvisit"
  /^\d+\s*days?\s*\d*/i,          // "30 days 45"
  /^\$?\d[\d,]*\s*(penalty|deductible|copay)/i, // "$750 penalty", "$200 deductibleadmission"
  /^(plus|and|or|the|for|if|you|a|an|at|in|of)\s/i, // starts with common words
  /coinsurance(all|in|visit|inpatient)/i, // "coinsuranceall other", "coinsuranceinpatient"
  /^\d+$/,                         // just a number like "900"
];

function matchServiceSlug(text: string): { slug: string; placeOfService: string; autoGenerated?: boolean } | null {
  const lower = text.toLowerCase().trim();

  // Skip known non-service terms
  if (SBC_NON_SERVICE_TERMS.has(lower)) return null;
  for (const term of SBC_NON_SERVICE_TERMS) {
    if (lower.startsWith(term)) return null;
  }
  // Skip cost fragments and layout text
  for (const pattern of SBC_NON_SERVICE_PATTERNS) {
    if (pattern.test(lower)) return null;
  }
  // Skip lines that are mostly numbers/symbols (cost data, not services)
  const alphaChars = text.replace(/[^a-zA-Z]/g, "");
  if (alphaChars.length < 4) return null;
  // Skip very short or very long lines (headers or multi-line fragments)
  if (text.length < 5 || text.length > 80) return null;

  for (const mapping of SBC_SERVICE_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (pattern.test(text)) {
        return {
          slug: mapping.slug,
          placeOfService: mapping.placeOfService || "any",
        };
      }
    }
  }

  // No known mapping found — only auto-generate if the text looks like a real service name
  // Must contain at least 2 words, no dollar signs, no percentage signs
  if (/\$|%|\d+\s*coinsurance|\d+\s*copay/i.test(text)) return null;
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return null;

  const generatedSlug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);

  if (generatedSlug.length >= 5) {
    return { slug: generatedSlug, placeOfService: "any", autoGenerated: true };
  }
  return null;
}

// ── Main SBC parser ──────────────────────────────────────────────────────────

export function parseSBCText(text: string, documentId?: string): SBCParseResult {
  const warnings: string[] = [];
  const plan: Partial<InsurancePlanInsert> = {
    source: "sbc_upload",
  };

  if (documentId) {
    plan.source_document_id = documentId;
  }

  // ── Extract plan identity ───────────────────────────────────────────────

  // Plan name / insurer from header — SBC format: "Employer LLC: Plan Name"
  // Patterns to reject as plan names (these are metadata, not actual plan names)
  const isMetadata = (s: string) =>
    /^(individual|family|employee|individual.*family|plan\s*type)/i.test(s.trim()) ||
    /coverage\s+(for|period)/i.test(s.trim()) ||
    s.includes("|") || s.length < 3;

  // Try "Employer: Plan Name" pattern (e.g., "Acme Corp: Open Access Plus")
  const employerPlan = text.match(/([A-Z][^\n:]{3,50}):\s+((?:Open Access|PPO|HMO|EPO|POS|HDHP|OAP)[^\n]*)/im);
  if (employerPlan && !isMetadata(employerPlan[2])) {
    plan.plan_name = employerPlan[2].trim();
    plan.employer_name = employerPlan[1].trim();
  }

  // Try structured header — look for a plan name line AFTER "Coverage Period" header
  // Skip "Coverage for:" lines (those are coverage tier, not plan name)
  if (!plan.plan_name) {
    const structuredHeader = text.match(/Coverage Period[^\n]*\n([^\n]*?:\s*)(.+?)(?:\n|$)/im);
    if (structuredHeader && !isMetadata(structuredHeader[2])) {
      plan.plan_name = structuredHeader[2].trim();
    }
  }

  // Try "Plan Name:" or "Plan:" direct label
  if (!plan.plan_name) {
    const directPlanName = text.match(/(?:^|\n)\s*Plan(?:\s+Name)?[:\s]+([A-Z][^\n]{3,60})/im);
    if (directPlanName && !isMetadata(directPlanName[1])) {
      plan.plan_name = directPlanName[1].trim();
    }
  }

  // ── Insurer name — detect from domain, branding, or repeated mentions ────
  const insurerPatterns: [RegExp, string][] = [
    [/cigna/i, "Cigna"],
    [/united\s*health/i, "UnitedHealthcare"],
    [/anthem/i, "Anthem"],
    [/aetna/i, "Aetna"],
    [/humana/i, "Humana"],
    [/kaiser/i, "Kaiser Permanente"],
    [/blue\s*cross/i, "Blue Cross Blue Shield"],
    [/molina/i, "Molina Healthcare"],
    [/oscar/i, "Oscar Health"],
    [/centene|ambetter|wellcare/i, "Centene"],
    [/highmark/i, "Highmark"],
    [/carefirst/i, "CareFirst"],
    [/florida\s*blue/i, "Florida Blue"],
    [/horizon/i, "Horizon BCBS"],
  ];
  for (const [pattern, name] of insurerPatterns) {
    if (pattern.test(text)) {
      plan.insurer_name = name;
      break;
    }
  }

  // Network name — same as plan name for most insurers
  if (plan.plan_name) {
    plan.network_name = plan.plan_name;
  }

  // Coverage period — supports two SBC formats:
  //  (a) "Coverage Period: 01/01/2026 - 12/31/2026" (full range, e.g. WHA, Cigna)
  //  (b) "Coverage Period: Beginning On or After 1/1/2025" (single date, e.g. Ambetter, Blue Shield)
  const periodMatch = text.match(/coverage\s+period[:\s]*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (periodMatch) {
    const m1 = periodMatch[1].padStart(2, "0");
    const d1 = periodMatch[2].padStart(2, "0");
    const m2 = periodMatch[4].padStart(2, "0");
    const d2 = periodMatch[5].padStart(2, "0");
    plan.coverage_period_start = `${periodMatch[3]}-${m1}-${d1}`;
    plan.coverage_period_end = `${periodMatch[6]}-${m2}-${d2}`;
    plan.plan_year = parseInt(periodMatch[3], 10);
  } else {
    // Fallback: "Beginning On or After MM/DD/YYYY" — assume calendar-year coverage
    const beginningMatch = text.match(/(?:coverage\s+period[^\n]*?)?beginning\s+(?:on\s+or\s+after\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (beginningMatch) {
      const m = beginningMatch[1].padStart(2, "0");
      const d = beginningMatch[2].padStart(2, "0");
      const y = parseInt(beginningMatch[3], 10);
      plan.coverage_period_start = `${y}-${m}-${d}`;
      plan.coverage_period_end = `${y}-12-31`;
      plan.plan_year = y;
    }
  }

  // Plan type
  const planTypeMatch = text.match(/plan\s+type[:\s]*(HMO|PPO|EPO|POS|OAP|HDHP|POS)/i);
  if (planTypeMatch) {
    plan.plan_type = planTypeMatch[1].toUpperCase();
  }

  // Coverage tier — handles standard "Individual + Family" plus carrier variants
  // like "All Covered Members" (Ambetter / Health Net) and "Self + Family" (WHA).
  const tierMatch = text.match(/coverage\s+for[:\s]*(individual\s*\+\s*family|individual.*family|self\s*\+\s*family|self\s+only|individual|family|all\s+covered\s+members)/i);
  if (tierMatch) {
    const t = tierMatch[1].toLowerCase();
    if (/all\s+covered\s+members/.test(t) || /individual.*family/.test(t) || /self\s*\+\s*family/.test(t)) {
      plan.coverage_tier = "individual_family";
    } else if (/family/.test(t)) {
      plan.coverage_tier = "family";
    } else {
      plan.coverage_tier = "individual";
    }
  }

  // ── Extract deductibles ─────────────────────────────────────────────────

  // In-network deductible
  const inDedMatch = text.match(/(?:what\s+is\s+the\s+)?overall\s+deductible.*?in[- ]network[^$]*?\$([\d,]+)\s*\/?\s*individual[^$]*?\$([\d,]+)\s*\/?\s*family/im)
    || text.match(/in[- ]network\s+providers?[:\s]*\$([\d,]+)\s*\/?\s*individual[^$]*?\$([\d,]+)\s*\/?\s*family/im);
  if (inDedMatch) {
    plan.in_deductible_individual = parseInt(inDedMatch[1].replace(/,/g, ""), 10);
    plan.in_deductible_family = parseInt(inDedMatch[2].replace(/,/g, ""), 10);
  } else {
    // Try simpler pattern
    const simpleInDed = text.match(/in[- ]network[^$\n]*?\$([\d,]+)\s*\/\s*individual/i);
    if (simpleInDed) plan.in_deductible_individual = parseInt(simpleInDed[1].replace(/,/g, ""), 10);
  }

  // Out-of-network deductible
  const outDedMatch = text.match(/out[- ]of[- ]network\s+providers?[:\s]*\$([\d,]+)\s*\/?\s*individual[^$]*?\$([\d,]+)\s*\/?\s*family/im);
  if (outDedMatch) {
    plan.out_deductible_individual = parseInt(outDedMatch[1].replace(/,/g, ""), 10);
    plan.out_deductible_family = parseInt(outDedMatch[2].replace(/,/g, ""), 10);
  }

  // ── Extract OOP max ─────────────────────────────────────────────────────

  // Strategy: find ALL "For in-network providers: $X/individual" patterns in the text.
  // The SBC has exactly two such blocks: one for deductibles, one for OOP max.
  // The deductible block appears first, the OOP block appears second.
  // We extract both and assign based on position.
  const allInNetworkMatches: { index: number; individual: number; family: number }[] = [];
  const allOutNetworkMatches: { index: number; individual: number; family: number }[] = [];

  const inNetRegex = /(?:for\s+)?in[- ]network\s+providers?[:\s]*\$([\d,]+)\s*\/?\s*individual[^$]*?\$([\d,]+)\s*\/?\s*family/gi;
  let inMatch;
  while ((inMatch = inNetRegex.exec(text)) !== null) {
    allInNetworkMatches.push({
      index: inMatch.index,
      individual: parseInt(inMatch[1].replace(/,/g, ""), 10),
      family: parseInt(inMatch[2].replace(/,/g, ""), 10),
    });
  }

  const outNetRegex = /(?:for\s+)?out[- ]of[- ]network\s+providers?[:\s]*\$([\d,]+)\s*\/?\s*individual[^$]*?\$([\d,]+)\s*\/?\s*family/gi;
  let outMatch;
  while ((outMatch = outNetRegex.exec(text)) !== null) {
    allOutNetworkMatches.push({
      index: outMatch.index,
      individual: parseInt(outMatch[1].replace(/,/g, ""), 10),
      family: parseInt(outMatch[2].replace(/,/g, ""), 10),
    });
  }

  // First occurrence = deductible (already extracted above, but use as fallback)
  // Second occurrence = OOP max
  if (allInNetworkMatches.length >= 2) {
    plan.in_oop_max_individual = allInNetworkMatches[1].individual;
    plan.in_oop_max_family = allInNetworkMatches[1].family;
  } else if (allInNetworkMatches.length === 1 && plan.in_deductible_individual != null) {
    // Only one match — it's the deductible, OOP not found
  } else if (allInNetworkMatches.length === 1) {
    // Can't tell if it's deductible or OOP — check proximity to "out-of-pocket"
    const oopIdx = text.search(/out[- ]of[- ]pocket\s+limit/i);
    if (oopIdx >= 0 && Math.abs(allInNetworkMatches[0].index - oopIdx) < 500) {
      plan.in_oop_max_individual = allInNetworkMatches[0].individual;
      plan.in_oop_max_family = allInNetworkMatches[0].family;
    }
  }

  if (allOutNetworkMatches.length >= 2) {
    plan.out_oop_max_individual = allOutNetworkMatches[1].individual;
    plan.out_oop_max_family = allOutNetworkMatches[1].family;
  } else if (allOutNetworkMatches.length === 1 && plan.out_deductible_individual != null) {
    // Only one match — it's the deductible
  } else if (allOutNetworkMatches.length === 1) {
    const oopIdx = text.search(/out[- ]of[- ]pocket\s+limit/i);
    if (oopIdx >= 0 && Math.abs(allOutNetworkMatches[0].index - oopIdx) < 500) {
      plan.out_oop_max_individual = allOutNetworkMatches[0].individual;
      plan.out_oop_max_family = allOutNetworkMatches[0].family;
    }
  }

  // ── Combined medical/Rx OOP ─────────────────────────────────────────────

  if (/combined\s+medical/i.test(text) && /pharmacy\s+out[- ]of[- ]pocket/i.test(text)) {
    plan.combined_medical_rx_oop = true;
  } else if (/combined\s+medical.*(?:pharmacy|rx)/i.test(text)) {
    plan.combined_medical_rx_oop = true;
  }

  // ── Referral required ───────────────────────────────────────────────────
  // In Document AI text, question and answer may be separated by other text
  // Look for "referral" near "No" or "you can see the specialist you choose"

  if (/referral/i.test(text)) {
    if (/you\s+can\s+see\s+the\s+specialist\s+you\s+choose/i.test(text)
      || /without\s+a\s+referral/i.test(text)) {
      plan.referral_required = false;
    } else if (/referral[\s\S]{0,200}?yes/im.test(text)) {
      plan.referral_required = true;
    } else {
      // Default: check if "No" appears near "referral"
      const refIdx = text.search(/referral/i);
      const nearby = text.slice(refIdx, refIdx + 300);
      if (/\bNo\b/.test(nearby)) {
        plan.referral_required = false;
      }
    }
  }

  // ── Default coinsurance ───────────────────────────────────────────────
  // Try to extract the most common coinsurance from the service table
  // SBC typically shows "10% coinsurance" or "30% coinsurance" repeatedly

  const coinsMatches = text.match(/(\d+)%\s*coinsurance/gi) || [];
  if (coinsMatches.length > 0) {
    // Count frequency of each coinsurance value
    const freq = new Map<number, number>();
    for (const m of coinsMatches) {
      const val = parseInt(m.match(/(\d+)/)?.[1] || "0", 10);
      if (val > 0 && val < 100) freq.set(val, (freq.get(val) || 0) + 1);
    }
    // Most common in-network coinsurance (typically the lower one)
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 1) {
      const lowest = Math.min(...sorted.map(([v]) => v));
      const highest = Math.max(...sorted.map(([v]) => v));
      plan.in_coinsurance_default = lowest / 100;  // e.g., 0.10 for 10%
      if (highest !== lowest) {
        plan.out_coinsurance_default = highest / 100;  // e.g., 0.30 for 30%
      }
    }
  }

  // ── State ─────────────────────────────────────────────────────────────
  // Try to extract from regulatory body mention or address
  const stateRegulator = text.match(/(?:department\s+of\s+(?:managed\s+health|insurance)|commissioner)[^\n]*?(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West\s+Virginia|Wisconsin|Wyoming)/i);
  if (stateRegulator) {
    plan.state = stateRegulator[1].trim();
  }

  // ── Minimum Essential Coverage / Minimum Value ──────────────────────────

  if (/minimum\s+essential\s+coverage/i.test(text) && /yes/i.test(text.slice(text.search(/minimum\s+essential/i), text.search(/minimum\s+essential/i) + 200))) {
    plan.minimum_essential_coverage = true;
  }
  if (/minimum\s+value\s+standard/i.test(text) && /yes/i.test(text.slice(text.search(/minimum\s+value/i), text.search(/minimum\s+value/i) + 200))) {
    plan.minimum_value_standard = true;
  }

  // ── OOP exclusions ──────────────────────────────────────────────────────
  // Scan a wider range around "not included in the out-of-pocket"
  const oopExclIdx = text.search(/not\s+included\s+in\s+the\s+out/i);
  if (oopExclIdx >= 0) {
    const excls = text.slice(oopExclIdx, oopExclIdx + 500);
    const items: string[] = [];
    if (/penalt/i.test(excls)) items.push("precert_penalties");
    if (/premium/i.test(excls)) items.push("premiums");
    if (/balance[- ]bill/i.test(excls)) items.push("balance_billing");
    if (/doesn.*cover|plan\s+doesn/i.test(excls)) items.push("non_covered_services");
    if (/health\s+care\s+this\s+plan\s+doesn/i.test(excls)) items.push("non_covered_services");
    // Deduplicate
    plan.oop_exclusions = [...new Set(items)];
  }

  // ── Other specific deductibles ──────────────────────────────────────────

  const otherDedMatch = text.match(/\$([\d,]+)\s+for\s+(in[- ]network[^\n.]*)/i);
  if (otherDedMatch) {
    plan.other_deductibles = { [otherDedMatch[2].trim().toLowerCase()]: parseInt(otherDedMatch[1].replace(/,/g, ""), 10) };
  }

  // ── Deductible calculation method ─────────────────────────────────────
  // SBC: "each family member must meet their own individual deductible" = embedded
  if (/each\s+family\s+member\s+must\s+meet\s+their\s+own/i.test(text)) {
    plan.deductible_calc_method = "embedded";
  } else if (/overall\s+family\s+deductible/i.test(text) && !/individual\s+deductible/i.test(text)) {
    plan.deductible_calc_method = "aggregate";
  }

  // ── Contact info (expanded) ───────────────────────────────────────────

  const contactInfo: Record<string, string> = {};

  // Phone numbers
  const phoneMatches = text.match(/1[-.]?\d{3}[-.]?\d{3}[-.]?\d{4}/g);
  if (phoneMatches && phoneMatches.length > 0) {
    contactInfo.phone = phoneMatches[0]!;
  }

  // Website
  const websiteMatch = text.match(/(?:www\.\w+\.com(?:\/\S*)?)/i);
  if (websiteMatch) contactInfo.website = websiteMatch[0];

  // Insurer portal
  if (plan.insurer_name === "Cigna") contactInfo.portal_url = "www.myCigna.com";

  // Grievance email
  const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) contactInfo.grievance_email = emailMatch[1];

  // Nondiscrimination address
  const nonDiscAddr = text.match(/(?:nondiscrimination|complaint)[^\n]*\n([^\n]*(?:P\.?O\.?\s*Box|[0-9]+\s+\w+)[^\n]*)/i);
  if (nonDiscAddr) contactInfo.nondiscrimination_address = nonDiscAddr[1].trim();

  // State regulator
  const regulatorMatch = text.match(/(department\s+of\s+(?:managed\s+health|insurance)[^\n]*)/i);
  if (regulatorMatch) contactInfo.state_regulator_name = regulatorMatch[1].trim();
  const regulatorPhone = text.match(/(?:department|commissioner)[^\n]*?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i);
  if (regulatorPhone) contactInfo.state_regulator_phone = regulatorPhone[1];

  if (Object.keys(contactInfo).length > 0) {
    plan.contact_info = contactInfo;
  }

  // ── Extract per-service cost sharing ────────────────────────────────────

  const services: SBCParsedService[] = [];

  // SBC service rows follow a pattern:
  // "Service Name" | "In-Network cost" | "Out-of-Network cost" | "Limitations"
  // We scan for known service names and extract the surrounding text

  // Split text into rough sections by looking for service-like headings
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = matchServiceSlug(line);
    if (!match) continue;

    // Gather context: the next few lines contain cost sharing info
    // Reduced from 8 to 4 to prevent bleeding into adjacent services
    const context = lines.slice(i, Math.min(i + 4, lines.length)).join(" ");

    // Look for in-network and out-of-network patterns in context
    // SBC format: in-network column first, then out-of-network
    const inNetSection = context.match(/(?:in[- ]network|you\s+will\s+pay\s+the\s+least)[:\s]*(.+?)(?:out[- ]of[- ]network|you\s+will\s+pay\s+the\s+most|limitations|$)/im);
    const outNetSection = context.match(/(?:out[- ]of[- ]network|you\s+will\s+pay\s+the\s+most)[:\s]*(.+?)(?:limitations|none|$|\n\n)/im);

    // Parse cost sharing from the context (simpler approach when columns aren't cleanly separated)
    const inText = inNetSection?.[1] || "";
    const outText = outNetSection?.[1] || "";

    // Fallback: parse the whole context
    const contextCost = parseCostSharing(context);

    const inCost = inText ? parseCostSharing(inText) : contextCost;
    const outCost = outText ? parseCostSharing(outText) : { copay: null, coinsurance: null, deductibleApplies: null, copayWaiverCondition: null, rawDescription: "" };

    // Check for special rules
    const oonAtIn = /out[- ]of[- ]network.*(?:paid|covered)\s+at\s+(?:the\s+)?in[- ]network/i.test(context)
      || /in[- ]network\s+cost[- ]?shar/i.test(context);

    const penaltyMatch = context.match(/\$([\d,]+)\s+penalty/i);
    const limitMatch = context.match(/(?:limited|coverage\s+is\s+limited)\s+to\s+(\d+)\s+(days?|visits?)/i);
    const priorAuth = /prior\s+auth/i.test(context) || /precert/i.test(context);

    // Check if "Not covered"
    const notCovered = /not\s+covered/i.test(context) && !inCost.copay && !inCost.coinsurance;

    // Rx-specific
    const supplyMatch = context.match(/(\d+)[- ]day\s+supply/i);
    const stepTherapy = /step\s+therapy/i.test(context);
    const homeDelivery = context.match(/home\s+delivery.*?\$([\d,]+)/i);

    const waiver = inCost.copayWaiverCondition || (context.match(/waived\s+if\s+(\w+)/i)?.[0] ?? null);

    services.push({
      serviceSlug: match.slug,
      placeOfService: match.placeOfService,
      inCopay: inCost.copay,
      inCoinsurance: inCost.coinsurance,
      inDeductibleApplies: inCost.deductibleApplies,
      inCopayWaiverCondition: waiver,
      inCostDescription: inCost.rawDescription || contextCost.rawDescription,
      outCopay: outCost.copay,
      outCoinsurance: outCost.coinsurance,
      outDeductibleApplies: outCost.deductibleApplies,
      outCostDescription: outCost.rawDescription,
      oonPaidAtInNetwork: oonAtIn,
      annualLimit: limitMatch ? `${limitMatch[1]} ${limitMatch[2]}` : null,
      annualLimitValue: limitMatch ? parseInt(limitMatch[1], 10) : null,
      priorAuthRequired: priorAuth || null,
      penaltyNoPrecert: penaltyMatch ? parseInt(penaltyMatch[1].replace(/,/g, ""), 10) : null,
      covered: !notCovered,
      coverageConditions: null,
      supplyLimitDays: supplyMatch ? parseInt(supplyMatch[1], 10) : null,
      homeDeliveryCopay: homeDelivery ? parseFloat(homeDelivery[1]) : null,
      stepTherapyRequired: stepTherapy || null,
      notes: null,
      confidence: inCost.copay !== null || inCost.coinsurance !== null ? 0.75 : 0.4,
    });
  }

  // ── Extract excluded services ───────────────────────────────────────────

  const excludedSection = text.match(/(?:services\s+your\s+plan\s+generally\s+does\s+not\s+cover|excluded\s+services)[:\s]*(.+?)(?:other\s+covered\s+services|your\s+rights|$)/im);
  if (excludedSection) {
    const excluded = excludedSection[1];
    const excludedItems = excluded.match(/[•●■✦]\s*([^•●■✦\n]+)/g) || excluded.split(/\n/).filter((l) => l.trim().length > 3);

    for (const item of excludedItems) {
      const cleaned = item.replace(/^[•●■✦]\s*/, "").trim();
      if (cleaned.length < 3) continue;

      // Try to match to a service
      const serviceMatch = matchServiceSlug(cleaned);
      if (serviceMatch) {
        services.push({
          serviceSlug: serviceMatch.slug,
          placeOfService: "any",
          inCopay: null, inCoinsurance: null, inDeductibleApplies: null,
          inCopayWaiverCondition: null, inCostDescription: "Not covered",
          outCopay: null, outCoinsurance: null, outDeductibleApplies: null,
          outCostDescription: "Not covered",
          oonPaidAtInNetwork: false,
          annualLimit: null, annualLimitValue: null,
          priorAuthRequired: null, penaltyNoPrecert: null,
          covered: false,
          coverageConditions: null,
          supplyLimitDays: null, homeDeliveryCopay: null, stepTherapyRequired: null,
          notes: `Excluded: ${cleaned}`,
          confidence: 0.9,
        });
      }
    }
  }

  // ── Calculate overall confidence ────────────────────────────────────────

  let parsedFields = 0;
  const totalFields = 10; // key fields we try to extract
  if (plan.plan_name) parsedFields++;
  if (plan.plan_year) parsedFields++;
  if (plan.plan_type) parsedFields++;
  if (plan.in_deductible_individual !== undefined) parsedFields++;
  if (plan.in_oop_max_individual !== undefined) parsedFields++;
  if (plan.out_deductible_individual !== undefined) parsedFields++;
  if (plan.out_oop_max_individual !== undefined) parsedFields++;
  if (plan.referral_required !== undefined) parsedFields++;
  if (plan.combined_medical_rx_oop !== undefined) parsedFields++;
  if (services.length > 0) parsedFields++;

  const confidence = parsedFields / totalFields;

  // Substance Use Disorder parity derivation. Many SBCs bundle SUD into mental
  // health rows (section header "Mental health, behavioral health, or substance
  // abuse services"; ER row text "medical, mental health and substance use
  // disorders"). ACA mental health parity requires SUD coverage at parity with
  // mental health, so when the SBC mentions SUD anywhere we mirror each
  // mental_health_outpatient/inpatient entry into a substance_abuse_*
  // counterpart with identical cost-sharing — unless the SBC has dedicated
  // SUD rows already producing those slugs.
  if (/substance\s+(?:abuse|use)/i.test(text)) {
    const existingSlugs = new Set(services.map((s) => s.serviceSlug));
    const sudPairs: Array<[string, string]> = [
      ["mental_health_outpatient", "substance_abuse_outpatient"],
      ["mental_health_inpatient", "substance_abuse_inpatient"],
    ];
    let derivedCount = 0;
    for (const [mhSlug, sudSlug] of sudPairs) {
      if (existingSlugs.has(sudSlug)) continue;
      const mh = services.find((s) => s.serviceSlug === mhSlug);
      if (!mh) continue;
      services.push({ ...mh, serviceSlug: sudSlug });
      derivedCount++;
    }
    if (derivedCount > 0) {
      warnings.push(`Substance abuse services derived from mental health rows per ACA mental health parity (MHPAEA); ${derivedCount} entries synthesized. Verify against EOC.`);
    }
  }

  if (services.length === 0) warnings.push("No per-service cost sharing was extracted");
  if (plan.in_deductible_individual == null) warnings.push("Could not extract in-network deductible");
  if (plan.in_oop_max_individual == null) warnings.push("Could not extract in-network OOP max");
  if (!plan.plan_name) warnings.push("Could not extract plan name");

  plan.confidence = Math.round(confidence * 100) / 100;

  return {
    plan,
    services,
    confidence: Math.round(confidence * 100) / 100,
    parseWarnings: warnings,
  };
}

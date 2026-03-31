/**
 * Plan Matching Engine
 *
 * Multi-signal fuzzy matching engine that scores candidate plans from plan_catalog
 * against user-provided data and returns ranked matches with confidence scores.
 *
 * Signals: insurer name, plan name, state, plan type, metal level, deductible, OOP max, plan source.
 */

import { SupabaseClient } from "@supabase/supabase-js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MatchInput {
  insurerName?: string;
  planName?: string;
  planType?: string;
  state?: string;
  groupNumber?: string;
  metalLevel?: string;
  memberId?: string;
  deductible?: number;
  oopMax?: number;
  premium?: number;
  planSource?: string; // "employer" | "marketplace" | "off_exchange" | "medicare" | "medicaid"
}

export interface PlanCatalogRow {
  id: string;
  hios_id: string | null;
  plan_name: string;
  plan_type: string | null;
  state: string | null;
  year: number | null;
  metal_level: string | null;
  premium_individual: number | null;
  insurer_id: string | null;
  insurer_name?: string;
  raw_data: Record<string, unknown> | null;
  sbc_document_url: string | null;
  data_status: string | null;
}

export interface MatchResult {
  planId: string;
  planName: string;
  insurerName: string;
  confidence: number; // 0-1
  matchedSignals: string[];
  plan: PlanCatalogRow;
}

// ── Insurer normalization ──────────────────────────────────────────────────────

const INSURER_ALIASES: Record<string, string[]> = {
  UnitedHealthcare: [
    "uhc", "united health", "united healthcare", "united health care",
    "unitedhealth", "optum", "uhg", "united healthone", "uhc river valley",
    "unitedhealthcare", "golden rule",
  ],
  "Anthem / Blue Cross Blue Shield": [
    "anthem", "bcbs", "blue cross", "bluecross", "blue shield",
    "blueshield", "anthem bcbs", "anthem blue cross", "anthem blue shield",
    "carefirst", "carefirst bcbs", "excellus", "independence blue cross",
    "horizon bcbs", "horizon blue cross", "highmark", "highmark bcbs",
    "blue cross nc", "blue cross and blue shield", "bcbsnc", "bcbsil",
    "bcbstx", "bcbsfl", "florida blue", "premera", "regence",
    "regence bcbs", "bcbsm", "bcbsma", "bcbsmn", "wellmark",
  ],
  Cigna: [
    "cigna", "cigna health", "cigna healthcare", "evernorth",
    "cigna health and life", "connecticare",
  ],
  Aetna: [
    "aetna", "aetna cvs", "cvs aetna", "cvs health", "aetna life",
    "aetna health",
  ],
  "Kaiser Permanente": [
    "kaiser", "kp", "kaiser permanente", "kaiser foundation",
  ],
  Humana: [
    "humana", "humana inc", "humana health",
  ],
  "Molina Healthcare": [
    "molina", "molina healthcare",
  ],
  "Oscar Health": [
    "oscar", "oscar health",
  ],
  Centene: [
    "centene", "ambetter", "wellcare", "health net", "fidelis",
    "peach state", "sunshine health", "superior healthplan",
  ],
  HCSC: [
    "hcsc", "health care service corporation",
  ],
  Medica: [
    "medica", "medica health plans",
  ],
  "Harvard Pilgrim": [
    "harvard pilgrim", "point32health",
  ],
  "Bright Health": [
    "bright health", "bright healthcare",
  ],
  "Priority Health": [
    "priority health",
  ],
};

// Build reverse lookup: alias → canonical name
const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(INSURER_ALIASES)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical);
  }
}

/**
 * Normalize an insurer name to its canonical form.
 * Returns the canonical name if found, otherwise the input cleaned up.
 */
export function normalizeInsurerName(name: string): string {
  const lower = name.toLowerCase().trim();

  // Direct alias match
  const direct = ALIAS_TO_CANONICAL.get(lower);
  if (direct) return direct;

  // Substring match: check if any alias is contained in the input
  for (const [alias, canonical] of ALIAS_TO_CANONICAL) {
    if (lower.includes(alias) && alias.length >= 3) {
      return canonical;
    }
  }

  // Clean up the input
  return name.trim().replace(/\s*(Inc\.?|Corp\.?|LLC|Company|Group|Holdings?)\s*$/i, "").trim();
}

// ── Plan type normalization ────────────────────────────────────────────────────

const PLAN_TYPE_MAP: Record<string, string> = {
  oap: "PPO",     // Open Access Plus → PPO variant
  cdhp: "HDHP",   // Consumer Directed → HDHP
  pos: "POS",
  "pos ii": "POS",
  hmo: "HMO",
  ppo: "PPO",
  epo: "EPO",
  hdhp: "HDHP",
};

function normalizePlanType(type: string): string {
  return PLAN_TYPE_MAP[type.toLowerCase().trim()] || type.toUpperCase().trim();
}

// ── Scoring functions ──────────────────────────────────────────────────────────

/** Trigram similarity between two strings (0-1). Simple JS implementation. */
function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return 1;

  const triA = trigrams(la);
  const triB = trigrams(lb);
  if (triA.size === 0 || triB.size === 0) return 0;

  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  return intersection / Math.max(triA.size, triB.size);
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const result = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    result.add(padded.slice(i, i + 3));
  }
  return result;
}

/**
 * Clean plan name by removing common suffixes/codes that don't help matching.
 * e.g., "UnitedHealthcare Choice Plus IN-022 (POS II)" → "unitedhealthcare choice plus"
 */
function cleanPlanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]{2}-\d{3}\b/gi, "")        // state-code identifiers like "IN-022"
    .replace(/\(.*?\)/g, "")                      // parenthesized suffixes
    .replace(/\b\d{4}\b/g, "")                    // year numbers
    .replace(/\b(bronze|silver|gold|platinum)\b/gi, "") // metal levels (scored separately)
    .replace(/\s+/g, " ")
    .trim();
}

/** Proximity score for numeric values. Full credit within 10%, partial within 25%. */
function proximityScore(actual: number, candidate: number): number {
  if (actual === 0 || candidate === 0) return 0;
  const ratio = Math.abs(actual - candidate) / actual;
  if (ratio <= 0.10) return 1;
  if (ratio <= 0.25) return 0.5;
  return 0;
}

// ── Signal weights ─────────────────────────────────────────────────────────────

const WEIGHTS = {
  insurer: 30,
  planName: 25,
  state: 15,
  planType: 10,
  metalLevel: 10,
  costProximity: 5,
  planSource: 5,
};

const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// ── Main matching function ─────────────────────────────────────────────────────

/**
 * Match user input against plans in plan_catalog.
 * Returns top matches sorted by confidence, minimum threshold 0.3.
 *
 * Strategy:
 * 1. Narrow candidates using state (exact) and insurer (fuzzy) filters in SQL
 * 2. Score each candidate against all input signals
 * 3. Return top 5 above threshold
 */
export async function matchPlan(
  supabase: SupabaseClient,
  input: MatchInput,
  options?: { limit?: number; minConfidence?: number }
): Promise<MatchResult[]> {
  const limit = options?.limit ?? 5;
  const minConfidence = options?.minConfidence ?? 0.3;

  // Resolve insurer to canonical name + catalog ID
  let insurerCanonical: string | null = null;
  let insurerCatalogId: string | null = null;

  if (input.insurerName) {
    insurerCanonical = normalizeInsurerName(input.insurerName);

    // Look up insurer in catalog
    const { data: insurerRows } = await supabase
      .from("insurer_catalog")
      .select("id, name")
      .or(`name.ilike.%${insurerCanonical}%,aliases.cs.{${input.insurerName.toLowerCase()}}`)
      .limit(5);

    if (insurerRows && insurerRows.length > 0) {
      // Pick best match
      let bestSim = 0;
      for (const row of insurerRows) {
        const sim = trigramSimilarity(insurerCanonical, row.name);
        if (sim > bestSim) {
          bestSim = sim;
          insurerCatalogId = row.id;
        }
      }
    }
  }

  // Build SQL query to narrow candidates
  let query = supabase
    .from("plan_catalog")
    .select("id, hios_id, plan_name, plan_type, state, year, metal_level, premium_individual, insurer_id, raw_data, sbc_document_url, data_status")
    .order("plan_name");

  // Hard filter: state (eliminates ~98% of plans)
  if (input.state) {
    query = query.eq("state", input.state);
  }

  // Soft filter: insurer (if we resolved it)
  if (insurerCatalogId) {
    query = query.eq("insurer_id", insurerCatalogId);
  }

  // Plan source filter: marketplace users shouldn't see medicare plans, etc.
  if (input.planSource === "marketplace") {
    query = query.in("marketplace_type", ["ffm", "sbe"]);
  } else if (input.planSource === "medicare") {
    query = query.eq("marketplace_type", "medicare");
  }

  // Limit candidates to something reasonable
  query = query.limit(200);

  const { data: candidates, error } = await query;

  if (error || !candidates || candidates.length === 0) {
    return [];
  }

  // Fetch insurer names for matched candidates
  const insurerIds = [...new Set(candidates.map((c) => c.insurer_id).filter(Boolean))];
  const insurerNameMap = new Map<string, string>();

  if (insurerIds.length > 0) {
    const { data: insurers } = await supabase
      .from("insurer_catalog")
      .select("id, name")
      .in("id", insurerIds);

    if (insurers) {
      for (const ins of insurers) {
        insurerNameMap.set(ins.id, ins.name);
      }
    }
  }

  // Score each candidate
  const normalizedInputType = input.planType ? normalizePlanType(input.planType) : null;
  const cleanedInputName = input.planName ? cleanPlanName(input.planName) : null;

  const scored: MatchResult[] = candidates.map((c) => {
    let score = 0;
    const matched: string[] = [];

    // Insurer match (30 pts)
    if (insurerCanonical && c.insurer_id) {
      const candidateInsurer = insurerNameMap.get(c.insurer_id) || "";
      const sim = trigramSimilarity(insurerCanonical, candidateInsurer);
      if (sim > 0.3) {
        score += WEIGHTS.insurer * sim;
        matched.push("insurer");
      }
    }

    // Plan name match (25 pts)
    if (cleanedInputName && c.plan_name) {
      const cleanedCandidate = cleanPlanName(c.plan_name);
      const sim = trigramSimilarity(cleanedInputName, cleanedCandidate);
      if (sim > 0.2) {
        score += WEIGHTS.planName * sim;
        matched.push("planName");
      }
    }

    // State match (15 pts) — exact
    if (input.state && c.state) {
      if (input.state.toUpperCase() === c.state.toUpperCase()) {
        score += WEIGHTS.state;
        matched.push("state");
      }
    }

    // Plan type match (10 pts)
    if (normalizedInputType && c.plan_type) {
      const candidateType = normalizePlanType(c.plan_type);
      if (normalizedInputType === candidateType) {
        score += WEIGHTS.planType;
        matched.push("planType");
      }
    }

    // Metal level match (10 pts)
    if (input.metalLevel && c.metal_level) {
      if (input.metalLevel.toLowerCase() === c.metal_level.toLowerCase()) {
        score += WEIGHTS.metalLevel;
        matched.push("metalLevel");
      }
    }

    // Cost proximity (5 pts)
    const rawData = c.raw_data as Record<string, unknown> | null;
    if (rawData) {
      let costScore = 0;
      let costFactors = 0;

      if (input.deductible != null && rawData.deductible_individual != null) {
        costScore += proximityScore(input.deductible, rawData.deductible_individual as number);
        costFactors++;
      }
      if (input.oopMax != null && rawData.oop_max_individual != null) {
        costScore += proximityScore(input.oopMax, rawData.oop_max_individual as number);
        costFactors++;
      }
      if (input.premium != null && c.premium_individual != null) {
        costScore += proximityScore(input.premium, c.premium_individual);
        costFactors++;
      }

      if (costFactors > 0) {
        score += WEIGHTS.costProximity * (costScore / costFactors);
        matched.push("cost");
      }
    }

    // Plan source (5 pts) — already filtered in SQL, bonus for matching
    if (input.planSource) {
      score += WEIGHTS.planSource; // Already filtered, so all candidates match
      matched.push("planSource");
    }

    const confidence = score / TOTAL_WEIGHT;

    return {
      planId: c.id,
      planName: c.plan_name,
      insurerName: insurerNameMap.get(c.insurer_id || "") || "",
      confidence,
      matchedSignals: matched,
      plan: {
        ...c,
        insurer_name: insurerNameMap.get(c.insurer_id || ""),
      } as PlanCatalogRow,
    };
  });

  // Filter and sort
  return scored
    .filter((r) => r.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Quick insurer lookup by name. Returns the best-matching insurer catalog entry.
 */
export async function findInsurer(
  supabase: SupabaseClient,
  name: string
): Promise<{ id: string; name: string } | null> {
  const canonical = normalizeInsurerName(name);

  const { data } = await supabase
    .from("insurer_catalog")
    .select("id, name")
    .or(`name.ilike.%${canonical}%,normalized_name.eq.${canonical.toLowerCase()}`)
    .limit(5);

  if (!data || data.length === 0) return null;

  // Return best trigram match
  let best = data[0];
  let bestSim = 0;
  for (const row of data) {
    const sim = trigramSimilarity(canonical, row.name);
    if (sim > bestSim) {
      bestSim = sim;
      best = row;
    }
  }

  return { id: best.id, name: best.name };
}

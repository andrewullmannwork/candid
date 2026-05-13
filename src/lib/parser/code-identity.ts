// S74.5 D2 — Code+Description Categorization Flywheel: signature normalization,
// composite-key lookup, Haiku-nearest fallback, cost cap, main entry point.
//
// Per plans/s74.5_categorization_flywheel.md v2 §3 Layer A+B + §5 + Q1+Q6 LOCK.
//
// Architecture:
//   1. normalizeDescriptionSignature() — pure, deterministic, no Haiku
//   2. lookupExactSignature() — composite-key DB lookup
//   3. haikuNearestSignature() — Haiku similarity (gated by per-user-day cap)
//   4. proposeNewSignature() — insert proposed row
//   5. categorizeLineItem() — main entry; called from D4 parser wiring
//
// All callers should run server-side (uses service-role Supabase client).

import { createServerClient } from "../supabase/server";
import { callHaikuWithCache } from "../haiku-client/base";
import { inferProcedureCodeType } from "../billing/code-type-inference";
import type { ProcedureCodeType } from "../billing/types";

// ============================================================================
// Pure normalization
// ============================================================================

const STOPWORDS = new Set([
  "the", "and", "or", "of", "for", "to", "a", "an", "in", "on", "at",
  // Common billing-line noise prefixes — meaningless to categorization
  "pr", "hc", "pt",
]);

// Conservative abbreviation collapse — only the highest-frequency medical-billing
// short forms. Haiku similarity catches the long tail.
const ABBREVIATIONS: Record<string, string> = {
  preventive: "prev",
  established: "est",
  outpatient: "outpt",
  inpatient: "inpt",
  professional: "prof",
  vaccine: "vacc",
  vaccines: "vacc",
  vaccination: "vacc",
  immunization: "immun",
  immunizations: "immun",
};

function applyAbbreviation(token: string): string {
  return ABBREVIATIONS[token] ?? token;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a provider description into a deterministic signature for Layer A
 * composite-key lookup. Order-invariant by design (sort tokens) so providers'
 * varying word orders collapse to the same key.
 *
 * Pure: no DB, no Haiku, no side effects.
 */
export function normalizeDescriptionSignature(description: string, code: string): string {
  if (!description) return "";

  let s = description.toLowerCase();

  // Strip the billing code if embedded (providers often prefix with code)
  if (code) {
    const codeLower = code.toLowerCase();
    s = s.replace(new RegExp(`\\b${escapeRegex(codeLower)}\\b`, "g"), " ");
  }

  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";

  const tokens = s
    .split(" ")
    .filter((t) => {
      if (!t) return false;
      if (STOPWORDS.has(t)) return false;
      // Drop 1-char tokens (mostly noise)
      if (t.length <= 1) return false;
      // Drop patient-id-looking long numbers (5+ digits aren't billing categories)
      if (/^\d{5,}$/.test(t)) return false;
      return true;
    })
    .map(applyAbbreviation)
    .sort();

  return tokens.join(" ");
}

// ============================================================================
// DB layer (service-role; Pattern 1 #14 writes via apply_mapping_promotion only)
// ============================================================================

interface BillingCodeIdentityRow {
  id: string;
  billing_code: string;
  billing_code_type: ProcedureCodeType;
  description_signature: string;
  description_examples: string[];
  service_slug: string | null;
  promotion_state: "proposed" | "corroborated" | "admin_verified";
  confidence: number;
  distinct_user_count: number;
}

export interface LookupResult {
  identityId: string;
  serviceSlug: string | null;
  confidence: number;
  promotionState: BillingCodeIdentityRow["promotion_state"];
}

export async function lookupExactSignature(
  code: string,
  codeType: ProcedureCodeType,
  signature: string,
): Promise<LookupResult | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("billing_code_identity")
    .select("id, service_slug, confidence, promotion_state")
    .eq("billing_code", code)
    .eq("billing_code_type", codeType)
    .eq("description_signature", signature)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[code-identity] lookupExactSignature error", error);
    return null;
  }
  if (!data) return null;
  return {
    identityId: data.id as string,
    serviceSlug: data.service_slug as string | null,
    confidence: data.confidence as number,
    promotionState: data.promotion_state as BillingCodeIdentityRow["promotion_state"],
  };
}

/**
 * Append a raw description example to an existing identity row (top 5; dedup).
 */
export async function addDescriptionExample(
  identityId: string,
  rawDescription: string,
): Promise<void> {
  const supabase = createServerClient();
  const { data: row, error: readErr } = await supabase
    .from("billing_code_identity")
    .select("description_examples")
    .eq("id", identityId)
    .maybeSingle();
  if (readErr || !row) return;

  const existing = (row.description_examples as string[]) ?? [];
  if (existing.includes(rawDescription)) return;
  const updated = [rawDescription, ...existing].slice(0, 5);

  await supabase
    .from("billing_code_identity")
    .update({ description_examples: updated })
    .eq("id", identityId);
}

/**
 * Insert a new proposed signature row. Idempotent on the composite UNIQUE —
 * on race conflict, re-queries the existing row.
 */
export async function proposeNewSignature(opts: {
  code: string;
  codeType: ProcedureCodeType;
  signature: string;
  rawDescription: string;
  proposedSlug: string | null;
  proposedByUserId: string | null;
}): Promise<LookupResult | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("billing_code_identity")
    .insert({
      billing_code: opts.code,
      billing_code_type: opts.codeType,
      description_signature: opts.signature,
      description_examples: [opts.rawDescription],
      service_slug: opts.proposedSlug,
      promotion_state: "proposed",
      confidence: 0.5,
      distinct_user_count: 1,
      proposed_by_user_id: opts.proposedByUserId,
    })
    .select("id, service_slug, confidence, promotion_state")
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation; race lost — re-query.
    if ((error as { code?: string }).code === "23505") {
      return lookupExactSignature(opts.code, opts.codeType, opts.signature);
    }
    console.warn("[code-identity] proposeNewSignature error", error);
    return null;
  }
  if (!data) return null;
  return {
    identityId: data.id as string,
    serviceSlug: data.service_slug as string | null,
    confidence: data.confidence as number,
    promotionState: data.promotion_state as BillingCodeIdentityRow["promotion_state"],
  };
}

// ============================================================================
// Haiku similarity scoring (only fires on signature-miss; per-user-day capped)
// ============================================================================

const HAIKU_NEAREST_INSTRUCTIONS = `You are matching a medical billing line item description to the closest existing description signature for the same billing code.

Input JSON:
{
  "target": { "raw": "<raw provider description>", "signature": "<normalized target signature>" },
  "candidates": [ { "signature": "<existing>", "examples": ["<raw>", ...] }, ... ]
}

Return ONE JSON object with this shape (no markdown, no commentary):
{
  "best_match_signature": "<existing signature>" | null,
  "similarity": 0.0..1.0,
  "reason": "<one sentence>"
}

Scoring guide:
- similarity >= 0.85 → "same semantic concept; reuse the existing mapping"
- similarity <  0.85 → "different concept; propose a new signature"

HIGH similarity examples (>=0.85):
- "OFFICE VISIT PREV EST AGE 18-39" ↔ "office visit preventive established"
- "Pfizer SARS-CoV-2 mRNA Vaccine" ↔ "COVID-19 vaccine mRNA"
- "MRI BRAIN W/O CONTRAST" ↔ "magnetic resonance imaging brain"

LOW similarity examples (<0.85):
- "office visit preventive" ↔ "office visit problem focused"
- "flu vaccine" ↔ "COVID vaccine"
- "lab panel comprehensive" ↔ "lab panel basic"

If candidates is empty or none match semantically, return best_match_signature=null with similarity=0.`;

interface NearestRaw {
  best_match_signature: string | null;
  similarity: number;
  reason: string;
}

export interface HaikuNearestResult {
  identityId: string;
  serviceSlug: string | null;
  confidence: number;
  promotionState: BillingCodeIdentityRow["promotion_state"];
  similarity: number;
}

export async function haikuNearestSignature(
  code: string,
  codeType: ProcedureCodeType,
  signature: string,
  rawDescription: string,
  thresholdOverride?: number,
): Promise<HaikuNearestResult | null> {
  const threshold = thresholdOverride ?? 0.85;

  const supabase = createServerClient();
  const { data: candidates, error } = await supabase
    .from("billing_code_identity")
    .select("id, description_signature, description_examples, service_slug, confidence, promotion_state")
    .eq("billing_code", code)
    .eq("billing_code_type", codeType)
    .order("confidence", { ascending: false })
    .limit(10);

  if (error || !candidates || candidates.length === 0) return null;

  const userContent = JSON.stringify(
    {
      target: { raw: rawDescription, signature },
      candidates: candidates.map((c) => ({
        signature: c.description_signature,
        examples: c.description_examples,
      })),
    },
    null,
    2,
  );

  try {
    const result = await callHaikuWithCache<NearestRaw>({
      systemPrompt: HAIKU_NEAREST_INSTRUCTIONS,
      userContent,
      sectionLabel: `code-identity-nearest/${code}-${codeType}`,
    });

    const sim = Number(result.data.similarity ?? 0);
    if (!Number.isFinite(sim) || sim < threshold) return null;
    if (!result.data.best_match_signature) return null;

    const winner = candidates.find(
      (c) => c.description_signature === result.data.best_match_signature,
    );
    if (!winner) return null;

    return {
      identityId: winner.id as string,
      serviceSlug: winner.service_slug as string | null,
      confidence: winner.confidence as number,
      promotionState: winner.promotion_state as BillingCodeIdentityRow["promotion_state"],
      similarity: sim,
    };
  } catch (err) {
    console.warn("[code-identity] haikuNearestSignature failed", err);
    return null;
  }
}

// ============================================================================
// Per-user-day Haiku budget cap (Q6 LOCK = 100 calls/user/day)
// ============================================================================
// Process-local map; resets on serverless cold-start. Sufficient for v1 cold-
// start scale where no single user uploads >100 distinct unknown signatures
// per day. Future: persist to Redis/DB for cross-instance enforcement.

const HAIKU_DAILY_CAP_BY_USER = new Map<string, { day: string; count: number }>();
const DEFAULT_DAILY_CAP = 100;

export function reserveHaikuBudget(userId: string, capOverride?: number): boolean {
  const cap = capOverride ?? DEFAULT_DAILY_CAP;
  const today = new Date().toISOString().slice(0, 10);
  const entry = HAIKU_DAILY_CAP_BY_USER.get(userId);
  if (!entry || entry.day !== today) {
    HAIKU_DAILY_CAP_BY_USER.set(userId, { day: today, count: 1 });
    return true;
  }
  if (entry.count >= cap) return false;
  entry.count += 1;
  return true;
}

// ============================================================================
// Main entry — called by haiku-bill-parser categorization wiring (D4)
// ============================================================================

export interface CategorizeResult {
  identityId: string | null;
  serviceSlug: string | null;
  confidence: number;
  needsReview: boolean;
  matchKind: "exact" | "haiku_nearest" | "proposed" | "skipped";
}

export async function categorizeLineItem(opts: {
  code: string;
  codeType: ProcedureCodeType | undefined;
  description: string;
  userId: string | null;
}): Promise<CategorizeResult> {
  const codeType = opts.codeType ?? inferProcedureCodeType(opts.code);
  if (!codeType || !opts.code) {
    return { identityId: null, serviceSlug: null, confidence: 0.3, needsReview: true, matchKind: "skipped" };
  }

  const signature = normalizeDescriptionSignature(opts.description, opts.code);
  if (!signature) {
    return { identityId: null, serviceSlug: null, confidence: 0.3, needsReview: true, matchKind: "skipped" };
  }

  const exact = await lookupExactSignature(opts.code, codeType, signature);
  if (exact && exact.serviceSlug) {
    return {
      identityId: exact.identityId,
      serviceSlug: exact.serviceSlug,
      confidence: exact.confidence,
      needsReview: exact.promotionState === "proposed",
      matchKind: "exact",
    };
  }

  const userIdForCap = opts.userId ?? "anonymous";
  if (reserveHaikuBudget(userIdForCap)) {
    const nearest = await haikuNearestSignature(opts.code, codeType, signature, opts.description);
    if (nearest && nearest.serviceSlug) {
      await addDescriptionExample(nearest.identityId, opts.description);
      return {
        identityId: nearest.identityId,
        serviceSlug: nearest.serviceSlug,
        confidence: nearest.confidence,
        needsReview: nearest.promotionState === "proposed",
        matchKind: "haiku_nearest",
      };
    }
  }

  const proposed = await proposeNewSignature({
    code: opts.code,
    codeType,
    signature,
    rawDescription: opts.description,
    proposedSlug: null,
    proposedByUserId: opts.userId,
  });

  return {
    identityId: proposed?.identityId ?? null,
    serviceSlug: null,
    confidence: 0.3,
    needsReview: true,
    matchKind: "proposed",
  };
}

/**
 * S74.6 D4 — Description → service_catalog Haiku similarity match.
 *
 * When a line item's billing code has no resolved slug (no billing_code_identity
 * row, or `promotion_state='proposed'`), Haiku compares the line's description
 * against `service_catalog.name` entries and returns a ranked top-K list with
 * similarity scores 0-1. Caller (audit pipeline) decides:
 *
 *   - top score ≥ 0.85, gap to next ≥ 0.05 → confident match; cast a vote
 *     (`bill_observed_description_match`) toward the matched slug, fire
 *     `code_uncategorized_description_match` finding with the provisional slug.
 *   - top score ≥ 0.85, gap to next < 0.05 → ambiguous; write 2 candidate rows
 *     (`bill_observed_description_match_candidate` source on each, no vote),
 *     surface admin queue row, render top-1 in UI.
 *   - top score < 0.85 → fire soft `uncategorized_service` finding.
 *
 * Cost protection: each Haiku call increments the existing
 * `haiku_budget_tracking` counter via `reserve_haiku_budget` RPC (mig 091).
 * Per-user-day cap rejects further calls beyond the configured budget;
 * caller treats rejection as "no match this run" (graceful degradation).
 *
 * Match scope: full service_catalog (NOT limited to user's plan_covered_services).
 * Per Q-S87-C4 — broader vocabulary needed at cold-start; the slug-in-plan
 * informational flag is captured separately if needed.
 */

import { callHaikuWithCache } from "../haiku-client/base";
import { guardedHaikuCall } from "../haiku-client/spend-guard";
import { createServerClient } from "../supabase/server";
import { isFeatureEnabled } from "../config/product-flags";
import { randomUUID } from "crypto";
import type { ParsedBill, AuditFinding, BillLineItem } from "../billing/types";

export interface DescriptionMatchCandidate {
  slug: string;
  /** 0-1 similarity score (Haiku-self-reported). */
  score: number;
}

export interface DescriptionMatchResult {
  /** Sorted desc by score. May be empty (no Haiku call OR no matches above the noise floor). */
  candidates: DescriptionMatchCandidate[];
  /** Convenience: candidates[0] || null. */
  topMatch: DescriptionMatchCandidate | null;
  /** Convenience: candidates[1] || null. */
  secondMatch: DescriptionMatchCandidate | null;
  /** True when topMatch.score >= 0.85 AND (topMatch.score - secondMatch.score) < 0.05. */
  ambiguous: boolean;
  /** True when topMatch.score >= 0.85 AND NOT ambiguous. */
  confident: boolean;
  /** Set when the Haiku budget rejected the call. */
  skippedReason?: "budget_exceeded" | "haiku_error" | "no_description";
}

const TOP_K = 5;
const CONFIDENT_FLOOR = 0.85;
const AMBIGUITY_WINDOW = 0.05;

const INSTRUCTIONS = `You are matching a billing description from a medical bill against a curated catalog of service slugs.

The catalog is a list of slug names (e.g., \`primary_care_visit\`, \`mri_imaging\`, \`physical_therapy\`). The description is short, often abbreviated, and may use carrier-specific shorthand.

Score each candidate slug 0-1 by semantic similarity to the description. Examples:
- Description "OFFICE VISIT EST PRIMARY CARE" → \`primary_care_visit\` 0.95, \`specialist_visit\` 0.45
- Description "MRI BRAIN W/O CONTRAST" → \`mri_imaging\` 0.92, \`ct_scan\` 0.35
- Description "BLOOD DRAW VENIPUNCTURE" → \`lab_test\` 0.88, \`blood_panel\` 0.65
- Description "ANESTHESIA GENERAL" → \`anesthesia\` 0.95
- Description "ROOM CHARGE PER DIEM" → \`inpatient_room\` 0.85, \`hospital_stay\` 0.55

Return ONLY the JSON object below — no commentary, no markdown fences:

{
  "matches": [
    { "slug": "<exact_slug_from_catalog>", "score": 0.91 },
    { "slug": "<second_slug>", "score": 0.55 }
  ]
}

Rules:
- Return at most 5 matches, sorted by score descending.
- Only emit slugs that EXIST in the provided catalog (verbatim string match).
- Be conservative: a score ≥ 0.85 should reflect strong semantic alignment, not pattern-match-ish guessing.
- If NO catalog entry is a reasonable match (score >= 0.50), return matches: [].
- If the description is too short or generic to disambiguate (e.g., just "MEDICAL"), return matches: [].

`;

interface HaikuResponse {
  matches?: Array<{ slug?: unknown; score?: unknown }>;
}

/**
 * Reserve one budget slot for a description-match call. Mirrors the existing
 * S74.5 D2 cost-cap discipline (reserve_haiku_budget RPC; mig 091). Returns
 * true when the slot was reserved; false when the user is over budget.
 */
async function reserveBudgetSlot(userId: string, cap = 500): Promise<boolean> {
  if (!userId) return false;
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("reserve_haiku_budget", {
    p_user_id: userId,
    p_max: cap,
  });
  if (error) {
    console.warn("[description-service-match] budget reserve failed", error);
    return false;
  }
  return Boolean(data);
}

/**
 * Score one bill description against the full service_catalog. Returns an
 * empty result when budget is exceeded, Haiku errors, or description is blank.
 *
 * @param description Raw billed description from the line item
 * @param catalogSlugs Pre-loaded list of valid service_catalog slugs (caller passes
 *   to avoid N+1 queries; reuse across all lines in one bill)
 * @param userId Used for per-user-day budget reservation
 */
export async function scoreDescriptionAgainstCatalog(opts: {
  description: string | null | undefined;
  catalogSlugs: readonly string[];
  userId: string;
  budgetCap?: number;
}): Promise<DescriptionMatchResult> {
  const empty: DescriptionMatchResult = {
    candidates: [],
    topMatch: null,
    secondMatch: null,
    ambiguous: false,
    confident: false,
  };

  if (!opts.description || opts.description.trim().length < 3) {
    return { ...empty, skippedReason: "no_description" };
  }
  if (opts.catalogSlugs.length === 0) return empty;

  const slotReserved = await reserveBudgetSlot(opts.userId, opts.budgetCap);
  if (!slotReserved) return { ...empty, skippedReason: "budget_exceeded" };

  // System prompt = INSTRUCTIONS + catalog list (the catalog is the cacheable
  // prefix; ~300 short slugs ≈ a few KB, well past Haiku's 4096-token cache
  // threshold so the prefix caches across calls in the same request batch).
  const catalogBlock = opts.catalogSlugs.join("\n");
  const systemPrompt = `${INSTRUCTIONS}\n\n## CATALOG\n\n${catalogBlock}\n\n## DESCRIPTION TO MATCH:\n`;

  // S74.6 D-cost §F.1 — wrap the Haiku call with the spend-cap guard. The
  // guard returns `paused: true` when the user is already over their daily
  // $10 cap (or when this call would trip it). Tripping the cap fires the
  // §F.3 admin alert via the spend-guard helper.
  const descTrim = (opts.description ?? "").trim();
  const guarded = await guardedHaikuCall(
    opts.userId,
    () =>
      callHaikuWithCache<HaikuResponse>({
        systemPrompt,
        userContent: descTrim,
        sectionLabel: "description-service-match",
      }),
  );
  if (guarded.paused) {
    return { ...empty, skippedReason: "budget_exceeded" };
  }
  if (!guarded.data) {
    console.warn("[description-service-match] haiku error", guarded.reason);
    return { ...empty, skippedReason: "haiku_error" };
  }
  const haikuRaw: HaikuResponse = guarded.data;

  const validSlugs = new Set(opts.catalogSlugs);
  const candidates: DescriptionMatchCandidate[] = [];
  for (const m of haikuRaw.matches ?? []) {
    const slug = typeof m.slug === "string" ? m.slug.trim() : "";
    const rawScore = typeof m.score === "number" ? m.score : NaN;
    if (!slug || !Number.isFinite(rawScore)) continue;
    if (!validSlugs.has(slug)) continue;
    const score = Math.min(1, Math.max(0, rawScore));
    candidates.push({ slug, score });
    if (candidates.length >= TOP_K) break;
  }
  candidates.sort((a, b) => b.score - a.score);

  const topMatch = candidates[0] ?? null;
  const secondMatch = candidates[1] ?? null;
  const ambiguous =
    topMatch != null &&
    secondMatch != null &&
    topMatch.score >= CONFIDENT_FLOOR &&
    topMatch.score - secondMatch.score < AMBIGUITY_WINDOW;
  const confident =
    topMatch != null && topMatch.score >= CONFIDENT_FLOOR && !ambiguous;

  return {
    candidates,
    topMatch,
    secondMatch,
    ambiguous,
    confident,
  };
}

/**
 * Load the full service_catalog slug list. Caller reuses this once per bill
 * and passes it to every per-line scoreDescriptionAgainstCatalog call.
 */
export async function loadServiceCatalogSlugs(): Promise<string[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug")
    .is("merged_into_id", null);
  if (error) {
    console.warn("[description-service-match] catalog load failed", error);
    return [];
  }
  return (data ?? [])
    .map((r) => r.slug as string)
    .filter((s): s is string => Boolean(s));
}

/**
 * Map Haiku similarity score to audit-finding confidence. Spec from Subplan §C:
 *   - score 0.85 → audit confidence 0.6
 *   - score 0.95 → audit confidence 0.8
 * Linear interpolation across the [0.85, 0.95] range; capped 0.5 ≤ conf ≤ 0.85.
 */
function similarityToAuditConfidence(score: number): number {
  if (score <= 0.85) return 0.6;
  if (score >= 0.95) return 0.8;
  const span = (score - 0.85) / 0.1;
  return 0.6 + span * 0.2;
}

function buildProvisionalFinding(
  item: BillLineItem,
  match: DescriptionMatchCandidate,
  ambiguous: boolean = false,
  secondMatch: DescriptionMatchCandidate | null = null,
): AuditFinding {
  return {
    id: randomUUID(),
    type: "code_uncategorized_description_match",
    severity: "low",
    lineItems: [item.lineNumber],
    title: `Provisional category: ${match.slug.replace(/_/g, " ")}`,
    description: `We couldn't find this billing code (${item.procedureCode || "—"}) in our catalog. Based on the description "${item.description}", it most closely matches "${match.slug.replace(/_/g, " ")}". Review the category pencil icon on this line to confirm or correct.`,
    estimatedOvercharge: 0,
    benchmarkSource: "haiku_description_match",
    billedAmount: item.billedAmount,
    confidence: similarityToAuditConfidence(match.score),
    actionable: false,
    // S74.6 D4 §D.1 + §D.2 — carry the provisional slug + score so persist.ts
    // can route to recordDescriptionMatchVote (confident) or
    // recordAmbiguousCandidate (ambiguous) after line item insert.
    descriptionMatch: {
      provisionalSlug: match.slug,
      haikuScore: match.score,
      ambiguous,
      secondMatch: secondMatch
        ? { slug: secondMatch.slug, score: secondMatch.score }
        : null,
    },
  };
}

function buildUncategorizedFinding(item: BillLineItem): AuditFinding {
  return {
    id: randomUUID(),
    type: "uncategorized_service",
    severity: "low",
    lineItems: [item.lineNumber],
    title: "Service not yet categorized",
    description: `We couldn't auto-categorize this charge (${item.procedureCode || "—"} — "${item.description}"). Review or correct via the category pencil icon. We'll learn from your correction.`,
    estimatedOvercharge: 0,
    benchmarkSource: "haiku_description_match",
    billedAmount: item.billedAmount,
    confidence: 0.5,
    actionable: false,
  };
}

/**
 * S74.6 D4 — audit rule: for each line that lacks a service_slug, dispatch
 * Haiku similarity matching and emit a provisional-category finding (confident)
 * OR a soft uncategorized finding (no match). Gated on
 * `s74_5_categorization_flywheel_v1` flag.
 *
 * v1 scope: emit findings only. Vote recording on `bill_observed_description_match`
 * source + ambiguous candidate row writes are deferred to D4 follow-up (require
 * admin UI to disambiguate; admin pages slated for fast-follow).
 */
export async function runDescriptionMatchCheck(
  bill: ParsedBill,
): Promise<AuditFinding[]> {
  const flagOn = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
  if (!flagOn) return [];

  // S74.6 §C.1 — service-mapper now runs upstream (preflight-slug-resolver),
  // so bill.lineItems carry `serviceSlug` when categorization already resolved.
  // Skip those lines entirely — D4 is for lines we couldn't categorize via
  // cached mapping, flywheel identity, or legacy service-mapper. This both
  // saves Haiku budget and prevents D4 from emitting findings on lines where
  // the user already has a confident category.
  const candidates = bill.lineItems.filter(
    (li) =>
      !li.serviceSlug &&
      li.procedureCode &&
      li.description &&
      li.description.trim().length >= 3,
  );
  if (candidates.length === 0) return [];

  const catalogSlugs = await loadServiceCatalogSlugs();
  if (catalogSlugs.length === 0) return [];

  const findings: AuditFinding[] = [];
  for (const item of candidates) {
    const result = await scoreDescriptionAgainstCatalog({
      description: item.description,
      catalogSlugs,
      userId: bill.userId,
    });
    if (result.skippedReason === "budget_exceeded") {
      // Hit the daily cap — stop iterating; subsequent calls will all reject.
      break;
    }
    if (!result.topMatch) {
      // No catalog match meaningful enough — soft uncategorized finding.
      findings.push(buildUncategorizedFinding(item));
      continue;
    }
    if (result.confident) {
      findings.push(buildProvisionalFinding(item, result.topMatch));
      continue;
    }
    if (result.ambiguous) {
      // §D.2 — surface top-1 as provisional with a hint that the alternative
      // is similar. Persist routes via recordAmbiguousCandidate (writes both
      // candidate slugs + admin queue row) based on the `ambiguous: true`
      // flag in metadata.
      const provisional = buildProvisionalFinding(
        item,
        result.topMatch,
        true,
        result.secondMatch ?? null,
      );
      if (result.secondMatch) {
        provisional.description += ` (Also similar: "${result.secondMatch.slug.replace(/_/g, " ")}" — admin may disambiguate.)`;
      }
      findings.push(provisional);
      continue;
    }
    // Below confident floor and not ambiguous (e.g., top score 0.6) → soft.
    findings.push(buildUncategorizedFinding(item));
  }

  return findings;
}

/**
 * Ing-I (S133) — Candidate-slug suggestion resolver for /admin/review-queue.
 *
 * 2-pass resolver:
 *   Pass 1 (cheap): trigram similarity via RPC find_service_catalog_candidates.
 *                   Pass 1 alone returns when (a) ≥2 candidates with top score
 *                   ≥ semantic_fallback_threshold, OR (b) Pass 2 disabled.
 *   Pass 2 (semantic fallback): Haiku description-match against existing
 *                                canonical service_catalog rows. Fires when
 *                                Pass 1 returns <2 candidates OR top score <
 *                                semantic_fallback_threshold. Writes one row
 *                                to parse_cost_events for Cost-F observability.
 *
 * Thresholds tunable via candidate_suggestions_config flag (mig 127):
 *   - trigram_threshold (0.4): Pass 1 minimum similarity to include
 *   - semantic_fallback_threshold (0.6): Pass 1 top score below which Pass 2 fires
 *   - top_k (3): max candidates surfaced to admin
 *   - haiku_match_score_floor (0.5): Pass 2 minimum score to include
 *
 * Pure helpers (testable):
 *   - parseConfig: extract config from feature_flag_rules row
 *   - buildHaikuMatchPrompt: prompt text given proposed + canonical universe
 *   - parseHaikuMatchResponse: extract { slug, match_score } pairs from response
 *
 * I/O wrapper:
 *   - resolveSlugCandidates: full 2-pass resolver
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordCostEvent } from "@/lib/cost/parse-cost-events";

// Cost figures derived from observed Cost-F PROD averages; adjust per metric:
// admin-tool fixed-text-match is well under typical bill parse (~$0.013) since
// input is tiny (one slug + ~68 canonicals). Cost reported per call.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_MAX_OUTPUT = 1024; // top-K of slug + score; well under any cap
const HAIKU_CALL_BUDGET_USD = 0.005; // conservative upper bound; actual usage tracked via parse_cost_events

export interface CandidateSuggestion {
  slug: string;
  name: string | null;
  description: string | null;
  concept_id: string | null;
  match_score: number;
  source: "trigram" | "haiku";
}

export interface ResolverConfig {
  trigram_threshold: number;
  semantic_fallback_threshold: number;
  top_k: number;
  haiku_match_score_floor: number;
}

export const DEFAULT_CONFIG: ResolverConfig = {
  trigram_threshold: 0.4,
  semantic_fallback_threshold: 0.6,
  top_k: 3,
  haiku_match_score_floor: 0.5,
};

/**
 * Pure: parse + validate config row from feature_flag_rules. Falls back to
 * defaults on any field missing / invalid. Defensive against future schema drift.
 */
export function parseConfig(raw: unknown): ResolverConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const r = raw as Record<string, unknown>;
  const out = { ...DEFAULT_CONFIG };
  if (typeof r.trigram_threshold === "number" && r.trigram_threshold >= 0 && r.trigram_threshold <= 1) {
    out.trigram_threshold = r.trigram_threshold;
  }
  if (typeof r.semantic_fallback_threshold === "number" && r.semantic_fallback_threshold >= 0 && r.semantic_fallback_threshold <= 1) {
    out.semantic_fallback_threshold = r.semantic_fallback_threshold;
  }
  if (typeof r.top_k === "number" && r.top_k >= 1 && r.top_k <= 10) {
    out.top_k = Math.floor(r.top_k);
  }
  if (typeof r.haiku_match_score_floor === "number" && r.haiku_match_score_floor >= 0 && r.haiku_match_score_floor <= 1) {
    out.haiku_match_score_floor = r.haiku_match_score_floor;
  }
  return out;
}

/**
 * Pure: build the Haiku semantic-match prompt for the slug-disambiguation use case.
 *
 * Distinct from src/lib/audit/description-service-match.ts (bill-line-item →
 * canonical match — different semantics). This prompt is tuned for SLUG-VS-SLUG
 * decisions: "is `chiropractic_care` the same concept as one of these existing
 * canonical service_catalog rows?"
 */
export function buildHaikuMatchPrompt(args: {
  proposedSlug: string;
  proposedLabel: string | null;
  canonicalCandidates: Array<{ slug: string; name: string; description: string | null }>;
  topK: number;
  scoreFloor: number;
}): string {
  const universe = args.canonicalCandidates
    .map((c, i) =>
      `${i + 1}. slug=\`${c.slug}\` · name=\`${c.name}\`${c.description ? ` · description=\`${c.description.slice(0, 200)}\`` : ""}`,
    )
    .join("\n");

  return `You are helping a Candid admin decide whether a parser-emitted slug is a duplicate of an existing canonical service_catalog entry.

PROPOSED SLUG: \`${args.proposedSlug}\`
PROPOSED LABEL (admin display): ${args.proposedLabel ? `\`${args.proposedLabel}\`` : "(none provided)"}

EXISTING CANONICAL SERVICE_CATALOG ROWS:
${universe}

Your task: assess which existing canonical row (if any) the proposed slug semantically represents the SAME concept as. Output the top-${args.topK} candidates by semantic match.

Scoring rules (match_score ∈ [0.0, 1.0]):
- 1.0 = exact concept match (different naming convention only; e.g., "pt" vs "physical_therapy")
- 0.8-0.99 = strong match (same medical concept, slight scope difference)
- 0.6-0.79 = plausible match (related concept; admin must decide)
- 0.4-0.59 = weak match (loosely related; admin likely should NOT merge)
- < 0.4 = different concept; do NOT include in output

Filter: only output candidates with match_score >= ${args.scoreFloor}. If no canonical row meets the floor, return an empty array.

Output strictly as JSON: \`{"candidates": [{"slug": "...", "match_score": 0.X}, ...]}\`. Do not include any other text.`;
}

/**
 * Pure: parse Haiku response. Defensive against malformed JSON / missing fields.
 * Returns [] on any parse failure (matches resolver expectation of empty
 * fallback rather than throwing into a non-fatal cost-tracking path).
 */
export function parseHaikuMatchResponse(raw: string): Array<{ slug: string; match_score: number }> {
  try {
    // Haiku occasionally wraps in markdown code fences; strip if present.
    const cleaned = raw.replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const cands = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(cands)) return [];
    return cands
      .filter((c): c is { slug: string; match_score: number } => {
        return (
          c !== null &&
          typeof c === "object" &&
          typeof (c as Record<string, unknown>).slug === "string" &&
          typeof (c as Record<string, unknown>).match_score === "number" &&
          (c as { match_score: number }).match_score >= 0 &&
          (c as { match_score: number }).match_score <= 1
        );
      })
      .map((c) => ({ slug: c.slug, match_score: c.match_score }));
  } catch {
    return [];
  }
}

export interface ResolveSlugCandidatesArgs {
  supabase: SupabaseClient;
  proposedSlug: string;
  proposedLabel: string | null;
  config?: ResolverConfig;
  /** Admin user id for cost attribution; pass null for backfill/admin-script use */
  adminUserId?: string | null;
  /** Optional Anthropic client override for testing */
  anthropicCall?: (prompt: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/**
 * I/O wrapper: full 2-pass resolver.
 *
 * Returns top-K candidates (trigram + optionally Haiku). Always non-throwing
 * — telemetry write failures don't propagate. On Pass 2 failure (Haiku error
 * / JSON parse failure), returns Pass 1 results unchanged.
 */
export async function resolveSlugCandidates(
  args: ResolveSlugCandidatesArgs,
): Promise<CandidateSuggestion[]> {
  const config = args.config ?? DEFAULT_CONFIG;

  // ─── Pass 1: trigram via RPC ───────────────────────────────────────────
  const { data: pass1Raw, error: pass1Err } = await args.supabase.rpc(
    "find_service_catalog_candidates",
    {
      p_proposed_slug: args.proposedSlug,
      p_proposed_label: args.proposedLabel,
      p_top_k: config.top_k,
      p_threshold: config.trigram_threshold,
    },
  );

  if (pass1Err) {
    console.warn(
      `[review-queue-candidates] Pass 1 RPC failed for "${args.proposedSlug}": ${pass1Err.message}`,
    );
    return [];
  }

  const pass1: CandidateSuggestion[] = ((pass1Raw ?? []) as Array<{
    slug: string;
    name: string | null;
    description: string | null;
    concept_id: string | null;
    match_score: number;
  }>).map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    concept_id: r.concept_id,
    match_score: Number(r.match_score),
    source: "trigram" as const,
  }));

  // Pass 1 sufficient? Return early.
  const topScore = pass1[0]?.match_score ?? 0;
  if (pass1.length >= 2 && topScore >= config.semantic_fallback_threshold) {
    return pass1;
  }

  // ─── Pass 2: Haiku semantic match ──────────────────────────────────────
  // Load existing canonical service_catalog rows (universe ~68 today)
  const { data: universeRaw, error: universeErr } = await args.supabase
    .from("service_catalog")
    .select("slug, name, description")
    .eq("canonical_for_concept", true)
    .eq("proposal_state", "canonical")
    .neq("slug", args.proposedSlug);

  if (universeErr || !universeRaw) {
    console.warn(
      `[review-queue-candidates] Pass 2 universe load failed: ${universeErr?.message ?? "no data"}`,
    );
    return pass1;
  }

  // Haiku call (lazy-import Anthropic client to avoid loading SDK in test paths)
  let haikuPairs: Array<{ slug: string; match_score: number }> = [];
  let costRecorded = false;
  try {
    const prompt = buildHaikuMatchPrompt({
      proposedSlug: args.proposedSlug,
      proposedLabel: args.proposedLabel,
      canonicalCandidates: universeRaw as Array<{
        slug: string;
        name: string;
        description: string | null;
      }>,
      topK: config.top_k,
      scoreFloor: config.haiku_match_score_floor,
    });

    const callFn = args.anthropicCall ?? defaultAnthropicCall;
    const { text, inputTokens, outputTokens } = await callFn(prompt);
    haikuPairs = parseHaikuMatchResponse(text);

    // Cost-F write: one row per Haiku call (Ship Gate G6 compliance)
    await recordCostEvent(args.supabase, {
      userId: args.adminUserId ?? null,
      parserKind: "admin_candidate_match",
      costSource: "admin_action",
      costUsd: HAIKU_CALL_BUDGET_USD,
      haikuTokensInput: inputTokens,
      haikuTokensOutput: outputTokens,
      metadata: {
        proposed_slug: args.proposedSlug,
        proposed_label: args.proposedLabel,
        universe_size: universeRaw.length,
        pass1_top_score: topScore,
        pass1_count: pass1.length,
      },
    });
    costRecorded = true;
  } catch (err) {
    console.warn(
      `[review-queue-candidates] Pass 2 Haiku call failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (!costRecorded) {
      // Record zero-cost event with error marker for visibility
      await recordCostEvent(args.supabase, {
        userId: args.adminUserId ?? null,
        parserKind: "admin_candidate_match",
        costSource: "admin_action",
        costUsd: 0,
        metadata: {
          proposed_slug: args.proposedSlug,
          error: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => undefined);
    }
    return pass1;
  }

  // Merge Pass 1 + Pass 2 by slug; Haiku score wins on conflict (semantic > syntactic)
  const merged = new Map<string, CandidateSuggestion>();
  for (const c of pass1) merged.set(c.slug, c);
  for (const h of haikuPairs) {
    const universeRow = (universeRaw as Array<{
      slug: string;
      name: string;
      description: string | null;
    }>).find((r) => r.slug === h.slug);
    if (!universeRow) continue; // Haiku hallucinated a slug not in universe; drop
    merged.set(h.slug, {
      slug: h.slug,
      name: universeRow.name,
      description: universeRow.description,
      concept_id: null, // Pass 2 path doesn't carry concept_id; UI doesn't need it for display
      match_score: h.match_score,
      source: "haiku",
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, config.top_k);
}

/**
 * Default Anthropic client wrapper. Lazy-imports SDK to keep test paths
 * import-free. Returns { text, inputTokens, outputTokens } for cost tracking.
 */
async function defaultAnthropicCall(
  prompt: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: 30000, maxRetries: 2 });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: HAIKU_MAX_OUTPUT,
    messages: [{ role: "user", content: prompt }],
  });
  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";
  return {
    text,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

/**
 * Helper: load resolver config from feature_flag_rules. Falls back to defaults
 * on any error / missing flag.
 */
export async function loadResolverConfig(
  supabase: SupabaseClient,
): Promise<ResolverConfig> {
  try {
    const { data, error } = await supabase
      .from("feature_flag_rules")
      .select("config, enabled")
      .eq("flag_key", "candidate_suggestions_config")
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_CONFIG };
    if (data.enabled === false) return { ...DEFAULT_CONFIG };
    return parseConfig(data.config);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

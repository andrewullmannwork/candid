/**
 * S153 — Unified service-match resolver.
 *
 * ONE entry point for "given a bill line (description [+ code]) or a search
 * query, what service_catalog slug is this?" — replacing the fragmented set of
 * matchers (hardcoded-list service-mapper, bare-slug description-match, substring
 * manual search) with a single tiered cascade over the LIVE service_catalog
 * vocabulary (slug + name + description + category).
 *
 * COST-MINIMIZING CASCADE (per line; Haiku is the last resort):
 *   Tier 0/1 — learned cache (free): billing_code_mappings, (code,type)→slug AND
 *              signature→slug, slug set immediately + confidence-scored. This is
 *              the "Haiku match cached as a synonym, served first" store.
 *   Tier 2   — trigram short-circuit (free): in-memory near-exact match of the
 *              description against catalog slug/name (≥ threshold). Skips Haiku
 *              for easy lines ("Office Visit" → office-visit name).
 *   Tier 3   — ONE batched Haiku call PER BILL for the lines Tiers 0-2 left over,
 *              with the full catalog (names+descriptions) as a cacheable prefix.
 *   Write-back — confident resolutions are cached (immediate) so the next
 *              identical line/code is a free Tier-0/1 hit; the cache warms toward
 *              zero Haiku over time.
 *
 * INVARIANTS:
 *   - Only emits slugs that EXIST in the live catalog (merged_into_id IS NULL).
 *   - Writes are backend-only (service-role); they populate the USER-scoped slug
 *     (caller) + the learned cache. Cross-user corroboration (billing_code_identity,
 *     threshold 5) is UNCHANGED and handled by the existing flywheel — this module
 *     does NOT touch the promotion-gated identity slug (Pattern 1 #14).
 *   - Deterministic (temp=0 via callHaikuWithCache) so the same description maps
 *     to the same slug across runs (cite-grade reproducibility).
 *
 * Flag-gated by service_resolver_v1 (mig 135); callers branch OFF → legacy path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDescriptionSignature } from "@/lib/parser/code-identity";
import { callHaikuWithCache } from "@/lib/haiku-client/base";
import { guardedHaikuCall } from "@/lib/haiku-client/spend-guard";
import { isPiiRedactionEnabled, redactExcerpt } from "@/lib/parser/pii-redaction-gate";

// ============================================================================
// Types
// ============================================================================

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  conceptId: string | null;
}

export type ResolutionSource =
  | "code_cache"
  | "signature_cache"
  | "trigram_exact"
  | "haiku"
  | "none";

export interface ServiceResolution {
  lineNumber?: number;
  slug: string | null;
  conceptId: string | null;
  confidence: number;
  source: ResolutionSource;
  /** True when slug is null OR confidence < reviewConfidenceFloor. */
  needsReview: boolean;
}

export interface ResolverConfig {
  haikuConfidenceFloor: number;
  writebackConfidenceFloor: number;
  reviewConfidenceFloor: number;
  trigramShortcircuitThreshold: number;
  cacheMinConfidence: number;
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  haikuConfidenceFloor: 0.7,
  writebackConfidenceFloor: 0.8,
  reviewConfidenceFloor: 0.6,
  trigramShortcircuitThreshold: 0.86,
  cacheMinConfidence: 0.8,
};

export interface ResolveLineInput {
  lineNumber: number;
  description: string;
  billingCode?: string | null;
  billingCodeType?: string | null;
}

// ============================================================================
// Pure helpers (no DB / no Haiku — unit-testable via fixture)
// ============================================================================

/**
 * Parse + validate the resolver config from a feature_flag_rules.config JSONB.
 * Falls back to DEFAULT_RESOLVER_CONFIG per field on missing/invalid values.
 */
export function parseResolverConfig(raw: unknown): ResolverConfig {
  const out = { ...DEFAULT_RESOLVER_CONFIG };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && v >= 0 && v <= 1 ? v : null;
  out.haikuConfidenceFloor = num(r.haiku_confidence_floor) ?? out.haikuConfidenceFloor;
  out.writebackConfidenceFloor = num(r.writeback_confidence_floor) ?? out.writebackConfidenceFloor;
  out.reviewConfidenceFloor = num(r.review_confidence_floor) ?? out.reviewConfidenceFloor;
  out.trigramShortcircuitThreshold = num(r.trigram_shortcircuit_threshold) ?? out.trigramShortcircuitThreshold;
  out.cacheMinConfidence = num(r.cache_min_confidence) ?? out.cacheMinConfidence;
  return out;
}

function normalizeForTrigram(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function trigrams(s: string): Set<string> {
  const n = normalizeForTrigram(s);
  const padded = `  ${n} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * Jaccard similarity over character trigrams (mirrors pg_trgm semantics closely
 * enough for an in-memory short-circuit). Range [0, 1].
 */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/**
 * Best in-memory match of `text` against the catalog by max trigram similarity
 * over slug + name. Returns null if catalog empty.
 */
export function bestTrigramMatch(
  text: string,
  catalog: CatalogEntry[],
): { entry: CatalogEntry; score: number } | null {
  let best: { entry: CatalogEntry; score: number } | null = null;
  for (const e of catalog) {
    const score = Math.max(
      trigramSimilarity(text, e.slug.replace(/_/g, " ")),
      trigramSimilarity(text, e.name),
    );
    if (!best || score > best.score) best = { entry: e, score };
  }
  return best;
}

const RESOLVER_INSTRUCTIONS = `You map medical bill line-item descriptions to the SINGLE best service slug from a curated catalog.

The catalog below lists each slug with its human name, category, and description. Descriptions on bills are short, abbreviated, and use carrier-specific shorthand — match on MEANING, not surface text. Examples:
- "OFFICE VISIT EST PRIMARY CARE" → pcp_visit
- "WELLNESS VISIT" / "ANNUAL WELLNESS EXAM" → preventive_care (a wellness/annual exam is preventive care, NOT a problem-focused pcp_visit)
- "MRI BRAIN W/O CONTRAST" → advanced_imaging
- "VENIPUNCTURE BLOOD DRAW" → a lab slug

Rules:
- Pick exactly ONE slug per line, chosen VERBATIM from the catalog. Never invent a slug.
- confidence ∈ [0,1]: ≥0.9 exact concept; 0.7-0.89 strong; 0.5-0.69 plausible; <0.5 weak.
- If no catalog entry is a reasonable match (best < 0.5), return slug=null for that line.

Return ONLY this JSON (no markdown, no commentary):
{"matches":[{"lineNumber":1,"slug":"<slug_or_null>","confidence":0.0}]}`;

/**
 * Build the batched resolver prompt. The rich catalog is the cacheable system
 * prefix (≥4K tokens unlocks Haiku prompt caching across the batch); the lines
 * are the user content.
 */
export function buildResolverPrompt(
  catalog: CatalogEntry[],
  lines: ResolveLineInput[],
): { systemPrompt: string; userContent: string } {
  const catalogBlock = catalog
    .map(
      (e) =>
        `- slug=${e.slug} · name="${e.name}"${e.category ? ` · category=${e.category}` : ""}${e.description ? ` · ${e.description.slice(0, 160)}` : ""}`,
    )
    .join("\n");
  const systemPrompt = `${RESOLVER_INSTRUCTIONS}\n\n## CATALOG\n${catalogBlock}\n\n## LINES TO MATCH:\n`;
  const userContent = lines
    .map(
      (l) =>
        `Line ${l.lineNumber}: "${l.description}"${l.billingCode ? ` (code ${l.billingCode}${l.billingCodeType ? ` ${l.billingCodeType}` : ""})` : ""}`,
    )
    .join("\n");
  return { systemPrompt, userContent };
}

interface ResolverHaikuResponse {
  matches?: Array<{ lineNumber?: unknown; slug?: unknown; confidence?: unknown }>;
}

/**
 * Parse the batched Haiku response into a per-line map. Drops slugs not in the
 * live catalog (anti-hallucination) and clamps confidence to [0,1].
 */
export function parseResolverResponse(
  raw: ResolverHaikuResponse,
  validSlugs: Set<string>,
): Map<number, { slug: string; confidence: number }> {
  const out = new Map<number, { slug: string; confidence: number }>();
  for (const m of raw.matches ?? []) {
    const lineNumber = typeof m.lineNumber === "number" ? m.lineNumber : NaN;
    const slug = typeof m.slug === "string" ? m.slug.trim() : "";
    const conf = typeof m.confidence === "number" ? m.confidence : NaN;
    if (!Number.isFinite(lineNumber)) continue;
    if (!slug || !validSlugs.has(slug)) continue; // null/hallucinated → skip
    if (!Number.isFinite(conf)) continue;
    out.set(lineNumber, { slug, confidence: Math.min(1, Math.max(0, conf)) });
  }
  return out;
}

// ============================================================================
// DB layer — vocabulary + learned cache (billing_code_mappings, mig 135)
// ============================================================================

/** Load the live catalog with names + descriptions (excludes merged-away slugs). */
export async function loadCatalogRich(supabase: SupabaseClient): Promise<CatalogEntry[]> {
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug, name, description, category, concept_id")
    .is("merged_into_id", null);
  if (error || !data) {
    console.warn("[service-resolver] catalog load failed", error?.message);
    return [];
  }
  return data.map((r) => ({
    slug: r.slug as string,
    name: (r.name as string) ?? (r.slug as string),
    description: (r.description as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    conceptId: (r.concept_id as string | null) ?? null,
  }));
}

export async function loadResolverConfig(supabase: SupabaseClient): Promise<ResolverConfig> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "service_resolver_v1")
      .maybeSingle();
    return parseResolverConfig(data?.config);
  } catch {
    return { ...DEFAULT_RESOLVER_CONFIG };
  }
}

/** Batched read of the (code,type)→slug learned cache for a set of codes. */
async function readCodeCacheBatch(
  supabase: SupabaseClient,
  codes: Array<{ code: string; type: string }>,
  minConfidence: number,
): Promise<Map<string, { slug: string; confidence: number }>> {
  const out = new Map<string, { slug: string; confidence: number }>();
  if (codes.length === 0) return out;
  const distinctCodes = Array.from(new Set(codes.map((c) => c.code)));
  const { data } = await supabase
    .from("billing_code_mappings")
    .select("billing_code, billing_code_type, service_slug, confidence")
    .in("billing_code", distinctCodes)
    .gte("confidence", minConfidence)
    .order("confidence", { ascending: false });
  for (const row of data ?? []) {
    const key = `${row.billing_code}|${row.billing_code_type}`;
    if (!out.has(key)) {
      out.set(key, { slug: row.service_slug as string, confidence: Number(row.confidence) });
    }
  }
  return out;
}

/** Batched read of the signature→slug learned cache (code-less rows). */
async function readSignatureCacheBatch(
  supabase: SupabaseClient,
  signatures: string[],
  minConfidence: number,
): Promise<Map<string, { slug: string; confidence: number }>> {
  const out = new Map<string, { slug: string; confidence: number }>();
  const distinct = Array.from(new Set(signatures.filter(Boolean)));
  if (distinct.length === 0) return out;
  const { data } = await supabase
    .from("billing_code_mappings")
    .select("description_signature, service_slug, confidence")
    .is("billing_code", null)
    .in("description_signature", distinct)
    .gte("confidence", minConfidence)
    .order("confidence", { ascending: false });
  for (const row of data ?? []) {
    const sig = row.description_signature as string;
    if (!out.has(sig)) {
      out.set(sig, { slug: row.service_slug as string, confidence: Number(row.confidence) });
    }
  }
  return out;
}

/**
 * Write a learned cache row (read-modify-write; mirrors code-intelligence's
 * updateCodeMappings pattern). Non-fatal. Keys on (code,type,slug) for coded
 * rows OR (signature,slug) for code-less rows. Confidence is monotonic-max so a
 * later weaker match never demotes a stronger learned mapping.
 */
export async function cacheLearnedMapping(
  supabase: SupabaseClient,
  m: {
    code: string | null;
    codeType: string | null;
    signature: string | null;
    slug: string;
    confidence: number;
    description: string | null;
    source: string;
  },
): Promise<void> {
  try {
    // Ing-E: redact PII before it lands in the cross-user
    // billing_code_mappings.provider_descriptions (flag OFF → unchanged →
    // byte-identical; the description_signature matching key is untouched).
    const piiOn = await isPiiRedactionEnabled(supabase);
    const desc = m.description
      ? redactExcerpt(m.description, piiOn, "billing_code_mappings.provider_descriptions")
      : null;

    const coded = Boolean(m.code && m.codeType);
    if (!coded && !m.signature) return; // need at least a signature to key on

    const sel = supabase
      .from("billing_code_mappings")
      .select("id, confidence, observation_count, provider_descriptions")
      .eq("service_slug", m.slug);
    const { data: existing } = coded
      ? await sel.eq("billing_code", m.code!).eq("billing_code_type", m.codeType!).maybeSingle()
      : await sel.is("billing_code", null).eq("description_signature", m.signature!).maybeSingle();

    if (existing) {
      const newCount = (existing.observation_count ?? 1) + 1;
      const newConfidence = Math.max(Number(existing.confidence ?? 0), m.confidence);
      const descs: string[] = (existing.provider_descriptions as string[] | null) ?? [];
      if (desc && descs.length < 10 && !descs.includes(desc)) {
        descs.push(desc);
      }
      await supabase
        .from("billing_code_mappings")
        .update({
          confidence: Math.round(newConfidence * 100) / 100,
          observation_count: newCount,
          provider_descriptions: descs,
          source: m.source,
          last_seen_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("billing_code_mappings").insert({
        billing_code: coded ? m.code : null,
        billing_code_type: coded ? m.codeType : null,
        description_signature: m.signature,
        service_slug: m.slug,
        confidence: Math.round(m.confidence * 100) / 100,
        observation_count: 1,
        provider_descriptions: desc ? [desc] : [],
        source: m.source,
      });
    }
  } catch (err) {
    console.warn("[service-resolver] writeLearnedMapping failed (non-fatal)", err);
  }
}

// ============================================================================
// Resolver — batched (bill path) + single (manual / reaudit)
// ============================================================================

export interface ResolveOpts {
  supabase: SupabaseClient;
  userId: string;
  config?: ResolverConfig;
  catalog?: CatalogEntry[];
  /** Disable the Haiku batch tier (cache + trigram only) — used in tests. */
  skipHaiku?: boolean;
  /** Test override for the Haiku batch call. */
  haikuCall?: (systemPrompt: string, userContent: string) => Promise<ResolverHaikuResponse | null>;
}

/**
 * Resolve a batch of bill lines. One Haiku call for ALL lines Tiers 0-2 leave
 * unresolved. Returns a Map keyed by lineNumber.
 */
export async function resolveServices(
  lines: ResolveLineInput[],
  opts: ResolveOpts,
): Promise<Map<number, ServiceResolution>> {
  const results = new Map<number, ServiceResolution>();
  if (lines.length === 0) return results;

  const config = opts.config ?? (await loadResolverConfig(opts.supabase));
  const catalog = opts.catalog ?? (await loadCatalogRich(opts.supabase));
  if (catalog.length === 0) {
    for (const l of lines) {
      results.set(l.lineNumber, {
        lineNumber: l.lineNumber, slug: null, conceptId: null,
        confidence: 0, source: "none", needsReview: true,
      });
    }
    return results;
  }
  const validSlugs = new Set(catalog.map((e) => e.slug));
  const conceptBySlug = new Map(catalog.map((e) => [e.slug, e.conceptId] as const));

  // Pre-compute per-line signature.
  const sigByLine = new Map<number, string>();
  for (const l of lines) {
    sigByLine.set(l.lineNumber, normalizeDescriptionSignature(l.description, l.billingCode ?? ""));
  }

  // ─── Tier 0/1 — learned cache (batched reads) ────────────────────────────
  const codeReqs = lines
    .filter((l) => l.billingCode && l.billingCodeType)
    .map((l) => ({ code: l.billingCode as string, type: l.billingCodeType as string }));
  const codeCache = await readCodeCacheBatch(opts.supabase, codeReqs, config.cacheMinConfidence);
  const sigCache = await readSignatureCacheBatch(
    opts.supabase,
    Array.from(sigByLine.values()),
    config.cacheMinConfidence,
  );

  const unresolved: ResolveLineInput[] = [];
  for (const l of lines) {
    const sig = sigByLine.get(l.lineNumber) ?? "";
    // Tier 1: code cache
    if (l.billingCode && l.billingCodeType) {
      const hit = codeCache.get(`${l.billingCode}|${l.billingCodeType}`);
      if (hit) {
        results.set(l.lineNumber, mkResolution(l.lineNumber, hit.slug, hit.confidence, "code_cache", conceptBySlug, config));
        continue;
      }
    }
    // Tier 1b: signature cache (code-less learned synonyms)
    const sigHit = sig ? sigCache.get(sig) : undefined;
    if (sigHit) {
      results.set(l.lineNumber, mkResolution(l.lineNumber, sigHit.slug, sigHit.confidence, "signature_cache", conceptBySlug, config));
      continue;
    }
    // Tier 2: trigram short-circuit
    const tri = bestTrigramMatch(l.description, catalog);
    if (tri && tri.score >= config.trigramShortcircuitThreshold) {
      results.set(l.lineNumber, mkResolution(l.lineNumber, tri.entry.slug, tri.score, "trigram_exact", conceptBySlug, config));
      continue;
    }
    unresolved.push(l);
  }

  // ─── Tier 3 — ONE batched Haiku call for the leftovers ───────────────────
  if (unresolved.length > 0 && !opts.skipHaiku) {
    const { systemPrompt, userContent } = buildResolverPrompt(catalog, unresolved);
    let parsed: Map<number, { slug: string; confidence: number }> = new Map();
    try {
      if (opts.haikuCall) {
        const raw = await opts.haikuCall(systemPrompt, userContent);
        if (raw) parsed = parseResolverResponse(raw, validSlugs);
      } else {
        const guarded = await guardedHaikuCall(opts.userId, () =>
          callHaikuWithCache<ResolverHaikuResponse>({
            systemPrompt,
            userContent,
            sectionLabel: "service-resolver/batch",
          }),
        );
        if (!guarded.paused && guarded.data) {
          parsed = parseResolverResponse(guarded.data, validSlugs);
        }
      }
    } catch (err) {
      console.warn("[service-resolver] Haiku batch failed (non-fatal)", err);
    }

    const writebacks: Promise<void>[] = [];
    for (const l of unresolved) {
      const hit = parsed.get(l.lineNumber);
      if (hit && hit.confidence >= config.haikuConfidenceFloor) {
        results.set(l.lineNumber, mkResolution(l.lineNumber, hit.slug, hit.confidence, "haiku", conceptBySlug, config));
        if (hit.confidence >= config.writebackConfidenceFloor) {
          const coded = Boolean(l.billingCode && l.billingCodeType);
          writebacks.push(
            cacheLearnedMapping(opts.supabase, {
              code: coded ? (l.billingCode as string) : null,
              codeType: coded ? (l.billingCodeType as string) : null,
              signature: coded ? null : (sigByLine.get(l.lineNumber) ?? null),
              slug: hit.slug,
              confidence: hit.confidence,
              description: l.description,
              source: "haiku_resolver",
            }),
          );
        }
      } else {
        results.set(l.lineNumber, mkResolution(l.lineNumber, null, hit?.confidence ?? 0, "none", conceptBySlug, config));
      }
    }
    await Promise.all(writebacks);
  } else {
    for (const l of unresolved) {
      results.set(l.lineNumber, mkResolution(l.lineNumber, null, 0, "none", conceptBySlug, config));
    }
  }

  return results;
}

function mkResolution(
  lineNumber: number,
  slug: string | null,
  confidence: number,
  source: ResolutionSource,
  conceptBySlug: Map<string, string | null>,
  config: ResolverConfig,
): ServiceResolution {
  return {
    lineNumber,
    slug,
    conceptId: slug ? (conceptBySlug.get(slug) ?? null) : null,
    confidence,
    source,
    needsReview: slug == null || confidence < config.reviewConfidenceFloor,
  };
}

/** Single-line resolve (manual / reaudit / search fallback). */
export async function resolveService(
  input: ResolveLineInput,
  opts: ResolveOpts,
): Promise<ServiceResolution> {
  const map = await resolveServices([input], opts);
  return (
    map.get(input.lineNumber) ?? {
      lineNumber: input.lineNumber, slug: null, conceptId: null,
      confidence: 0, source: "none", needsReview: true,
    }
  );
}

// ============================================================================
// Manual search — instant trigram + learned synonyms, Haiku fallback on weak
// ============================================================================

export interface SearchResult extends CatalogEntry {
  score: number;
  source: "name" | "category" | "synonym" | "haiku";
}

/**
 * Rank catalog entries for a manual search query. Instant path = trigram over
 * slug/name + substring boost + learned-synonym hits (billing_code_mappings
 * signatures). If the top instant score is weak AND a budget slot is available,
 * a single Haiku resolve runs and its result is boosted to the top + LEARNED
 * (cached as a signature synonym) so the next identical search is instant.
 */
export async function searchServices(
  query: string,
  opts: ResolveOpts & { limit?: number; weakScoreFloor?: number },
): Promise<SearchResult[]> {
  const q = query.trim();
  const limit = opts.limit ?? 20;
  const catalog = opts.catalog ?? (await loadCatalogRich(opts.supabase));
  if (!q || catalog.length === 0) return [];
  const config = opts.config ?? (await loadResolverConfig(opts.supabase));

  const qNorm = normalizeForTrigram(q);
  const scored: SearchResult[] = catalog.map((e) => {
    const nameScore = Math.max(
      trigramSimilarity(q, e.name),
      trigramSimilarity(q, e.slug.replace(/_/g, " ")),
    );
    const sub = normalizeForTrigram(e.name).includes(qNorm) || e.slug.includes(qNorm.replace(/ /g, "_")) ? 0.3 : 0;
    const cat = e.category && trigramSimilarity(q, e.category) > 0.5 ? 0.1 : 0;
    return { ...e, score: Math.min(1, nameScore + sub + cat), source: "name" as const };
  });

  // Learned-synonym boost: signature cache rows whose signature ~ the query.
  try {
    const sig = normalizeDescriptionSignature(q, "");
    if (sig) {
      const { data } = await opts.supabase
        .from("billing_code_mappings")
        .select("service_slug, confidence")
        .is("billing_code", null)
        .ilike("description_signature", `%${sig}%`)
        .gte("confidence", config.cacheMinConfidence)
        .limit(10);
      for (const row of data ?? []) {
        const target = scored.find((s) => s.slug === row.service_slug);
        if (target) {
          target.score = Math.max(target.score, 0.9);
          target.source = "synonym";
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const weakFloor = opts.weakScoreFloor ?? 0.5;

  // Haiku fallback only when instant ranking is weak (semantic query like
  // "wellness" with no learned synonym yet). Budget-gated; learns on success.
  if ((!top || top.score < weakFloor) && !opts.skipHaiku) {
    const resolved = await resolveService(
      { lineNumber: 0, description: q },
      { ...opts, catalog, config },
    );
    if (resolved.slug) {
      const target = scored.find((s) => s.slug === resolved.slug);
      if (target) {
        target.score = Math.max(target.score, resolved.confidence, 0.9);
        target.source = "haiku";
        scored.sort((a, b) => b.score - a.score);
      }
    }
  }

  return scored.slice(0, limit);
}

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

/** Pattern-S service component (who bills): facility (UB-04 / TC), professional (CMS-1500 / 26), or global (no split). */
export type ServiceComponent = "facility" | "professional" | "global";

/** A Pattern-S identity tuple: pure-service slug + where (place_of_service) + who (component). */
export interface ServiceModifierTuple {
  slug: string;
  placeOfService: string;
  component: ServiceComponent;
}

/** deriveModifiers() output: the where/who modifiers for a line, + an optional multi-label SET for a
 *  genuinely compound line (the inpatient physician/surgeon umbrella). */
export interface DerivedModifiers {
  placeOfService: string;
  component: ServiceComponent;
  multiLabel?: ServiceModifierTuple[];
  /** A2b Phase 2 item 6: true when a NAMED preventive screening resolves to a non-preventive slug
   *  (e.g. bone-density/DEXA → advanced_imaging) — keep the slug + flag, never collapse to preventive_care. */
  isPreventiveEligible?: boolean;
  /** A2b Phase 2 item 5: drug FORMULARY tier as a plan-local modifier ('tier_1'..'tier_12'; Hard Rule
   *  #17 — the slug stays the descriptor). Present ONLY for a single-tier drug/pharmacy line; absent
   *  otherwise (non-drug, network-tier, or multi-tier rows). */
  planTierLabel?: string;
}

export interface ServiceResolution {
  lineNumber?: number;
  slug: string | null;
  conceptId: string | null;
  confidence: number;
  source: ResolutionSource;
  /** True when slug is null OR confidence < reviewConfidenceFloor. */
  needsReview: boolean;
  /** Pattern-S modifiers (A2b Phase 2). Present ONLY when emitModifiers / thesaurus_phase1a_v1 is on
   *  (flag OFF → undefined → byte-identical). Description-derived → deterministic (no Haiku). */
  placeOfService?: string;
  component?: ServiceComponent;
  /** Multi-label SET for a compound line (inpatient physician/surgeon umbrella); undefined otherwise. */
  multiLabel?: ServiceModifierTuple[];
  /** A2b Phase 2 item 6: preventive-eligible flag on a named screening that resolves to a non-preventive
   *  slug (Hard Rule #17 / §1.5). Present ONLY when emitModifiers / thesaurus_phase1a_v1 is on. */
  isPreventiveEligible?: boolean;
  /** A2b Phase 2 item 5: drug FORMULARY tier modifier ('tier_1'..'tier_12'; Hard Rule #17). Present
   *  ONLY when emitModifiers / thesaurus_phase1a_v1 is on AND the line is a single-tier drug line. */
  planTierLabel?: string;
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

// ============================================================================
// Trust-tiering — billing_code_mappings provenance model (thesaurus Phase 1a)
// ============================================================================
//
// The shared learned cache holds two sub-caches with two DIFFERENT trust signals:
//
//   • CODE-LESS signature rows (synonyms) — trusted by `source` PROVENANCE.
//     A single uncorroborated Haiku synonym guess (`source='haiku_resolver'`)
//     must never be served cross-user as authority (F3). Trust = an ALLOWLIST
//     (default-deny): only the sources below serve; everything else (incl.
//     haiku_resolver + any future/unknown source) is quarantined.
//
//   • CODED rows (code→slug) — NOT source-filtered. The corroborated authority
//     is `billing_code_identity` (Pattern 1 #3, distinct verified users); this
//     cache is the honest pre-corroboration FALLBACK, trusted by observation /
//     confidence, never by source (an obs-corroborated code mapping that Haiku
//     merely touched must keep serving — so source is the wrong signal here).
//
// Flag-gated by `thesaurus_phase1a_v1` (OFF → byte-identical: every row serves
// + the writeback fires, exactly as before). The trusted set is config-tunable
// (Ship Gate G6) — `config.trusted_sources` is UNIONed in — but `haiku_resolver`
// is HARD-quarantined regardless of config (no footgun re-opening F3).
//
// SAFEGUARD (Decision 1 — don't silently drop a legitimate source): every
// `source` a writer emits MUST appear in ALL_KNOWN_CACHE_SOURCES + be classified.
// A new writer with an unregistered source is quarantined by default (allowlist)
// AND surfaces via countUnrecognizedCacheSources() (G7 monitoring). See the
// fixture at scripts/calibration/fixtures/thesaurus-phase1a/trust-tiering.ts.

/** Code-less signature sources trusted as cross-user authority (default-deny allowlist). */
export const TRUSTED_SIGNATURE_SOURCES_DEFAULT = [
  "thesaurus_remap", // S171 seeds (mig 154) — curated standard-label synonyms
  "user_correction", // correct-category route — user-confirmed @0.95
  "multi_source_corroboration", // Pattern 1 #3 promotion (reserved; canonical-side today)
  "admin_verified", // admin attestation (reserved)
] as const;

/** Sources HARD-quarantined regardless of config (single-source, uncorroborated). */
export const QUARANTINED_CACHE_SOURCES = new Set<string>(["haiku_resolver"]);

/** Registry of every source any writer emits, for the classification safeguard. */
export const ALL_KNOWN_CACHE_SOURCES: Record<
  string,
  "trusted_signature" | "quarantined" | "code_cache"
> = {
  thesaurus_remap: "trusted_signature",
  user_correction: "trusted_signature",
  multi_source_corroboration: "trusted_signature",
  admin_verified: "trusted_signature",
  haiku_resolver: "quarantined",
  code_observation: "code_cache", // coded rows — NOT subject to the signature allowlist
};

/** Effective trusted-signature set: code default ∪ config, minus hard-quarantined. */
export function buildTrustedSourceSet(configTrustedSources?: unknown): Set<string> {
  const set = new Set<string>(TRUSTED_SIGNATURE_SOURCES_DEFAULT);
  if (Array.isArray(configTrustedSources)) {
    for (const s of configTrustedSources) if (typeof s === "string") set.add(s);
  }
  for (const q of QUARANTINED_CACHE_SOURCES) set.delete(q); // never trust a hard-quarantined source
  return set;
}

/** Is a code-less signature row's source trusted as cross-user authority? Default-deny. */
export function isTrustedSignatureSource(source: string | null, trusted: Set<string>): boolean {
  if (source == null) return false; // allowlist: no legitimate code-less row is source-NULL
  return trusted.has(source);
}

/**
 * Apply the signature-cache trust filter BEFORE the per-signature dedup, so a
 * quarantined high-confidence row can never shadow a trusted lower-confidence
 * row for the same signature. Rows must be pre-ordered by confidence DESC.
 * trustEnabled=false → byte-identical (serve all).
 */
export function selectTrustedSignatureHits(
  rows: Array<{
    description_signature: string;
    service_slug: string;
    confidence: number | string;
    source?: string | null;
  }>,
  opts: { trustEnabled: boolean; trustedSources: Set<string> },
): Map<string, { slug: string; confidence: number }> {
  const out = new Map<string, { slug: string; confidence: number }>();
  for (const row of rows) {
    if (opts.trustEnabled && !isTrustedSignatureSource(row.source ?? null, opts.trustedSources)) {
      continue;
    }
    const sig = row.description_signature;
    if (!out.has(sig)) out.set(sig, { slug: row.service_slug, confidence: Number(row.confidence) });
  }
  return out;
}

interface TrustTiering {
  enabled: boolean;
  trustedSources: Set<string>;
}

/** Read thesaurus_phase1a_v1 {enabled, config.trusted_sources} in one query. Fail-safe OFF. */
async function loadTrustTiering(supabase: SupabaseClient): Promise<TrustTiering> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", "thesaurus_phase1a_v1")
      .maybeSingle();
    const config = (data?.config ?? null) as Record<string, unknown> | null;
    return {
      enabled: data?.enabled === true,
      trustedSources: buildTrustedSourceSet(config?.trusted_sources),
    };
  } catch {
    return { enabled: false, trustedSources: buildTrustedSourceSet() };
  }
}

/**
 * G7 monitoring (Decision 1 safeguard): count cache rows whose source is neither
 * registered-trusted, registered-quarantined, nor a known code-cache source — i.e.
 * a source we forgot to classify. A nonzero/rising count means a legitimate writer
 * may be silently quarantined. Cron-wire as a follow-up; callable now for admin checks.
 */
export async function countUnrecognizedCacheSources(supabase: SupabaseClient): Promise<number> {
  const known = Object.keys(ALL_KNOWN_CACHE_SOURCES);
  const { count } = await supabase
    .from("billing_code_mappings")
    .select("id", { count: "exact", head: true })
    .not("source", "is", null)
    .not("source", "in", `(${known.map((s) => `"${s}"`).join(",")})`);
  return count ?? 0;
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
    .is("merged_into_id", null)
    // S169: honor deprecation — a RETIRED slug (deprecated_at set) drops out of the resolver
    // candidate set even when it wasn't merged into another concept. Today every deprecated slug is
    // also merged (already excluded above), so this is a no-op until mig 152 retires hospital_outpatient
    // (never the correct answer; 0 stored rows; only ever mis-captured outpatient-surgery facility fees).
    .is("deprecated_at", null);
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

/**
 * Batched read of the (code,type)→slug learned cache for a set of codes.
 *
 * NOT source-filtered (thesaurus Phase 1a, Decision 2). The coded cache's trust
 * signal is observation/confidence, NOT provenance: an obs-corroborated code
 * mapping that Haiku merely touched must keep serving, so a source allowlist
 * would wrongly quarantine it. The distinct-user-corroborated code→slug AUTHORITY
 * is `billing_code_identity` (Pattern 1 #3), consulted first on the bills path;
 * this cache is the honest pre-corroboration FALLBACK. (Collapsing the two into
 * one corroboration-aware table is a tracked fast-follow.)
 */
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

/**
 * Batched read of the signature→slug learned cache (code-less rows). Trust-tiered
 * (thesaurus Phase 1a): when `trust.enabled`, only ALLOWLISTED sources are served
 * as authority (single-Haiku `haiku_resolver` synonyms are quarantined). The
 * filter runs BEFORE the per-signature dedup so a quarantined hi-conf row cannot
 * shadow a trusted lo-conf row. trust.enabled=false → byte-identical (serve all).
 */
async function readSignatureCacheBatch(
  supabase: SupabaseClient,
  signatures: string[],
  minConfidence: number,
  trust: TrustTiering,
): Promise<Map<string, { slug: string; confidence: number }>> {
  const distinct = Array.from(new Set(signatures.filter(Boolean)));
  if (distinct.length === 0) return new Map();
  const { data } = await supabase
    .from("billing_code_mappings")
    .select("description_signature, service_slug, confidence, source")
    .is("billing_code", null)
    .in("description_signature", distinct)
    .gte("confidence", minConfidence)
    .order("confidence", { ascending: false });
  return selectTrustedSignatureHits(
    (data ?? []) as Array<{
      description_signature: string;
      service_slug: string;
      confidence: number | string;
      source: string | null;
    }>,
    { trustEnabled: trust.enabled, trustedSources: trust.trustedSources },
  );
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
      .select("id, confidence, observation_count, provider_descriptions, source")
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
      // Monotonic-trust guard (thesaurus Phase 1a): never DOWNGRADE a trusted
      // provenance (seed / user-confirm / corroborated) to an untrusted one — e.g.
      // a single haiku_resolver write landing on a seed's signature would otherwise
      // flip source→haiku_resolver and self-quarantine it under the read filter.
      // Slug + confidence are unaffected; only the source label is protected.
      // Always on (its job is to protect seeds during the flag-OFF window).
      const trusted = buildTrustedSourceSet();
      const existingSource = (existing.source as string | null) ?? null;
      const guardedSource =
        existingSource && trusted.has(existingSource) && !trusted.has(m.source)
          ? existingSource
          : m.source;
      await supabase
        .from("billing_code_mappings")
        .update({
          confidence: Math.round(newConfidence * 100) / 100,
          observation_count: newCount,
          provider_descriptions: descs,
          source: guardedSource,
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
  /**
   * Suppress ALL learned-mapping persistence (the confidence-gated writeback to
   * billing_code_mappings). Set true for calibration/measurement runs so the
   * resolver never teaches itself from the test set (leakage) and never mutates
   * the PROD learned cache (reproducibility). Any future learn-write added to
   * this resolver MUST also gate on this flag. Default false = current behavior.
   */
  skipWriteback?: boolean;
  /** Test override for the Haiku batch call. */
  haikuCall?: (systemPrompt: string, userContent: string) => Promise<ResolverHaikuResponse | null>;
  /**
   * Calibration honesty (S170): when true, a failure of the Haiku batch tier — a thrown error
   * (missing client / API error) OR a spend-cap PAUSE — RE-THROWS instead of degrading to all-null.
   * The PROD bill path leaves this false (a user upload must not crash on a transient Haiku error →
   * it degrades to needs-review). Calibration/measurement runs set true so a degraded resolution can
   * never masquerade as a result. Default false = current behavior.
   */
  strict?: boolean;
  /**
   * Trust-tiering override (thesaurus Phase 1a). When set, bypasses the
   * `thesaurus_phase1a_v1` flag read and forces the signature-cache trust filter
   * + writeback suppression on/off. Tests + the N=9 calibration re-gate pass
   * `false` explicitly so they measure the UNCHANGED resolver. When omitted
   * (PROD), the flag is read live via loadTrustTiering(). Default (omitted) =
   * flag-driven.
   */
  trustTieredCache?: boolean;
  /**
   * A2b Phase 2 — emit Pattern-S modifiers (place_of_service + component + multi-label) on each
   * resolution. DECOUPLED from trustTieredCache so the calibration gate measures the new modifier
   * dimension WITHOUT perturbing slug resolution (slug tiers untouched → slug-level byte-identical).
   * Omitted (PROD) → falls back to thesaurus_phase1a_v1 (via trust.enabled) → OFF → undefined modifiers
   * → byte-identical. The calibration harness passes true. Default (omitted) = flag-driven.
   */
  emitModifiers?: boolean;
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
  // Trust-tiering (thesaurus Phase 1a). Explicit opt wins (tests + the N=9 re-gate
  // pass false → measure the UNCHANGED resolver); otherwise read the flag live.
  // OFF → byte-identical (serve all cache rows + writeback fires).
  const trust: TrustTiering =
    opts.trustTieredCache !== undefined
      ? { enabled: opts.trustTieredCache, trustedSources: buildTrustedSourceSet() }
      : await loadTrustTiering(opts.supabase);
  // A2b Phase 2: emit modifiers decoupled from trust (so the gate measures them without touching slugs).
  const emitMods = opts.emitModifiers !== undefined ? opts.emitModifiers : trust.enabled;
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
    trust,
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
        if (guarded.paused) {
          // S170 strict (calibration): a spend-cap pause silently drops these lines → degraded result.
          if (opts.strict) throw new Error("[service-resolver] Haiku batch PAUSED by spend-cap under strict mode — result would be degraded.");
        } else if (guarded.data) {
          parsed = parseResolverResponse(guarded.data, validSlugs);
        }
      }
    } catch (err) {
      // S170 strict (calibration): a Haiku-tier failure must ABORT, not silently degrade to all-null.
      if (opts.strict) throw err instanceof Error ? err : new Error(String(err));
      console.warn("[service-resolver] Haiku batch failed (non-fatal)", err);
    }

    const writebacks: Promise<void>[] = [];
    for (const l of unresolved) {
      const hit = parsed.get(l.lineNumber);
      if (hit && hit.confidence >= config.haikuConfidenceFloor) {
        results.set(l.lineNumber, mkResolution(l.lineNumber, hit.slug, hit.confidence, "haiku", conceptBySlug, config));
        // Cross-user writeback (F3). SUPPRESSED entirely under trust-tiering: a
        // single uncorroborated Haiku resolution stays usable for THIS parse (set
        // above) but is never written cross-user — coded mappings are owned by
        // code-intelligence (observation-corroborated), code-less synonyms come
        // only from seeds/corrections. trust.enabled=false → fires (byte-identical).
        if (!trust.enabled && !opts.skipWriteback && hit.confidence >= config.writebackConfidenceFloor) {
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

  // A2b Phase 2 — attach Pattern-S modifiers (deterministic, description-derived) when enabled.
  // OFF → results untouched (byte-identical). One pass covering every resolution tier.
  if (emitMods) {
    for (const l of lines) {
      const res = results.get(l.lineNumber);
      if (!res) continue;
      const m = deriveModifiers(l.description);
      res.placeOfService = m.placeOfService;
      res.component = m.component;
      if (m.multiLabel) res.multiLabel = m.multiLabel;
      if (m.isPreventiveEligible) res.isPreventiveEligible = m.isPreventiveEligible;
      if (m.planTierLabel) res.planTierLabel = m.planTierLabel;
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

/**
 * Derive Pattern-S modifiers (place_of_service + component, + a multi-label SET for the inpatient
 * physician/surgeon umbrella) from a benefit/line DESCRIPTION. UNIVERSAL — grounded in the federal SBC
 * template + CMS place-of-service / TC-26 component billing. INDEPENDENT of the calibration GT classifier
 * (circularity firewall) and PURE (no DB/Haiku → deterministic across N runs). Defaults to (any, global):
 * only explicit component-fee wording + a facility context move it, so generic office visits stay global.
 */
export function deriveModifiers(description: string): DerivedModifiers {
  const d = (description || "").toLowerCase();
  // place_of_service — only mig-147 CHECK values; LEAD subset (facility settings) + 'any' default.
  // An ASC / surgical center / freestanding center is a LOCATION (independent_facility), NOT a component
  // signal (A2b Phase 2, Andrew D1): a bare ASC place-name's facility-ness is a plan-STRUCTURE property
  // (does a companion surgeon line exist?) → that's Option-3/assembly, never inferred from this line's text.
  const place =
    /ambulatory surg(?:ery|ical) center|\basc\b|freestanding|surg(?:ery|ical) center/.test(d) ? "independent_facility"
      : /\binpatient\b|hospital stay|hospital admission|hospital inpatient|hospital room|room and board/.test(d) ? "inpatient_facility"
        : /\boutpatient\b/.test(d) ? "outpatient_facility"
          : "any";
  // component — professional FIRST (the NOT-facility guard: a physician/surgeon fee line delivered IN a
  // facility is the PROFESSIONAL component, not facility), THEN facility ONLY when the line uses the WORD
  // "facility" as a billing label (facility fee/charge/services, "...facility inpatient services", the
  // "(facility)" tag) or an explicit room charge — NEVER on a place-type name (ASC, "— Outpatient
  // Facility" as a setting suffix, "at a Plan Facility"). Else global. (A2b Phase 2, Andrew D1: a
  // place-name ≠ a component; a facility line that's facility only by plan structure is Option-3.)
  const component: ServiceComponent =
    /(physician|surgeon|doctor)[^.]{0,40}\b(fee|fees|services|visit|visits)\b|surgeon fee/.test(d) ? "professional"
      : /facility (?:fee|charge|services?|inpatient)|\(facility\)|hospital room|room and board/.test(d) ? "facility"
        : "global";
  // is_preventive_eligible — a NAMED preventive screening that resolves to a non-preventive slug (e.g.
  // bone-density / DEXA → advanced_imaging): keep the real slug + FLAG it preventive, never collapse to
  // preventive_care (Hard Rule #17 / §1.5). Text-only, universal (USPSTF screening cue). flag-OFF → omitted.
  const prev: { isPreventiveEligible?: true } =
    /bone density|bone mineral density|\bdexa\b|osteoporosis screening/.test(d) ? { isPreventiveEligible: true } : {};
  // item 5 — plan_tier_label: the drug FORMULARY tier as a plan-local modifier (Hard Rule #17 — the slug
  // stays the descriptor). Emitted ONLY in a drug/pharmacy context (a "Tier N" on a hospital/provider line
  // is a NETWORK tier, not a formulary tier) and ONLY when exactly one tier is named (a line spanning
  // "Tier 1/2/4" or "Tier 2 and Tier 4" is deliberately tier-agnostic → omitted). Universal (federal-SBC +
  // commercial pharmacy wording); text-only → deterministic; flag-OFF → omitted.
  const tier: { planTierLabel?: string } = derivePlanTierLabel(d);
  // item 7 — compound oncology-OPD bundle (federal-SBC: "...treatment of illness or injury, radiation
  // therapy, chemotherapy, and necessary supplies"): ONE cost-share over several distinct services → emit
  // the SET (D4 multi-label), not a single slug. Trigger = radiation + chemotherapy named together (precise
  // "chemotherapy" dodges "IV therapy (non-chemo)"); specialist_visit added when an illness/injury visit is
  // also bundled. place from the line (OPD → outpatient_facility); component global (one shared cost-share).
  if (/radiation/.test(d) && /chemotherapy/.test(d)) {
    const set: ServiceModifierTuple[] = [];
    if (/illness|injury|treatment|visit|office/.test(d)) set.push({ slug: "specialist_visit", placeOfService: place, component: "global" });
    set.push({ slug: "chemotherapy_rx", placeOfService: place, component: "global" });
    set.push({ slug: "radiation_therapy", placeOfService: place, component: "global" });
    return { placeOfService: place, component: "global", multiLabel: set, ...prev, ...tier };
  }
  // mixed inpatient physician/surgeon umbrella → multi-label SET (exclude mental-health + transplant).
  const mixed =
    place === "inpatient_facility" &&
    /physician|doctor/.test(d) && /surgeon|surgical/.test(d) &&
    !/mental|behavioral|psych|autism|substance|\bsud\b/.test(d) &&
    !/transplant/.test(d);
  if (mixed) {
    return {
      placeOfService: "inpatient_facility",
      component: "professional",
      multiLabel: [
        { slug: "surgery", placeOfService: "inpatient_facility", component: "professional" },
        { slug: "hospital_admission", placeOfService: "inpatient_facility", component: "professional" },
      ],
      ...prev,
      ...tier,
    };
  }
  return { placeOfService: place, component, ...prev, ...tier };
}

/**
 * Item 5 — extract the drug FORMULARY tier from a benefit/line description (lowercased). Returns
 * `{ planTierLabel: 'tier_<n>' }` ONLY for an unambiguous single-tier DRUG line; `{}` otherwise. Two
 * universal guards (A2b Phase 2, Andrew-ratified §8/D-C):
 *   (1) drug-context — requires a drug/pharmacy/prescription cue, so a NETWORK/provider "Tier N" (e.g.
 *       "Tier 1 hospital") is never mistaken for a formulary tier;
 *   (2) single-tier — a line naming several tiers ("Tier 1/2/4", "Tier 2 and Tier 4") is deliberately
 *       tier-agnostic (one cost-share across tiers) → omitted.
 * The slug is untouched (the descriptor); this is a plan-local modifier only. Clamped to tier_1..tier_12
 * (the mig-181 CHECK range).
 */
function derivePlanTierLabel(d: string): { planTierLabel?: string } {
  const drugCtx =
    /\bdrugs?\b|\brx\b|\bpharmacy\b|\bprescriptions?\b|\bformulary\b|\bmedications?\b|\banticancer\b|\bchemo\w*\b|\binsulin\b|\bcontracepti\w*\b|\bbiologic\w*\b|\binfusion\b/.test(d);
  if (!drugCtx) return {};
  // multi-tier → tier-agnostic: ≥2 "tier N" mentions, or a "tier N/M" / "tier N & M" / "tier N-M" run.
  const tierMentions = (d.match(/\btiers?\s*\d/g) || []).length;
  const multi = tierMentions >= 2 || /\btier\s*\d+\s*[/,&–-]\s*\d/.test(d);
  if (multi) return {};
  // (?!\d) not \b: a letter-suffixed sub-tier ("Tier 1a" / "Tier 1b") still reads tier_1, while a stray
  // 3-digit run ("Tier 100…") is rejected (no real formulary tier exceeds the 1..12 CHECK range anyway).
  const m = d.match(/\btiers?\s*(\d{1,2})(?!\d)/);
  if (!m) return {};
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 12 ? { planTierLabel: `tier_${n}` } : {};
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
  // Trust-tiering (thesaurus Phase 1a) — gates the learned-synonym boost read below.
  const trust: TrustTiering =
    opts.trustTieredCache !== undefined
      ? { enabled: opts.trustTieredCache, trustedSources: buildTrustedSourceSet() }
      : await loadTrustTiering(opts.supabase);

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
        .select("service_slug, confidence, source")
        .is("billing_code", null)
        .ilike("description_signature", `%${sig}%`)
        .gte("confidence", config.cacheMinConfidence)
        .limit(10);
      for (const row of data ?? []) {
        // Trust filter (thesaurus Phase 1a): a quarantined single-Haiku synonym
        // never boosts search ranking as authority. trust.enabled=false → unchanged.
        if (
          trust.enabled &&
          !isTrustedSignatureSource((row as { source: string | null }).source ?? null, trust.trustedSources)
        ) {
          continue;
        }
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

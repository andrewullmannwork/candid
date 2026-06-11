/**
 * Service Thesaurus Phase 1a (T3a) — plan-doc resolver routing.
 *
 * After the plan-doc parser assigns each service a catalog slug, route the
 * service's verbatim `rawLabel` (the T2 contract field) through the shared
 * `resolveServices` cache CACHE-FIRST (no Haiku, no writeback). A TRUSTWORTHY
 * signature-cache hit — Step A's trust filter already excludes single-Haiku
 * `haiku_resolver` synonyms — WINS and overrides the extractor's slug; otherwise
 * the extractor slug is kept (recall preserved). The chosen slug is then
 * canonicalized through the `service_catalog.merged_into_id` rename-map so a
 * deprecated extractor slug resolves to its live replacement.
 *
 * The override is written in LOCKSTEP across the legacy (`SBCParsedService`) and
 * haiku (`PlanDocService`) arrays, which `toLegacyPlanDocResult` keeps 1:1-aligned.
 *
 * Gating (S175): the rename-map canonicalization (dead→live) is ALWAYS-ON — a pure
 * correctness fix, because the extractor prompt still emits deprecated slugs that would
 * otherwise resolve to a merged catalog row consumer-reads exclude (service dropped). The
 * signature-cache OVERRIDE (synonym routing) stays gated by `thesaurus_phase1a_v1`, since
 * synonym-inferred coverage is exposure-held for Phase 2/6.
 *
 * `applyThesaurusRouting` + `canonicalizeSlug` are PURE (no DB / no Haiku) and are
 * exercised by scripts/calibration/fixtures/thesaurus-phase1a/routing.ts;
 * `loadServiceRenameMap` + `routePlanDocServices` are the impure I/O shell.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveServices,
  type ResolveLineInput,
  type ResolutionSource,
  type ServiceResolution,
} from "@/lib/claims/service-resolver";
import type { SBCParsedService } from "@/lib/sbc/types";
import type { PlanDocService } from "@/lib/plan_doc/types";

/**
 * Resolution tiers whose slug is trusted to OVERRIDE the extractor's slug. Only the
 * corroborated/learned caches win — NOT `trigram_exact` (not reliably better than the
 * contextual extractor → regression risk; §9.4) and NOT `haiku` (never fires here: the
 * caller passes `skipHaiku`). `code_cache` cannot fire on code-less plan-docs but is
 * honored for contract-correctness.
 */
const WINNING_SOURCES: ReadonlySet<ResolutionSource> = new Set<ResolutionSource>([
  "signature_cache",
  "code_cache",
]);

/** Canonicalize a slug through the dead→live rename-map (no-op when already live). */
export function canonicalizeSlug(slug: string, renameMap: ReadonlyMap<string, string>): string {
  return renameMap.get(slug) ?? slug;
}

/**
 * EOC Section-A prior-auth carries a real billing CODE, but the resolver "description" fed for it is
 * criteria PROSE (e.g. "required for procedures over $500") — NOT a service label. So only the
 * CODE-ANCHORED cache may win: a `signature_cache`/`trigram` match on prose manufactures a
 * confident-wrong slug. Returns the `code_cache` slug, or null for any other tier.
 *
 * Distinct from `WINNING_SOURCES` (which also trusts `signature_cache`) because plan-doc routes a
 * real `rawLabel` while EOC routes a billing code against prose — keep the two acceptance sets apart.
 */
export function acceptCodeAnchoredSlug(
  res: Pick<ServiceResolution, "slug" | "source"> | undefined,
): string | null {
  return res && res.source === "code_cache" && res.slug ? res.slug : null;
}

export interface ThesaurusRoutingResult {
  /** Services considered (the 1:1-aligned prefix). */
  total: number;
  /** Services where a trustworthy cache hit replaced the extractor slug. */
  cacheWins: number;
  /** Services whose final slug differs from the extractor slug (cache win OR rename). */
  slugChanged: number;
}

/**
 * PURE core: for each 1:1-aligned service, pick the trustworthy-cache slug (if any) else
 * the extractor slug, canonicalize it, and write it onto BOTH arrays in lockstep. Mutates
 * the input arrays in place.
 */
export function applyThesaurusRouting(args: {
  legacyServices: Array<Pick<SBCParsedService, "serviceSlug">>;
  haikuServices: Array<Pick<PlanDocService, "serviceSlug">>;
  resolutions: ReadonlyMap<number, Pick<ServiceResolution, "slug" | "source">>;
  renameMap: ReadonlyMap<string, string>;
}): ThesaurusRoutingResult {
  const { legacyServices, haikuServices, resolutions, renameMap } = args;
  const total = Math.min(legacyServices.length, haikuServices.length);
  let cacheWins = 0;
  let slugChanged = 0;
  for (let i = 0; i < total; i++) {
    const extractorSlug = legacyServices[i].serviceSlug;
    const res = resolutions.get(i);
    const cacheSlug = res && res.slug && WINNING_SOURCES.has(res.source) ? res.slug : null;
    const chosen = cacheSlug ?? extractorSlug;
    const finalSlug = canonicalizeSlug(chosen, renameMap);
    if (cacheSlug !== null && cacheSlug !== extractorSlug) cacheWins++;
    if (finalSlug !== extractorSlug) slugChanged++;
    legacyServices[i].serviceSlug = finalSlug;
    haikuServices[i].serviceSlug = finalSlug;
  }
  return { total, cacheWins, slugChanged };
}

/**
 * Build the dead-slug → live-slug rename map from `service_catalog.merged_into_id` chains
 * (the same link the calibration scorer uses; §9.5). Cycle-guarded. Returns an empty map on
 * error → `canonicalizeSlug` becomes a no-op (fail-safe: the extractor slug is kept).
 */
export async function loadServiceRenameMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("service_catalog")
    .select("id, slug, merged_into_id");
  if (error || !data) return new Map();

  const byId = new Map<string, { slug: string; mergedInto: string | null }>();
  for (const row of data as Array<{ id: string; slug: string; merged_into_id: string | null }>) {
    byId.set(row.id, { slug: row.slug, mergedInto: row.merged_into_id ?? null });
  }

  const renameMap = new Map<string, string>();
  for (const start of byId.values()) {
    if (start.mergedInto === null) continue; // already a live slug — no rename needed
    const visited = new Set<string>();
    let nextId: string | null = start.mergedInto;
    let terminalSlug: string | null = null;
    while (nextId !== null && !visited.has(nextId)) {
      visited.add(nextId);
      const next = byId.get(nextId);
      if (!next) break;
      if (next.mergedInto === null) {
        terminalSlug = next.slug;
        break;
      }
      nextId = next.mergedInto;
    }
    if (terminalSlug !== null && terminalSlug !== start.slug) {
      renameMap.set(start.slug, terminalSlug);
    }
  }
  return renameMap;
}

/**
 * Impure orchestrator called by `process-plan.ts` on EVERY plan-doc parse. Two behaviors,
 * differently gated:
 *   • Rename-map canonicalization (dead→live) — ALWAYS (pure correctness; ungated).
 *   • Signature-cache OVERRIDE (synonym routing) — only when `cacheRoutingEnabled`
 *     (the `thesaurus_phase1a_v1` flag), since synonym coverage is exposure-held.
 * Returns null (no-op) when the two arrays are misaligned (fail-safe — keep extractor slugs).
 */
export async function routePlanDocServices(args: {
  supabase: SupabaseClient;
  userId: string;
  legacyServices: SBCParsedService[];
  haikuServices: PlanDocService[];
  cacheRoutingEnabled: boolean;
}): Promise<ThesaurusRoutingResult | null> {
  const { supabase, userId, legacyServices, haikuServices, cacheRoutingEnabled } = args;
  if (legacyServices.length !== haikuServices.length) {
    console.warn(
      `[thesaurus-routing] legacy/haiku length mismatch (${legacyServices.length} vs ${haikuServices.length}) — skipping routing (fail-safe)`,
    );
    return null;
  }

  // Synonym-cache override (FLAG-GATED). Empty resolutions when OFF → applyThesaurusRouting
  // becomes canonicalize-only. Cache-first: no Haiku (skipHaiku), no writeback (skipWriteback);
  // the resolver's own trust filter (loadTrustTiering) excludes quarantined haiku_resolver rows.
  let resolutions: Map<number, ServiceResolution> = new Map();
  if (cacheRoutingEnabled) {
    const lines: ResolveLineInput[] = [];
    for (let i = 0; i < legacyServices.length; i++) {
      const raw = legacyServices[i].rawLabel;
      if (raw && raw.trim().length > 0) lines.push({ lineNumber: i, description: raw });
    }
    if (lines.length > 0) {
      resolutions = await resolveServices(lines, { supabase, userId, skipHaiku: true, skipWriteback: true });
    }
  }

  // Rename-map canonicalization (dead→live) — ALWAYS, regardless of the flag.
  const renameMap = await loadServiceRenameMap(supabase);
  return applyThesaurusRouting({ legacyServices, haikuServices, resolutions, renameMap });
}

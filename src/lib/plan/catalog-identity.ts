/**
 * loadCatalogIdentity — THE shared slug → service_catalog identity resolver
 * for tables that store a bare `service_slug` TEXT without the FK
 * (`canonical_plan_services`; mig 019 comment promised the FK, mig 213 adds
 * it). Follows `merged_into_id` chains so a row stored on a merged (dead)
 * slug resolves to the LIVE catalog row's identity.
 *
 * This replaced three divergent per-reader derivations (S289):
 *   - /api/plan/analyze canonical gap-fill — hardcoded category "other"
 *   - src/lib/plan/compare.ts resolveCanonicalPlan — inline two-query merge
 *   - src/lib/audit/coverage-loader.ts loadCanonicalCoverageMeta — ditto
 *
 * Axis note (do not confuse the resolvers):
 *   - THIS module = the MERGE axis (`merged_into_id`): "this stored slug's
 *     live storage identity". Use it when reading slug-keyed rows.
 *   - `src/lib/parser/canonical-resolution.ts` = the CONCEPT-SIBLING axis
 *     (`canonical_for_concept`): display-level alias dedupe across sibling
 *     slugs of one concept. Use it for grouping, never for storage identity.
 *   - `plan_covered_services` needs neither: its `service_id` FK joins
 *     `service_catalog` directly.
 *
 * Unknown slugs are simply absent from the returned Map — callers keep their
 * own fallback (`?? "other"` on display paths, `?? null` on meta paths).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CatalogIdentity {
  /** The slug exactly as stored on the querying row (Map key). */
  requestedSlug: string;
  /** Live slug after following merged_into_id (equals requestedSlug when not merged). */
  liveSlug: string;
  /** service_catalog.name of the LIVE row. */
  name: string;
  /** service_catalog.category of the LIVE row. */
  category: string;
  /** service_catalog.id (UUID) of the LIVE row. */
  serviceId: string;
  /** service_catalog.concept_id of the LIVE row (null on the rare unlinked row). */
  conceptId: string | null;
}

interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  merged_into_id: string | null;
  concept_id: string | null;
}

/** DB truth is depth-1 chains; cap defends against a future accidental cycle. */
const MAX_MERGE_HOPS = 3;

export async function loadCatalogIdentity(
  supabase: SupabaseClient,
  slugs: Array<string | null | undefined>,
): Promise<Map<string, CatalogIdentity>> {
  const out = new Map<string, CatalogIdentity>();
  const wanted = Array.from(new Set(slugs.filter((s): s is string => Boolean(s))));
  if (wanted.length === 0) return out;

  const { data: rows, error } = await supabase
    .from("service_catalog")
    .select("id, slug, name, category, merged_into_id, concept_id")
    .in("slug", wanted);
  if (error) {
    console.warn("[catalog-identity] slug lookup failed:", error.message);
    return out;
  }
  const byId = new Map<string, CatalogRow>();
  const bySlug = new Map<string, CatalogRow>();
  for (const r of (rows ?? []) as CatalogRow[]) {
    byId.set(r.id, r);
    bySlug.set(r.slug, r);
  }

  // Fetch merge targets not already in hand (depth-1 in practice; loop caps at 3).
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const missingTargets = Array.from(
      new Set(
        Array.from(byId.values())
          .map((r) => r.merged_into_id)
          .filter((id): id is string => Boolean(id) && !byId.has(id as string)),
      ),
    );
    if (missingTargets.length === 0) break;
    const { data: targets, error: tErr } = await supabase
      .from("service_catalog")
      .select("id, slug, name, category, merged_into_id, concept_id")
      .in("id", missingTargets);
    if (tErr) {
      console.warn("[catalog-identity] merge-target lookup failed:", tErr.message);
      break;
    }
    for (const r of (targets ?? []) as CatalogRow[]) byId.set(r.id, r);
  }

  for (const requestedSlug of wanted) {
    let row = bySlug.get(requestedSlug);
    if (!row) continue; // unknown slug — caller's fallback applies
    const seen = new Set<string>([row.id]);
    let hops = 0;
    while (row.merged_into_id && hops < MAX_MERGE_HOPS) {
      const target = byId.get(row.merged_into_id);
      if (!target || seen.has(target.id)) break; // dangling target or cycle — stop at last good row
      row = target;
      seen.add(row.id);
      hops++;
    }
    out.set(requestedSlug, {
      requestedSlug,
      liveSlug: row.slug,
      name: row.name,
      category: row.category,
      serviceId: row.id,
      conceptId: row.concept_id ?? null,
    });
  }
  return out;
}

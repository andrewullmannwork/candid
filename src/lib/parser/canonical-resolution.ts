/**
 * src/lib/parser/canonical-resolution.ts — S94 B1 Stage 3.
 *
 * Triplet-based canonical authority helper. Resolves any slug (canonical OR alias)
 * to its canonical sibling per concept_id grouping.
 *
 * Post-S94 reset the catalog only contains canonical rows (proposal_state='canonical'
 * + canonical_for_concept=true). When admin promotes a proposed_* slug as an ALIAS
 * (instead of standalone canonical), the alias row gets canonical_for_concept=false +
 * shared concept_id with the canonical sibling. This helper walks that linkage.
 *
 * Source-of-truth contract (mig 103 + S94 LOCK):
 * - slug (PK) + concept_id (medical equivalence) + display_name forms the triplet
 * - exactly ONE row per concept_id has canonical_for_concept=true
 *   (enforced by enforce_canonical_per_concept() trigger)
 * - Pattern 1 #3 corroboration aggregates across ALL slugs sharing concept_id
 *
 * Usage:
 *   const canonical = await resolveCanonicalSlug("physical_therapy", supabase);
 *   // → "pt_rehab" once admin promotes physical_therapy as alias of pt_rehab
 *   // → "physical_therapy" if no such alias exists (untouched passthrough)
 */
import type { SupabaseClient } from "@supabase/supabase-js";

interface CatalogRow {
  slug: string;
  concept_id: string | null;
  canonical_for_concept: boolean | null;
  proposal_state: string | null;
}

/**
 * Resolve a service slug to its canonical sibling per concept_id grouping.
 *
 * Returns:
 * - the rawSlug itself if it IS already canonical, OR if it's not in service_catalog
 *   at all (caller should treat as parser-violation or proposed_* not yet promoted)
 * - the canonical sibling's slug if rawSlug is an alias with shared concept_id
 *
 * Performance: single-row reads against an indexed table. Cache at caller side if
 * resolving in a tight loop (e.g., display rendering for a long services list).
 */
export async function resolveCanonicalSlug(
  rawSlug: string,
  supabase: SupabaseClient,
): Promise<string> {
  if (!rawSlug || typeof rawSlug !== "string") return rawSlug;

  const { data: row, error } = await supabase
    .from("service_catalog")
    .select("slug, concept_id, canonical_for_concept, proposal_state")
    .eq("slug", rawSlug)
    .maybeSingle<CatalogRow>();

  if (error) {
    console.warn(`[canonical-resolution] lookup failed for "${rawSlug}": ${error.message}`);
    return rawSlug;
  }
  if (!row) {
    // Slug not in catalog — likely proposed_* not yet admin-promoted, or a
    // legacy slug from pre-S94 data. Return as-is; caller decides next steps.
    return rawSlug;
  }

  // Already canonical — fast path.
  if (row.canonical_for_concept === true) return row.slug;

  // Alias — walk concept_id link to find canonical sibling.
  if (!row.concept_id) {
    // Alias row WITHOUT concept_id is a data-integrity bug. The
    // enforce_canonical_per_concept() trigger should prevent this, but on a
    // race or buggy admin promotion, surface it instead of silently returning
    // the orphan alias.
    console.warn(
      `[canonical-resolution] alias "${rawSlug}" (canonical_for_concept=false) has NULL concept_id — orphan alias`,
    );
    return rawSlug;
  }

  const { data: sibling, error: sibErr } = await supabase
    .from("service_catalog")
    .select("slug")
    .eq("concept_id", row.concept_id)
    .eq("canonical_for_concept", true)
    .maybeSingle<{ slug: string }>();

  if (sibErr) {
    console.warn(
      `[canonical-resolution] sibling lookup for concept_id ${row.concept_id} failed: ${sibErr.message}`,
    );
    return rawSlug;
  }
  if (!sibling) {
    // No canonical sibling for this concept_id — another data-integrity case
    // the trigger should prevent.
    console.warn(
      `[canonical-resolution] alias "${rawSlug}" has concept_id ${row.concept_id} but no canonical sibling`,
    );
    return rawSlug;
  }

  return sibling.slug;
}

/**
 * Batch resolve. Returns Map<rawSlug, canonicalSlug>. Slugs not in catalog
 * map to themselves. Single round-trip to service_catalog when possible.
 *
 * Use this for display rendering of multiple services. Single resolveCanonicalSlug
 * calls are fine for one-off lookups.
 */
export async function resolveCanonicalSlugs(
  rawSlugs: string[],
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!rawSlugs || rawSlugs.length === 0) return result;

  const uniq = [...new Set(rawSlugs.filter((s) => typeof s === "string" && s.length > 0))];
  for (const s of uniq) result.set(s, s); // default: unchanged

  // Pull every row for the input slugs in one query.
  const { data: rows, error } = await supabase
    .from("service_catalog")
    .select("slug, concept_id, canonical_for_concept")
    .in("slug", uniq);
  if (error) {
    console.warn(`[canonical-resolution] batch lookup failed: ${error.message}`);
    return result;
  }

  // Identify aliases needing sibling lookup.
  const conceptIdsToResolve = new Set<string>();
  const aliasBySlug = new Map<string, string>(); // rawSlug → concept_id
  for (const r of rows ?? []) {
    const row = r as CatalogRow;
    if (row.canonical_for_concept === true) {
      result.set(row.slug, row.slug);
      continue;
    }
    if (row.concept_id) {
      conceptIdsToResolve.add(row.concept_id);
      aliasBySlug.set(row.slug, row.concept_id);
    }
  }

  if (conceptIdsToResolve.size === 0) return result;

  // One query to pull canonical siblings for all needed concept_ids.
  const { data: siblings, error: sibErr } = await supabase
    .from("service_catalog")
    .select("slug, concept_id")
    .in("concept_id", [...conceptIdsToResolve])
    .eq("canonical_for_concept", true);
  if (sibErr) {
    console.warn(`[canonical-resolution] batch sibling lookup failed: ${sibErr.message}`);
    return result;
  }

  const canonicalByConceptId = new Map<string, string>();
  for (const s of siblings ?? []) {
    const row = s as { slug: string; concept_id: string };
    canonicalByConceptId.set(row.concept_id, row.slug);
  }

  for (const [aliasSlug, conceptId] of aliasBySlug) {
    const canonical = canonicalByConceptId.get(conceptId);
    if (canonical) result.set(aliasSlug, canonical);
  }

  return result;
}

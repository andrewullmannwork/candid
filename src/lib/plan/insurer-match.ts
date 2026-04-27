import type { SupabaseClient } from "@supabase/supabase-js";
import { inferCarrierFromPlanName } from "@/lib/disputes/plan-context";

export type InsurerMatchVia = "insurer_name" | "plan_name_inference";

export interface InsurerMatchResult {
  id: string;
  name: string;
  via: InsurerMatchVia;
}

/**
 * Fuzzy-match a raw insurer name against the insurer_catalog.
 * Returns the matched catalog entry or null.
 */
export async function matchInsurerCatalog(
  supabase: SupabaseClient,
  rawName: string
): Promise<{ id: string; name: string } | null> {
  if (!rawName || rawName.trim().length === 0) return null;

  const normalized = rawName.trim().toLowerCase();

  // Fetch all catalog entries (small table, ~70 rows)
  const { data: catalog } = await supabase
    .from("insurer_catalog")
    .select("id, name, aliases");

  if (!catalog || catalog.length === 0) return null;

  for (const entry of catalog) {
    const catalogName = (entry.name || "").toLowerCase();

    // Exact match
    if (catalogName === normalized) {
      return { id: entry.id, name: entry.name };
    }

    // Check aliases
    const aliases: string[] = entry.aliases || [];
    for (const alias of aliases) {
      if (alias.toLowerCase() === normalized) {
        return { id: entry.id, name: entry.name };
      }
    }

    // Substring containment (both directions)
    if (catalogName.includes(normalized) || normalized.includes(catalogName)) {
      return { id: entry.id, name: entry.name };
    }

    // Check alias substrings
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.includes(normalized) || normalized.includes(aliasLower)) {
        return { id: entry.id, name: entry.name };
      }
    }
  }

  return null;
}

/**
 * Resolve the carrier insurer for a plan, with PEO-aware fallback.
 *
 * Some plans capture the group sponsor as `insurer_name` (e.g., a PEO like
 * "Sequoia One PEO, LLC") instead of the actual carrier (e.g., Cigna).
 * `matchInsurerCatalog` won't find those because PEOs aren't in the carrier
 * catalog. This wrapper falls through to plan-name carrier inference (which
 * understands "Open Access Plus" → Cigna, "Choice Plus" → UnitedHealthcare,
 * etc.) so canonical-plan linking still succeeds for PEO-administered plans.
 *
 * Returns the matched catalog entry plus a `via` discriminator the caller
 * can log / surface for confidence-tracking. Null if neither path matched.
 */
export async function matchInsurerWithPlanFallback(
  supabase: SupabaseClient,
  params: { insurerName: string | null | undefined; planName: string | null | undefined },
): Promise<InsurerMatchResult | null> {
  const direct = await matchInsurerCatalog(supabase, params.insurerName ?? "");
  if (direct) return { ...direct, via: "insurer_name" };

  const inferred = params.planName ? inferCarrierFromPlanName(params.planName) : null;
  if (!inferred) return null;

  const fromPlan = await matchInsurerCatalog(supabase, inferred);
  if (!fromPlan) return null;

  return { ...fromPlan, via: "plan_name_inference" };
}

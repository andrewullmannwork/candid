import type { SupabaseClient } from "@supabase/supabase-js";

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

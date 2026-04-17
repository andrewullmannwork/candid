/**
 * NPPES Provider Lookup — enriches provider records with public NPI data.
 *
 * Queries the NPPES NPI Registry API to get provider details:
 * name, specialty, address, organization.
 *
 * Best-effort, 30-day cache, never blocks the pipeline.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const NPPES_API = "https://npiregistry.cms.hhs.gov/api/?version=2.1";
const CACHE_DAYS = 30;

interface NPPESResult {
  displayName: string;
  specialty: string | null;
  organizationName: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
}

/**
 * Look up a provider by NPI number via the NPPES API.
 * Returns null if not found or API unavailable.
 */
async function queryNPPES(npi: string): Promise<NPPESResult | null> {
  try {
    const res = await fetch(`${NPPES_API}&number=${encodeURIComponent(npi)}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const results = data.results;
    if (!results || results.length === 0) return null;

    const r = results[0];
    const isOrg = r.enumeration_type === "NPI-2";

    // Get primary practice address
    const addr = r.addresses?.find((a: Record<string, unknown>) => a.address_purpose === "LOCATION") || r.addresses?.[0];

    // Get primary taxonomy (specialty)
    const taxonomy = r.taxonomies?.find((t: Record<string, unknown>) => t.primary === true) || r.taxonomies?.[0];

    return {
      displayName: isOrg
        ? r.basic?.organization_name || ""
        : `${r.basic?.first_name || ""} ${r.basic?.last_name || ""}`.trim(),
      specialty: taxonomy?.desc || null,
      organizationName: isOrg ? r.basic?.organization_name || null : r.basic?.organization_name || null,
      addressCity: addr?.city || null,
      addressState: addr?.state || null,
      addressZip: addr?.postal_code?.slice(0, 5) || null,
    };
  } catch (err) {
    console.error(`[provider-lookup] NPPES query failed for NPI ${npi}:`, err);
    return null;
  }
}

/**
 * Look up and enrich a provider record from NPPES.
 * Skips if data was fetched within the cache window.
 */
export async function lookupProvider(
  supabase: SupabaseClient,
  providerId: string
): Promise<void> {
  // Fetch current provider record
  const { data: provider } = await supabase
    .from("providers")
    .select("id, npi, display_name, nppes_updated_at")
    .eq("id", providerId)
    .single();

  if (!provider?.npi) return;

  // Check cache
  if (provider.nppes_updated_at) {
    const cacheAge = (Date.now() - new Date(provider.nppes_updated_at).getTime()) / (1000 * 60 * 60 * 24);
    if (cacheAge < CACHE_DAYS) return;
  }

  const nppes = await queryNPPES(provider.npi);
  if (!nppes) return;

  await supabase
    .from("providers")
    .update({
      display_name: nppes.displayName || provider.display_name,
      specialty: nppes.specialty,
      organization_name: nppes.organizationName,
      address_city: nppes.addressCity,
      address_state: nppes.addressState,
      address_zip: nppes.addressZip,
      nppes_updated_at: new Date().toISOString(),
    })
    .eq("id", providerId);

  console.log(`[provider-lookup] Enriched provider ${providerId}: ${nppes.displayName}`);
}

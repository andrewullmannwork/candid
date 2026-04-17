/**
 * Provider Audit Metrics — aggregates billing audit findings per provider.
 *
 * After each bill is audited, this module upserts the provider_audit_metrics
 * table with finding counts and rates. Feeds Candid Care provider scorecards.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Collect and aggregate audit findings for a provider.
 * Called after runAudit() in the bill processing pipeline.
 */
export async function collectProviderAuditData(
  supabase: SupabaseClient,
  providerId: string,
  findingCount: number,
  lineItemCount: number,
  findingTypes: string[]
): Promise<void> {
  if (!providerId || lineItemCount === 0) return;

  const findingRate = lineItemCount > 0 ? findingCount / lineItemCount : 0;

  // Aggregate finding types into a count map
  const typeMap: Record<string, number> = {};
  for (const t of findingTypes) {
    typeMap[t] = (typeMap[t] || 0) + 1;
  }

  const { data: existing } = await supabase
    .from("provider_audit_metrics")
    .select("id, total_bills_analyzed, finding_count, finding_types")
    .eq("provider_id", providerId)
    .maybeSingle();

  if (existing) {
    const newTotal = existing.total_bills_analyzed + 1;
    const newFindings = existing.finding_count + findingCount;
    const newRate = newTotal > 0 ? newFindings / newTotal : 0;

    // Merge finding types
    const prevTypes = (existing.finding_types as Record<string, number>) || {};
    for (const [k, v] of Object.entries(typeMap)) {
      prevTypes[k] = (prevTypes[k] || 0) + v;
    }

    await supabase
      .from("provider_audit_metrics")
      .update({
        total_bills_analyzed: newTotal,
        finding_count: newFindings,
        finding_rate: Math.round(newRate * 10000) / 10000,
        finding_types: prevTypes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("provider_audit_metrics").insert({
      provider_id: providerId,
      total_bills_analyzed: 1,
      finding_count: findingCount,
      finding_rate: Math.round(findingRate * 10000) / 10000,
      finding_types: typeMap,
    });
  }
}

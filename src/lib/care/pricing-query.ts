/**
 * Care Pricing Query — retrieves anonymized community pricing data.
 *
 * Queries pricing_data table (procedure_code + region columns) with
 * a join to billing_code_mappings for service_slug → procedure_code resolution.
 * k-anonymity enforced: HAVING count >= 5.
 *
 * Schema (migration 002): pricing_data has procedure_code, region, billed_amount,
 * patient_paid, data_source. No service_slug column — we resolve via billing_code_mappings.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { K_ANON_THRESHOLDS } from "./interface";

// S305 — one definition of the rule, and it stays behind the legal-review gate
// that owns it (see K_ANON_THRESHOLDS' header in ./interface).
const K_ANONYMITY_THRESHOLD = K_ANON_THRESHOLDS.unspecified_reference;

export interface PricingResult {
  serviceSlug: string;
  serviceName: string;
  observationCount: number;
  medianBilled: number | null;
  avgBilled: number | null;
  minBilled: number | null;
  maxBilled: number | null;
  medianPatientOwes: number | null;
  avgPatientOwes: number | null;
  medicareBenchmark: number | null;
  region: string | null;
}

/**
 * Get community pricing for a service in a region.
 * Resolves service_slug → procedure_codes via billing_code_mappings,
 * then queries pricing_data by those codes.
 * Returns null if insufficient data (k-anonymity).
 */
export async function getServicePricing(
  supabase: SupabaseClient,
  params: {
    serviceSlug: string;
    state?: string;
  }
): Promise<PricingResult | null> {
  const { serviceSlug, state } = params;

  // Step 1: Resolve service_slug → billing codes via billing_code_mappings
  const { data: mappings } = await supabase
    .from("billing_code_mappings")
    .select("billing_code")
    .eq("service_slug", serviceSlug)
    .gte("confidence", 0.5);

  const codes = mappings?.map((m) => m.billing_code) || [];

  // Also check if procedure_category matches (pricing_data stores plain-English category)
  // Build query for both billing codes and category match
  let query = supabase
    .from("pricing_data")
    .select("billed_amount, patient_paid, region")
    .not("billed_amount", "is", null);

  if (state) {
    query = query.eq("region", state);
  }

  // Query by procedure codes if we have mappings, otherwise by category
  if (codes.length > 0) {
    query = query.in("procedure_code", codes);
  } else {
    // Fall back to procedure_category matching the slug
    const categoryName = serviceSlug.replace(/_/g, " ");
    query = query.ilike("procedure_category", `%${categoryName}%`);
  }

  const { data: rows } = await query;

  if (!rows || rows.length < K_ANONYMITY_THRESHOLD) return null;

  // Compute aggregates
  const billedAmounts = rows
    .map((r) => r.billed_amount as number)
    .filter((a) => a > 0)
    .sort((a, b) => a - b);

  const patientAmounts = rows
    .map((r) => r.patient_paid as number | null)
    .filter((a): a is number => a != null && a > 0)
    .sort((a, b) => a - b);

  if (billedAmounts.length < K_ANONYMITY_THRESHOLD) return null;

  // Get service name
  const { data: svc } = await supabase
    .from("service_catalog")
    .select("name")
    .eq("slug", serviceSlug)
    .single();

  // Get Medicare benchmark (CMS PPL source)
  let medicareBenchmark: number | null = null;
  if (codes.length > 0) {
    try {
      const { data: medicare } = await supabase
        .from("pricing_data")
        .select("billed_amount")
        .eq("data_source", "cms_ppl")
        .in("procedure_code", codes)
        .limit(1)
        .maybeSingle();
      medicareBenchmark = medicare?.billed_amount || null;
    } catch {
      // Best-effort
    }
  }

  return {
    serviceSlug,
    serviceName: svc?.name || serviceSlug.replace(/_/g, " "),
    observationCount: billedAmounts.length,
    medianBilled: billedAmounts[Math.floor(billedAmounts.length / 2)],
    avgBilled: Math.round(billedAmounts.reduce((s, a) => s + a, 0) / billedAmounts.length),
    minBilled: billedAmounts[0],
    maxBilled: billedAmounts[billedAmounts.length - 1],
    medianPatientOwes: patientAmounts.length >= K_ANONYMITY_THRESHOLD
      ? patientAmounts[Math.floor(patientAmounts.length / 2)]
      : null,
    avgPatientOwes: patientAmounts.length >= K_ANONYMITY_THRESHOLD
      ? Math.round(patientAmounts.reduce((s, a) => s + a, 0) / patientAmounts.length)
      : null,
    medicareBenchmark,
    region: state || null,
  };
}

/**
 * Search for available services with pricing data.
 * Returns services that have sufficient data for display.
 */
export async function searchPricedServices(
  supabase: SupabaseClient,
  params: {
    query?: string;
    state?: string;
    limit?: number;
  }
): Promise<Array<{ serviceSlug: string; serviceName: string; observationCount: number }>> {
  const { query: searchQuery, state, limit = 20 } = params;

  // Get procedure_category counts from pricing_data
  let dataQuery = supabase
    .from("pricing_data")
    .select("procedure_category, procedure_code")
    .not("billed_amount", "is", null);

  if (state) dataQuery = dataQuery.eq("region", state);

  const { data: rows } = await dataQuery;

  if (!rows) return [];

  // Count by procedure_category (plain-English) and resolve to slugs via billing_code_mappings
  const categoryCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.procedure_category) {
      categoryCounts.set(row.procedure_category, (categoryCounts.get(row.procedure_category) || 0) + 1);
    }
    if (row.procedure_code) {
      codeCounts.set(row.procedure_code, (codeCounts.get(row.procedure_code) || 0) + 1);
    }
  }

  // Look up code→slug mappings for the top codes
  const topCodes = Array.from(codeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100)
    .map(([code]) => code);

  const { data: mappings } = await supabase
    .from("billing_code_mappings")
    .select("billing_code, service_slug")
    .in("billing_code", topCodes)
    .gte("confidence", 0.5);

  // Aggregate counts by service_slug
  const slugCounts = new Map<string, number>();
  for (const m of mappings || []) {
    const count = codeCounts.get(m.billing_code) || 0;
    slugCounts.set(m.service_slug, (slugCounts.get(m.service_slug) || 0) + count);
  }

  // Filter by k-anonymity
  const eligible = Array.from(slugCounts.entries())
    .filter(([, count]) => count >= K_ANONYMITY_THRESHOLD)
    .sort((a, b) => b[1] - a[1]);

  // Look up service names
  const slugs = eligible.slice(0, limit * 2).map(([slug]) => slug);
  const { data: services } = await supabase
    .from("service_catalog")
    .select("slug, name")
    .in("slug", slugs);

  const nameMap = new Map((services || []).map((s) => [s.slug, s.name]));

  let results = eligible.map(([slug, count]) => ({
    serviceSlug: slug,
    serviceName: nameMap.get(slug) || slug.replace(/_/g, " "),
    observationCount: count,
  }));

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    results = results.filter(
      (r) => r.serviceName.toLowerCase().includes(q) || r.serviceSlug.includes(q)
    );
  }

  return results.slice(0, limit);
}

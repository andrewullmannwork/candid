/**
 * GET /api/care/provider — Provider info + audit metrics
 *
 * Query params:
 * - id: provider UUID (required)
 *
 * Returns provider details + billing audit metrics (k-anonymity enforced).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

const K_ANONYMITY_THRESHOLD = 5;

export async function GET(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("id");
  if (!providerId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Fetch provider
  const { data: provider, error } = await supabase
    .from("providers")
    .select("id, name, npi, display_name, specialty, organization_name, address_city, address_state, address_zip")
    .eq("id", providerId)
    .single();

  if (error || !provider) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }

  // Fetch audit metrics (k-anonymity enforced)
  let auditMetrics = null;
  const { data: metrics } = await supabase
    .from("provider_audit_metrics")
    .select("total_bills_analyzed, finding_count, finding_rate, finding_types")
    .eq("provider_id", providerId)
    .single();

  if (metrics && metrics.total_bills_analyzed >= K_ANONYMITY_THRESHOLD) {
    auditMetrics = {
      totalBillsAnalyzed: metrics.total_bills_analyzed,
      findingCount: metrics.finding_count,
      findingRate: metrics.finding_rate,
      findingTypes: metrics.finding_types,
    };
  }

  return NextResponse.json({
    provider: {
      id: provider.id,
      name: provider.display_name || provider.name,
      npi: provider.npi,
      specialty: provider.specialty,
      organization: provider.organization_name,
      city: provider.address_city,
      state: provider.address_state,
      zip: provider.address_zip,
    },
    auditMetrics,
  });
}

/**
 * GET /api/care/pricing — Community pricing data for a service
 *
 * Query params:
 * - service: service_slug (required)
 * - state: 2-letter state code (optional, filters by region)
 * - search: search query for service discovery (if no service specified)
 *
 * Returns: pricing aggregates with Medicare benchmark. k-anonymity enforced.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getServicePricing, searchPricedServices } from "@/lib/care/pricing-query";

export async function GET(req: NextRequest) {
  const service = req.nextUrl.searchParams.get("service");
  const state = req.nextUrl.searchParams.get("state") || undefined;
  const search = req.nextUrl.searchParams.get("search");

  const supabase = createServerClient();

  // Search mode: list services with pricing data
  if (!service) {
    const results = await searchPricedServices(supabase, { query: search || undefined, state });
    return NextResponse.json({ services: results });
  }

  // Pricing mode: get pricing for a specific service
  const pricing = await getServicePricing(supabase, { serviceSlug: service, state });

  if (!pricing) {
    return NextResponse.json(
      { error: "Insufficient data for this service. We need more community reports." },
      { status: 404 }
    );
  }

  return NextResponse.json({ pricing });
}

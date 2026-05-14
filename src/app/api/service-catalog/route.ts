/**
 * GET /api/service-catalog
 *
 * Returns the list of service_catalog slugs for D6 CategoryCorrectionModal
 * autocomplete. Public read (service catalog is reference data per Pattern P-9).
 *
 * No auth required; cached at the CDN layer for 5 minutes.
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("service_catalog")
    .select("slug, name, category")
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { items: data ?? [] },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    },
  );
}

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  // Verify auth
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { query, insurer, state } = await req.json();

  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return NextResponse.json({ plans: [] });
  }

  const supabase = createServerClient();
  const searchTerm = query.trim();

  // Use pg_trgm similarity search with optional insurer/state filters
  // Falls back to ilike if pg_trgm isn't available
  let dbQuery = supabase
    .from("plan_catalog")
    .select(
      "id, hios_id, plan_name, plan_type, state, metal_level, premium_individual, sbc_document_url, year, data_status, raw_data, insurer_id"
    )
    .ilike("plan_name", `%${searchTerm}%`)
    .order("plan_name")
    .limit(15);

  if (state) {
    dbQuery = dbQuery.eq("state", state);
  }

  const { data: plans, error } = await dbQuery;

  if (error) {
    console.error("Plan search error:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }

  // If insurer filter provided, try to prioritize matching plans but don't exclude others
  let filteredPlans = plans || [];
  if (insurer && filteredPlans.length > 0) {
    const { data: insurerMatch } = await supabase
      .from("insurer_catalog")
      .select("id")
      .ilike("name", `%${insurer}%`)
      .limit(5);

    if (insurerMatch && insurerMatch.length > 0) {
      const insurerIds = new Set(insurerMatch.map((i) => i.id));
      // Sort insurer matches first, but keep all results
      filteredPlans.sort((a, b) => {
        const aMatch = insurerIds.has(a.insurer_id) ? 0 : 1;
        const bMatch = insurerIds.has(b.insurer_id) ? 0 : 1;
        return aMatch - bMatch;
      });
    }
  }

  // Format response
  const results = filteredPlans.map((p) => ({
    id: p.id,
    hiosId: p.hios_id,
    name: p.plan_name,
    type: p.plan_type,
    state: p.state,
    metalLevel: p.metal_level,
    premium: p.premium_individual,
    deductible: p.raw_data?.deductible_individual,
    oopMax: p.raw_data?.oop_max_individual,
    year: p.year,
    hasSbcUrl: !!p.sbc_document_url,
    dataStatus: p.data_status,
  }));

  return NextResponse.json({ plans: results });
}

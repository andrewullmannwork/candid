import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { matchPlan } from "@/lib/plan/matcher";

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

  const { query, insurer, state, planType, metalLevel, planSource } = await req.json();

  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return NextResponse.json({ plans: [] });
  }

  const trimmed = query.trim();
  const supabase = createServerClient();

  // Three-tier search strategy. Each tier widens the funnel.
  //
  // 1. Trigram matcher narrowed by insurer + state — best ranking when filters fit.
  // 2. Trigram matcher with no insurer/state filters — covers the update-insurance
  //    flow where saved state/insurer over-restrict the catalog query.
  // 3. ILIKE substring fallback — trigram similarity normalizes by max(triA, triB),
  //    which scores short queries (e.g., "conn") against long candidate names
  //    ("Connect Bronze 3800 Indiv Med Deductible") below the 0.2 sim threshold,
  //    so the matcher returns nothing for very short inputs even though the user
  //    is clearly typing a prefix. ILIKE recovers those.
  let matches = await matchPlan(supabase, {
    planName: trimmed,
    insurerName: insurer || undefined,
    state: state || undefined,
    planType: planType || undefined,
    metalLevel: metalLevel || undefined,
    planSource: planSource || undefined,
  }, {
    limit: 15,
    minConfidence: 0.15, // Lower threshold for autocomplete — show more results
  });

  if (matches.length === 0 && (insurer || state)) {
    matches = await matchPlan(supabase, {
      planName: trimmed,
      planType: planType || undefined,
      metalLevel: metalLevel || undefined,
      planSource: planSource || undefined,
    }, {
      limit: 15,
      minConfidence: 0.15,
    });
  }

  // Tier 1+2 results — format and return if we have any.
  if (matches.length > 0) {
    const tier12CanonicalMap = await fetchCanonicalMap(
      supabase,
      matches.map((m) => m.planId),
    );
    const results = matches.map((m) => ({
      id: m.planId,
      // canonical_plan_id (via plan_catalog_canonical_map). Required for /compare;
      // undefined if this plan_catalog row hasn't been mapped to a canonical plan.
      canonicalPlanId: tier12CanonicalMap.get(m.planId),
      hiosId: m.plan.hios_id,
      name: m.planName,
      type: m.plan.plan_type,
      state: m.plan.state,
      metalLevel: m.plan.metal_level,
      premium: m.plan.premium_individual,
      deductible: (m.plan.raw_data as Record<string, unknown>)?.deductible_individual,
      oopMax: (m.plan.raw_data as Record<string, unknown>)?.oop_max_individual,
      year: m.plan.year,
      hasSbcUrl: !!m.plan.sbc_document_url,
      dataStatus: m.plan.data_status,
      confidence: m.confidence,
      matchedSignals: m.matchedSignals,
    }));
    return NextResponse.json({ plans: results });
  }

  // Tier 3 — ILIKE substring fallback. Pulls plan names that contain the query
  // as a substring; trigram-scoring is bypassed entirely. Sorts prefix matches
  // first, then by data_status (verified rows preferred), then alphabetically.
  // Escape SQL ILIKE wildcards so user input doesn't widen the pattern.
  const escaped = trimmed.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data: ilikeRows } = await supabase
    .from("plan_catalog")
    .select("id, hios_id, plan_name, plan_type, state, year, metal_level, premium_individual, insurer_id, raw_data, sbc_document_url, data_status")
    .ilike("plan_name", `%${escaped}%`)
    .limit(30);

  if (!ilikeRows || ilikeRows.length === 0) {
    return NextResponse.json({ plans: [] });
  }

  // Resolve insurer names so the autocomplete row UI can render them.
  const insurerIds = [...new Set(ilikeRows.map((r) => r.insurer_id).filter(Boolean))] as string[];
  const insurerNameMap = new Map<string, string>();
  if (insurerIds.length > 0) {
    const { data: insurers } = await supabase
      .from("insurer_catalog")
      .select("id, name")
      .in("id", insurerIds);
    if (insurers) {
      for (const ins of insurers) insurerNameMap.set(ins.id, ins.name);
    }
  }

  const lowerQ = trimmed.toLowerCase();
  const ranked = ilikeRows
    .map((r) => {
      const lowerName = (r.plan_name || "").toLowerCase();
      const startsWith = lowerName.startsWith(lowerQ) ? 0 : 1;
      const verifiedFirst = r.data_status === "verified" ? 0 : 1;
      return { row: r, startsWith, verifiedFirst };
    })
    .sort((a, b) => {
      if (a.startsWith !== b.startsWith) return a.startsWith - b.startsWith;
      if (a.verifiedFirst !== b.verifiedFirst) return a.verifiedFirst - b.verifiedFirst;
      return (a.row.plan_name || "").localeCompare(b.row.plan_name || "");
    })
    .slice(0, 15);

  const tier3CanonicalMap = await fetchCanonicalMap(
    supabase,
    ranked.map(({ row }) => row.id),
  );

  const rankedResults = ranked.map(({ row }) => ({
    id: row.id,
    canonicalPlanId: tier3CanonicalMap.get(row.id),
    hiosId: row.hios_id,
    name: row.plan_name,
    type: row.plan_type,
    state: row.state,
    metalLevel: row.metal_level,
    premium: row.premium_individual,
    deductible: (row.raw_data as Record<string, unknown>)?.deductible_individual,
    oopMax: (row.raw_data as Record<string, unknown>)?.oop_max_individual,
    year: row.year,
    hasSbcUrl: !!row.sbc_document_url,
    dataStatus: row.data_status,
    confidence: 0.5,
    matchedSignals: ["planNameSubstring"],
    insurerName: insurerNameMap.get(row.insurer_id || "") || "",
  }));

  return NextResponse.json({ plans: rankedResults });
}

/**
 * Look up canonical_plan_id for each plan_catalog row in `planCatalogIds`.
 * Returns a Map keyed by plan_catalog.id with the corresponding
 * canonical_plans.id when the row has been mapped (via mig 040 era migration).
 *
 * Plans without a canonical mapping (rare; legacy rows) won't appear in the map
 * and their `canonicalPlanId` will be undefined in the search response — the
 * /compare flow filters those out client-side since they can't be resolved.
 */
async function fetchCanonicalMap(
  supabase: ReturnType<typeof createServerClient>,
  planCatalogIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (planCatalogIds.length === 0) return out;
  const { data: rows } = await supabase
    .from("plan_catalog_canonical_map")
    .select("plan_catalog_id, canonical_plan_id")
    .in("plan_catalog_id", planCatalogIds);
  if (!rows) return out;
  for (const r of rows) {
    if (r.plan_catalog_id && r.canonical_plan_id) {
      out.set(r.plan_catalog_id as string, r.canonical_plan_id as string);
    }
  }
  return out;
}

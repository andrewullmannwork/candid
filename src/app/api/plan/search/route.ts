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
    const results = matches.map((m) => ({
      id: m.planId,
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
    .slice(0, 15)
    .map(({ row }) => ({
      id: row.id,
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

  return NextResponse.json({ plans: ranked });
}

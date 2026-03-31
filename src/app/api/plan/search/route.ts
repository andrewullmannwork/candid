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

  const supabase = createServerClient();

  // Use the matching engine for fuzzy multi-signal search
  const matches = await matchPlan(supabase, {
    planName: query.trim(),
    insurerName: insurer || undefined,
    state: state || undefined,
    planType: planType || undefined,
    metalLevel: metalLevel || undefined,
    planSource: planSource || undefined,
  }, {
    limit: 15,
    minConfidence: 0.15, // Lower threshold for autocomplete — show more results
  });

  // Format response
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

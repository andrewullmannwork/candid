import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST /api/compare/premium-observation — record a user-scoped premium observation
 * for the Compare premium flywheel (Compare v2, PR4).
 *
 * Pattern 1 #14 / Rule #5: USER-SCOPED WRITE ONLY. Every confirmed/entered premium
 * in Compare (the member's own plan OR a searched canonical) records one row tagged
 * to the plan. The ≥N k-anon aggregation read-back (→ the "Community" premium
 * suggestion tier) is a deliberate FOLLOW-UP — N is the COMPARE_FLYWHEEL_MIN_MEMBERS
 * setting in /admin/settings (default 5). No canonical write here; no cross-user
 * read. Best-effort: a flywheel write must NEVER block the Compare UI, so failures
 * return 200 { ok:false } and the client ignores the result.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let internalUserId: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    internalUserId = user.id as string;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const premium = Number(body.premiumMonthly);
  if (!Number.isFinite(premium) || premium < 0 || premium > 1_000_000) {
    return NextResponse.json(
      { error: "premiumMonthly must be a number between 0 and 1,000,000" },
      { status: 400 },
    );
  }

  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

  const supabase = createServerClient();
  const { error } = await supabase.from("compare_premium_observations").insert({
    user_id: internalUserId,
    canonical_plan_id: str(body.canonicalPlanId, 64),
    insurance_plan_id: str(body.insurancePlanId, 64),
    plan_label: str(body.planLabel, 200),
    metal_level: str(body.metalLevel, 40),
    state: str(body.state, 8),
    premium_monthly: Math.round(premium),
    incl_employer: body.inclEmployer === true,
    source: "compare_user_entry",
  });

  if (error) {
    // Non-fatal — a flywheel write must never break the comparison UI.
    console.warn("[premium-observation] insert failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  return NextResponse.json({ ok: true });
}

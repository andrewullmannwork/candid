/**
 * GET /api/plan/accumulators?planId=<uuid>&year=<YYYY>
 *
 * Candid's own cross-bill deductible/OOP running tally for one (plan, year), beside the
 * insurer's reported accumulator, with material like-for-like divergences flagged (§9).
 * Lazy-loaded by the /plan panel + the dashboard mini so the heavy compute stays off the
 * critical-path /api/plan/analyze.
 *
 * Auth: Firebase bearer token → users.id. Gated by `accumulator_ledger_v1` (OFF → the
 * ledger is omitted → the UI hides the panel). All data access is userScoped (B9).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { loadAccumulatorLedger } from "@/lib/claims/accumulator-loader";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // OFF → omit the ledger; the panel stays hidden (byte-identical to today).
  if (!(await isFeatureEnabled("accumulator_ledger_v1"))) {
    return NextResponse.json({ enabled: false });
  }

  // planId optional — the loader self-resolves the user's active plan when omitted (the
  // /plan panel has no insurancePlanId in the generic plan-type view); year likewise
  // falls back to the plan's plan_year inside the loader.
  const planId = req.nextUrl.searchParams.get("planId");
  const yearRaw = req.nextUrl.searchParams.get("year");
  const year = yearRaw ? parseInt(yearRaw, 10) : null;
  if (year != null && !Number.isFinite(year)) {
    return NextResponse.json({ error: "invalid year" }, { status: 400 });
  }

  const ledger = await loadAccumulatorLedger(supabase, user.id as string, planId, year);
  return NextResponse.json({ enabled: true, ledger });
}

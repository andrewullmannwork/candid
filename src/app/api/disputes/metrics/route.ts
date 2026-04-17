/**
 * GET /api/disputes/metrics — User + aggregate dispute metrics
 *
 * Returns personal stats and insurer-level aggregates (k-anonymity enforced).
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getUserDisputeMetrics, getAggregateMetrics } from "@/lib/disputes/metrics";

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

  const [userMetrics, aggregateMetrics] = await Promise.all([
    getUserDisputeMetrics(supabase, user.id),
    getAggregateMetrics(supabase),
  ]);

  return NextResponse.json({
    user: userMetrics,
    aggregate: aggregateMetrics,
  });
}

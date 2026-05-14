/**
 * GET /api/admin/code-identity/counts
 *
 * S74.5c §3.11 — cross-tab promotion-state counts for the admin
 * code-identity-review surface. Without this, the admin UI only knows the
 * loaded tab's row count; the other tabs render with no count badge so the
 * admin can't see "5 proposed, 12 corroborated, 30 admin-verified" at a
 * glance. Three single-row Supabase head-counts; cheap to run on every
 * promotion landing.
 *
 * Auth: requires admin (Firebase token + users.is_admin = true).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function verifyAdmin(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    return Boolean(data?.is_admin);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const states: Array<"proposed" | "corroborated" | "admin_verified"> = [
    "proposed",
    "corroborated",
    "admin_verified",
  ];

  const counts: Record<string, number> = {};
  await Promise.all(
    states.map(async (state) => {
      const { count } = await supabase
        .from("billing_code_identity")
        .select("id", { count: "exact", head: true })
        .eq("promotion_state", state);
      counts[state] = count ?? 0;
    }),
  );

  return NextResponse.json({ counts });
}

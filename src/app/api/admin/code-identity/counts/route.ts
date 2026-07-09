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
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

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

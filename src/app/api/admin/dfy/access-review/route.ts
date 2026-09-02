/**
 * /api/admin/dfy/access-review — the D8 WEEKLY access review (S330). ADMIN only.
 *   GET  → { operators: [{ userId, email, displayName, isAdmin }], lastReview, stale }
 *   POST → records that the admin reviewed the operator list now (audit-logged;
 *          written to the flag config so the operator banner reads ONE fact)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import { accessReviewAgeDays, accessReviewStale, readDfyState, writeDfyConfigKey } from "@/lib/dfy/config";

async function operators(supabase: ReturnType<typeof import("@/lib/supabase/server").createServerClient>) {
  const { data } = await supabase.from("users").select("id, email, display_name, is_admin, is_operator").eq("is_operator", true).order("email");
  return ((data ?? []) as Array<{ id: string; email: string; display_name: string | null; is_admin: boolean }>).map((u) => ({
    userId: u.id, email: u.email, displayName: u.display_name, isAdmin: u.is_admin === true,
  }));
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const state = await readDfyState(auth.supabase);
  return NextResponse.json({
    operators: await operators(auth.supabase),
    lastReview: state.config.accessReview,
    ageDays: accessReviewAgeDays(state.config),
    stale: accessReviewStale(state.config),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase, adminUserId, adminEmail } = auth;
  const ops = await operators(supabase);
  const at = new Date().toISOString();
  await writeDfyConfigKey(supabase, "access_review", { at, by: adminEmail });
  await logAdminAction({ adminUserId, adminEmail, action: "dfy_access_review", targetTable: "users", details: `reviewed ${ops.length} operator account(s): ${ops.map((o) => o.email).join(", ") || "none"}` });
  return NextResponse.json({ ok: true, lastReview: { at, by: adminEmail }, operators: ops });
}

/**
 * POST /api/admin/users/[userId]/operator — grant or revoke the DFY operator
 * role (S330, D8). ADMIN only, audit-logged. Body: { isOperator: boolean }.
 * The role admits a user to the /admin/dfy section only; it never touches is_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";

export async function POST(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase, adminUserId, adminEmail } = auth;
  const { userId } = await params;
  let body: { isOperator?: unknown };
  try { body = (await req.json()) as { isOperator?: unknown }; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.isOperator !== "boolean") return NextResponse.json({ error: "isOperator must be boolean" }, { status: 400 });
  const { data, error } = await supabase.from("users").update({ is_operator: body.isOperator }).eq("id", userId).select("id, email, is_operator").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "User not found" }, { status: 404 });
  await logAdminAction({ adminUserId, adminEmail, action: body.isOperator ? "dfy_operator_grant" : "dfy_operator_revoke", targetUserId: userId, targetTable: "users", details: `${(data as { email?: string }).email ?? userId} is_operator → ${body.isOperator}` });
  return NextResponse.json({ ok: true, user: data });
}

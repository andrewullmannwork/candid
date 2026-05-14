/**
 * POST /api/admin/code-identity/decline-ambiguous
 *
 * S74.6 §H.1 A1 — admin declines BOTH candidates in an ambiguous pair (e.g.,
 * the Haiku description-match produced two plausible but wrong slugs). Marks
 * both `billing_code_identity` rows as `admin_rejected` (mig 098 widened the
 * CHECK to admit this state) and marks the queue row as `rejected`. No
 * promotion fires; the user-visible UI continues to show the top-1 candidate
 * slug already written to claim_line_items.service_slug (per persist.ts §D.4)
 * but it won't claim corroboration.
 *
 * Body:
 *   {
 *     queueId: string,
 *     reason?: string,  // optional admin note (free text)
 *   }
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { logAdminAction } from "@/lib/admin/audit-log";

async function verifyAdmin(req: NextRequest): Promise<
  | { authorized: false }
  | { authorized: true; adminUserId: string; adminEmail: string }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { authorized: false };

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("id, email, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!data?.is_admin) return { authorized: false };
    return {
      authorized: true,
      adminUserId: data.id as string,
      adminEmail: (data.email as string) ?? "",
    };
  } catch {
    return { authorized: false };
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdmin(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { queueId?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const queueId = typeof body.queueId === "string" ? body.queueId : "";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
  if (!queueId) {
    return NextResponse.json({ error: "queueId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: queueRow } = await supabase
    .from("code_identity_admin_review_queue")
    .select("id, identity_id, status")
    .eq("id", queueId)
    .maybeSingle();
  if (!queueRow) {
    return NextResponse.json({ error: "Queue row not found" }, { status: 404 });
  }
  if (queueRow.status !== "pending") {
    return NextResponse.json(
      { error: `Queue row already ${queueRow.status}` },
      { status: 409 },
    );
  }

  const { data: seedIdentity } = await supabase
    .from("billing_code_identity")
    .select("id, billing_code, billing_code_type, description_signature")
    .eq("id", queueRow.identity_id)
    .maybeSingle();
  if (!seedIdentity) {
    return NextResponse.json(
      { error: "Seed identity row missing" },
      { status: 404 },
    );
  }

  // Reject ALL ambiguous_candidate rows for this composite key.
  const { data: pairRows } = await supabase
    .from("billing_code_identity")
    .select("id")
    .eq("billing_code", seedIdentity.billing_code)
    .eq("billing_code_type", seedIdentity.billing_code_type)
    .eq("description_signature", seedIdentity.description_signature)
    .eq("promotion_state", "ambiguous_candidate");

  let rejectedCount = 0;
  if (pairRows && pairRows.length > 0) {
    const { error: rejectErr, data: rejectedRows } = await supabase
      .from("billing_code_identity")
      .update({
        promotion_state: "admin_rejected",
        last_promotion_event_at: new Date().toISOString(),
      })
      .in(
        "id",
        pairRows.map((r) => r.id),
      )
      .select("id");
    if (rejectErr) {
      return NextResponse.json({ error: rejectErr.message }, { status: 500 });
    }
    rejectedCount = rejectedRows?.length ?? 0;
  }

  await supabase
    .from("code_identity_admin_review_queue")
    .update({
      status: "rejected",
      admin_notes: reason || null,
      resolved_by_admin_id: auth.adminUserId,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "code_identity_ambiguous_declined",
    targetTable: "code_identity_admin_review_queue",
    details: `Declined queue ${queueId} (${seedIdentity.billing_code}/${seedIdentity.billing_code_type}): rejected ${rejectedCount} ambiguous_candidate rows${reason ? `; reason="${reason}"` : ""}`,
  });

  return NextResponse.json({ ok: true, queueId, rejectedCount });
}

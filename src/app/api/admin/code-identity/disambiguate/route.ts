/**
 * POST /api/admin/code-identity/disambiguate
 *
 * S74.6 §H.1 A1 — resolve a pending `code_identity_admin_review_queue` row by
 * picking a winning slug. The pipeline:
 *
 *   1. Locate the two `billing_code_identity` rows in `ambiguous_candidate`
 *      state for this `(billing_code, billing_code_type, description_signature)`.
 *   2. Promote the row whose `service_slug` matches `chosenSlug` to
 *      `admin_verified` via the standard `promote_with_slug` RPC. Backfill
 *      peer claim_line_items.
 *   3. Mark the sibling row(s) as `admin_rejected` so they don't continue
 *      surfacing under the Ambiguous tab.
 *   4. Mark the queue row as `resolved` with the chosen slug + admin_id +
 *      timestamp.
 *
 * Body:
 *   {
 *     queueId: string,
 *     chosenSlug: string,
 *   }
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import { backfillCorroboratedMapping } from "@/lib/parser/code-identity-promotion";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { queueId?: unknown; chosenSlug?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const queueId = typeof body.queueId === "string" ? body.queueId : "";
  const chosenSlug =
    typeof body.chosenSlug === "string" ? body.chosenSlug.trim() : "";
  if (!queueId || !chosenSlug) {
    return NextResponse.json(
      { error: "queueId and chosenSlug required" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  // Load the queue row + the seed identity it points at.
  const { data: queueRow, error: queueErr } = await supabase
    .from("code_identity_admin_review_queue")
    .select("id, identity_id, status, candidate_slugs")
    .eq("id", queueId)
    .maybeSingle();
  if (queueErr || !queueRow) {
    return NextResponse.json({ error: "Queue row not found" }, { status: 404 });
  }
  if (queueRow.status !== "pending") {
    return NextResponse.json(
      { error: `Queue row already ${queueRow.status}` },
      { status: 409 },
    );
  }

  // Find the seed identity to learn (code, code_type, signature) — used to
  // locate sibling ambiguous_candidate rows.
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

  // Locate all ambiguous_candidate rows for this composite key. Expect 2;
  // tolerate 1 (sibling already pruned) or more (pathological).
  const { data: pairRows, error: pairErr } = await supabase
    .from("billing_code_identity")
    .select("id, service_slug, promotion_state")
    .eq("billing_code", seedIdentity.billing_code)
    .eq("billing_code_type", seedIdentity.billing_code_type)
    .eq("description_signature", seedIdentity.description_signature)
    .eq("promotion_state", "ambiguous_candidate");
  if (pairErr) {
    return NextResponse.json({ error: pairErr.message }, { status: 500 });
  }

  const winner = (pairRows ?? []).find((r) => r.service_slug === chosenSlug);
  if (!winner) {
    return NextResponse.json(
      {
        error: `No ambiguous_candidate row with slug='${chosenSlug}' for this code/signature`,
      },
      { status: 400 },
    );
  }
  const siblings = (pairRows ?? []).filter((r) => r.id !== winner.id);

  // Validate the slug against service_catalog (defense in depth — already
  // written on the candidate row, but a stale candidate could reference a
  // merged slug).
  const { data: slugRow } = await supabase
    .from("service_catalog")
    .select("slug")
    .eq("slug", chosenSlug)
    .maybeSingle();
  if (!slugRow) {
    return NextResponse.json(
      { error: `Unknown service slug: ${chosenSlug}` },
      { status: 400 },
    );
  }

  // Promote the winner via the standard RPC. promote_with_slug writes the
  // slug atomically under the advisory lock — but the winner already has
  // its slug; pass null so the RPC just promotes.
  const { error: rpcErr } = await supabase.rpc("promote_with_slug", {
    p_identity_id: winner.id,
    p_new_state: "admin_verified",
    p_set_slug: null,
    p_fire_source: "admin-disambiguate",
    p_actor_user_id: auth.adminUserId,
  });
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }

  // Reject siblings — flip their promotion_state to 'admin_rejected'. We use
  // a generic UPDATE rather than the RPC because we're moving to a terminal
  // (non-promoted) state and don't need event-firing semantics.
  let rejectedSiblings = 0;
  if (siblings.length > 0) {
    const { error: rejectErr, data: rejectedRows } = await supabase
      .from("billing_code_identity")
      .update({
        promotion_state: "admin_rejected",
        last_promotion_event_at: new Date().toISOString(),
      })
      .in(
        "id",
        siblings.map((s) => s.id),
      )
      .select("id");
    if (rejectErr) {
      console.warn(
        "[disambiguate] sibling reject UPDATE failed (non-fatal)",
        rejectErr,
      );
    }
    rejectedSiblings = rejectedRows?.length ?? 0;
  }

  // Backfill peer claim_line_items for the winning slug.
  let backfillUpdated = 0;
  try {
    const backfillResult = await backfillCorroboratedMapping(
      winner.id,
      chosenSlug,
    );
    backfillUpdated = backfillResult.updatedRowCount;
  } catch (err) {
    console.warn(
      "[disambiguate] backfill failed (non-fatal)",
      err,
    );
  }

  // Mark queue row resolved.
  await supabase
    .from("code_identity_admin_review_queue")
    .update({
      status: "resolved",
      resolved_slug: chosenSlug,
      resolved_by_admin_id: auth.adminUserId,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "code_identity_disambiguated",
    targetTable: "code_identity_admin_review_queue",
    details: `Resolved queue ${queueId}: chose ${chosenSlug} for ${seedIdentity.billing_code}/${seedIdentity.billing_code_type}, promoted ${winner.id} to admin_verified, rejected ${rejectedSiblings} siblings, backfilled ${backfillUpdated} peer line items`,
  });

  return NextResponse.json({
    ok: true,
    queueId,
    winnerIdentityId: winner.id,
    chosenSlug,
    rejectedSiblings,
    backfillUpdatedRowCount: backfillUpdated,
  });
}

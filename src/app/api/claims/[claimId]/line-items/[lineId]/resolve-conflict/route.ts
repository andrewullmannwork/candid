/**
 * POST /api/claims/[claimId]/line-items/[lineId]/resolve-conflict
 *
 * S74.5 D6 G4 LOCK — community-vs-user conflict resolution endpoint.
 *
 * Called by CommunityConflictModal in ClaimDetail when a Pattern 1 #3
 * promotion landed a slug that differs from the user's prior correction.
 * The backfill already swapped service_slug to the community value AND
 * snapshotted the user's prior slug into metadata.user_correction_pre_backfill_slug.
 *
 * Body: { action: "revert" | "accept" }
 *
 *   - "revert"  → restore service_slug to the snapshotted prior slug + set
 *                 user_correction_locked_at so future community shifts
 *                 won't auto-override again (sticky per-account).
 *   - "accept"  → keep service_slug as the community value; clear the
 *                 snapshot metadata so the modal stops surfacing.
 *
 * Auth: Firebase bearer token; verifies user owns the claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { userScoped, selectOwnedChildren, updateOwnedChildren } from "@/lib/security/user-scoped";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; lineId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const flywheelEnabled = await isFeatureEnabled(
    "s74_5_categorization_flywheel_v1",
  );
  if (!flywheelEnabled) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
  }

  const { claimId, lineId } = await params;

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "revert" && action !== "accept") {
    return NextResponse.json(
      { error: "action must be 'revert' or 'accept'" },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  // Resolve user_id from Firebase UID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Load line item + verify ownership. B9 B1.2 — replace the `claims!inner`
  // ownership join + JS 403 with the layer: selectOwnedChildren proves the
  // parent claim is owned by construction (foreign/unknown claim → []), then we
  // resolve the requested line by id (parent [claimId] in scope). A non-owned
  // claim now yields 404 (anti-enum standard) rather than the prior 403.
  const ownedLines = await selectOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    [claimId],
    "id, claim_id, service_slug, metadata, user_correction_locked_at",
  );
  const lineItem = ownedLines.find((r) => r.id === lineId) ?? null;
  if (!lineItem) {
    return NextResponse.json({ error: "Line item not found" }, { status: 404 });
  }

  const meta = (lineItem.metadata as Record<string, unknown> | null) ?? {};
  const priorSlug =
    (meta.user_correction_pre_backfill_slug as string | undefined) ?? null;

  // Clear the snapshot keys regardless of action — both paths "consume" the
  // pending conflict.
  const nextMeta: Record<string, unknown> = { ...meta };
  delete nextMeta.user_correction_pre_backfill_slug;
  delete nextMeta.user_correction_pre_backfill_at;

  const updates: Record<string, unknown> = { metadata: nextMeta };

  if (action === "revert") {
    if (!priorSlug) {
      return NextResponse.json(
        {
          error:
            "No prior user slug snapshot available to revert to; the community value stays.",
        },
        { status: 409 },
      );
    }
    updates.service_slug = priorSlug;
    updates.user_correction_locked_at = new Date().toISOString();
    // Re-mark audit stale so D7 re-audit picks up the slug change
    // (handled at claim level below).
  }

  // B9 B1.2 — child WRITE via the parent-scoped primitive (claimId proven owned
  // above). updated=0 here ⇒ write failure (the line is known to exist).
  const { updated } = await updateOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    claimId,
    [{ id: lineId, values: updates }],
  );
  if (updated === 0) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  // Mark claim audit_status='stale' so D7 re-audit fires on next view fetch
  // (only relevant when slug actually changed, but cheap regardless).
  if (action === "revert") {
    const { data: claimRow } = await userScoped(supabase, user.id)
      .table("claims")
      .select("metadata")
      .eq("id", claimId)
      .maybeSingle();
    const claimMeta = (claimRow?.metadata as Record<string, unknown> | null) ?? {};
    await userScoped(supabase, user.id)
      .table("claims")
      .update({
        metadata: {
          ...claimMeta,
          audit_status: "stale",
          audit_stale_at: new Date().toISOString(),
        },
      })
      .eq("id", claimId);
  }

  return NextResponse.json({ ok: true, action, restoredSlug: action === "revert" ? priorSlug : null });
}

/**
 * POST /api/admin/code-identity/promote
 *
 * S74.5 D8 (Session 83) — admin attestation endpoint for the categorization
 * flywheel. Calls apply_mapping_promotion(..., 'admin_verified', 'admin-ui', actor)
 * which atomically advances promotion_state and writes a mapping_promotion_events
 * row (Pattern 1 #14 single-discipline storage).
 *
 * Per Pattern 1 #16 cold-start lever — at MVP scale the ≥3 EMAIL+PHONE-verified
 * threshold may be structurally unreachable for niche codes; admin attestation
 * bypasses it so the catalog can grow before the flywheel fires.
 *
 * Body:
 *   {
 *     identityId: string,
 *     slug?: string,    // optional: set service_slug before promoting (when the
 *                       // proposed row was auto-created with slug=null by the
 *                       // parser path and admin is choosing a slug)
 *   }
 *
 * Auth: requires admin (Firebase token + users.is_admin = true).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import { backfillCorroboratedMapping } from "@/lib/parser/code-identity-promotion";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { identityId?: unknown; slug?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const identityId = typeof body.identityId === "string" ? body.identityId : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!identityId) {
    return NextResponse.json({ error: "identityId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Load the target row to check current state + slug
  const { data: identity, error: readErr } = await supabase
    .from("billing_code_identity")
    .select(
      "id, billing_code, billing_code_type, description_signature, service_slug, promotion_state",
    )
    .eq("id", identityId)
    .maybeSingle();
  if (readErr || !identity) {
    return NextResponse.json(
      { error: "Identity row not found" },
      { status: 404 },
    );
  }

  // If admin provided a slug, validate against service_catalog. The actual
  // slug-write happens atomically inside the promote_with_slug RPC below
  // (under the advisory lock) per S74.5c C-6 — eliminates the race window
  // where a concurrent corroborator-upsert could land between a separate
  // UPDATE and apply_mapping_promotion call.
  if (slug) {
    const { data: slugRow } = await supabase
      .from("service_catalog")
      .select("slug")
      .eq("slug", slug)
      .maybeSingle();
    if (!slugRow) {
      return NextResponse.json(
        { error: `Unknown service slug: ${slug}` },
        { status: 400 },
      );
    }
  } else if (!identity.service_slug) {
    return NextResponse.json(
      { error: "Cannot promote a row with no service_slug; provide slug" },
      { status: 400 },
    );
  }

  // Fire the atomic RPC. promote_with_slug acquires the advisory lock, writes
  // the slug if provided, then delegates to apply_mapping_promotion under the
  // same lock — single continuous critical section.
  const slugToWrite = slug && identity.service_slug !== slug ? slug : null;
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "promote_with_slug",
    {
      p_identity_id: identityId,
      p_new_state: "admin_verified",
      p_set_slug: slugToWrite,
      p_fire_source: "admin-ui",
      p_actor_user_id: auth.adminUserId,
    },
  );

  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }

  // §1.2 — propagate the admin-attested slug across peer claim_line_items.
  // Without this, admin attestation is half-functional: the identity row flips
  // to admin_verified but other users' claim_line_items keep their stale slug.
  // backfillCorroboratedMapping respects user_correction_locked_at (G4 LOCK)
  // and snapshots prior slugs into metadata for G4 conflict-modal handling.
  const finalSlug = slug || (identity.service_slug as string | null);
  let backfillUpdated = 0;
  let backfillConflicts: string[] = [];
  if (finalSlug) {
    try {
      const backfillResult = await backfillCorroboratedMapping(
        identityId,
        finalSlug,
      );
      backfillUpdated = backfillResult.updatedRowCount;
      backfillConflicts = backfillResult.conflictingUserIds;
    } catch (err) {
      // Non-fatal: the promotion succeeded; backfill failure is a follow-up
      // operational concern (admin can re-trigger via a future admin tool or
      // wait for affected users' next /claim view to surface stale rows).
      console.warn(
        "[admin/code-identity/promote] backfill failed (non-fatal)",
        err,
      );
    }
  }

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "code_identity_admin_attested",
    targetTable: "billing_code_identity",
    details: `Promoted ${identityId} to admin_verified — code=${identity.billing_code}, type=${identity.billing_code_type}, slug=${finalSlug ?? "<unset>"}; backfilled ${backfillUpdated} peer line items (${backfillConflicts.length} users with locked corrections preserved)`,
  });

  return NextResponse.json({
    ok: true,
    eventId: rpcData,
    identityId,
    promotedSlug: finalSlug,
    backfillUpdatedRowCount: backfillUpdated,
    backfillConflictingUserCount: backfillConflicts.length,
  });
}

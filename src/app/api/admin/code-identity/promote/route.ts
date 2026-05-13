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

  // If admin provided a slug, validate against service_catalog and update the
  // row BEFORE the promotion RPC fires. The RPC reads the row inside the
  // advisory lock; the slug must be set when the event fires so the
  // mapping_promotion_events row records the correct promoted_slug.
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
    if (identity.service_slug !== slug) {
      const { error: updateErr } = await supabase
        .from("billing_code_identity")
        .update({ service_slug: slug })
        .eq("id", identityId);
      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }
    }
  } else if (!identity.service_slug) {
    return NextResponse.json(
      { error: "Cannot promote a row with no service_slug; provide slug" },
      { status: 400 },
    );
  }

  // Fire the RPC. Uses an advisory lock per composite key inside the function
  // so concurrent admin/community promotions can't race.
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "apply_mapping_promotion",
    {
      p_identity_id: identityId,
      p_new_state: "admin_verified",
      p_fire_source: "admin-ui",
      p_actor_user_id: auth.adminUserId,
    },
  );

  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "code_identity_admin_attested",
    targetTable: "billing_code_identity",
    details: `Promoted ${identityId} to admin_verified — code=${identity.billing_code}, type=${identity.billing_code_type}, slug=${slug || identity.service_slug}`,
  });

  return NextResponse.json({
    ok: true,
    eventId: rpcData,
    identityId,
    promotedSlug: slug || identity.service_slug,
  });
}

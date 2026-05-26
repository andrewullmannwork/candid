/**
 * Ing-I (S133) — POST /api/admin/review-queue/merge
 *
 * Atomic MERGE: admin picks a canonical_slug from the candidate panel for a
 * pending service_catalog_admin_review_queue row. This route invokes the
 * Postgres RPC merge_proposed_slug_into_canonical (mig 127) which (in one
 * transaction with advisory lock):
 *   1. Verifies queue row exists + status='pending'
 *   2. Verifies canonical_slug exists + canonical_for_concept=TRUE
 *   3. Verifies no proposed_slug collision
 *   4. INSERTs alias row in service_catalog (proposal_state='alias',
 *      canonical_for_concept=FALSE, shared concept_id)
 *   5. UPDATEs queue row to status='merged' + resolved_service_slug + reviewed_*
 *
 * Body: { queueId: string, canonicalSlug: string }
 * Response: { ok: true, alias_slug, canonical_slug, concept_id }
 *        OR { ok: false, error, detail? }
 *
 * Admin-auth gated (same inline pattern as /api/admin/canonical-match-decisions).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { mergeProposedSlugIntoCanonical } from "@/lib/parser/review-queue-merge-rpc";

async function requireAdmin(req: NextRequest): Promise<
  | {
      ok: true;
      supabase: ReturnType<typeof createServerClient>;
      adminUserId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Admin access required" },
          { status: 403 },
        ),
      };
    }
    return { ok: true, supabase, adminUserId: user.id };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid token" }, { status: 401 }),
    };
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { queueId?: string; canonicalSlug?: string };
  try {
    body = (await req.json()) as { queueId?: string; canonicalSlug?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.queueId || typeof body.queueId !== "string") {
    return NextResponse.json({ error: "queueId required" }, { status: 400 });
  }
  if (!body.canonicalSlug || typeof body.canonicalSlug !== "string") {
    return NextResponse.json(
      { error: "canonicalSlug required" },
      { status: 400 },
    );
  }

  const result = await mergeProposedSlugIntoCanonical(auth.supabase, {
    queueId: body.queueId,
    canonicalSlug: body.canonicalSlug,
    adminUserId: auth.adminUserId,
  });

  if (result.ok) {
    return NextResponse.json(result, { status: 200 });
  }

  // Map RPC error codes → HTTP status
  const statusByError: Record<string, number> = {
    queue_row_not_found: 404,
    queue_row_not_pending: 409, // concurrent merge race
    canonical_not_found: 400,
    proposed_slug_collides: 409,
    merge_exception: 500,
    rpc_call_failed: 500,
  };
  const status = statusByError[result.error] ?? 500;
  return NextResponse.json(result, { status });
}

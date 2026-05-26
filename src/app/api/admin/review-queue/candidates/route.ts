/**
 * Ing-I (S133) — POST /api/admin/review-queue/candidates
 *
 * Returns candidate canonical slugs for a pending review-queue row.
 * Read-through cache: if `candidate_suggestions` is null on the row, computes
 * via 2-pass resolver + persists the result. Subsequent reads return cached.
 *
 * Body: { queueId: string }
 * Response: { candidates: CandidateSuggestion[], cached: boolean }
 *
 * Admin-auth gated (same inline pattern as /api/admin/canonical-match-decisions).
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  loadResolverConfig,
  resolveSlugCandidates,
} from "@/lib/parser/review-queue-candidates";

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

  let body: { queueId?: string };
  try {
    body = (await req.json()) as { queueId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const queueId = body.queueId;
  if (!queueId || typeof queueId !== "string") {
    return NextResponse.json({ error: "queueId required" }, { status: 400 });
  }

  // Load queue row
  const { data: queueRow, error: queueErr } = await auth.supabase
    .from("service_catalog_admin_review_queue")
    .select(
      "id, status, proposed_service_slug, proposed_service_label, candidate_suggestions, candidate_suggestions_computed_at",
    )
    .eq("id", queueId)
    .maybeSingle();

  if (queueErr) {
    return NextResponse.json(
      { error: `Queue row lookup failed: ${queueErr.message}` },
      { status: 500 },
    );
  }
  if (!queueRow) {
    return NextResponse.json({ error: "Queue row not found" }, { status: 404 });
  }

  // Cache hit
  if (
    queueRow.candidate_suggestions &&
    Array.isArray(queueRow.candidate_suggestions) &&
    queueRow.candidate_suggestions.length > 0
  ) {
    return NextResponse.json({
      candidates: queueRow.candidate_suggestions,
      cached: true,
      cached_at: queueRow.candidate_suggestions_computed_at,
    });
  }

  // Cache miss: resolve + persist
  const config = await loadResolverConfig(auth.supabase);
  const candidates = await resolveSlugCandidates({
    supabase: auth.supabase,
    proposedSlug: queueRow.proposed_service_slug,
    proposedLabel: queueRow.proposed_service_label,
    config,
    adminUserId: auth.adminUserId,
  });

  // Persist cache (non-fatal — admin still gets candidates even if cache write fails)
  const computedAt = new Date().toISOString();
  const { error: cacheErr } = await auth.supabase
    .from("service_catalog_admin_review_queue")
    .update({
      candidate_suggestions: candidates,
      candidate_suggestions_computed_at: computedAt,
    })
    .eq("id", queueId);

  if (cacheErr) {
    console.warn(
      `[/api/admin/review-queue/candidates] cache write failed for queueId=${queueId}: ${cacheErr.message}`,
    );
  }

  return NextResponse.json({
    candidates,
    cached: false,
    cached_at: computedAt,
  });
}

/**
 * GET /api/admin/insurer-appeals
 *
 * Phase 6.3 admin review queue. Returns:
 *   - pending: doc-extraction + user-correction proposals awaiting review
 *   - stale:   insurers with NULL addresses OR last_confirmed_at > 365 days
 *              OR doc_extraction source with verification_count < 3
 *   - coverage: insurers that appear on user plans but have NULL appeals data
 *
 * Admin auth enforced by the same shape as /api/admin/dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

const STALE_ADMIN_THRESHOLD_DAYS = 365;
const DOC_EXT_MIN_VERIFICATIONS = 3;

async function requireAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin, email")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!user?.is_admin) return null;
    return { user, supabase };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const ctx = await requireAdmin(req);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { supabase } = ctx;

  const staleCutoff = new Date(
    Date.now() - STALE_ADMIN_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Pending proposed changes joined with insurer name.
  const { data: pending } = await supabase
    .from("insurer_appeals_proposed_changes")
    .select("id, insurer_id, proposed_by, proposed_by_user_id, source_document_id, source_excerpt, current_values, proposed_values, confidence, status, created_at, insurer_catalog!inner(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(50);

  // Stale: admin_verified but super old OR doc_extraction below threshold.
  const { data: stale } = await supabase
    .from("insurer_catalog")
    .select("id, name, appeals_source, appeals_verification_count, appeals_last_confirmed_at")
    .or(`appeals_last_confirmed_at.lt.${staleCutoff},and(appeals_source.eq.doc_extraction,appeals_verification_count.lt.${DOC_EXT_MIN_VERIFICATIONS})`)
    .not("appeals_address_line_1", "is", null)
    .limit(50);

  // Coverage gaps: insurers that are referenced by any insurance_plan but
  // have no appeals address seeded.
  const { data: gaps } = await supabase
    .from("insurer_catalog")
    .select("id, name, appeals_source")
    .is("appeals_address_line_1", null)
    .limit(50);

  // Recently updated: insurers that HAVE an appeals address, newest first — the
  // "revise an already-set address" surface (dispute-letters v2 S3).
  const { data: recent } = await supabase
    .from("insurer_catalog")
    .select("id, name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_last_confirmed_at")
    .not("appeals_address_line_1", "is", null)
    .order("appeals_last_confirmed_at", { ascending: false, nullsFirst: false })
    .limit(25);

  return NextResponse.json({
    pending: (pending ?? []).map((p) => ({
      id: p.id,
      insurerId: p.insurer_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insurerName: (p.insurer_catalog as any)?.name ?? "Unknown",
      proposedBy: p.proposed_by,
      sourceExcerpt: p.source_excerpt,
      current: p.current_values,
      proposed: p.proposed_values,
      confidence: p.confidence,
      createdAt: p.created_at,
    })),
    stale: stale ?? [],
    coverageGaps: gaps ?? [],
    recentlyUpdated: (recent ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      source: r.appeals_source,
      lastConfirmedAt: r.appeals_last_confirmed_at,
      values: {
        address_line_1: r.appeals_address_line_1,
        address_line_2: r.appeals_address_line_2,
        city: r.appeals_city,
        state: r.appeals_state,
        postal_code: r.appeals_postal_code,
        phone: r.appeals_phone,
      },
    })),
  });
}

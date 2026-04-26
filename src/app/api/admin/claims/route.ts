/**
 * GET /api/admin/claims
 *
 * Aggregator for the /admin/claims tab. Returns:
 *   - insurerAppeals.pending   — proposed appeals-address changes awaiting review (Pattern 1)
 *   - insurerAppeals.stale     — admin_verified > 365d OR doc_extraction < 3 verifications
 *   - insurerAppeals.gaps      — insurers with NULL appeals data
 *   - disputesMissingPlan      — pending disputes where the claim's plan_year has no matching user plan
 *
 * Admin auth enforced same as /api/admin/dashboard.
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

  const [
    { data: pending },
    { data: stale },
    { data: gaps },
  ] = await Promise.all([
    supabase
      .from("insurer_appeals_proposed_changes")
      .select("id, insurer_id, proposed_by, proposed_by_user_id, source_document_id, source_excerpt, current_values, proposed_values, confidence, status, created_at, insurer_catalog!inner(name)")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("insurer_catalog")
      .select("id, name, appeals_source, appeals_verification_count, appeals_last_confirmed_at")
      .or(`appeals_last_confirmed_at.lt.${staleCutoff},and(appeals_source.eq.doc_extraction,appeals_verification_count.lt.${DOC_EXT_MIN_VERIFICATIONS})`)
      .not("appeals_address_line_1", "is", null)
      .limit(50),
    supabase
      .from("insurer_catalog")
      .select("id, name, appeals_source")
      .is("appeals_address_line_1", null)
      .limit(50),
  ]);

  // Disputes missing plan year for their claim.
  const disputesMissingPlan = await (async () => {
    try {
      const { data: rows } = await supabase
        .from("dispute_outcomes")
        .select("id, claim_id, dispute_type, status, created_at, user_id, amount_disputed, claims!inner(plan_year, date_of_service, metadata)")
        .in("status", ["dispute_letter_drafted", "filed", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(50);
      if (!rows) return [];
      type Row = {
        id: string;
        claim_id: string;
        dispute_type: string;
        status: string;
        created_at: string;
        user_id: string;
        amount_disputed: number | null;
        claims: { plan_year: number | null; date_of_service: string | null; metadata: Record<string, unknown> } | Array<{ plan_year: number | null; date_of_service: string | null; metadata: Record<string, unknown> }>;
      };
      const results: Array<{
        id: string;
        disputeId: string;
        claimId: string;
        disputeType: string;
        status: string;
        amountDisputed: number | null;
        claimYear: number;
        dateOfService: string | null;
        providerName: string | null;
        createdAt: string;
      }> = [];
      for (const r of rows as Row[]) {
        const claim = Array.isArray(r.claims) ? r.claims[0] : r.claims;
        const claimYear = claim?.plan_year ?? null;
        if (!claimYear) continue;
        const { data: plan } = await supabase
          .from("insurance_plans")
          .select("id")
          .eq("user_id", r.user_id)
          .eq("plan_year", claimYear)
          .limit(1)
          .maybeSingle();
        if (plan) continue;
        const provider = (claim?.metadata as { provider?: { name?: string } } | undefined)?.provider?.name ?? null;
        results.push({
          id: r.id,
          disputeId: r.id,
          claimId: r.claim_id,
          disputeType: r.dispute_type,
          status: r.status,
          amountDisputed: r.amount_disputed,
          claimYear,
          dateOfService: claim?.date_of_service ?? null,
          providerName: provider,
          createdAt: r.created_at,
        });
      }
      return results;
    } catch (err) {
      console.error("[admin/claims] disputesMissingPlan query failed:", err);
      return [];
    }
  })();

  return NextResponse.json({
    insurerAppeals: {
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
      gaps: gaps ?? [],
    },
    disputesMissingPlan,
  });
}

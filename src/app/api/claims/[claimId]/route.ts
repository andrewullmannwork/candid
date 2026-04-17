/**
 * GET /api/claims/[claimId] — Fetch single claim with full line items + coverage status.
 * Auth: Firebase bearer token. Verifies user owns the claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { claimId } = await params;
  const supabase = createServerClient();

  // Resolve user_id
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Fetch claim and verify ownership
  const { data: claim, error: claimError } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .eq("user_id", user.id)
    .single();

  if (claimError || !claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  // Fetch line items
  const { data: lineItems } = await supabase
    .from("claim_line_items")
    .select("*")
    .eq("claim_id", claimId)
    .order("line_number", { ascending: true });

  // Fetch coverage status for each line item's service_slug
  const coverageMap = new Map<string, { covered: boolean | null; copay: number | null; coinsurance: number | null; source: string | null }>();

  if (claim.insurance_plan_id) {
    const { data: coveredServices } = await supabase
      .from("plan_covered_services")
      .select("covered, in_copay, in_coinsurance, source, service_catalog!inner(slug)")
      .eq("insurance_plan_id", claim.insurance_plan_id);

    if (coveredServices) {
      for (const svc of coveredServices) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slug = (svc.service_catalog as any)?.slug as string | undefined;
        if (slug) {
          coverageMap.set(slug, {
            covered: svc.covered,
            copay: svc.in_copay,
            coinsurance: svc.in_coinsurance,
            source: svc.source,
          });
        }
      }
    }
  }

  // Enrich line items with coverage status
  const enrichedLineItems = (lineItems || []).map((item) => {
    const coverage = item.service_slug ? coverageMap.get(item.service_slug) : null;
    return {
      ...item,
      coverageStatus: coverage
        ? coverage.covered === false
          ? "not_covered"
          : "covered"
        : item.service_slug
          ? "unknown"
          : null,
      planCoverage: coverage || null,
    };
  });

  // Fetch linked disputes
  const { data: disputes } = await supabase
    .from("dispute_outcomes")
    .select("id, dispute_type, status, amount_disputed, amount_recovered, filed_date, resolution_date")
    .eq("claim_id", claimId);

  // Fetch related claims in same group
  let relatedClaims: Array<{ id: string; date_of_service: string; status: string; total_billed: number }> = [];
  if (claim.claim_group_id) {
    const { data: grouped } = await supabase
      .from("claims")
      .select("id, date_of_service, status, total_billed")
      .eq("claim_group_id", claim.claim_group_id)
      .neq("id", claimId);
    relatedClaims = grouped || [];
  }

  return NextResponse.json({
    claim,
    lineItems: enrichedLineItems,
    disputes: disputes || [],
    relatedClaims,
  });
}

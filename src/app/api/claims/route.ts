/**
 * GET /api/claims — Fetch user's claims with summary stats.
 * Returns paginated claims with line item counts, totals, and finding counts.
 * Auth: Firebase bearer token.
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

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // Resolve user_id from firebase_uid
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "20", 10), 50);
  const offset = (page - 1) * limit;

  // Fetch claims with pagination
  const { data: claims, error, count } = await supabase
    .from("claims")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // For each claim, get line item summary + top findings + potential savings
  const claimsWithSummary = await Promise.all(
    (claims || []).map(async (claim) => {
      const { data: lineItems } = await supabase
        .from("claim_line_items")
        .select("id, service_slug, billing_code, metadata, billed_amount, patient_owes, insurance_paid, description")
        .eq("claim_id", claim.id);

      const items = lineItems || [];
      let findingCount = 0;
      let potentialSavings = 0;
      let reviewNeededCount = 0;
      let lineItemPatientOwedSum = 0;
      const topFindings: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }> = [];
      const reviewLineItems: Array<{
        id: string;
        description: string | null;
        billing_code: string | null;
        service_slug: string | null;
        billed_amount: number | null;
      }> = [];

      for (const item of items) {
        const findings = (item.metadata as Record<string, unknown>)?.auditFindings;
        if (Array.isArray(findings)) {
          findingCount += findings.length;
          for (const f of findings as Array<Record<string, unknown>>) {
            const overcharge = Number(f.estimatedOvercharge || 0);
            potentialSavings += overcharge;
            topFindings.push({
              title: String(f.title || f.type || "Issue"),
              estimatedOvercharge: overcharge,
              billingCode: item.billing_code,
            });
          }
        }

        // Detect unexplained gap: billed > 0 but paid + owed = 0
        const billed = Number(item.billed_amount || 0);
        const paid = Number(item.insurance_paid || 0);
        const owed = Number(item.patient_owes || 0);
        if (billed > 0 && paid === 0 && owed === 0) {
          reviewNeededCount++;
          reviewLineItems.push({
            id: item.id,
            description: item.description,
            billing_code: item.billing_code,
            service_slug: item.service_slug,
            billed_amount: item.billed_amount,
          });
        }
        lineItemPatientOwedSum += owed;
      }

      // Keep top 3 findings by overcharge size
      topFindings.sort((a, b) => b.estimatedOvercharge - a.estimatedOvercharge);

      return {
        ...claim,
        lineItemCount: items.length,
        findingCount,
        reviewNeededCount,
        reviewLineItems,
        potentialSavings,
        lineItemPatientOwedSum,
        topFindings: topFindings.slice(0, 3),
        providerName: (claim.metadata as Record<string, unknown>)?.provider
          ? ((claim.metadata as Record<string, unknown>).provider as Record<string, unknown>)?.name || "Unknown Provider"
          : "Unknown Provider",
      };
    })
  );

  // Summary stats (computed across all user claims, not just paginated)
  const { data: allClaims } = await supabase
    .from("claims")
    .select("id, status, total_billed, total_patient_responsibility")
    .eq("user_id", user.id);

  // Aggregate potential savings across all claims' line items.
  // "Issues flagged" = classic audit findings + unverified-charge review cases.
  let totalPotentialSavings = 0;
  let totalIssuesFlagged = 0;
  if (allClaims && allClaims.length > 0) {
    const { data: allLineItems } = await supabase
      .from("claim_line_items")
      .select("metadata, claim_id, billed_amount, insurance_paid, patient_owes")
      .in("claim_id", allClaims.map((c) => c.id));

    for (const li of allLineItems || []) {
      const findings = (li.metadata as Record<string, unknown>)?.auditFindings;
      if (Array.isArray(findings)) {
        for (const f of findings as Array<Record<string, unknown>>) {
          totalPotentialSavings += Number(f.estimatedOvercharge || 0);
          totalIssuesFlagged += 1;
        }
      }
      // Also count unexplained-gap lines (billed > 0, paid + owed = 0)
      const billed = Number(li.billed_amount || 0);
      const paid = Number(li.insurance_paid || 0);
      const owed = Number(li.patient_owes || 0);
      if (billed > 0 && paid === 0 && owed === 0) {
        totalIssuesFlagged += 1;
      }
    }
  }

  const stats = {
    totalBills: allClaims?.length || 0,
    flaggedBills: allClaims?.filter((c) => c.status === "flagged").length || 0,
    totalBilled: allClaims?.reduce((sum, c) => sum + (c.total_billed || 0), 0) || 0,
    totalPatientResponsibility: allClaims?.reduce((sum, c) => sum + (c.total_patient_responsibility || 0), 0) || 0,
    totalPotentialSavings,
    totalIssuesFlagged,
  };

  return NextResponse.json({
    claims: claimsWithSummary,
    stats,
    pagination: { page, limit, total: count || 0 },
  });
}

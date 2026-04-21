/**
 * GET /api/disputes/[disputeId] — Fetch single dispute with letter + evidence + linked bill lines.
 * Used by the Linked Disputes expansion on the claim detail page.
 * Auth: Firebase bearer token. Verifies user owns the dispute.
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
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute, error } = await supabase
    .from("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .eq("user_id", user.id)
    .single();

  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // Linked line items — primary + any extras in metadata.claimLineItemIds
  const extraIds = (dispute.metadata?.claimLineItemIds as string[] | undefined) || [];
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];

  let lineItems: unknown[] = [];
  if (allLineItemIds.length > 0) {
    const { data: items } = await supabase
      .from("claim_line_items")
      .select("id, line_number, description, billing_code, billed_amount, insurance_paid, patient_owes")
      .in("id", allLineItemIds);
    lineItems = items || [];
  }

  return NextResponse.json({
    id: dispute.id,
    disputeType: dispute.dispute_type,
    status: dispute.status,
    amountDisputed: dispute.amount_disputed,
    amountRecovered: dispute.amount_recovered,
    filedDate: dispute.filed_date,
    resolutionDate: dispute.resolution_date,
    claimId: dispute.claim_id,
    letterContent: dispute.letter_content,
    evidencePackage: dispute.evidence_package,
    lineItems,
  });
}

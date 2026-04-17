/**
 * GET /api/legal/small-claims — Eligibility check + court info
 *
 * Query params:
 * - state: 2-letter state code (required)
 * - amount: dispute amount in dollars (required)
 * - county: county name (optional, for county-specific data)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { checkSmallClaimsEligibility } from "@/lib/legal/small-claims";

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state");
  const amountStr = req.nextUrl.searchParams.get("amount");
  const county = req.nextUrl.searchParams.get("county") || undefined;

  if (!state || !amountStr) {
    return NextResponse.json({ error: "state and amount required" }, { status: 400 });
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }

  const supabase = createServerClient();

  const result = await checkSmallClaimsEligibility(supabase, {
    state: state.toUpperCase(),
    county,
    disputeAmount: amount,
  });

  return NextResponse.json(result);
}

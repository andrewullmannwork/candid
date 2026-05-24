/**
 * GET /api/billing/usage — User-scoped usage aggregates for the /billing
 * Usage stats card.
 *
 * Returns 4 metrics + milestone multiplier:
 *   - total_recovered  : SUM(dispute_outcomes.amount_recovered) for won/settled
 *   - disputes_drafted : COUNT(dispute_outcomes) lifetime for the user
 *   - bills_audited    : COUNT(documents) where doc_type in ('eob', 'itemized_bill')
 *                          and status='processed'
 *   - plans_parsed     : COUNT(documents) where doc_type in ('plan_document', 'eoc')
 *                          and status='processed'
 *   - multiplier       : total_recovered / (months_subscribed × monthly_equivalent_price).
 *                          Returns 0 for Free users or anyone with 0 recovered.
 *
 * Per Pattern 1 #14 (user-scoped storage authority): no cross-user joins;
 * every aggregate scoped to the caller's user_id. Service role bypasses RLS
 * the same way /api/subscription/me does.
 *
 * Auth: Firebase bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

const MONTHLY_PRICE_USD = 5;
const ANNUAL_PRICE_USD = 48;
const ANNUAL_EQUIVALENT_MONTHLY = ANNUAL_PRICE_USD / 12; // $4/mo
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

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

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userId = user.id;

  // Run aggregates in parallel — each scoped to user_id (Pattern 1 #14).
  // Documents are fetched with metadata so we can filter out admin
  // cold-start seeded uploads (`metadata.seeded_via` set by tools/admin-
  // cold-start-sonnet) — those are system seeding events, not personal
  // user activity, and shouldn't inflate the user's own /billing stats.
  const [
    disputeRows,
    billDocs,
    planDocs,
    stripeRow,
  ] = await Promise.all([
    supabase
      .from("dispute_outcomes")
      .select("status, amount_recovered")
      .eq("user_id", userId),
    supabase
      .from("documents")
      .select("id, metadata")
      .eq("user_id", userId)
      .in("doc_type", ["eob", "itemized_bill"])
      .eq("status", "processed"),
    supabase
      .from("documents")
      .select("id, metadata")
      .eq("user_id", userId)
      .in("doc_type", ["plan_document", "eoc"])
      .eq("status", "processed"),
    supabase
      .from("stripe_customers")
      .select("created_at, subscription_tier, subscription_status, tier_cycle")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  // Surface real query errors as 500 instead of silently degrading to zero
  // counts. Null-data with no error is a legitimate "user has nothing yet"
  // case — that's expected for new users and stays as the zero-state.
  const queryErrors = [
    disputeRows.error,
    billDocs.error,
    planDocs.error,
    stripeRow.error,
  ].filter(Boolean);
  if (queryErrors.length > 0) {
    console.error("[billing/usage] aggregate query failed:", queryErrors);
    return NextResponse.json({ error: "usage_query_failed" }, { status: 500 });
  }

  const disputes = disputeRows.data ?? [];
  const disputesDrafted = disputes.length;

  const WON_STATUSES = new Set([
    "won",
    "won_on_escalation",
    "settled",
    "settled_on_escalation",
  ]);
  const totalRecovered = disputes.reduce((sum, d) => {
    if (!WON_STATUSES.has(d.status)) return sum;
    const amt = Number(d.amount_recovered);
    return Number.isFinite(amt) && amt > 0 ? sum + amt : sum;
  }, 0);

  function isUserDoc(d: { metadata: unknown }): boolean {
    const meta = (d.metadata ?? {}) as Record<string, unknown>;
    return !meta.seeded_via;
  }

  const billsAudited = (billDocs.data ?? []).filter(isUserDoc).length;
  const plansParsed = (planDocs.data ?? []).filter(isUserDoc).length;

  // Multiplier — only computed for Pro users with at least one full month
  // of subscription history and at least $1 recovered. Free users and
  // anyone with 0 recovery get multiplier=0 (UI suppresses the milestone copy).
  const stripe = stripeRow.data;
  const isPro =
    stripe?.subscription_tier === "pro" &&
    (stripe?.subscription_status === "active" ||
      stripe?.subscription_status === "trialing");

  let multiplier = 0;
  if (isPro && totalRecovered > 0 && stripe?.created_at) {
    const monthsSubscribed = Math.max(
      1,
      Math.floor((Date.now() - new Date(stripe.created_at).getTime()) / MS_PER_MONTH),
    );
    const monthlyPrice =
      stripe?.tier_cycle === "annual" ? ANNUAL_EQUIVALENT_MONTHLY : MONTHLY_PRICE_USD;
    const subscriptionCost = monthsSubscribed * monthlyPrice;
    if (subscriptionCost > 0) {
      multiplier = totalRecovered / subscriptionCost;
    }
  }

  return NextResponse.json({
    totalRecovered,
    disputesDrafted,
    billsAudited,
    plansParsed,
    multiplier,
  });
}

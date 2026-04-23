/**
 * GET /api/stripe/invoices — Last 6 invoices for the authenticated user.
 *
 * Monthly billing → 6 invoices is roughly 6 months of history, which is the
 * approved depth for /billing's invoice card.
 *
 * Auth: Firebase bearer token.
 * Returns: { invoices: Array<{ id, number, amountPaid, status, pdfUrl, periodStart, periodEnd, created }> }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

const INVOICE_LIMIT = 6;

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

  const { data: row } = await supabase
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!row?.stripe_customer_id) {
    return NextResponse.json({ invoices: [] });
  }

  const stripe = getStripe();
  const list = await stripe.invoices.list({
    customer: row.stripe_customer_id,
    limit: INVOICE_LIMIT,
  });

  const invoices = list.data.map((inv) => ({
    id: inv.id,
    number: inv.number,
    /** Total charged/owed on this invoice. Display this, not amount_paid —
     *  an open ($5) invoice with $0 paid should still read "$5" to the user. */
    total: inv.total,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    status: inv.status,
    pdfUrl: inv.invoice_pdf,
    hostedUrl: inv.hosted_invoice_url,
    periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
  }));

  return NextResponse.json({ invoices });
}

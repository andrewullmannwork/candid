/**
 * GET /api/admin/users — admin user directory. Returns up to 50 users (newest
 * first), each hydrated with profile, Stripe, documents, and consent joins.
 * Optional ?q= filters by email or display_name (ilike). Read-only.
 *
 * Auth: requireAdmin (Firebase bearer token + users.is_admin).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const supabase = createServerClient();
  const q = req.nextUrl.searchParams.get("q")?.trim();

  // If search query provided, search by email or name
  let query = supabase
    .from("users")
    .select(`
      id, email, display_name, is_admin, is_operator, firebase_uid, created_at,
      profiles (insurer, plan_type, state, primary_concern),
      stripe_customers (stripe_customer_id, subscription_status, subscription_tier, current_period_end),
      documents (id, file_name, doc_type, status, created_at),
      consent_events (consent_type, consent_version, granted, created_at)
    `)
    .order("created_at", { ascending: false })
    .limit(50);

  if (q) {
    query = query.or(`email.ilike.%${q}%,display_name.ilike.%${q}%`);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ users: data });
}

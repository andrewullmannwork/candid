import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getAdminAuth } from "@/lib/firebase/admin";

async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data: user } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    return user?.is_admin ? user : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const q = req.nextUrl.searchParams.get("q")?.trim();

  // If search query provided, search by email or name
  let query = supabase
    .from("users")
    .select(`
      id, email, display_name, is_admin, firebase_uid, created_at,
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

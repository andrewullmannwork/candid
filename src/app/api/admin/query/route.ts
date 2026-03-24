import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";

// Allowed tables for admin queries — whitelist to prevent arbitrary table access
const ALLOWED_TABLES = [
  "waitlist",
  "users",
  "documents",
  "consent_events",
  "profiles",
  "stripe_customers",
  "support_tickets",
  "insurer_catalog",
  "insurer_discovery_queue",
  "plan_catalog",
  "plan_benefits",
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];

async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    return data?.is_admin === true;
  } catch {
    return false;
  }
}

/**
 * POST /api/admin/query
 * Body: { table, select?, filters?, order?, limit? }
 * Returns data from the specified table using service role (bypasses RLS).
 */
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const body = await req.json();
  const { table, select = "*", filters, order, limit = 100 } = body;

  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    return NextResponse.json({ error: "Table not allowed" }, { status: 400 });
  }

  const supabase = createServerClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase.from(table).select(select);

  // Apply filters
  if (filters && Array.isArray(filters)) {
    for (const f of filters) {
      if (f.op === "eq") q = q.eq(f.column, f.value);
      else if (f.op === "neq") q = q.neq(f.column, f.value);
      else if (f.op === "gt") q = q.gt(f.column, f.value);
      else if (f.op === "lt") q = q.lt(f.column, f.value);
      else if (f.op === "like") q = q.like(f.column, f.value);
      else if (f.op === "ilike") q = q.ilike(f.column, f.value);
    }
  }

  // Apply order
  if (order) {
    q = q.order(order.column, { ascending: order.ascending ?? false });
  }

  q = q.limit(limit);

  const { data, error } = await q;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

/**
 * PATCH /api/admin/query
 * Body: { table, id, updates }
 * Updates a row by id using service role.
 */
export async function PATCH(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const body = await req.json();
  const { table, id, updates } = body;

  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    return NextResponse.json({ error: "Table not allowed" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error } = await supabase.from(table).update(updates).eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

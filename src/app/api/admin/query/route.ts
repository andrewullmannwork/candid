import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { logAdminAction } from "@/lib/admin/audit-log";

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
  "sbc_tickets",
  "admin_audit_log",
  "service_catalog",
  "service_categories",
  "plan_covered_services",
  "insurance_plans",
  "concepts",
  "concept_relationships",
  "feature_flag_rules",
  "parse_audit_runs",
  // Bundle PR #1 (Session 55, audit item #8) — Pattern 1 #1 admin review queues
  // for parser-emitted unknown reference data (slugs + billing codes).
  "concept_admin_review_queue",
  "service_catalog_admin_review_queue",
  // S74.5 D8 (Session 83) — Pattern 1 #16 admin attestation surface for the
  // categorization flywheel. billing_code_identity carries proposed/promoted
  // signatures; mapping_promotion_events is the append-only audit log; the
  // zero_cost_share_codes registry is admin-tunable reference data.
  "billing_code_identity",
  "mapping_promotion_events",
  "zero_cost_share_codes",
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];

async function verifyAdmin(req: NextRequest): Promise<
  | { authorized: false }
  | { authorized: true; adminUserId: string; adminEmail: string }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { authorized: false };

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("id, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (data?.is_admin !== true) return { authorized: false };
    return {
      authorized: true,
      adminUserId: data.id,
      adminEmail: decoded.email || "unknown",
    };
  } catch {
    return { authorized: false };
  }
}

/**
 * POST /api/admin/query
 * Body: { table, select?, filters?, order?, limit? }
 * Returns data from the specified table using service role (bypasses RLS).
 */
export async function POST(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const body = await req.json();
  const { table, select = "*", filters, order, limit = 100, insert } = body;

  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    return NextResponse.json({ error: "Table not allowed" }, { status: 400 });
  }

  const supabase = createServerClient();

  // INSERT mode
  if (insert) {
    const { data: insertedData, error: insertError } = await supabase
      .from(table)
      .insert(insert)
      .select("*")
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    await logAdminAction({
      adminUserId: admin.adminUserId,
      adminEmail: admin.adminEmail,
      action: "insert_record",
      targetTable: table,
      details: `Inserted row into ${table}`,
      ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
    });

    return NextResponse.json({ data: insertedData });
  }

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
      else if (f.op === "in") q = q.in(f.column, f.value);
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

  // Audit log
  await logAdminAction({
    adminUserId: admin.adminUserId,
    adminEmail: admin.adminEmail,
    action: "query_table",
    targetTable: table,
    details: `Queried ${table} (select: ${select}, limit: ${limit})`,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
  });

  return NextResponse.json({ data });
}

/**
 * PATCH /api/admin/query
 * Body: { table, id, updates }
 * Updates a row by id using service role.
 */
export async function PATCH(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin.authorized) {
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

  // Audit log
  await logAdminAction({
    adminUserId: admin.adminUserId,
    adminEmail: admin.adminEmail,
    action: "update_record",
    targetTable: table,
    details: `Updated row ${id} in ${table}`,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
  });

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/admin/query
 * Body: { table, id }
 * Deletes a row by id using service role.
 */
export async function DELETE(req: NextRequest) {
  const admin = await verifyAdmin(req);
  if (!admin.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const body = await req.json();
  const { table, id } = body;

  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    return NextResponse.json({ error: "Table not allowed" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error } = await supabase.from(table).delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAdminAction({
    adminUserId: admin.adminUserId,
    adminEmail: admin.adminEmail,
    action: "delete_record",
    targetTable: table,
    details: `Deleted row ${id} from ${table}`,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
  });

  return NextResponse.json({ success: true });
}

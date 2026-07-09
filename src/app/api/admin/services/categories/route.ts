/**
 * /api/admin/services/categories — CRUD for service_categories (the buckets that
 * group service_catalog slugs on the admin services surface).
 *   GET    — list all categories, sorted by sort_order.
 *   POST   — create a category (id slugified to [a-z0-9_]; sort_order defaults 50).
 *   DELETE — delete a category, but only after every service in it is reassigned
 *            (reassignTo); the 'other' catch-all can never be deleted.
 *
 * Auth: requireAdmin (Firebase bearer token + users.is_admin).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";

/** GET /api/admin/services/categories — list all categories */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("service_categories")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

/** POST /api/admin/services/categories — create a category */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const { id, label } = await req.json();
  if (!id || !label) return NextResponse.json({ error: "id and label required" }, { status: 400 });

  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  const supabase = createServerClient();
  const { error } = await supabase.from("service_categories").insert({ id: slug, label, sort_order: 50 });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAdminAction({
    adminUserId: admin.adminUserId,
    adminEmail: admin.adminEmail,
    action: "category_create",
    targetTable: "service_categories",
    details: `Created category: ${slug} (${label})`,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
  });

  return NextResponse.json({ success: true, id: slug, label });
}

/** DELETE /api/admin/services/categories — delete a category (with optional reassignment) */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const { categoryId, reassignTo } = await req.json();
  if (!categoryId) return NextResponse.json({ error: "categoryId required" }, { status: 400 });

  if (categoryId === "other") {
    return NextResponse.json({ error: "Cannot delete the 'other' category" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Check if any services use this category
  const { data: servicesInCategory } = await supabase
    .from("service_catalog")
    .select("id")
    .eq("category", categoryId)
    .is("merged_into_id", null);

  if (servicesInCategory && servicesInCategory.length > 0) {
    if (!reassignTo) {
      return NextResponse.json({
        error: "Category has services",
        count: servicesInCategory.length,
        message: `${servicesInCategory.length} services must be reassigned before deletion. Provide reassignTo.`,
      }, { status: 400 });
    }

    // Bulk reassign services to the new category
    const { error: reassignError } = await supabase
      .from("service_catalog")
      .update({ category: reassignTo })
      .eq("category", categoryId)
      .is("merged_into_id", null);

    if (reassignError) return NextResponse.json({ error: reassignError.message }, { status: 500 });
  }

  // Delete the category
  const { error: deleteError } = await supabase
    .from("service_categories")
    .delete()
    .eq("id", categoryId);

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  await logAdminAction({
    adminUserId: admin.adminUserId,
    adminEmail: admin.adminEmail,
    action: "category_delete",
    targetTable: "service_categories",
    details: `Deleted category: ${categoryId}${reassignTo ? ` (reassigned ${servicesInCategory?.length || 0} services to ${reassignTo})` : ""}`,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
  });

  return NextResponse.json({ success: true, reassigned: servicesInCategory?.length || 0 });
}

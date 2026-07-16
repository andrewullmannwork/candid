/**
 * /api/admin/line-items/unmapped — classify bill line items the parser couldn't
 * (plans/unmapped_line_items_admin_fix.md; the Slack "Unmapped Bill Line Items"
 * alert deep-links here via /admin/pipeline#unmapped).
 *
 *   GET  — null-slug claim_line_items grouped by (code, code type, description)
 *          so one assignment covers every occurrence.
 *   POST — assign a service_slug to a group; the write sequence lives in
 *          src/lib/admin/unmapped-assign.ts (flywheel identity + promote RPC +
 *          line-item stamp + resolver cache).
 *
 * claim_line_items is deliberately NOT in the /api/admin/query whitelist; this
 * route is the narrow, audited exception (reads null-slug rows, writes only the
 * assigned slug). Auth: requireAdmin (Firebase bearer + users.is_admin).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import {
  groupUnmappedLineItems,
  UNMAPPED_FETCH_CAP,
  type UnmappedLineItemRow,
} from "@/lib/admin/unmapped-line-items";
import { assignUnmappedGroup, fetchUnmappedLineItemRows } from "@/lib/admin/unmapped-assign";

/** GET — grouped null-slug line items for the admin pipeline surface. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  const supabase = createServerClient();
  // Cross-user read lives in the lib accessor (B9 B1: no raw user-table .from in routes)
  const { rows: data, error } = await fetchUnmappedLineItemRows(supabase, UNMAPPED_FETCH_CAP);

  if (error) return NextResponse.json({ error }, { status: 500 });

  const rows = (data ?? []) as UnmappedLineItemRow[];
  const groups = groupUnmappedLineItems(rows);
  return NextResponse.json({
    groups,
    totalUnmapped: rows.length,
    fetchCapHit: rows.length >= UNMAPPED_FETCH_CAP,
  });
}

/** POST — assign a service slug to one unmapped group. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  let body: {
    billingCode?: unknown;
    billingCodeType?: unknown;
    description?: unknown;
    serviceSlug?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const billingCode = typeof body.billingCode === "string" ? body.billingCode.trim() : "";
  const codeTypeRaw = typeof body.billingCodeType === "string" ? body.billingCodeType.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const serviceSlug = typeof body.serviceSlug === "string" ? body.serviceSlug.trim() : "";

  if (!description || !serviceSlug) {
    return NextResponse.json({ error: "description and serviceSlug required" }, { status: 400 });
  }
  // Any stored type is accepted: bridgeable types feed the flywheel; stored
  // 'ICD10'/'unknown' degrade to row-stamp + cache (assignUnmappedGroup) — a
  // GET-visible group is always assignable (review finding 2026-07-16).
  const codeType = codeTypeRaw || null;

  const supabase = createServerClient();
  const result = await assignUnmappedGroup(supabase, {
    billingCode: billingCode || null,
    codeType,
    description,
    serviceSlug,
    actorUserId: admin.adminUserId,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await logAdminAction({
    adminUserId: admin.adminUserId,
    adminEmail: admin.adminEmail,
    action: "line_items_unmapped_assign",
    targetTable: "claim_line_items",
    details: `Assigned ${serviceSlug} to "${description}" (${billingCode && codeType ? `${codeType} ${billingCode}` : "code-less"}) — ${result.updatedCount} line items updated${result.identityId ? `, identity ${result.identityId} admin_verified, ${result.backfillUpdated} linked peers backfilled` : ""}`,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"),
  });

  return NextResponse.json({
    ok: true,
    updatedCount: result.updatedCount,
    identityId: result.identityId,
    backfillUpdated: result.backfillUpdated,
  });
}

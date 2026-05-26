/**
 * POST /api/claims/[claimId]/line-items/[lineId]/correct-category
 *
 * S74.5 D5 — user submits a category correction for a single line item.
 * Pattern 1 #14 storage discipline: writes to user's own row immediately;
 * billing_code_identity update + Pattern 1 #3 promotion evaluator fire async.
 *
 * Body: { slug: string }
 * Auth: Firebase bearer token. Verifies user owns the claim.
 *
 * Spam throttle: 1 correction per line item per minute (Q3 LOCK partial).
 * Per-claim per-day throttle lives in D7 re-audit pipeline.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     contributedToFlywheel: boolean,
 *     reason?: string,
 *     identityId?: string,
 *     promotion?: { promoted, newPromotionState, distinctUserCount, threshold, reason }
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  recordUserCorrection,
  type CorrectionReason,
} from "@/lib/parser/code-identity-promotion";
import type { ProcedureCodeType } from "@/lib/billing/types";

const VALID_REASONS = new Set<CorrectionReason>([
  "wrong_service",
  "wrong_code_type",
  "missing_modifier",
  "ambiguous_description",
  "other",
]);

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

const THROTTLE_SECONDS = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; lineId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Gate behind feature flag (Q-J LOCK: all S74.5 behavior gated)
  const flywheelEnabled = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
  if (!flywheelEnabled) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
  }

  const { claimId, lineId } = await params;

  // Validate body
  let body: { slug?: unknown; reason?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!slug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }
  // §3.6 — optional correction-reason + free-text note. When reason='other'
  // we require a note; for other reasons note is optional.
  const reasonRaw = typeof body.reason === "string" ? body.reason : "";
  const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
  let correctionReason: CorrectionReason | undefined;
  if (reasonRaw) {
    if (!VALID_REASONS.has(reasonRaw as CorrectionReason)) {
      return NextResponse.json(
        {
          error: `reason must be one of: ${Array.from(VALID_REASONS).join(", ")}`,
        },
        { status: 400 },
      );
    }
    correctionReason = reasonRaw as CorrectionReason;
    if (correctionReason === "other" && !noteRaw) {
      return NextResponse.json(
        { error: "Free-text note is required when reason is 'other'" },
        { status: 400 },
      );
    }
  }

  const supabase = createServerClient();

  // Resolve user_id from Firebase UID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Verify claim ownership + load line item
  const { data: lineItem, error: lineErr } = await supabase
    .from("claim_line_items")
    .select(
      "id, claim_id, billing_code, billing_code_type, description, user_corrected_at, claims!inner(id, user_id)",
    )
    .eq("id", lineId)
    .eq("claim_id", claimId)
    .single();

  if (lineErr || !lineItem) {
    return NextResponse.json({ error: "Line item not found" }, { status: 404 });
  }

  // Safe accessor for joined claim (Supabase returns either object or array depending on shape)
  const claimsJoin = (lineItem as { claims?: { user_id?: string } | { user_id?: string }[] }).claims;
  const claimUserId = Array.isArray(claimsJoin) ? claimsJoin[0]?.user_id : claimsJoin?.user_id;
  if (claimUserId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Throttle: 1 correction per line item per minute
  if (lineItem.user_corrected_at) {
    const lastCorrected = new Date(lineItem.user_corrected_at as string).getTime();
    const secondsSince = (Date.now() - lastCorrected) / 1000;
    if (secondsSince < THROTTLE_SECONDS) {
      return NextResponse.json(
        {
          error: "Throttled",
          retryAfterSeconds: Math.ceil(THROTTLE_SECONDS - secondsSince),
        },
        { status: 429 },
      );
    }
  }

  // Validate slug exists in service_catalog
  const { data: slugRow } = await supabase
    .from("service_catalog")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle();
  if (!slugRow) {
    return NextResponse.json({ error: `Unknown service slug: ${slug}` }, { status: 400 });
  }

  const billingCode = (lineItem.billing_code as string | null) ?? "";
  const billingCodeType =
    (lineItem.billing_code_type as ProcedureCodeType | null) ?? undefined;
  const description = (lineItem.description as string | null) ?? "";

  if (!billingCode || !description) {
    return NextResponse.json(
      { error: "Line item missing billing_code or description; cannot categorize" },
      { status: 422 },
    );
  }

  // Fire the correction flow
  const result = await recordUserCorrection({
    lineItemId: lineId,
    userId: user.id,
    newSlug: slug,
    billingCode,
    billingCodeType,
    description,
    correctionReason,
    correctionNote: noteRaw || undefined,
  });

  // Mark claim audit_status stale so D7 re-runs on next fetch
  // (Stored in claims.metadata.audit_status for v1; column promotion to dedicated
  // audit_status enum is a future migration if needed.)
  // S132 iter-8 — also stamp audit_stale_reason='user_category_correction'
  // so maybeReauditClaim can exempt user-driven re-audits from the 5/day
  // daily cap. User explicitly correcting categorization should never
  // get throttled into "Findings will refresh tomorrow" — the 1/min rate
  // limit still applies as a safety guard against double-submits.
  const { data: claimRow } = await supabase
    .from("claims")
    .select("metadata")
    .eq("id", claimId)
    .maybeSingle();
  const claimMeta = (claimRow?.metadata as Record<string, unknown> | null) ?? {};
  await supabase
    .from("claims")
    .update({
      metadata: {
        ...claimMeta,
        audit_status: "stale",
        audit_stale_at: new Date().toISOString(),
        audit_stale_reason: "user_category_correction",
      },
    })
    .eq("id", claimId);

  // S132 iter-13 — root-cause cleanup: mark stale claim_discrepancies on this
  // line as 'resolved' with a dedicated resolved_at timestamp (mig 128).
  // The eob_discrepancy_detection pipeline wrote them at parse time against
  // the auto-classified slug; the user explicitly re-categorizing this line
  // implicitly resolves any coverage_status / payment discrepancies that
  // were keyed off the old slug. Without this, BillCard on /claim list stays
  // in needs_review because deriveBillState reads from BOTH metadata.auditFindings
  // (which re-audit refreshes) AND claim_discrepancies.
  //
  // Safe to mark ALL active discrepancies on the line resolved: re-audit runs
  // immediately after on the next /api/claims/[claimId] fetch (audit_status=stale)
  // and writes fresh findings; if real issues remain on the line, they re-surface
  // through metadata.auditFindings (the source of truth for the row UI).
  const nowIso = new Date().toISOString();
  const { error: discrepancyUpdateError } = await supabase
    .from("claim_discrepancies")
    .update({
      status: "resolved",
      resolved_at: nowIso,
      updated_at: nowIso,
    })
    .eq("claim_line_item_id", lineId)
    .in("status", ["flagged", "verifying", "disputed"]);
  if (discrepancyUpdateError) {
    console.warn(
      "[correct-category] claim_discrepancies cleanup failed",
      { lineId, error: discrepancyUpdateError.message },
    );
  }

  return NextResponse.json(result);
}

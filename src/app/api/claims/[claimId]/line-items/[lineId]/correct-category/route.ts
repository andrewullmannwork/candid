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
 * Spam throttle (B4.2 Pattern Y per plans/b4.2_bill_detail_redesign.md §8):
 * grace window allows quick re-correction (user typo-fixing their first pick
 * within 30s of their previous one), then the full 60s throttle kicks in for
 * the rest of the minute. Past 60s, allowed again. Per-claim per-day throttle
 * lives in D7 re-audit pipeline.
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
  type RecordCorrectionResult,
} from "@/lib/parser/code-identity-promotion";
import type { ProcedureCodeType } from "@/lib/billing/types";
import {
  userScoped,
  selectOwnedChildren,
  updateOwnedChildren,
} from "@/lib/security/user-scoped";

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
// B4.2 Pattern Y (Open Q E lock): seconds inside which a re-correction is
// allowed without throttling. Lets the user typo-fix their first pick. Beyond
// this, the full THROTTLE_SECONDS gate applies until 60s elapse.
const GRACE_RECENT_SECONDS = 30;

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
  // S153 — when ON, code-less lines are correctable + the correction is written
  // to the learned cache (served first next time).
  const resolverEnabled = await isFeatureEnabled("service_resolver_v1");

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

  // Verify claim ownership + load line item. B9 B1.2 — replace the
  // `claims!inner` ownership join + JS 403 with the layer: selectOwnedChildren
  // proves the parent claim is owned by construction (foreign/unknown claim →
  // []), then resolve the requested line by id (parent [claimId] in scope). A
  // non-owned claim now yields 404 (anti-enum standard) rather than the prior 403.
  const ownedLines = await selectOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    [claimId],
    "id, claim_id, billing_code, billing_code_type, description, user_corrected_at",
  );
  const lineItem = ownedLines.find((r) => r.id === lineId) ?? null;
  if (!lineItem) {
    return NextResponse.json({ error: "Line item not found" }, { status: 404 });
  }

  // B4.2 Pattern Y throttle: grace window (≤30s since prior correction) allows
  // quick re-correction freely; once past grace but still inside the 60s
  // throttle window, returns 429. Past the throttle window, allowed.
  if (lineItem.user_corrected_at) {
    const lastCorrected = new Date(lineItem.user_corrected_at as string).getTime();
    const secondsSince = (Date.now() - lastCorrected) / 1000;
    if (
      secondsSince >= GRACE_RECENT_SECONDS &&
      secondsSince < THROTTLE_SECONDS
    ) {
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

  // S153 — a description is always required (signature input + label). A billing
  // code is required only on the legacy path (the flywheel is code-keyed); with
  // the resolver ON, code-less lines are correctable via the signature cache.
  if (!description) {
    return NextResponse.json(
      { error: "Line item missing description; cannot categorize" },
      { status: 422 },
    );
  }
  if (!billingCode && !resolverEnabled) {
    return NextResponse.json(
      { error: "Line item missing billing_code; cannot categorize" },
      { status: 422 },
    );
  }

  // Fire the correction flow. Coded lines go through the flywheel
  // (recordUserCorrection updates the user row + casts the vote); code-less
  // lines update the user-owned row directly (no billing_code_identity exists).
  let result: RecordCorrectionResult;
  if (billingCode) {
    result = await recordUserCorrection({
      lineItemId: lineId,
      userId: user.id,
      newSlug: slug,
      billingCode,
      billingCodeType,
      description,
      correctionReason,
      correctionNote: noteRaw || undefined,
    });
  } else {
    // B9 B1.2 — child WRITE via the parent-scoped primitive (claimId proven
    // owned above; line known to exist). updated=0 ⇒ write failure.
    const { updated } = await updateOwnedChildren(
      supabase,
      user.id,
      "claim_line_items",
      claimId,
      [
        {
          id: lineId,
          values: { service_slug: slug, user_corrected_at: new Date().toISOString() },
        },
      ],
    );
    result = updated === 0
      ? { ok: false, contributedToFlywheel: false, reason: "user_row_update_failed" }
      : { ok: true, contributedToFlywheel: false, reason: "code_less_user_correction" };
  }

  // S153 — write the correction to the learned cache so it is served first on
  // the next identical line/description (backend-only write; Rule #4/#10 safe —
  // billing_code_mappings is a cache, not a canonical/identity table).
  if (resolverEnabled && result.ok) {
    try {
      const { cacheLearnedMapping } = await import("@/lib/claims/service-resolver");
      const { normalizeDescriptionSignature } = await import(
        "@/lib/parser/code-identity"
      );
      await cacheLearnedMapping(supabase, {
        code: billingCode || null,
        codeType: billingCode ? (billingCodeType ?? null) : null,
        signature: billingCode
          ? null
          : normalizeDescriptionSignature(description, ""),
        slug,
        confidence: 0.95, // user correction is a strong signal
        description,
        source: "user_correction",
      });
    } catch (e) {
      console.warn("[correct-category] learned-cache write failed (non-fatal)", e);
    }
  }

  // Mark claim audit_status stale so D7 re-runs on next fetch
  // (Stored in claims.metadata.audit_status for v1; column promotion to dedicated
  // audit_status enum is a future migration if needed.)
  // S132 iter-8 — also stamp audit_stale_reason='user_category_correction'
  // so maybeReauditClaim can exempt user-driven re-audits from the 5/day
  // daily cap. User explicitly correcting categorization should never
  // get throttled into "Findings will refresh tomorrow" — the 1/min rate
  // limit still applies as a safety guard against double-submits.
  const { data: claimRow } = await userScoped(supabase, user.id)
    .table("claims")
    .select("metadata")
    .eq("id", claimId)
    .maybeSingle();
  const claimMeta = (claimRow?.metadata as Record<string, unknown> | null) ?? {};
  await userScoped(supabase, user.id)
    .table("claims")
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
  // B9 B1.2 — claim_discrepancies is a direct user_id table; userScoped adds
  // `.eq("user_id")` (defense-in-depth — lineId already belongs to the owned
  // claim, so this is op-equivalent for the owner).
  const { error: discrepancyUpdateError } = await userScoped(supabase, user.id)
    .table("claim_discrepancies")
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

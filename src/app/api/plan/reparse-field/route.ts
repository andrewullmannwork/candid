/**
 * POST /api/plan/reparse-field — Phase 4.0.5 Task 4.0.5-E.
 *
 * Targeted re-parse of a single field. Body shape:
 *   { planId: string, fieldName: string, serviceSlug?: string }
 *
 * When `serviceSlug` is omitted, targets a column on `insurance_plans` (plan-identity
 * scalar). When provided, targets a column on `plan_covered_services` (per-service
 * cost-sharing field).
 *
 * Auth: Firebase admin token via Authorization: Bearer header. Maps to internal user
 * via `users.firebase_uid`. Plan ownership verified inside `reparseField()` (server lib).
 *
 * Feature flag: `consumer_read_filter_v1` global ON since Session 57. Library reads
 * cost caps from `consumer_read_filter_v1.config` JSONB sub-keys (admin-tunable via
 * `/admin/flags` UI without code change).
 *
 * Returns `DecoratedValue<T>` shape per Phase 4.0 contract — UI swaps in-place.
 *
 * Error semantics:
 *   - 401 unauthorized: missing or invalid Firebase token
 *   - 403 forbidden: feature flag OFF for this user
 *   - 404 not_found: plan or service row not found / not owned
 *   - 409 conflict: ocr_text_not_cached (forward-only fallback) OR no_unsearched_sections
 *   - 429 too_many_requests: cost_cap_exceeded / daily_cap_exceeded / rate_limit_exceeded
 *   - 400 bad_request: field_not_eligible (column not in re-parse allow-list)
 *   - 500 internal_error: row update failed
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { reparseField, type ReparseError } from "@/lib/plan/reparse-field";
import { loadDecorationContext } from "@/lib/plan/analyze-decoration";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

function statusForError(err: ReparseError): number {
  switch (err) {
    case "ocr_text_not_cached":
    case "no_unsearched_sections":
      return 409;
    case "cost_cap_exceeded":
    case "daily_cap_exceeded":
    case "rate_limit_exceeded":
      return 429;
    case "field_not_eligible":
      return 400;
    case "plan_not_found":
    case "service_not_found":
      return 404;
    case "internal_error":
    default:
      return 500;
  }
}

export async function POST(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data: internalUser } = await supabase
    .from("users")
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();

  if (!internalUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Phase 4.0.5 gates on consumer_read_filter_v1 (already global ON since Session 57).
  // Q-S63-1 LOCK: NO new feature flag — backout via revert UI to single-link or admin
  // tunable cost caps to $0.00 via `/admin/flags` config.
  const flagOn = await isFeatureEnabled("consumer_read_filter_v1", internalUser.email ?? undefined);
  if (!flagOn) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  let body: { planId?: string; fieldName?: string; serviceSlug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.planId || typeof body.planId !== "string") {
    return NextResponse.json({ error: "planId required" }, { status: 400 });
  }
  if (!body.fieldName || typeof body.fieldName !== "string") {
    return NextResponse.json({ error: "fieldName required" }, { status: 400 });
  }
  if (body.serviceSlug !== undefined && typeof body.serviceSlug !== "string") {
    return NextResponse.json({ error: "serviceSlug must be a string" }, { status: 400 });
  }

  // Decoration context — needed to compute final DecoratedValue.state for response.
  // Loads multiSourceThreshold from feature_flag_rules; canonicalSourceCount from
  // canonical_plans.verification_count if userPlan is canonical-mapped.
  const { data: userPlanCanon } = await supabase
    .from("insurance_plans")
    .select("canonical_plan_id")
    .eq("id", body.planId)
    .single();
  const decoration = await loadDecorationContext(
    supabase,
    internalUser.email ?? null,
    userPlanCanon ?? null,
  );
  if (!decoration) {
    // Defensive — flag was on at line above; race against admin flip is unlikely.
    return NextResponse.json({ error: "Decoration context unavailable" }, { status: 503 });
  }

  const result = await reparseField(
    supabase,
    internalUser.id as string,
    {
      planId: body.planId,
      fieldName: body.fieldName,
      serviceSlug: body.serviceSlug,
    },
    decoration,
  );

  if (!result.success) {
    return NextResponse.json(
      { error: result.error ?? "internal_error" },
      { status: statusForError(result.error ?? "internal_error") },
    );
  }

  return NextResponse.json({
    success: true,
    decoratedValue: result.decoratedValue,
    finalVerifiedState: result.finalVerifiedState,
    costUsd: result.costUsd,
    dispatchedThisRun: result.dispatchedThisRun,
  });
}

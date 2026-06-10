/**
 * POST /api/claims/[claimId]/line-items/[lineId]/confirm-coverage
 *
 * S154 — user confirms (or un-confirms) an `estimate`-tier secondary coverage
 * match. The secondary match resolves a bill line to a covered sibling's
 * cost-share when the exact slug has no plan row; when the borrow is ambiguous
 * (heterogeneous category + weak textual match) the gate marks it `estimate`,
 * the detail UI shows a "Verify coverage" affordance, and the dispute pipeline
 * demotes it below cite-grade. This endpoint records the user's confirmation so
 * `coverageNeedsConfirmation` flips to false (affordance disappears; dispute may
 * cite it).
 *
 * Pattern 1 #14 — writes to the user's OWN claim_line_items row only; no
 * canonical / cross-user write. Coverage-borrow is plan + user specific, so it
 * does not feed the identity learned-cache (that's the separate correct-category
 * path keyed on code/description → slug).
 *
 * Body: { confirmed?: boolean }  (default true; pass false to un-confirm)
 * Auth: Firebase bearer token. Verifies the user owns the claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { userScoped, selectOwnedChildren, updateOwnedChildren } from "@/lib/security/user-scoped";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; lineId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Gate behind the feature this serves. OFF → no estimate tier exists, so the
  // endpoint is a no-op surface (404 mirrors correct-category's gate behavior).
  const secondaryV2 = await isFeatureEnabled("secondary_coverage_v2");
  if (!secondaryV2) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
  }

  const { claimId, lineId } = await params;

  let body: { confirmed?: unknown; decision?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body → default to match
  }
  // Detail-page Verify button sends {confirmed:true} (→ match); the dispute
  // ServiceVerificationGateCard sends {decision:"match"|"no_match"}. "clear"
  // resets to undecided (re-surfaces the gate).
  const decision: "match" | "no_match" | "clear" =
    body.decision === "no_match"
      ? "no_match"
      : body.decision === "match"
        ? "match"
        : body.confirmed === false
          ? "clear"
          : "match";

  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Ownership: the claim must belong to this user (userScoped injects user_id).
  const { data: claim } = await userScoped(supabase, user.id)
    .table("claims")
    .select("id")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  // The line item must belong to that claim. B9 B1.2 — claim_line_items has no
  // user_id; selectOwnedChildren re-verifies the parent claim is owned then
  // returns its lines; resolve the requested line by id in JS (parent-in-scope,
  // the S185 child-read-by-id pattern). Foreign claim → [] → 404.
  const ownedLines = await selectOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    [claimId],
    "id, metadata",
  );
  const li = ownedLines.find((r) => r.id === lineId) ?? null;
  if (!li) {
    return NextResponse.json({ error: "Line item not found" }, { status: 404 });
  }

  const meta = ((li.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const nextMeta: Record<string, unknown> = { ...meta };
  if (decision === "match") {
    nextMeta.coverage_user_confirmed = true;
    nextMeta.coverage_confirmed_at = new Date().toISOString();
    delete nextMeta.coverage_user_rejected;
    delete nextMeta.coverage_rejected_at;
  } else if (decision === "no_match") {
    nextMeta.coverage_user_rejected = true;
    nextMeta.coverage_rejected_at = new Date().toISOString();
    delete nextMeta.coverage_user_confirmed;
    delete nextMeta.coverage_confirmed_at;
  } else {
    delete nextMeta.coverage_user_confirmed;
    delete nextMeta.coverage_confirmed_at;
    delete nextMeta.coverage_user_rejected;
    delete nextMeta.coverage_rejected_at;
  }

  // B9 B1.2 — child WRITE via the parent-scoped primitive: verifies claimId is
  // owned once, then updates the line scoped by id AND claim_id (fail-closed).
  // The line is already proven to exist + belong to claimId above, so updated=0
  // here means a write failure (op-equivalent to the prior error→500).
  const { updated } = await updateOwnedChildren(
    supabase,
    user.id,
    "claim_line_items",
    claimId,
    [{ id: lineId, values: { metadata: nextMeta } }],
  );
  if (updated === 0) {
    console.error("[confirm-coverage] update failed for line:", lineId);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, decision });
}

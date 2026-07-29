/**
 * POST /api/plan/unwind-merge — "This isn't my plan" (S292 item 4C).
 *
 * Undoes a supplement-merge that the plan-identity resolver performed on a
 * `same` verdict. At the 0.85 confidence floor the merge lands before the user
 * ever sees the confirmation, so the escape hatch must REVERT rather than
 * prevent — a control that only prevented would silently do nothing.
 *
 * The undo is driven by the receipt captured at merge time
 * (`documents.metadata.plan_merge_receipt`); see `merge-receipt.ts` for why the
 * prior state is unrecoverable without it.
 *
 * PROPERTIES
 *  • OWNERSHIP — every read and write is userScoped; a foreign document 404s
 *    rather than 403s (anti-enumeration, matching the B9 family).
 *  • IDEMPOTENT — `unwoundAt` on the receipt makes a double-click a no-op
 *    instead of a second revert.
 *  • COMPARE-AND-SWAP — a field is reverted only if it still holds exactly what
 *    the merge wrote. Anything corrected since is kept, and REPORTED, so we
 *    never claim a clean undo we didn't perform.
 *  • NON-DESTRUCTIVE — the disowned document's plan data is not deleted; the
 *    document is marked so a re-parse cannot silently re-merge it.
 *
 * OUT OF SCOPE, DELIBERATELY: canonical corroboration. `findOrCreateCanonicalPlan`
 * may have incremented a canonical's `source_count` off this document. That is
 * cross-user flywheel signal governed by the Rule-10 promotion path, not a
 * per-user undo, and quietly decrementing it here would let one user's mistake
 * edit shared reference data. Reported in the response as `canonicalUntouched`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import {
  userScoped,
  selectOwnedChildren,
  upsertOwnedChildren,
  deleteOwnedChildren,
} from "@/lib/security/user-scoped";
import {
  buildPlanRevertPatch,
  buildProfileRevertPatch,
  buildCellRevert,
  provenanceCitesDocument,
  PLAN_MERGE_RECEIPT_VERSION,
  type PlanMergeReceipt,
} from "@/lib/plan/merge-receipt";
import { PLAN_COVERED_ONCONFLICT } from "@/lib/plan/coverage-targeting";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let decodedUid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    decodedUid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { documentId?: string };
  const documentId = body.documentId;
  if (!documentId) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users").select("id").eq("firebase_uid", decodedUid).single();
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Ownership: userScoped means a document belonging to someone else simply
  // isn't found — 404, never 403, so the endpoint can't confirm existence.
  const { data: doc } = await userScoped(supabase, user.id)
    .table("documents")
    .select("id, metadata")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const meta = ((doc.metadata as Record<string, unknown> | null) ?? {});
  const receipt = meta.plan_merge_receipt as PlanMergeReceipt | undefined;
  if (!receipt || receipt.version !== PLAN_MERGE_RECEIPT_VERSION) {
    // No receipt = nothing we can honestly undo. Say so rather than reverting
    // to a guess.
    return NextResponse.json(
      { error: "This upload can't be undone automatically.", reason: "no_receipt" },
      { status: 409 },
    );
  }
  if (receipt.unwoundAt) {
    return NextResponse.json({ ok: true, alreadyUnwound: true, unwoundAt: receipt.unwoundAt });
  }

  // ── Plan row ────────────────────────────────────────────────────────────────
  const { data: planNow } = await userScoped(supabase, user.id)
    .table("insurance_plans")
    .select("*")
    .eq("id", receipt.targetPlanId)
    .maybeSingle();
  if (!planNow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const planRevert = buildPlanRevertPatch(receipt, planNow as Record<string, unknown>);
  if (Object.keys(planRevert.patch).length > 0) {
    const { error } = await userScoped(supabase, user.id)
      .table("insurance_plans")
      .update(planRevert.patch)
      .eq("id", receipt.targetPlanId);
    if (error) {
      return NextResponse.json({ error: "Couldn't undo this merge." }, { status: 500 });
    }
  }

  // ── Profile ─────────────────────────────────────────────────────────────────
  let profileKept: string[] = [];
  if (receipt.profile) {
    const { data: profNow } = await userScoped(supabase, user.id)
      .table("profiles")
      .select("active_insurance_plan_id, insurer, plan_name")
      .maybeSingle();
    if (profNow) {
      const profRevert = buildProfileRevertPatch(receipt, profNow as Record<string, unknown>);
      profileKept = profRevert.keptByUser;
      if (Object.keys(profRevert.patch).length > 0) {
        await userScoped(supabase, user.id)
          .table("profiles")
          .update(profRevert.patch)
          .eq("user_id", user.id);
      }
    }
  }

  // ── Coverage cells ──────────────────────────────────────────────────────────
  let cellsRestored = 0;
  let cellsDeleted = 0;
  let cellsKept = 0;
  if (receipt.servicesUnwindable) {
    // Child-table access goes through the B9 parent-join primitives — the plan's
    // ownership is re-verified inside each, not merely inferred from the check
    // above. That redundancy is the point of the class-backstop.
    const cellsNow = await selectOwnedChildren(
      supabase,
      user.id,
      "plan_covered_services",
      [receipt.targetPlanId],
      "*",
    );

    const revert = buildCellRevert(
      receipt,
      (cellsNow ?? []) as Array<Record<string, unknown>>,
      provenanceCitesDocument,
    );
    cellsKept = revert.keptByUser;

    if (revert.restore.length > 0) {
      const { upserted } = await upsertOwnedChildren(
        supabase,
        user.id,
        "plan_covered_services",
        receipt.targetPlanId,
        revert.restore,
        { onConflict: PLAN_COVERED_ONCONFLICT },
      );
      cellsRestored = upserted;
    }
    if (revert.deleteKeys.length > 0) {
      const { deleted } = await deleteOwnedChildren(
        supabase,
        user.id,
        "plan_covered_services",
        receipt.targetPlanId,
        revert.deleteKeys.map((k) => ({
          service_id: k.service_id,
          place_of_service: k.place_of_service,
          component: k.component,
          plan_tier_label: k.plan_tier_label,
        })),
      );
      cellsDeleted = deleted;
    }
  }

  // ── Mark the document ───────────────────────────────────────────────────────
  // `plan_identity_user_verdict` is what stops a re-parse from silently
  // re-merging the document the user has just disowned. The receipt is kept
  // (not cleared) as the record of what happened.
  const unwoundAt = new Date().toISOString();
  await userScoped(supabase, user.id)
    .table("documents")
    .update({
      metadata: {
        ...meta,
        plan_merge_receipt: { ...receipt, unwoundAt },
        plan_identity_user_verdict: "not_my_plan",
      },
      insurer_mismatch: {
        mismatch: true,
        type: "plan_name",
        existingInsurer: "",
        parsedInsurer: "",
        identity: {
          verdict: "different",
          reason: "user_rejected_match",
          evidence: "You told us this document isn't for the plan we added it to.",
          existingPlanId: receipt.targetPlanId,
        },
      },
    })
    .eq("id", documentId);

  console.log(
    `[unwind-merge] doc=${documentId} plan=${receipt.targetPlanId} ` +
      `cols=${Object.keys(planRevert.patch).length} keptByUser=${planRevert.keptByUser.length} ` +
      `cells restored=${cellsRestored} deleted=${cellsDeleted} kept=${cellsKept} ` +
      `servicesUnwindable=${receipt.servicesUnwindable}`,
  );

  return NextResponse.json({
    ok: true,
    unwoundAt,
    planFieldsReverted: Object.keys(planRevert.patch).filter((c) => c !== "field_provenance").length,
    // Surfaced, not swallowed: these are the parts of the merge we deliberately
    // did NOT undo, and the caller can tell the user plainly.
    keptBecauseYouChangedThem: [...planRevert.keptByUser, ...profileKept],
    cellsRestored,
    cellsDeleted,
    cellsKeptBecauseNotFromThisDocument: cellsKept,
    servicesUnwindable: receipt.servicesUnwindable,
    canonicalUntouched: true,
  });
}

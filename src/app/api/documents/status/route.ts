/**
 * GET /api/documents/status?id=<documentId>
 * POST /api/documents/status (with { documentId, action: "trigger" })
 *
 * Lightweight polling endpoint for the client to check processing progress
 * and trigger the next chunk when needed. No auth required for GET (document
 * IDs are UUIDs and not guessable). POST trigger calls process-chunk.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getAdminAuth } from "@/lib/firebase/admin";

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get("id");
  if (!documentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("status, processing_step, processing_completed_pages, processing_total_pages, insurer_mismatch, processing_error, retry_count, processing_started_at, linked_insurance_plan_id")
    .eq("id", documentId)
    .single();

  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // For processed plan-document/SBC uploads, surface premium_monthly so the
  // /upload completion UI can prompt the user when it's null (premiums aren't
  // in SBC documents — must be user-supplied to power /plan + /compare).
  let linkedPlanPremium: number | null = null;
  if (doc.linked_insurance_plan_id && doc.status === "processed") {
    const { data: plan } = await supabase
      .from("insurance_plans")
      .select("premium_monthly")
      .eq("id", doc.linked_insurance_plan_id)
      .single();
    linkedPlanPremium = (plan?.premium_monthly as number | null) ?? null;
  }

  // Determine if the client should trigger a chunk
  const needsTrigger =
    (doc.status === "queued" && !doc.processing_step) || // Never started
    (doc.status === "processing" && doc.processing_step && !doc.processing_step.startsWith("working_")); // Ready for next step

  // Detect stuck documents (processing for >10 min with no progress)
  const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
  const isStuck = doc.status === "processing"
    && doc.processing_started_at
    && (Date.now() - new Date(doc.processing_started_at).getTime()) > STUCK_THRESHOLD_MS
    && (!doc.processing_step || doc.processing_step.startsWith("working_"));

  return NextResponse.json({
    status: doc.status,
    step: doc.processing_step,
    completedPages: doc.processing_completed_pages || 0,
    totalPages: doc.processing_total_pages || 0,
    needsTrigger,
    insurerMismatch: doc.insurer_mismatch || null,
    processingError: doc.processing_error || null,
    retryCount: doc.retry_count || 0,
    isStuck: isStuck || false,
    // Surfaced so /compare can build user_plan PlanRefs without a separate
    // browser-client Supabase query (which 406s under RLS for new docs).
    linkedInsurancePlanId: doc.linked_insurance_plan_id || null,
    // Null when premium hasn't been collected yet (SBCs don't include premium —
    // user must supply it post-parse via the prompt on /upload completion).
    linkedPlanPremium,
  });
}

export async function POST(req: NextRequest) {
  const reqBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const documentId = reqBody.documentId as string | undefined;
  const action = reqBody.action as string | undefined;
  if (!documentId) {
    return NextResponse.json({ error: "documentId required" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Auth check for mutating actions — verify the user owns the document
  const mutatingActions = [
    "activate_plan",
    "confirm_canonical_match",
    "reject_canonical_match",
    "record_disambiguation",
    "cancel",
  ];
  if (action && mutatingActions.includes(action)) {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
      const { data: authUser } = await supabase.from("users").select("id").eq("firebase_uid", decoded.uid).single();
      const { data: docOwner } = await supabase.from("documents").select("user_id").eq("id", documentId).single();
      if (!authUser || !docOwner || authUser.id !== docOwner.user_id) {
        return NextResponse.json({ error: "Not authorized for this document" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
  }

  // S91 — soft-cancel an in-flight upload. Sets status='error' +
  // processing_step='canceled_by_user' so the next process-chunk worker
  // invocation hits the status gate at process-chunk/route.ts:474 and bails.
  //
  // Trade-off: the chunk currently in-flight (if any) completes and writes its
  // partial results before bailing. To truly abort mid-Haiku-call we'd need to
  // capture QStash message IDs at enqueue time and delete them via
  // qstash.messages.delete — heavier lift; current approach is sufficient for
  // the user-perception goal ("stop charging me, stop processing further").
  if (action === "cancel") {
    const { data: existing } = await supabase
      .from("documents")
      .select("status, metadata")
      .eq("id", documentId)
      .single();
    if (!existing) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    // No-op if already terminal — don't overwrite a successful processed state
    // or a different error/canceled record.
    if (existing.status === "processed" || existing.status === "error") {
      return NextResponse.json({ success: true, alreadyTerminal: true, status: existing.status });
    }
    const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
    const newMeta = {
      ...existingMeta,
      canceled_by_user: { at: new Date().toISOString() },
    };
    const { error } = await supabase
      .from("documents")
      .update({
        status: "error",
        processing_step: "canceled_by_user",
        processing_error: "Canceled by user via the upload-screen X button.",
        metadata: newMeta,
      })
      .eq("id", documentId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  // S91 Option B — record the user's choice on the insurer-mismatch / year-rollover
  // modal so post-MVP we can correlate doc-type override decisions with whether
  // the user actually adopted the parsed plan. Fire-and-forget metadata write.
  if (action === "record_disambiguation") {
    const choice = reqBody.choice;
    const modalType = reqBody.modalType;
    if (choice !== "keep_current" && choice !== "use_this_plan") {
      return NextResponse.json(
        { error: "choice must be 'keep_current' or 'use_this_plan'" },
        { status: 400 },
      );
    }
    if (modalType !== "insurer_mismatch" && modalType !== "year_rollover") {
      return NextResponse.json(
        { error: "modalType must be 'insurer_mismatch' or 'year_rollover'" },
        { status: 400 },
      );
    }

    const { data: existing } = await supabase
      .from("documents")
      .select("metadata")
      .eq("id", documentId)
      .single();
    const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
    const newMeta = {
      ...existingMeta,
      user_disambiguation: {
        choice,
        modal_type: modalType,
        recorded_at: new Date().toISOString(),
      },
    };
    await supabase.from("documents").update({ metadata: newMeta }).eq("id", documentId);
    return NextResponse.json({ success: true });
  }

  // Activate a mismatched plan (user chose to use the new insurer)
  if (action === "activate_plan") {
    const { data: doc } = await supabase
      .from("documents")
      .select("user_id, linked_insurance_plan_id")
      .eq("id", documentId)
      .single();

    if (!doc?.linked_insurance_plan_id) {
      return NextResponse.json({ error: "No plan linked to this document" }, { status: 400 });
    }

    // Deactivate old plans
    await supabase
      .from("insurance_plans")
      .update({ is_active: false })
      .eq("user_id", doc.user_id)
      .eq("is_active", true);

    // Activate the new plan
    await supabase
      .from("insurance_plans")
      .update({ is_active: true })
      .eq("id", doc.linked_insurance_plan_id);

    // Clear stale plan-specific fields from profile (preserves personal info: name, DOB, phone, etc.)
    // New plan's extracted values will backfill via process-plan or next card scan
    await supabase
      .from("profiles")
      .update({
        active_insurance_plan_id: doc.linked_insurance_plan_id,
        // Clear all cost/plan fields — stale data from old plan (personal info preserved)
        insurer: null, plan_name: null, plan_type: null, state: null,
        group_number: null, member_id: null,
        deductible_individual: null, oop_max_individual: null,
        copay_primary: null, copay_specialist: null, copay_er: null,
        copay_urgent_care: null, copay_rx: null, coinsurance_pct: null,
        matched_plan_id: null, plan_source: null,
      })
      .eq("user_id", doc.user_id);

    // Backfill profile with new plan's data so profile stays in sync
    const { data: newPlan } = await supabase
      .from("insurance_plans")
      .select("insurer_name, plan_name, plan_type, state, group_number, member_id, in_deductible_individual, in_oop_max_individual, source")
      .eq("id", doc.linked_insurance_plan_id)
      .single();

    if (newPlan) {
      const backfill: Record<string, unknown> = {};
      if (newPlan.insurer_name) backfill.insurer = newPlan.insurer_name;
      if (newPlan.plan_name) backfill.plan_name = newPlan.plan_name;
      if (newPlan.plan_type) backfill.plan_type = newPlan.plan_type;
      if (newPlan.state) backfill.state = newPlan.state;
      if (newPlan.in_deductible_individual != null) backfill.deductible_individual = newPlan.in_deductible_individual;
      if (newPlan.in_oop_max_individual != null) backfill.oop_max_individual = newPlan.in_oop_max_individual;
      if (Object.keys(backfill).length > 0) {
        await supabase.from("profiles").update(backfill).eq("user_id", doc.user_id);
      }
    }

    // Card-derived fields (member_id, group_number) were cleared — user needs to re-scan
    return NextResponse.json({ success: true, needsCardRescan: true });
  }

  // Confirm canonical plan match (user verified the matched plan is correct)
  if (action === "confirm_canonical_match") {
    const { data: doc } = await supabase
      .from("documents")
      .select("linked_insurance_plan_id, insurer_mismatch")
      .eq("id", documentId)
      .single();

    const pendingMatch = doc?.insurer_mismatch?.pending_canonical_match;
    if (!doc?.linked_insurance_plan_id || !pendingMatch) {
      return NextResponse.json({ error: "No pending canonical match" }, { status: 400 });
    }

    try {
      const { confirmCanonicalMatch } = await import("@/lib/plan/canonical-match");
      await confirmCanonicalMatch(supabase, doc.linked_insurance_plan_id, pendingMatch.canonicalPlanId);

      // Clear the pending match from document metadata
      const updatedMismatch = { ...(doc.insurer_mismatch || {}) };
      delete updatedMismatch.pending_canonical_match;
      await supabase.from("documents").update({
        insurer_mismatch: Object.keys(updatedMismatch).length > 0 ? updatedMismatch : null,
      }).eq("id", documentId);

      return NextResponse.json({ success: true, canonicalPlanId: pendingMatch.canonicalPlanId });
    } catch (err) {
      console.error("[canonical-plan] Confirm failed:", err);
      return NextResponse.json({ error: "Failed to confirm canonical match" }, { status: 500 });
    }
  }

  // Reject canonical plan match (user says this isn't their plan)
  if (action === "reject_canonical_match") {
    const { data: doc } = await supabase
      .from("documents")
      .select("linked_insurance_plan_id, insurer_mismatch")
      .eq("id", documentId)
      .single();

    const pendingMatch = doc?.insurer_mismatch?.pending_canonical_match;
    if (!doc?.linked_insurance_plan_id || !pendingMatch) {
      return NextResponse.json({ error: "No pending canonical match" }, { status: 400 });
    }

    try {
      const { rejectCanonicalMatch } = await import("@/lib/plan/canonical-match");
      const newCanonicalId = await rejectCanonicalMatch(
        supabase,
        doc.linked_insurance_plan_id,
        pendingMatch.canonicalPlanId
      );

      // Clear the pending match from document metadata
      const updatedMismatch = { ...(doc.insurer_mismatch || {}) };
      delete updatedMismatch.pending_canonical_match;
      await supabase.from("documents").update({
        insurer_mismatch: Object.keys(updatedMismatch).length > 0 ? updatedMismatch : null,
      }).eq("id", documentId);

      return NextResponse.json({ success: true, canonicalPlanId: newCanonicalId });
    } catch (err) {
      console.error("[canonical-plan] Reject failed:", err);
      return NextResponse.json({ error: "Failed to reject canonical match" }, { status: 500 });
    }
  }

  // Default: trigger the next processing chunk via QStash (guaranteed delivery)
  try {
    const { enqueueChunk } = await import("@/lib/queue/qstash");
    const baseUrl = req.headers.get("x-forwarded-proto") && req.headers.get("x-forwarded-host")
      ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("x-forwarded-host")}`
      : new URL(req.url).origin;
    const enqueued = await enqueueChunk(documentId, baseUrl);
    if (!enqueued) {
      return NextResponse.json({ error: "Failed to enqueue chunk" }, { status: 500 });
    }
    return NextResponse.json({ success: true, triggered: true });
  } catch {
    return NextResponse.json({ error: "Trigger failed" }, { status: 500 });
  }
}

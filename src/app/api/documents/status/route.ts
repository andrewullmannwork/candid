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

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get("id");
  if (!documentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("status, processing_step, processing_completed_pages, processing_total_pages, insurer_mismatch, processing_error, retry_count, processing_started_at")
    .eq("id", documentId)
    .single();

  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  });
}

export async function POST(req: NextRequest) {
  const { documentId, action } = await req.json();
  if (!documentId) {
    return NextResponse.json({ error: "documentId required" }, { status: 400 });
  }

  const supabase = createServerClient();

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
        // Clear cost fields — stale data from old plan
        insurer: null,
        plan_name: null,
        plan_type: null,
        group_number: null,
        member_id: null,
        deductible_individual: null,
        oop_max_individual: null,
        copay_primary: null,
        copay_specialist: null,
        copay_er: null,
        coinsurance_pct: null,
        matched_plan_id: null,
        plan_source: null,
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

  // Default: trigger the next processing chunk
  const chunkUrl = new URL("/api/documents/process-chunk", req.url);
  try {
    const res = await fetch(chunkUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    });
    const result = await res.json();
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Trigger failed" }, { status: 500 });
  }
}

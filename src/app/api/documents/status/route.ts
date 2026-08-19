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
import { adoptUnlinkedClaims, repointClaimsFromDeactivatedPlans } from "@/lib/claims/claim-plan-link";
import { getAdminAuth } from "@/lib/firebase/admin";
import { decideCardPreservation } from "@/lib/plan/insurer-match";

export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get("id");
  if (!documentId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("status, processing_step, processing_completed_pages, processing_total_pages, insurer_mismatch, processing_error, retry_count, processing_started_at, linked_insurance_plan_id, metadata")
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

  // S102 follow-up — surface smart-skip outcome so the frontend can use
  // accelerated page-tick + sub-phase intervals when the backend took the
  // smart-skip path (no full Haiku parse). Written by linkDocumentToCanonical
  // in extraction-dedup.ts. Null on full-parse uploads or pre-smart-skip docs.
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const smartSkipOutcome = (metadata.smart_skip_outcome as string | undefined) ?? null;

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
    // S102 follow-up: "skipped" when smart-skip fired; null otherwise. Frontend
    // gates accelerated UI intervals on this.
    smartSkipOutcome,
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

    // ── S292 — card-preservation decision, read BEFORE anything is mutated ──
    // This action used to clear profile member_id/group_number UNCONDITIONALLY
    // and report needsCardRescan: true unconditionally — the "confirmed switch
    // clears the other half" rule with no assembly or same-insurer exception.
    // Real cost: a user who scanned her card and then confirmed her own SBC
    // ("Blue Cross" card → "Blue Cross Blue Shield of Wyoming" document) had
    // the onboarding card slot wiped client-side (needsCardRescan → setCard
    // null) as if her ID card were deleted. Same decision as search-select now:
    // the SHARED decideCardPreservation (set-active-canonical refactored onto
    // it too) — preserve on assembly and same-family switches, clear only on a
    // confident cross-insurer switch, and REPORT what actually happened.
    const { data: priorProfile } = await supabase
      .from("profiles")
      .select("insurer, member_id, group_number, active_insurance_plan_id")
      .eq("user_id", doc.user_id)
      .maybeSingle();
    let priorActiveSource: string | null = null;
    if (priorProfile?.active_insurance_plan_id) {
      const { data: priorActive } = await supabase
        .from("insurance_plans")
        .select("source")
        .eq("id", priorProfile.active_insurance_plan_id)
        .eq("user_id", doc.user_id)
        .maybeSingle();
      priorActiveSource = (priorActive?.source as string | null) ?? null;
    }

    // S317 — who is active BEFORE the deactivation, so the claims pointing at
    // those rows can follow the new plan rather than resolving coverage against
    // an is_active=false one. This seam is reachable straight from /check (the
    // "use this document" SBC path), so a second bill hits it.
    const { data: activeBeforeRows } = await supabase
      .from("insurance_plans")
      .select("id")
      .eq("user_id", doc.user_id)
      .eq("is_active", true);
    const activeBeforeIds: string[] = (activeBeforeRows ?? []).map((p: { id: string }) => p.id);

    // Deactivate old plans
    await supabase
      .from("insurance_plans")
      .update({ is_active: false })
      .eq("user_id", doc.user_id)
      .eq("is_active", true);

    // Activate the new plan
    await supabase
      .from("insurance_plans")
      .update({ is_active: true, activated_at: new Date().toISOString() })
      .eq("id", doc.linked_insurance_plan_id);

    // Repoint the profile to the newly-activated plan FIRST, in its own
    // error-checked statement. This MUST NOT be silently lost: if it fails, the
    // /plan analyze read (which keys off profiles.active_insurance_plan_id) keeps
    // rendering the old plan even though insurance_plans.is_active already moved.
    // (A prior bug bundled this repoint with phantom copay columns into one
    // update that the DB rejected wholesale, stranding the pointer.) Async/
    // finalize path → log loudly rather than 500.
    const { error: repointErr } = await supabase
      .from("profiles")
      .update({ active_insurance_plan_id: doc.linked_insurance_plan_id })
      .eq("user_id", doc.user_id);
    if (!repointErr) {
      // S315 — a plan just became active: unlinked claims adopt it.
      await adoptUnlinkedClaims(supabase, doc.user_id as string, doc.linked_insurance_plan_id as string);
      // S317 — claims on the plan(s) just deactivated follow it too.
      await repointClaimsFromDeactivatedPlans(
        supabase,
        doc.user_id as string,
        activeBeforeIds,
        doc.linked_insurance_plan_id as string,
      );
    }
    if (repointErr) {
      console.error(
        `[documents/status activate_plan] profile repoint FAILED for user ${doc.user_id} → plan ${doc.linked_insurance_plan_id}:`,
        repointErr.message,
      );
    }

    // New plan row read up front — its insurer feeds the card-preservation
    // decision, and its data backfills the profile below.
    const { data: newPlan } = await supabase
      .from("insurance_plans")
      .select("insurer_name, plan_name, plan_type, state, group_number, member_id, in_deductible_individual, in_oop_max_individual, source")
      .eq("id", doc.linked_insurance_plan_id)
      .single();

    // S292 — THE shared decision (insurer-match.ts). Assembly (prior active
    // was a card/manual stub or nothing) and same-family switches PRESERVE the
    // card IDs; only a confident cross-insurer switch clears them.
    const { preserveCard } = await decideCardPreservation(supabase, {
      priorActiveSource,
      priorInsurerName: (priorProfile?.insurer as string | null) ?? null,
      newInsurerName: (newPlan?.insurer_name as string | null) ?? null,
    });
    const keptMemberId = preserveCard ? ((priorProfile?.member_id as string | null) ?? null) : null;
    const keptGroupNumber = preserveCard ? ((priorProfile?.group_number as string | null) ?? null) : null;
    const cardCleared =
      !preserveCard && (priorProfile?.member_id != null || priorProfile?.group_number != null);

    // Clear stale plan-specific fields from profile (preserves personal info: name, DOB, phone, etc.)
    // New plan's extracted values will backfill via process-plan or next card scan.
    // Card IDs (member_id/group_number) follow the preservation decision above
    // instead of being cleared unconditionally.
    const { error: clearErr } = await supabase
      .from("profiles")
      .update({
        // Clear all cost/plan fields — stale data from old plan (personal info preserved)
        insurer: null, plan_name: null, plan_type: null, state: null,
        group_number: keptGroupNumber, member_id: keptMemberId,
        deductible_individual: null, oop_max_individual: null,
        copay_primary: null, copay_specialist: null, copay_er: null,
        coinsurance_pct: null,
        matched_plan_id: null, plan_source: null,
      })
      .eq("user_id", doc.user_id);
    if (clearErr) {
      console.error(
        `[documents/status activate_plan] profile stale-field clear FAILED for user ${doc.user_id}:`,
        clearErr.message,
      );
    }

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

      // S292 — preserved card IDs ride onto the newly-activated plan row too
      // (they describe the user's enrollment in THIS plan once the pair is
      // coherent — same as set-active-canonical's cardCarry). Fill-only:
      // never overwrite IDs the plan row already has.
      const planCardCarry: Record<string, unknown> = {};
      if (keptMemberId != null && newPlan.member_id == null) planCardCarry.member_id = keptMemberId;
      if (keptGroupNumber != null && newPlan.group_number == null) planCardCarry.group_number = keptGroupNumber;
      if (Object.keys(planCardCarry).length > 0) {
        await supabase.from("insurance_plans").update(planCardCarry).eq("id", doc.linked_insurance_plan_id);
      }
    }

    // Ing-J (S127) — bind canonical to the newly-activated plan when the
    // mismatch path left canonical_plan_id NULL. process-plan.ts stores
    // pending_canonical_match on doc.insurer_mismatch when the canonical
    // fuzzy match returned 0.7-0.9 confidence (needsConfirmation=true);
    // the row's canonical_plan_id stays NULL until the user resolves.
    // User clicking "Use this plan" on the mismatch modal is an explicit
    // assertion that the doc's plan is correct AND different from the
    // suggested fuzzy match — so reject the pending match (decreases its
    // confidence) + create a fresh canonical for the doc's actual plan +
    // fire canonical-promotion (which also fires the Ing-A auto-reparse
    // triage hook when auto_reparse_enabled flag is ON).
    //
    // Non-fatal — canonical binding failure can't block the activation.
    try {
      const { data: planRow } = await supabase
        .from("insurance_plans")
        .select("canonical_plan_id")
        .eq("id", doc.linked_insurance_plan_id)
        .single();

      if (planRow && !planRow.canonical_plan_id) {
        const { data: docFull } = await supabase
          .from("documents")
          .select("insurer_mismatch")
          .eq("id", documentId)
          .single();
        const insurerMismatch = (docFull?.insurer_mismatch as
          | { pending_canonical_match?: { canonicalPlanId?: string } }
          | null) ?? null;
        const pendingMatchCanonicalId = insurerMismatch?.pending_canonical_match?.canonicalPlanId;

        if (pendingMatchCanonicalId) {
          const { rejectCanonicalMatch } = await import("@/lib/plan/canonical-match");
          const newCanonicalId = await rejectCanonicalMatch(
            supabase,
            doc.linked_insurance_plan_id,
            pendingMatchCanonicalId,
          );

          // Clear pending_canonical_match from document metadata (superseded).
          const updatedMismatch = { ...(insurerMismatch as Record<string, unknown>) };
          delete updatedMismatch.pending_canonical_match;
          await supabase.from("documents").update({
            insurer_mismatch:
              Object.keys(updatedMismatch).length > 0 ? updatedMismatch : null,
          }).eq("id", documentId);

          console.log(
            `[activate_plan] Ing-J canonical-binding: rejected pending=${pendingMatchCanonicalId.slice(0, 8)}…, created new=${newCanonicalId.slice(0, 8)}… for plan=${doc.linked_insurance_plan_id.slice(0, 8)}…`,
          );

          // Fire canonical-promotion flywheel for the newly-bound canonical.
          // Mirrors process-plan.ts:1229 / process-eoc.ts:135 call pattern so
          // Pattern 1 #14 user-scoped writes + Ing-A auto-reparse triage hook
          // both fire as on the original parse path. Non-fatal nested.
          try {
            const { commitUploadAndEvaluateCorroboration, PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC } =
              await import("@/lib/parser/commit-and-evaluate");
            const candidates = PHASE_4_0_6_PLAN_IDENTITY_FIELDS_SBC.map((fieldName) => ({
              serviceSlug: null as string | null,
              fieldName,
            }));
            const result = await commitUploadAndEvaluateCorroboration(supabase, {
              canonicalPlanId: newCanonicalId,
              actorUserId: doc.user_id,
              fireSource: "activate-plan-mismatch",
              candidates,
              documentId,
            });
            console.log(
              `[canonical-promotion] [activate_plan] canonical=${newCanonicalId.slice(0, 8)}… candidates=${candidates.length} fired=${result.promotionsFired} challenges=${result.challengeCandidates} errors=${result.errors.length}`,
            );
          } catch (promotionErr) {
            console.error("[activate_plan] canonical-promotion non-fatal:", promotionErr);
          }
        } else {
          // Rare: row has no canonical AND no pending_canonical_match was
          // recorded by the upstream parser. Leaves the row unbound; surfaced
          // for investigation rather than silently fixed (don't paper over a
          // parser-side gap).
          console.warn(
            `[activate_plan] Plan ${doc.linked_insurance_plan_id.slice(0, 8)}… has no canonical_plan_id and no pending_canonical_match — leaving unbound (rare; investigate if seen).`,
          );
        }
      }
    } catch (err) {
      console.error("[activate_plan] Ing-J canonical-binding non-fatal:", err);
    }

    // S292 — honest report: needsCardRescan only when card IDs were ACTUALLY
    // cleared (confident cross-insurer switch with IDs on file). Assembly and
    // same-family switches preserve them, and the client must not wipe its
    // card display for a card that still exists server-side.
    return NextResponse.json({ success: true, needsCardRescan: cardCleared });
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

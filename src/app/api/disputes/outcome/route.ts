/**
 * GET /api/disputes/outcome — Fetch the authenticated user's dispute history.
 * POST /api/disputes/outcome — Update a dispute's outcome (status, amount recovered).
 *
 * S74 hardening: both methods now require a Firebase bearer token and verify the
 * caller owns the target dispute. Prior to S74 the POST handler accepted any
 * disputeId from any caller, and GET took `userId` as a URL parameter — both
 * routes leaked across users. The "mark sent" UI added in S74 reuses POST with
 * `status='filed'`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { updateDisputeOutcome, getUserDisputes } from "@/lib/disputes/persist";
import { isOutcomeDetail } from "@/lib/disputes/outcome-taxonomy";
import { emitCaseEvents, type CaseEventInput } from "@/lib/case/case-events";
import { commitDisputeOutcome, OUTCOME_METADATA_KEYS } from "@/lib/disputes/commit-outcome";
import { bankSentVersion, stampUnsent } from "@/lib/disputes/sent-versions";
import {
  resolveDisputeReadiness,
  sendBlockers,
  SEND_GATE_ERROR,
} from "@/lib/disputes/dispute-readiness";
import { isFeatureEnabled, readFeatureFlagConfig } from "@/lib/config/product-flags";
import {
  computeCooldownUntil,
  computeEvidenceFingerprint,
  loadFingerprintInputForClaim,
} from "@/lib/disputes/evidence-fingerprint";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

async function resolveUserId(supabase: ReturnType<typeof createServerClient>, firebaseUid: string): Promise<string | null> {
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", firebaseUid)
    .single();
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const userId = await resolveUserId(supabase, decoded.uid);
  if (!userId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const result = await getUserDisputes(supabase, userId);
  // Guided Steps v1 (S297) — the sent-card countdown threshold, config-backed
  // (guided_steps_v1.config.sent_countdown_amber_days; no key → 7). Tunable
  // via a config upsert, no deploy.
  const sentCountdownAmberDays = await readFeatureFlagConfig(
    "guided_steps_v1",
    "sent_countdown_amber_days",
    7,
  );
  return NextResponse.json({ ...result, sentCountdownAmberDays });
}

export async function POST(req: NextRequest) {
  try {
    const decoded = await getAuthUser(req);
    if (!decoded) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      disputeId,
      status,
      enclosuresConfirmed,
      sendMethod,
      amountRecovered,
      resolutionDate,
      strategyNotes,
      // S74.6 D5 — optional capture of the alternative code the insurer paid on.
      // Only persisted when status='won_on_escalation' (paired with status
      // because pre-escalation wins typically use the original code).
      recodedAs,
      // dispute-letters v2 Zone-3 (S266) — optional nested outcome the FE derived
      // `status` from (via outcome-taxonomy). Persisted verbatim to
      // metadata.outcomeDetail as the launch record + seed for tracker-M
      // auto-advance. Advisory only — no auto-escalation here.
      outcomeDetail,
      // dispute-letters v2 Zone-3 (S266) — undo support (clicked in error). clearSentAt
      // unmarks a sent dispute (status back to drafted); clearOutcomeDetail reverts a
      // reported result (status back to filed). The FE sends the target status too.
      clearSentAt,
      clearOutcomeDetail,
    } = await req.json();

    if (!disputeId || !status) {
      return NextResponse.json(
        { error: "disputeId and status are required" },
        { status: 400 }
      );
    }

    // Zone-3: outcomeDetail is optional (back-compat with mark-sent + legacy
    // callers that send only `status`), but if present it must be a known value.
    if (outcomeDetail !== undefined && !isOutcomeDetail(outcomeDetail)) {
      return NextResponse.json(
        { error: "outcomeDetail is not a recognized outcome" },
        { status: 400 }
      );
    }

    // S74: the new lifecycle vocabulary (Session 35+) coexists with the legacy
    // statuses. The mark-sent button on the disputes toolbar POSTs with
    // status='filed' to transition the dispute from drafted → filed.
    const validStatuses = [
      "filed",
      "in_progress",
      "won",
      "lost",
      "settled",
      "withdrawn",
      "won_on_escalation",
      "settled_on_escalation",
      "dispute_letter_drafted",
      "court_documentation_drafted",
    ];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const supabase = createServerClient();
    const userId = await resolveUserId(supabase, decoded.uid);
    if (!userId) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Ownership check — verify the dispute belongs to the authenticated user
    // BEFORE running the update. Without this guard any authenticated user
    // could mutate any dispute by knowing its UUID.
    const { data: existing } = await userScoped(supabase, userId)
      .table("dispute_outcomes")
      .select(
        // S302 — dispute_type / insurance_plan_id / claim_line_item_id feed the
        // shared readiness resolver used by the send gate below.
        "id, user_id, status, filed_date, claim_id, letter_content, sent_at, metadata, dispute_type, insurance_plan_id, claim_line_item_id",
      )
      .eq("id", disputeId)
      .single();

    if (!existing || existing.user_id !== userId) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    // S311 (tree §2.1) — a CANCELLED letter is void by the user's own choice:
    // marking it sent (or stamping any outcome) would resurrect a read-only
    // exhibit into a live record — the corpse's page rendered a working
    // "Mark as sent" while redraft had its 409 since S308; this writer was
    // the missed sibling. Deliberately narrower than driftMachineryApplies:
    // a RESOLVED-without-send row must stay outcome-correctable (lost →
    // settled, amount fixes), so only the cancelled status blocks here.
    if (((existing.status as string | null) ?? "") === "cancelled") {
      return NextResponse.json({ error: "letter_cancelled" }, { status: 409 });
    }

    // ── S302 SEND GATE ────────────────────────────────────────────────────────
    // Andrew: "make sure the letter can't be sent or used until the required
    // fields are added." The screen locks the buttons; this is the backstop on
    // the RECORD — marking a letter sent starts the response clock, schedules
    // the follow-up chain, and feeds the flywheel, so an unready letter must
    // not be able to claim any of it.
    //
    // Fires ONLY on the genuine mark-sent transition: target `filed`, not an
    // undo (`clearSentAt`), and not already sent — which is what distinguishes
    // it from undoResultPayload, whose target status is also `filed` but which
    // runs on a letter that IS sent.
    //
    // Judged by the SAME resolver the letter page renders from, so the button's
    // state and the route's verdict cannot disagree. Flag-gated in lockstep
    // with the floor's own definition: with `letter_requirements_v1` OFF the
    // floor still uses the legacy recipient mapping, under which a collector
    // letter fails for a provider address it never prints — enforcing that
    // would lock a user out of sending a correct letter.
    const isMarkSent = status === "filed" && !clearSentAt && existing.sent_at == null;
    if (isMarkSent) {
      const letterRequirementsOn = await isFeatureEnabled("letter_requirements_v1");
      if (letterRequirementsOn) {
        const extraLineIds =
          ((existing.metadata as Record<string, unknown> | null)
            ?.claimLineItemIds as string[] | undefined) ?? [];
        const readiness = await resolveDisputeReadiness(supabase, {
          userId,
          dispute: existing,
          lineItemIds: Array.from(
            new Set([existing.claim_line_item_id, ...extraLineIds].filter(Boolean)),
          ) as string[],
        });
        const blockers = sendBlockers(readiness.strength?.readiness ?? null, letterRequirementsOn);
        if (blockers.length > 0) {
          return NextResponse.json(
            { error: SEND_GATE_ERROR, blockers },
            { status: 409 },
          );
        }
      }
    }

    const success = await updateDisputeOutcome(supabase, disputeId, {
      status,
      amountRecovered: amountRecovered ?? undefined,
      resolutionDate: resolutionDate ?? undefined,
      strategyNotes: strategyNotes ?? undefined,
    });

    if (!success) {
      return NextResponse.json({ error: "Failed to update dispute" }, { status: 500 });
    }

    // dispute-letters v2 Zone-3 (S266) — persist the nested outcome verbatim to
    // metadata.outcomeDetail (JSONB, Rule #9 store-first — no schema change). The
    // coarse `status` column above was derived from this by the FE; keeping the
    // fine-grained outcome is the launch record + the seed for the tracker-M
    // auto-advance state machine. Merge (never clobber sibling metadata). Non-
    // fatal — the status write already succeeded and is the source of truth.
    // S331 — the metadata trio, provenance and follow-up quieting now live in
    // ONE writer shared with the DFY operator path (see commit-outcome). The
    // coarse status above stays here: it can be `won_on_escalation`, which the
    // taxonomy mapper never returns. The returned event is emitted below, in
    // the same batch as this route's own.
    let outcomeEvent: CaseEventInput | null = null;
    if (outcomeDetail && isOutcomeDetail(outcomeDetail)) {
      outcomeEvent = await commitDisputeOutcome(supabase, {
        disputeId,
        claimId: (existing.claim_id as string | null) ?? null,
        userId,
        outcomeDetail,
        status,
        existingMetadata: (existing.metadata as Record<string, unknown> | null) ?? null,
        reportedBy: { actor: "user" },
      });
    }

    // S320 — the enclosure-aware send record: the attestation + method from
    // surfaces that ran the enclosure confirm (external review today). Merge,
    // never clobber; non-fatal (the send itself already recorded above).
    if (status === "filed" && (enclosuresConfirmed === true || typeof sendMethod === "string")) {
      try {
        const baseMetadata = (existing.metadata as Record<string, unknown>) ?? {};
        await userScoped(supabase, userId)
          .table("dispute_outcomes")
          .update({
            metadata: {
              ...baseMetadata,
              ...(enclosuresConfirmed === true
                ? { sentEnclosuresConfirmed: true, sentEnclosuresConfirmedAt: new Date().toISOString() }
                : {}),
              ...(typeof sendMethod === "string" ? { sendMethod: sendMethod.slice(0, 32) } : {}),
            },
          })
          .eq("id", disputeId);
      } catch (stampErr) {
        console.warn("[disputes/outcome] enclosure-record stamp failed (non-fatal):", stampErr);
      }
    }

    // dispute-letters v2 Zone-3 (S266) — undo. clearSentAt un-sends (drops sent_at +
    // cooldown so the stage returns to draft); clearOutcomeDetail reverts a reported
    // result (drops metadata.outcomeDetail so the escalate CTA + terminal stage clear).
    // The coarse status was already set by updateDisputeOutcome above. Non-fatal.
    if (clearSentAt || clearOutcomeDetail) {
      try {
        const patch: Record<string, unknown> = {};
        if (clearSentAt) {
          patch.sent_at = null;
          patch.cooldown_until = null;
          // §0.9b (S299 phase 2a) — the marked-sent snapshot is RETAINED and
          // labeled ("Marked sent «date», then unsent — never mailed"), never
          // again rendered as a mailed letter. sent_letter itself is left in
          // place (S74.5 column semantics unchanged; the stack is the label
          // authority).
          patch.metadata = stampUnsent(
            (existing.metadata as Record<string, unknown> | null) ?? null,
            new Date().toISOString(),
          );
        }
        if (clearOutcomeDetail) {
          const baseMetadata = {
            ...(((patch.metadata as Record<string, unknown> | undefined) ??
              (existing.metadata as Record<string, unknown>)) ??
              {}),
          };
          for (const k of OUTCOME_METADATA_KEYS) delete baseMetadata[k];
          patch.metadata = baseMetadata;
        }
        await userScoped(supabase, userId)
          .table("dispute_outcomes")
          .update(patch)
          .eq("id", disputeId);
      } catch (err) {
        console.error("[disputes/outcome] undo patch failed (non-fatal):", err);
      }
    }

    // S74.6 D5 — capture recoded_as_code on won_on_escalation outcomes. Writes
    // directly to dispute_outcomes columns (mig 094); separate from
    // updateDisputeOutcome which doesn't yet know about these columns. We
    // intentionally accept the recodedAs only when status='won_on_escalation'
    // so the "insurer paid on a different code" signal is honest — pre-
    // escalation wins typically pay on the original code.
    if (
      status === "won_on_escalation" &&
      recodedAs &&
      typeof recodedAs.code === "string" &&
      typeof recodedAs.codeType === "string" &&
      recodedAs.code.trim().length > 0 &&
      recodedAs.codeType.trim().length > 0
    ) {
      const recodedCode = recodedAs.code.trim();
      const recodedCodeType = recodedAs.codeType.trim();
      try {
        await userScoped(supabase, userId)
          .table("dispute_outcomes")
          .update({
            recoded_as_code: recodedCode,
            recoded_as_code_type: recodedCodeType,
          })
          .eq("id", disputeId);

        // S74.6 D5 §E.1 — cast `dispute_won_recoding` vote on the
        // (recodedAs.code, slug) billing_code_identity row so the peer-code
        // engine + Pattern 1 #3 promotion threshold gains real-world signal
        // from "the insurer paid on this alternative code." Pattern 1 #15
        // gated inside the helper; non-verified users no-op. Non-blocking on
        // failure — the recoded_as_code columns are already written above
        // and provide the dispute-letter alt-code surface independent of the
        // flywheel vote.
        try {
          const { recordDisputeWonRecoding } = await import(
            "@/lib/parser/code-identity-promotion"
          );
          const result = await recordDisputeWonRecoding({
            userId,
            disputeId,
            recodedAsCode: recodedCode,
            recodedAsCodeType: recodedCodeType,
          });
          if (!result.contributedToFlywheel) {
            console.log(
              "[disputes/outcome] dispute_won_recoding vote skipped:",
              result.reason,
            );
          }
        } catch (voteErr) {
          console.error(
            "[disputes/outcome] dispute_won_recoding vote write failed (non-fatal):",
            voteErr,
          );
        }
      } catch (err) {
        console.error(
          "[disputes/outcome] D5 recoded_as_code capture failed (non-fatal):",
          err,
        );
      }
    }

    // S74.5 D16 — Mark-as-Sent snapshot capture. When the transition is
    // drafted → filed AND sent_at hasn't already been captured (idempotent
    // re-clicks shouldn't reset the cooldown clock), snapshot the current
    // letter_content into sent_letter + set sent_at + cooldown_until +
    // refresh evidence_fingerprint. Gated on flag so OFF preserves
    // pre-S74.5 behavior exactly.
    if (status === "filed" && !existing.sent_at) {
      try {
        const flywheelOn = await isFeatureEnabled(
          "s74_5_categorization_flywheel_v1",
        );
        // Cost-Share v2 (Finding 4) — also snapshot the sent-letter fingerprint
        // under the cost-share flag so save matches the [disputeId] view's
        // (flywheelOn || costShareV2) compare gate (symmetric if flywheel is off).
        const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
        if (flywheelOn || costShareV2) {
          const sentAt = new Date();
          const cooldownUntil = computeCooldownUntil(sentAt, 30);

          let fingerprint: string | null = null;
          if (existing.claim_id) {
            // UX-2 — sentAt is EXPLICITLY the send being stamped: the loader
            // therefore produces the evidence-only shape (no compose basis).
            // That freeze is what makes the post-unsend first view a guaranteed
            // mismatch → the draft rebuilds to current inputs immediately.
            const fpInput = await loadFingerprintInputForClaim(
              supabase,
              existing.claim_id as string,
              userId,
              {
                sentAt: sentAt.toISOString(),
                metadata: (existing.metadata as Record<string, unknown> | null) ?? null,
                insurancePlanId: (existing.insurance_plan_id as string | null) ?? null,
              },
            );
            if (fpInput) fingerprint = computeEvidenceFingerprint(fpInput);
          }

          await userScoped(supabase, userId)
            .table("dispute_outcomes")
            .update({
              sent_letter: existing.letter_content,
              sent_at: sentAt.toISOString(),
              cooldown_until: cooldownUntil.toISOString(),
              evidence_fingerprint:
                fingerprint ?? undefined,
              last_refresh_at: sentAt.toISOString(),
              // §0.9 rule 4 (S299 phase 2a) — bank this send into the version
              // stack (additive metadata; sent_letter stays the current-
              // artifact column). Same write as the snapshot, no extra trip.
              metadata: bankSentVersion(
                (existing.metadata as Record<string, unknown> | null) ?? null,
                (existing.letter_content as string) ?? "",
                sentAt.toISOString(),
                // Recipient AS MAILED (one truth per version — S299).
                (((existing.metadata as Record<string, unknown> | null)
                  ?.collector as { name?: string; address?: string | null } | undefined) ??
                  null),
              ),
            })
            .eq("id", disputeId);
        }
      } catch (err) {
        console.error(
          "[disputes/outcome] D16 sent-letter snapshot failed (non-fatal):",
          err,
        );
      }

      // Surface 4 (clarity redesign) — mark-as-sent starts the reminder clock:
      // reschedule the still-pending flat-cadence initial follow-up to
      // sent + firstDays (or create one if none is pending). Same flag gate
      // as follow-up creation; non-fatal like the snapshot above.
      try {
        const followupsEnabled = await isFeatureEnabled("dispute_feedback_loop");
        if (followupsEnabled) {
          const { rescheduleInitialFollowupOnSent } = await import(
            "@/lib/disputes/followups"
          );
          await rescheduleInitialFollowupOnSent(supabase, {
            disputeId,
            userId,
            sentDate: new Date(),
          });
        }
      } catch (err) {
        console.error(
          "[disputes/outcome] follow-up reschedule failed (non-fatal):",
          err,
        );
      }
    }

    // Timeline unification Phase 0 (S298, mig 221) — case-history events for
    // this mutation, derived from the request shape + the row's PRIOR state
    // (existing.* was read before any write above). Flag-gated + fail-soft
    // inside the emitter; payloads carry references only.
    if (existing.claim_id) {
      const claimId = existing.claim_id as string;
      const events: CaseEventInput[] = [];
      if (clearSentAt) {
        events.push({ claimId, disputeId, kind: "letter_unsent" });
      }
      if (clearOutcomeDetail) {
        events.push({ claimId, disputeId, kind: "outcome_undone" });
      }
      if (outcomeEvent) events.push(outcomeEvent);
      // Mirror of the D16 snapshot guard: only the genuine drafted→sent
      // transition (idempotent re-clicks and undo round-trips excluded).
      if (
        status === "filed" &&
        !existing.sent_at &&
        !clearSentAt &&
        !clearOutcomeDetail &&
        !outcomeDetail
      ) {
        events.push({
          claimId,
          disputeId,
          kind: "letter_sent",
          payload: { statusFrom: existing.status },
        });
      }
      await emitCaseEvents(supabase, userId, events);
    }

    // S300 phase 2b — a logged response RE-ANCHORS this letter's nudge chain.
    // The banner is a pure pointer now, so its "Still waiting" button (the only
    // thing that used to advance initial→reprompt→final) is gone; without this
    // a user who reports "they asked for more information" — one of the FIVE
    // outcome details that map to `in_progress`, so persist.ts's terminal sweep
    // never fires — keeps being asked "did you hear back?" forever.
    // Deliberately re-anchors instead of cancelling: those cases are still
    // OPEN, and going dark on them would lose the outcome that actually feeds
    // the flywheel. Fail-soft inside.
    // (follow-up re-anchoring runs inside commitDisputeOutcome above.)

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Dispute outcome update error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

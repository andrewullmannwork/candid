/**
 * POST /api/disputes/[disputeId]/escalate — dispute-letters v2 Zone-3 (S266).
 *
 * User-triggered LADDER ADVANCE: from a viewed dispute, spawn the next-rung
 * letter (external_review / final_notice / debt_validation) as a NEW dispute
 * row, rendered server-side from the source dispute's claim (mirrors the redraft
 * path — no client auditReport/findingIds). NOT auto-advance (tracker M is the
 * automated version); the user clicks, we produce the letter.
 *
 * Gates (checkEscalateGate — same posture as /api/disputes/generate, so escalate
 * can't be a laxer bypass): allowlist (only the 3 ladder types) · tier
 * (final_notice/external_review = Pro; debt_validation free) · exhaustion
 * (external_review requires an attested final internal denial) · S303
 * rung-already-taken (409 when a letter of the target type is already on the
 * claim — persistDisputeLetter's dedupe excludes resolved rows by design, so
 * without this a stale client can insert a second letter on an exhausted rung).
 *
 * Auth: Firebase bearer token; verifies the user owns the SOURCE dispute.
 * Returns: { success, disputeId } — the new (or dedup-updated) dispute to open.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { driftMachineryApplies } from "@/lib/disputes/evidence-fingerprint";
import { resolvePlanContext, type InsurerAddressOverride } from "@/lib/disputes/plan-context";
import { validateAnchor } from "@/lib/disputes/deadline-anchors";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { rerenderDisputeLetter } from "@/lib/disputes/rerender";
import { persistDisputeLetter } from "@/lib/disputes/persist";
import { loadClaimLitigationAttested } from "@/lib/disputes/letter-access-state";
import { checkEscalateGate } from "@/lib/disputes/escalate-gate";
import { resolveLetterTypeFromDispute, letterPatientIdentityFromMeta } from "@/lib/disputes/letter-type";
import type { CaseLetterRef } from "@/lib/disputes/outcome-taxonomy";
import { evaluateDeadline, readDeadlineConfig } from "@/lib/disputes/deadline-engine";
import { loadServerSubscription } from "@/lib/subscription/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  computeEvidenceFingerprint,
  loadFingerprintInputForClaim,
} from "@/lib/disputes/evidence-fingerprint";
import { emitCaseEvents, type CaseEventInput } from "@/lib/case/case-events";

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
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const {
    targetLetterType,
    collector,
    appealExhausted,
    certifiedMail,
    collectorFirstContactDate,
    denialNoticeDate,
  } = (body ?? {}) as {
    targetLetterType?: unknown;
    collector?: { name: string; address?: string | null; originalCreditor?: string | null };
    appealExhausted?: { attested: boolean; denialDate?: string | null };
    certifiedMail?: boolean;
    collectorFirstContactDate?: string | null;
    denialNoticeDate?: string | null;
  };

  // S309 F15 — this route is a SECOND writer of the deadline anchors the
  // letters recite; it stored them unvalidated (the deadline-inputs route
  // always validated). One shared validator now guards every write path.
  {
    const todayIso = new Date().toISOString().slice(0, 10);
    if (denialNoticeDate !== undefined && !validateAnchor(denialNoticeDate, todayIso).ok) {
      return NextResponse.json(
        { error: "denialNoticeDate must be YYYY-MM-DD on or before today, or null" },
        { status: 400 },
      );
    }
    if (collectorFirstContactDate !== undefined && !validateAnchor(collectorFirstContactDate, todayIso).ok) {
      return NextResponse.json(
        { error: "collectorFirstContactDate must be YYYY-MM-DD on or before today, or null" },
        { status: 400 },
      );
    }
    if (appealExhausted?.denialDate != null && !validateAnchor(appealExhausted.denialDate, todayIso).ok) {
      return NextResponse.json(
        { error: "appealExhausted.denialDate must be YYYY-MM-DD on or before today, or null" },
        { status: 400 },
      );
    }
  }

  // Ownership — load the SOURCE dispute (must belong to the caller).
  const { data: dispute, error } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .single();
  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // S311 (tree §2.1) — a VOID letter is a read-only exhibit (S308's rule;
  // this route was reachable from a cancelled letter's page and its write
  // would have moved the frozen row's updated_at). Sent letters stay
  // writable — their metadata is the knowledge layer follow-ups read.
  // One rule, stated once: driftMachineryApplies === false ⇔ void.
  if (
    !driftMachineryApplies(
      (dispute.status as string | null) ?? null,
      dispute.sent_at ? new Date(dispute.sent_at as string) : null,
    )
  ) {
    return NextResponse.json({ error: "letter_void" }, { status: 409 });
  }
  if (!dispute.claim_id) {
    return NextResponse.json({ error: "Dispute has no linked claim" }, { status: 400 });
  }

  // S303 — every letter already on this claim, for the rung-taken gate below.
  // Same letter-type resolver the projector and the GET's `siblings` use, so
  // the gate cannot judge a letter's type differently from the surfaces that
  // decided whether to offer the escalation.
  const { data: siblingRows } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("id, dispute_type, status, metadata")
    .eq("claim_id", dispute.claim_id);
  const caseLetters: CaseLetterRef[] = ((siblingRows ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
      disputeId: r.id as string,
      letterType: resolveLetterTypeFromDispute(
        r as { dispute_type: string; metadata?: Record<string, unknown> | null },
      ),
      status: (r.status as string | null) ?? null,
    }),
  );

  // Gate — allowlist + tier + exhaustion + rung-already-taken (fail-closed;
  // same posture as generate).
  const subscription = await loadServerSubscription(supabase, user.id);
  // S326 (Rule 8) — the litigation hold reaches escalation exactly like
  // generate/redraft (one gate, one loader).
  const litigationAttested = await loadClaimLitigationAttested(
    supabase,
    user.id,
    (dispute.claim_id as string | null) ?? null,
  );
  const gate = checkEscalateGate({
    targetLetterType,
    isPro: subscription.isPro,
    appealExhausted,
    caseLetters,
    sourceDisputeId: dispute.id as string,
    litigationAttested,
  });
  if (!gate.ok) {
    return NextResponse.json(
      gate.reason ? { error: gate.error, reason: gate.reason } : { error: gate.error },
      { status: gate.status },
    );
  }
  const letterType = gate.targetLetterType;

  const meta = (dispute.metadata as Record<string, unknown> | null) ?? null;
  const extraIds = (meta?.claimLineItemIds as string[] | undefined) || [];
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];

  // Plan context — carry the source dispute's user-supplied appeals address +
  // canonical bind + plan pin, so external_review mails to the right Appeals dept.
  const insurerAddressOverride =
    (meta?.insurerAddressOverride as InsurerAddressOverride | null) ?? null;
  const canonicalPlanIdForBillYear =
    typeof meta?.canonicalPlanIdForBillYear === "string" && meta.canonicalPlanIdForBillYear.length > 0
      ? (meta.canonicalPlanIdForBillYear as string)
      : null;
  const planContext = await resolvePlanContext(supabase, {
    userId: user.id,
    claimId: dispute.claim_id,
    canonicalPlanIdForBillYear,
    insurerAddressOverride,
    pinnedInsurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
  });

  // Evidence — resolved for parity with the redraft/generate render path. The
  // escalation templates don't consume it, so a failure is non-fatal.
  let evidence = null;
  try {
    evidence = await resolveEvidence(supabase, {
      userId: user.id,
      claimIds: [dispute.claim_id],
      lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
      planContext,
      letterType,
      disputeId: dispute.id,
      canonicalPlanIdForBillYear,
    });
  } catch (err) {
    console.error("[disputes/escalate] evidence resolve failed (non-fatal):", err);
  }

  // Deadline for the NEW letter (mirror generate): the FDCPA §1692g window teeth
  // for debt_validation + the governing deadline/countdown for the new dispute.
  const deadlineEngineOn = await isFeatureEnabled("dispute_deadline_engine_v1");
  let governingDeadlineDate: string | null = null;
  let deadlineType: string | null = null;
  let debtWithinWindow: boolean;
  if (deadlineEngineOn) {
    const deadlineConfig = await readDeadlineConfig(supabase);
    const dr = evaluateDeadline(
      {
        letterType,
        denialNoticeDate: denialNoticeDate ?? null,
        collectorFirstContactDate: collectorFirstContactDate ?? null,
      },
      deadlineConfig,
    );
    debtWithinWindow = dr.debtWithinWindow;
    governingDeadlineDate = dr.governingDeadlineDate;
    deadlineType = dr.deadlineType;
  } else {
    debtWithinWindow = (() => {
      if (!collectorFirstContactDate) return false;
      const first = Date.parse(collectorFirstContactDate);
      if (Number.isNaN(first)) return false;
      return Date.now() - first <= 30 * 24 * 60 * 60 * 1000;
    })();
  }

  // Render the new-rung letter server-side (findings:[] — the escalation templates
  // recite via attested dates, not the audit findings).
  const accountNumber = (meta?.accountNumber as string | null) ?? null;
  const rerendered = await rerenderDisputeLetter(supabase, {
    // S306 — NULL, deliberately: the letter being composed has no row yet
    // (persist runs below), and the id in hand is the PARENT dispute's. Passing
    // that here excluded the parent's send from the child's recital — a final
    // notice that could not recite the very letter it escalates from.
    composingDisputeId: null,
    userId: user.id,
    letterType,
    claimId: dispute.claim_id,
    lineItemIds: allLineItemIds,
    planContext,
    evidence,
    accountNumber,
    // S300 (Item N) — `priorContactDates` from the request body is no longer
    // threaded: rerenderDisputeLetter derives the recital from the case
    // projection + attested calls server-side. The rail passed one date (the
    // parent's latest send); the ledger knows every genuine send, and it can't
    // be shaped by the client.
    certifiedMail: typeof certifiedMail === "boolean" ? certifiedMail : undefined,
    appealExhausted: appealExhausted ?? undefined,
    collector: collector ?? undefined,
    debtWithinWindow,
    // S306 (UX-2) — the child letter names the SAME patient the parent's
    // identity answer resolved; without this an escalation reverted to the
    // account-holder default until the user re-answered on the child.
    patientIdentity: letterPatientIdentityFromMeta(meta),
  });
  if (!rerendered) {
    return NextResponse.json({ error: "Letter generation failed" }, { status: 500 });
  }

  // Persist a NEW dispute row for the new type (dedup-safe: persistDisputeLetter
  // keys on (user, claim_line_item, dispute_type), so a repeat escalation updates
  // the same target-type row). Carry the source dispute's amount.
  const amountDisputed = Number(dispute.amount_disputed) || 0;
  const result = await persistDisputeLetter(supabase, {
    userId: user.id,
    claimId: dispute.claim_id,
    claimLineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
    letterType,
    amountDisputed,
    letterContent: rerendered.body,
    insurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
    ...(deadlineEngineOn ? { deadline: { governingDeadlineDate, deadlineType } } : {}),
  });
  if (!result?.disputeId) {
    return NextResponse.json({ error: "Failed to persist escalation" }, { status: 500 });
  }

  // Persist the escalation inputs onto the NEW dispute's metadata so re-views, the
  // Zone-2 deadline surface, and a future redraft keep the collector + anchor
  // dates. Merge (never clobber persistDisputeLetter's metadata.letterType).
  // Non-fatal — the rendered letter_content already carries these.
  try {
    const { data: newRow } = await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .select("metadata, sent_at")
      .eq("id", result.disputeId)
      .single();
    const baseMeta = (newRow?.metadata as Record<string, unknown>) ?? {};
    const merged: Record<string, unknown> = { ...baseMeta, escalatedFromDisputeId: dispute.id };
    // S299 guard — a SENT letter's recipient identity is immutable (S74.5
    // spirit; the E2E "Test" clobber re-addressed a mailed letter's metadata).
    // On a sent child, collector fields fill only when MISSING; drafts keep
    // today's overwrite semantics.
    const childSent = newRow?.sent_at != null;
    if (collector && (!childSent || baseMeta.collector == null)) merged.collector = collector;
    if (
      collectorFirstContactDate &&
      (!childSent || baseMeta.collectorFirstContactDate == null)
    )
      merged.collectorFirstContactDate = collectorFirstContactDate;
    if (denialNoticeDate) merged.denialNoticeDate = denialNoticeDate;
    if (appealExhausted) merged.appealExhausted = appealExhausted;
    // S306 (UX-2) — persist the compose inputs the birth render used, so a
    // later regenerate (live rebuild / redraft) composes the SAME letter
    // instead of renderGated-omitting the clauses. certifiedMail was never
    // persisted anywhere; accountNumber + the identity answer are carried
    // from the SOURCE letter (same account, same patient). Fill-only on the
    // identity keys: a child that somehow has its own answer keeps it.
    if (typeof certifiedMail === "boolean") merged.certifiedMail = certifiedMail;
    if (accountNumber && merged.accountNumber == null) merged.accountNumber = accountNumber;
    if (meta?.patientIdentityChoice != null && merged.patientIdentityChoice == null) {
      merged.patientIdentityChoice = meta.patientIdentityChoice;
      merged.patientCorrectedName = meta.patientCorrectedName ?? null;
      merged.patientIdentityResolved = meta.patientIdentityResolved ?? true;
      merged.patientIdentityResolvedAt = meta.patientIdentityResolvedAt ?? null;
    }
    await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .update({ metadata: merged })
      .eq("id", result.disputeId);
  } catch (err) {
    console.error("[disputes/escalate] escalation-input metadata persist failed (non-fatal):", err);
  }

  // S301 — seed the CLAIM-scoped collector knowledge from this capture.
  //
  // CollectorModal is where we first learn the agency, so the create path has to
  // write the same home the edit path (collector-contact) writes; otherwise the
  // same fact lives in two places and only one of them cascades. The dispute's
  // own metadata.collector above stays the AS-ADDRESSED record for this letter
  // (immutable once sent, S299) — this is the knowledge every LATER letter reads.
  //
  // Fill-only: never overwrite a stored value with a blank, so a re-escalation
  // that omits the address can't erase one the user already supplied. Non-fatal.
  if (collector && dispute.claim_id) {
    try {
      const { data: claimRow } = await userScoped(supabase, user.id)
        .table("claims")
        .select("id, metadata")
        .eq("id", dispute.claim_id)
        .single();
      const claimMeta = (claimRow?.metadata as Record<string, unknown> | null) ?? {};
      const existing = (claimMeta.collector as Record<string, unknown> | undefined) ?? {};
      const fill = (next: unknown, prev: unknown) =>
        typeof next === "string" && next.trim() ? next.trim() : (prev ?? null);
      const nextCollector = {
        ...existing,
        name: fill(collector.name, existing.name),
        address: fill(collector.address, existing.address),
        originalCreditor: fill(collector.originalCreditor, existing.originalCreditor),
        accountNumber: fill(
          (collector as { accountNumber?: string | null }).accountNumber,
          existing.accountNumber,
        ),
        source: existing.source ?? "user_supplied",
        updated_at: new Date().toISOString(),
      };
      await userScoped(supabase, user.id)
        .table("claims")
        .update({ metadata: { ...claimMeta, collector: nextCollector } })
        .eq("id", dispute.claim_id);
    } catch (err) {
      console.error("[disputes/escalate] claim collector seed failed (non-fatal):", err);
    }
  }

  // S298 (Andrew) — birth fingerprint. Escalation-created letters never got an
  // evidence_fingerprint (generate's D16 block stamps it; this route didn't),
  // so isDisputeStale read `current ≠ null-stored` and every freshly escalated
  // letter greeted the user with the "plan details changed since this was
  // drafted" banner seconds after drafting. Same flag gate + loader as the
  // sibling routes; non-fatal like every stamp here.
  try {
    const flywheelOn = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
    const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
    if (flywheelOn || costShareV2) {
      // UX-2 — birth-stamped as a DRAFT; metadata null (the merged metadata is
      // out of scope here) → compose fields null. A collector-bearing
      // escalation self-heals with one regenerate on first view.
      const fpInput = await loadFingerprintInputForClaim(supabase, dispute.claim_id, user.id, {
        sentAt: null,
        metadata: null,
        // S311 — the escalated letter inherits the parent's pin; if persist
        // pinned differently the first view self-heals (one regenerate),
        // same as the metadata:null birth pattern above.
        insurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
      });
      if (fpInput) {
        await userScoped(supabase, user.id)
          .table("dispute_outcomes")
          .update({ evidence_fingerprint: computeEvidenceFingerprint(fpInput) })
          .eq("id", result.disputeId);
      }
    }
  } catch (err) {
    console.error("[disputes/escalate] birth fingerprint stamp failed (non-fatal):", err);
  }

  // Timeline unification Phase 0 (S298, mig 221) — the track move + the new
  // rung's draft, in one batch. A debt_validation escalation IS the collections
  // capture (CollectorModal routes here), so it also emits collections_reported.
  // Flag-gated + fail-soft inside the emitter; references only.
  {
    const events: CaseEventInput[] = [
      {
        claimId: dispute.claim_id,
        disputeId: dispute.id,
        kind: "escalated",
        payload: { toDisputeId: result.disputeId, targetLetterType: letterType },
      },
      {
        claimId: dispute.claim_id,
        disputeId: result.disputeId,
        kind: "letter_drafted",
        payload: { letterType, escalatedFromDisputeId: dispute.id },
      },
    ];
    if (letterType === "debt_validation") {
      events.push({
        claimId: dispute.claim_id,
        disputeId: result.disputeId,
        kind: "collections_reported",
        payload: {
          hasCollector: !!collector,
          hasFirstContactDate: !!collectorFirstContactDate,
        },
      });
    }
    await emitCaseEvents(supabase, user.id, events);
  }

  return NextResponse.json({
    success: true,
    disputeId: result.disputeId,
    deduplicated: result.deduplicated,
  });
}

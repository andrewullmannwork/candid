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
 * (external_review requires an attested final internal denial).
 *
 * Auth: Firebase bearer token; verifies the user owns the SOURCE dispute.
 * Returns: { success, disputeId } — the new (or dedup-updated) dispute to open.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { resolvePlanContext, type InsurerAddressOverride } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { rerenderDisputeLetter } from "@/lib/disputes/rerender";
import { persistDisputeLetter } from "@/lib/disputes/persist";
import { checkEscalateGate } from "@/lib/disputes/escalate-gate";
import { evaluateDeadline, readDeadlineConfig } from "@/lib/disputes/deadline-engine";
import { loadServerSubscription } from "@/lib/subscription/server";
import { isFeatureEnabled } from "@/lib/config/product-flags";
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
    priorContactDates,
    collectorFirstContactDate,
    denialNoticeDate,
  } = (body ?? {}) as {
    targetLetterType?: unknown;
    collector?: { name: string; address?: string | null; originalCreditor?: string | null };
    appealExhausted?: { attested: boolean; denialDate?: string | null };
    certifiedMail?: boolean;
    priorContactDates?: string[];
    collectorFirstContactDate?: string | null;
    denialNoticeDate?: string | null;
  };

  // Ownership — load the SOURCE dispute (must belong to the caller).
  const { data: dispute, error } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .single();
  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }
  if (!dispute.claim_id) {
    return NextResponse.json({ error: "Dispute has no linked claim" }, { status: 400 });
  }

  // Gate — allowlist + tier + exhaustion (fail-closed; same posture as generate).
  const subscription = await loadServerSubscription(supabase, user.id);
  const gate = checkEscalateGate({
    targetLetterType,
    isPro: subscription.isPro,
    appealExhausted,
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
    disputeId: dispute.id,
    userId: user.id,
    letterType,
    claimId: dispute.claim_id,
    lineItemIds: allLineItemIds,
    planContext,
    evidence,
    accountNumber,
    priorContactDates: Array.isArray(priorContactDates) ? priorContactDates : undefined,
    certifiedMail: typeof certifiedMail === "boolean" ? certifiedMail : undefined,
    appealExhausted: appealExhausted ?? undefined,
    collector: collector ?? undefined,
    debtWithinWindow,
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
      .select("metadata")
      .eq("id", result.disputeId)
      .single();
    const baseMeta = (newRow?.metadata as Record<string, unknown>) ?? {};
    const merged: Record<string, unknown> = { ...baseMeta, escalatedFromDisputeId: dispute.id };
    if (collector) merged.collector = collector;
    if (collectorFirstContactDate) merged.collectorFirstContactDate = collectorFirstContactDate;
    if (denialNoticeDate) merged.denialNoticeDate = denialNoticeDate;
    if (appealExhausted) merged.appealExhausted = appealExhausted;
    await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .update({ metadata: merged })
      .eq("id", result.disputeId);
  } catch (err) {
    console.error("[disputes/escalate] escalation-input metadata persist failed (non-fatal):", err);
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

/**
 * POST /api/admin/dfy/engagements/[engagementId]/screen — run the intake gates (S330).
 *
 * Body: the three operator-attested answers read off the member's documents
 *   { planSponsorType, secondaryCoverageCdi, governmentProgram, memberAskedWhatToArgue }
 * Everything else is what the platform already knows: the member's screening
 * classification (snapshot at invitation, refreshed here), the litigation
 * attestation, the collections fact, the composition events, the adverse
 * determination and the deadline engine's runway, and the config thresholds.
 *
 * FAIL-CLOSED: every gate must pass. An ineligible applicant is TERMINATED with
 * the first failing gate's reason written on the row; they keep the free tool.
 * The full gate sheet is persisted on the engagement (intake JSONB) so the
 * record shows exactly what was screened, by whom, and when.
 */
import { NextRequest, NextResponse } from "next/server";
import { signedInstruments, paperComplete } from "@/lib/dfy/paper";
import { sendDfyDeclineEmail, sendDfyMatterUpdateEmail } from "@/lib/email/dfy-emails";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { operatorScoped, patchEngagement, OperatorAccessError } from "@/lib/security/operator-scoped";
import { maybeActivateEngagement } from "@/lib/dfy/sign";
import { loadClaimLitigationAttested } from "@/lib/disputes/letter-access-state";
import type { RegulatoryClassification } from "@/lib/disputes/forums";
import { evaluateIntake, type IntakeFacts, type PlanSponsorType, memberDeclineCopy, type IntakeDecision } from "@/lib/dfy/intake-gates";
import { computeRunway, loadInsurerLetter } from "@/lib/dfy/matter";
import { emitOperatorEvent, loadCompositionProof, operatorErrorResponse } from "@/lib/dfy/operator-action";

const SPONSOR_TYPES = new Set<PlanSponsorType>(["single_employer", "mewa_association_peo", "individual_marketplace", "unknown"]);

function tri(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, config, ip } = auth;
  const { engagementId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // evaluate (default) runs the gates and stores the decision — it never closes
  // anything; accept / decline are the operator's explicit calls; reopen undoes
  // a decline at intake (Andrew, S330 round 2: "Screen" must not cancel).
  const action = body.action === "accept" || body.action === "decline" || body.action === "reopen" ? (body.action as "accept" | "decline" | "reopen") : "evaluate";
  const operatorReason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  // What the operator read in the member's documents (Gate 1/2 facts) when the
  // plan row carries no classification of its own. Persisted on the engagement.
  const COVERAGE = new Set(["commercial_fully_insured", "employer_self_funded", "employer_self_funded_public", "medicare", "medicaid"]);
  const coverageType = typeof body.coverageType === "string" && COVERAGE.has(body.coverageType) ? (body.coverageType as RegulatoryClassification["coverageType"]) : null;
  const caRegulator = body.caRegulator === "DMHC" || body.caRegulator === "CDI" || body.caRegulator === "unknown" ? (body.caRegulator as "DMHC" | "CDI" | "unknown") : null;
  const planSponsorType = SPONSOR_TYPES.has(body.planSponsorType as PlanSponsorType) ? (body.planSponsorType as PlanSponsorType) : null;

  try {
    const scope = await operatorScoped(supabase, operatorUserId, engagementId, {
      statuses: action === "reopen" ? ["terminated"] : ["eligibility_pending", "signed"],
      requireHolder: false,
    });
    const e = scope.engagement;
    const now = new Date();

    const [profile, claim, plan, litigation, composition, insurerLetter] = await Promise.all([
      scope.table("profiles").select("state").maybeSingle(),
      scope.table("claims").select("id, insurance_plan_id, metadata").maybeSingle(),
      // refreshed classification: the member may have answered screening since the invitation
      (async () => {
        const { data: c } = await scope.table("claims").select("insurance_plan_id").maybeSingle();
        const planId = (c as { insurance_plan_id?: string | null } | null)?.insurance_plan_id ?? null;
        if (!planId) return null;
        const { data } = await scope.table("insurance_plans").select("metadata").eq("id", planId).maybeSingle();
        const meta = ((data as { metadata?: Record<string, unknown> } | null)?.metadata ?? null) as Record<string, unknown> | null;
        return meta && meta.regulatory_classification && typeof meta.regulatory_classification === "object"
          ? (meta.regulatory_classification as unknown as RegulatoryClassification)
          : null;
      })(),
      loadClaimLitigationAttested(supabase, e.user_id, e.claim_id),
      loadCompositionProof(supabase, e.user_id, e.claim_id),
      loadInsurerLetter(supabase, e.user_id, e.claim_id),
    ]);
    const claimMeta = ((claim.data as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
    const operatorClassification: RegulatoryClassification | null = coverageType
      ? { coverageType, ...(coverageType === "commercial_fully_insured" && caRegulator ? { caRegulator } : {}), source: "operator_intake", answeredAt: now.toISOString() }
      : null;
    // the member's own screening answers on the plan row win; then the operator's reading; then the snapshot
    const classification = plan ?? operatorClassification ?? ((e.plan_classification as unknown as RegulatoryClassification | null) ?? null);
    const runwayBusinessDays = await computeRunway(supabase, insurerLetter, now);

    const facts: IntakeFacts = {
      memberState: ((profile.data as { state?: string | null } | null)?.state ?? e.member_state) ?? null,
      classification,
      planSponsorType,
      secondaryCoverageCdi: tri(body.secondaryCoverageCdi),
      governmentProgram: tri(body.governmentProgram),
      litigationAttested: litigation,
      inCollections: !!claimMeta.collector,
      // The signed Scope of Engagement says, in the member's own signature, that
      // Candid will not choose the grounds — so unless the operator records that
      // a message asked us to, the answer is "no" (Andrew #5: no extra step).
      memberAskedWhatToArgue: tri(body.memberAskedWhatToArgue) ?? (signedInstruments(e.consent_event_ids).dfy_scope_of_engagement ? false : null),
      part2Records: tri(body.part2Records),
      compositionEvents: composition,
      adverseDeterminationDate: insurerLetter?.denialNoticeDate ?? null,
      runwayBusinessDays,
      refusalRunwayBusinessDays: config.refusalRunwayBusinessDays,
      marketingGateVerifiedOn: config.marketingGateVerifiedOn,
    };
    const declinedAtIntake = e.status === "terminated" && typeof (e.metadata as { closedReason?: string }).closedReason === "string" && (e.metadata as { closedReason: string }).closedReason.startsWith("declined at intake");
    const stored = (e.intake as { decision?: IntakeDecision | null }).decision ?? null;

    if (action === "reopen") {
      if (!declinedAtIntake) throw new OperatorAccessError(409, "not_declined_at_intake", "this matter was not declined at intake");
      const updated = await patchEngagement(supabase, engagementId, { status: "terminated" }, {
        status: "eligibility_pending",
        closed_at: null,
        intake: { ...e.intake, decision: null, reopened: { at: now.toISOString(), by: { operatorUserId, role } } },
        metadata: { ...e.metadata, closedReason: null, closedBy: null, reopened: { at: now.toISOString(), by: operatorUserId, previousReason: (e.metadata as { closedReason?: string }).closedReason ?? null } },
      });
      if (!updated) return NextResponse.json({ error: "The matter changed underneath you — reload", code: "screen_race" }, { status: 409 });
      const scoped = { ...scope, engagement: updated };
      await emitOperatorEvent(supabase, scoped, "dfy_engagement_reopened", { at: "intake" });
      await logAdminAction({ adminUserId: operatorUserId, adminEmail: operatorEmail, action: "dfy_reopen", targetUserId: updated.user_id, targetTable: "dfy_engagements", details: `engagement ${updated.id}: reopened at intake (${role})`, ipAddress: ip });
      return NextResponse.json({ ok: true, engagement: updated });
    }

    if (action === "decline") {
      // The member reads their plain sentence (the gate's copy when a gate failed,
      // a generic one when the operator declined on judgment); the operator's
      // words stay in the audit trail.
      const memberReason = (stored && !stored.eligible ? memberDeclineCopy(stored) : null) ?? "This isn't one we can take on right now.";
      const auditReason = operatorReason || (stored && !stored.eligible ? stored.declineReason : null) || "operator judgment";
      const updated = await patchEngagement(supabase, engagementId, { status: e.status }, {
        status: "terminated",
        closed_at: now.toISOString(),
        intake: { ...e.intake, declined: { at: now.toISOString(), by: { operatorUserId, role }, reason: auditReason, memberReason } },
        metadata: { ...e.metadata, closedReason: `declined at intake — ${auditReason}`, closedBy: { operatorUserId, role } },
      });
      if (!updated) return NextResponse.json({ error: "The applicant changed underneath you — reload", code: "screen_race" }, { status: 409 });
      const scoped = { ...scope, engagement: updated };
      await emitOperatorEvent(supabase, scoped, "dfy_engagement_closed", { status: "terminated", at: "intake", reason: auditReason });
      const { data: mr } = await supabase.from("users").select("email, display_name").eq("id", updated.user_id).maybeSingle();
      const member = mr as { email?: string | null; display_name?: string | null } | null;
      const emailed = member?.email ? await sendDfyDeclineEmail({ to: member.email, firstName: member.display_name?.trim().split(/\s+/)[0] ?? null, claimId: updated.claim_id, reason: memberReason }) : false;
      await logAdminAction({ adminUserId: operatorUserId, adminEmail: operatorEmail, action: "dfy_decline", targetUserId: updated.user_id, targetTable: "dfy_engagements", details: `engagement ${updated.id}: declined at intake — ${auditReason} (${role}); member emailed: ${emailed}`, ipAddress: ip });
      return NextResponse.json({ ok: true, engagement: updated, emailed });
    }

    if (action === "accept") {
      if (!stored || !stored.eligible) throw new OperatorAccessError(409, "not_screened_eligible", "run the gates first — accept needs an eligible decision on the row");
      const updated = await patchEngagement(supabase, engagementId, { status: e.status }, {
        intake: { ...e.intake, accepted: { at: now.toISOString(), by: { operatorUserId, role } } },
      });
      if (!updated) return NextResponse.json({ error: "The applicant changed underneath you — reload", code: "screen_race" }, { status: 409 });
      const finalRow = updated.status === "signed" ? await maybeActivateEngagement(supabase, updated, config, now) : updated;
      const scoped = { ...scope, engagement: finalRow };
      await emitOperatorEvent(supabase, scoped, "dfy_engagement_screened", { eligible: true, accepted: true });
      // The member hears the acceptance. Activation sends its own "we've started"
      // mail; when the matter is NOT yet active, the next step is theirs.
      if (finalRow.status !== "active") {
        const { data: mr } = await supabase.from("users").select("email, display_name").eq("id", finalRow.user_id).maybeSingle();
        const member = mr as { email?: string | null; display_name?: string | null } | null;
        const signedAll = paperComplete(finalRow.payer, finalRow.consent_event_ids);
        const what = signedAll
          ? "confirmed we can take your appeal on. Next: choose what to argue in the free tool, and we start the moment it's ready"
          : "confirmed we can take your appeal on. Next: finish signing your documents, then choose what to argue in the free tool";
        if (member?.email) void sendDfyMatterUpdateEmail({ to: member.email, firstName: member.display_name?.trim().split(/\s+/)[0] ?? null, claimId: finalRow.claim_id, what });
      }
      await logAdminAction({ adminUserId: operatorUserId, adminEmail: operatorEmail, action: "dfy_accept", targetUserId: finalRow.user_id, targetTable: "dfy_engagements", details: `engagement ${finalRow.id}: accepted at intake (${role}) → ${finalRow.status}`, ipAddress: ip });
      return NextResponse.json({ ok: true, engagement: finalRow });
    }

    // evaluate — run the gates, store the decision, never close anything.
    const decision = evaluateIntake(facts);
    const intake = {
      ...e.intake,
      facts,
      decision,
      screenedAt: now.toISOString(),
      screenedBy: { operatorUserId, role },
    };
    const updated = await patchEngagement(supabase, engagementId, { status: e.status }, {
      intake,
      ...(operatorClassification && !plan ? { plan_classification: { ...operatorClassification, by: operatorUserId } as unknown as Record<string, unknown> } : {}),
    });
    if (!updated) {
      return NextResponse.json({ error: "The applicant changed underneath you — reload", code: "screen_race" }, { status: 409 });
    }
    // Sign-first: an eligible decision on an already-signed matter activates it here.
    const finalRow = decision.eligible && updated.status === "signed" ? await maybeActivateEngagement(supabase, updated, config, now) : updated;
    const scoped = { ...scope, engagement: finalRow };
    await emitOperatorEvent(supabase, scoped, "dfy_engagement_screened", {
      eligible: decision.eligible,
      failedGates: decision.gates.filter((g) => !g.pass).map((g) => g.id),
    });
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: "dfy_screen",
      targetUserId: finalRow.user_id,
      targetTable: "dfy_engagements",
      details: `engagement ${finalRow.id}: ${decision.eligible ? "eligible" : `gates failed — ${decision.declineReason}`} (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, decision, engagement: finalRow });
  } catch (err) {
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}

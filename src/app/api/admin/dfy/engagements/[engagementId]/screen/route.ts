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
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import { operatorScoped, patchEngagement } from "@/lib/security/operator-scoped";
import { maybeActivateEngagement } from "@/lib/dfy/sign";
import { loadClaimLitigationAttested } from "@/lib/disputes/letter-access-state";
import type { RegulatoryClassification } from "@/lib/disputes/forums";
import { evaluateIntake, type IntakeFacts, type PlanSponsorType } from "@/lib/dfy/intake-gates";
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
  const planSponsorType = SPONSOR_TYPES.has(body.planSponsorType as PlanSponsorType) ? (body.planSponsorType as PlanSponsorType) : null;

  try {
    const scope = await operatorScoped(supabase, operatorUserId, engagementId, {
      statuses: ["eligibility_pending", "signed"],
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
    const classification = plan ?? ((e.plan_classification as unknown as RegulatoryClassification | null) ?? null);
    const runwayBusinessDays = await computeRunway(supabase, insurerLetter, now);

    const facts: IntakeFacts = {
      memberState: ((profile.data as { state?: string | null } | null)?.state ?? e.member_state) ?? null,
      classification,
      planSponsorType,
      secondaryCoverageCdi: tri(body.secondaryCoverageCdi),
      governmentProgram: tri(body.governmentProgram),
      litigationAttested: litigation,
      inCollections: !!claimMeta.collector,
      memberAskedWhatToArgue: tri(body.memberAskedWhatToArgue),
      part2Records: tri(body.part2Records),
      compositionEvents: composition,
      adverseDeterminationDate: insurerLetter?.denialNoticeDate ?? null,
      runwayBusinessDays,
      refusalRunwayBusinessDays: config.refusalRunwayBusinessDays,
      marketingGateVerifiedOn: config.marketingGateVerifiedOn,
    };
    const decision = evaluateIntake(facts);

    const intake = {
      ...e.intake,
      facts,
      decision,
      screenedAt: now.toISOString(),
      screenedBy: { operatorUserId, role },
    };
    const updated = await patchEngagement(
      supabase,
      engagementId,
      { status: e.status },
      decision.eligible
        ? { intake }
        : {
            intake,
            status: "terminated",
            closed_at: now.toISOString(),
            metadata: { ...e.metadata, closedReason: `declined at intake — ${decision.declineReason}`, closedBy: { operatorUserId, role } },
          },
    );
    if (!updated) {
      return NextResponse.json({ error: "The applicant changed underneath you — reload", code: "screen_race" }, { status: 409 });
    }
    // Sign-first: the member may have completed the stack before screening —
    // an eligible decision on a signed matter activates it here, so the
    // operator can act at once (composition + payer rule still apply inside).
    const finalRow = decision.eligible && updated.status === "signed" ? await maybeActivateEngagement(supabase, updated, config, now) : updated;
    const scoped = { ...scope, engagement: finalRow };
    await emitOperatorEvent(supabase, scoped, "dfy_engagement_screened", {
      eligible: decision.eligible,
      failedGates: decision.gates.filter((g) => !g.pass).map((g) => g.id),
    });
    if (!decision.eligible) {
      await emitOperatorEvent(supabase, scoped, "dfy_engagement_closed", { status: "terminated", at: "intake" });
    }
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: "dfy_screen",
      targetUserId: updated.user_id,
      targetTable: "dfy_engagements",
      details: `engagement ${updated.id}: ${decision.eligible ? "eligible" : `declined — ${decision.declineReason}`} (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, decision, engagement: finalRow });
  } catch (err) {
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}

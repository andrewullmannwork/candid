/**
 * POST /api/dfy/apply — a MEMBER asks for the done-for-you service on their own
 * claim (S330, the P4 entry point). Body: { claimId, sponsorCode? }.
 *
 * Open only when the entry point is enabled. Composition (the member's own
 * ground selection + adoption) is recorded as a FACT here, not required — the
 * engagement opens unclaimed, the member signs the stack right away (sign-first,
 * Andrew S330), and the conduct rule holds where it matters: activation and
 * every executing act stay gated on the member's own composition events.
 * Operators are pinged in the DFY Slack channel.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { createEngagement } from "@/lib/security/operator-scoped";
import { readDfyState } from "@/lib/dfy/config";
import { compositionComplete, loadCompositionProof } from "@/lib/dfy/operator-action";
import { loadSponsorByCode, normalizeSponsorCode, sponsorCodeUsable } from "@/lib/dfy/sponsors";
import { dfyLaneOpen } from "@/lib/dfy/state-lanes";
import { LIVE_ENGAGEMENT_STATUSES } from "@/lib/dfy/engagement-state";
import { paperComplete } from "@/lib/dfy/paper";
import type { EngagementPayer } from "@/lib/security/operator-scoped";
import { emitCaseEvents } from "@/lib/case/case-events";
import { postOpsMessage } from "@/lib/slack/ops-message";

export async function POST(req: NextRequest) {
  const user = await requireAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.isAnonymous) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled || !state.config.entryPointEnabled) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { claimId?: unknown; sponsorCode?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";
  if (!claimId) return NextResponse.json({ error: "claimId required" }, { status: 400 });
  const sponsorCode = typeof body.sponsorCode === "string" && body.sponsorCode.trim() ? normalizeSponsorCode(body.sponsorCode) : null;

  const scoped = userScoped(supabase, user.id);
  const [{ data: claim }, { data: profile }] = await Promise.all([
    scoped.table("claims").select("id, insurance_plan_id").eq("id", claimId).maybeSingle(),
    scoped.table("profiles").select("state").maybeSingle(),
  ]);
  const c = claim as { id: string; insurance_plan_id: string | null } | null;
  if (!c) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  const memberState = (profile as { state?: string | null } | null)?.state ?? null;
  if (!dfyLaneOpen(memberState)) {
    return NextResponse.json({ error: "Right now this service is open in California only.", code: "lane_closed" }, { status: 409 });
  }
  const proof = await loadCompositionProof(supabase, user.id, c.id);
  const composed = compositionComplete(proof);
  let sponsorId: string | null = null;
  if (sponsorCode) {
    const sponsor = await loadSponsorByCode(supabase, sponsorCode);
    const usable = sponsorCodeUsable(sponsor);
    if (!usable.ok) return NextResponse.json({ error: `That employer code can't be used: ${usable.reason}`, code: "sponsor_code_unusable" }, { status: 409 });
    sponsorId = sponsor!.id;
  }
  const plan = c.insurance_plan_id ? await scoped.table("insurance_plans").select("metadata").eq("id", c.insurance_plan_id).maybeSingle() : { data: null };
  const meta = ((plan as { data?: { metadata?: Record<string, unknown> } | null }).data?.metadata ?? null) as Record<string, unknown> | null;
  const classification = meta && meta.regulatory_classification && typeof meta.regulatory_classification === "object" ? (meta.regulatory_classification as Record<string, unknown>) : null;

  const { engagement, conflict } = await createEngagement(supabase, user.id, {
    claim_id: c.id,
    payer: sponsorId ? "sponsor_paid" : "member_paid",
    sponsor_ref: sponsorCode,
    sponsor_id: sponsorId,
    member_state: memberState,
    plan_classification: classification,
    metadata: { appliedBy: { actor: "user", userId: user.id }, appliedAt: new Date().toISOString(), compositionAtApply: composed },
  });
  if (conflict) {
    // S331 — a repeat ask is a STATUS question, not a refusal. Return the facts
    // the member-status vocabulary needs so the page can say where it stands
    // and when they asked, instead of a bare "already handling".
    const { data: liveRows } = await scoped
      .table("dfy_engagements")
      .select("id, status, payer, consent_event_ids, intake, created_at")
      .eq("claim_id", c.id)
      .in("status", LIVE_ENGAGEMENT_STATUSES)
      .limit(1);
    const live = (liveRows ?? [])[0] as
      | { id: string; status: string; payer: string; consent_event_ids: Record<string, unknown>; intake: Record<string, unknown> | null; created_at: string }
      | undefined;
    const decision = (live?.intake as { decision?: { eligible?: boolean; declineReason?: string | null } } | null)?.decision ?? null;
    return NextResponse.json(
      {
        error: "We're already handling this claim.",
        code: "engagement_exists",
        engagement: live
          ? {
              id: live.id,
              status: live.status,
              allSigned: paperComplete(live.payer as EngagementPayer, live.consent_event_ids ?? {}),
              composed,
              screened: decision ? { eligible: decision.eligible === true, declineReason: decision.declineReason ?? null } : null,
              requestedAt: live.created_at,
            }
          : null,
      },
      { status: 409 },
    );
  }
  if (!engagement) return NextResponse.json({ error: "Something went wrong. Try again.", code: "create_failed" }, { status: 500 });
  await emitCaseEvents(supabase, user.id, [{ claimId: c.id, kind: "dfy_engagement_created", actor: "user", payload: { engagementId: engagement.id, appliedBy: "member", payer: engagement.payer } }]);
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com";
  void postOpsMessage(
    `🆕 DFY request — matter ${engagement.id.slice(0, 8)} · ${memberState ?? "state ?"} · ${engagement.payer}${sponsorCode ? ` (${sponsorCode})` : ""} · appeal ${composed ? "composed ✓" : "not composed yet"} · unsigned · awaits screening: ${base}/admin/dfy/${engagement.id}`,
    { channel: state.config.opsChannelId ?? undefined },
  );
  return NextResponse.json({ ok: true, engagementId: engagement.id }, { status: 201 });
}

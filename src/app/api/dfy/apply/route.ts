/**
 * POST /api/dfy/apply — a MEMBER asks for the done-for-you service on their own
 * claim (S330, the P4 entry point). Body: { claimId, sponsorCode? }.
 *
 * Open only when the entry point is enabled. The member must already have
 * COMPOSED the appeal in the free tool (ground selection + adoption on the
 * claim) — the conduct rule: composition precedes any execution, so an
 * application without it is refused with the honest next step. The engagement
 * opens unclaimed in intake; an operator screens it and claims it, and the
 * member is then pointed to their signing page.
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
    return NextResponse.json({ error: "This service is open in California only right now", code: "lane_closed" }, { status: 409 });
  }
  const proof = await loadCompositionProof(supabase, user.id, c.id);
  if (!compositionComplete(proof)) {
    return NextResponse.json({ error: "Compose and adopt your appeal in the free tool first — Candid executes what you composed", code: "composition_missing" }, { status: 409 });
  }
  let sponsorId: string | null = null;
  if (sponsorCode) {
    const sponsor = await loadSponsorByCode(supabase, sponsorCode);
    const usable = sponsorCodeUsable(sponsor);
    if (!usable.ok) return NextResponse.json({ error: `That sponsor code cannot be used: ${usable.reason}`, code: "sponsor_code_unusable" }, { status: 409 });
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
    metadata: { appliedBy: { actor: "user", userId: user.id }, appliedAt: new Date().toISOString() },
  });
  if (conflict) return NextResponse.json({ error: "This claim already has a live engagement", code: "engagement_exists" }, { status: 409 });
  if (!engagement) return NextResponse.json({ error: "Could not open the engagement", code: "create_failed" }, { status: 500 });
  await emitCaseEvents(supabase, user.id, [{ claimId: c.id, kind: "dfy_engagement_created", actor: "user", payload: { engagementId: engagement.id, appliedBy: "member", payer: engagement.payer } }]);
  void postOpsMessage(`🆕 DFY application — matter ${engagement.id.slice(0, 8)} awaits screening: ${process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com"}/admin/dfy`);
  return NextResponse.json({ ok: true, engagementId: engagement.id }, { status: 201 });
}

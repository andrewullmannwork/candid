/**
 * GET /api/dfy/engagements/[engagementId] — the MEMBER's view of their own
 * engagement (S330). Read through the member's ownership; the instrument texts
 * are composed server-side so the member reads exactly what they will sign;
 * a `signed` engagement is opportunistically activated (idempotent) so a
 * composition that arrived later, or a payment the webhook confirmed, takes
 * effect on the next view.
 */
import { NextRequest, NextResponse } from "next/server";
import { dfyFeeOutstanding } from "@/lib/dfy/member-status";
import { signedInstrumentFile } from "@/lib/dfy/instrument-files";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { parseEngagementRow, DFY_ENGAGEMENT_COLUMNS } from "@/lib/security/operator-scoped";
import { readDfyState } from "@/lib/dfy/config";
import { requiredDfyConsents, renderInstrument, signedInstruments } from "@/lib/dfy/paper";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { buildInstrumentContext, maybeActivateEngagement, memberIsEligibleToSign, instrumentDeferral } from "@/lib/dfy/sign";
import { loadCompositionProof } from "@/lib/dfy/operator-action";
import { memberDeclineCopy, type GateId } from "@/lib/dfy/intake-gates";

export async function GET(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const user = await requireAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.isAnonymous) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = createServerClient();
  const state = await readDfyState(supabase);
  if (!state.enabled) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { engagementId } = await params;

  const { data } = await userScoped(supabase, user.id)
    .table("dfy_engagements")
    .select(DFY_ENGAGEMENT_COLUMNS)
    .eq("id", engagementId)
    .maybeSingle();
  let e = parseEngagementRow(data);
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (e.status === "signed") e = await maybeActivateEngagement(supabase, e, state.config);

  const { data: userRow } = await supabase.from("users").select("display_name").eq("id", user.id).maybeSingle();
  const member = { id: user.id, email: user.email, displayName: (userRow as { display_name?: string | null } | null)?.display_name ?? null };
  const signed = signedInstruments(e.consent_event_ids);
  const canSign = memberIsEligibleToSign(e);

  let instruments: Array<Record<string, unknown>> = [];
  try {
    const ctx = await buildInstrumentContext(supabase, e, member, state.config, new Date());
    instruments = await Promise.all(
      requiredDfyConsents(e.payer).map(async (type) => {
        const ref = signed[type] ?? null;
        const rendered = type === "health_data_upload"
          ? (() => { const d = getConsentDocument(type); return { title: d.title, version: d.version, effectiveDate: d.effectiveDate, text: d.fullText, authorizationForm: false }; })()
          : renderInstrument(type, ctx);
        // S331 — one resolver, shared with the operator's send kit, so both
        // surfaces hand out the same file from the same bucket for the same TTL.
        const { pdfUrl } = await signedInstrumentFile(supabase, user.id, ref?.documentId);
        return { type, deferred: instrumentDeferral(type, e, state.config), title: rendered.title, version: rendered.version, effectiveDate: rendered.effectiveDate, text: rendered.text, authorizationForm: rendered.authorizationForm, signed: ref ? { signedName: ref.signedName, signedAt: ref.signedAt } : null, pdfUrl };
      }),
    );
  } catch (err) {
    console.error("[dfy member GET] instrument render failed:", err);
  }

  const proof = await loadCompositionProof(supabase, user.id, e.claim_id);
  const decision = (e.intake as { decision?: { eligible?: boolean; gates?: Array<{ id: GateId; pass: boolean }> } }).decision ?? null;
  return NextResponse.json({
    engagement: { id: e.id, claimId: e.claim_id, status: e.status, payer: e.payer, sponsorRef: e.sponsor_ref, signedAt: e.signed_at, activatedAt: e.activated_at, closedAt: e.closed_at },
    screened: decision ? { eligible: decision.eligible === true, declineReason: memberDeclineCopy(decision) } : null,
    composition: proof,
    canSign,
    instruments,
    payment: {
      required: dfyFeeOutstanding(e, state.config.feeCents),
      feeCents: e.payer === "member_paid" ? state.config.feeCents : 0,
    },
  });
}

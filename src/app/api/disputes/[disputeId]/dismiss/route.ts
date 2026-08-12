/**
 * POST /api/disputes/[disputeId]/dismiss — S312 (F2-S312.1, Andrew's ruling).
 *
 * The two answers to the "This letter may no longer be needed" banner, one
 * route per user question (the checklist pattern):
 *
 *   { action: "dismiss" }  → status → "cancelled". The letter becomes a
 *     read-only exhibit (the S308 void rule): every write route 409s, the
 *     claim card grays it, the Case File still binds it. Nothing is deleted.
 *     Emits `letter_dismissed` (spine Rule #10 — fail-soft, refs-only) with
 *     `reason` so the flywheel learns WHY drafted letters die.
 *
 *   { action: "keep" }     → stamps `metadata.zeroDemandKeptAt`. The banner
 *     stays away while the demand is $0. Deliberately DURABLE — a keep is the
 *     user's standing answer; if dollars return, the banner condition is
 *     false anyway, so no clearing machinery exists (fewer moving parts, no
 *     coupling to the amount float). Last-write-wins on metadata — same
 *     exposure class as the sibling checklist route (cross-route metadata CAS
 *     is the known standing carry-forward).
 *
 * Guards: only a LIVE, never-sent draft is dismissible/keepable. A sent
 * letter is a record (409 letter_sent); a void row is already an exhibit
 * (409 letter_void — the FIX-3 guard family, one rule stated once).
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute (userScoped).
 */
import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { isLiveDraftStatus } from "@/lib/disputes/letter-type";
import { emitCaseEvent } from "@/lib/case/case-events";

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

  let body: { action?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = body.action === "dismiss" || body.action === "keep" ? body.action : null;
  if (!action) {
    return NextResponse.json(
      { error: 'Expected { action: "dismiss" | "keep" }' },
      { status: 400 },
    );
  }
  // The only reason the banner sends today; anything else records as "user"
  // (a future generic cancel affordance reuses this route unchanged).
  const reason = body.reason === "zero_demand" ? "zero_demand" : "user";

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute, error: fetchErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("id, claim_id, metadata, status, sent_at")
    .eq("id", disputeId)
    .single();
  if (fetchErr || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // A sent letter is a record — it can be unsent (its own control) but never
  // dismissed; a void row is already an exhibit. Distinct 409 codes so the
  // client can speak each refusal plainly (the S311 round-6 lesson: the
  // refusal needs a voice).
  if (dispute.sent_at != null) {
    return NextResponse.json({ error: "letter_sent" }, { status: 409 });
  }
  if (!isLiveDraftStatus((dispute.status as string | null) ?? null)) {
    return NextResponse.json({ error: "letter_void" }, { status: 409 });
  }

  if (action === "keep") {
    const meta = (dispute.metadata as Record<string, unknown>) ?? {};
    const zeroDemandKeptAt = new Date().toISOString();
    const { error: updateErr } = await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .update({
        metadata: { ...meta, zeroDemandKeptAt },
        updated_at: new Date().toISOString(),
      })
      .eq("id", dispute.id);
    if (updateErr) {
      console.error("[dispute-dismiss] keep failed:", updateErr);
      return NextResponse.json({ error: "Failed to save" }, { status: 500 });
    }
    return NextResponse.json({ kept: true, zeroDemandKeptAt });
  }

  const { error: updateErr } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", dispute.id);
  if (updateErr) {
    console.error("[dispute-dismiss] dismiss failed:", updateErr);
    return NextResponse.json({ error: "Failed to dismiss" }, { status: 500 });
  }

  // Spine Rule #10 — every mutation site emits, fail-soft, references only.
  // Legacy disputes without a linked claim have no case to anchor to → no event.
  if (dispute.claim_id) {
    await emitCaseEvent(supabase, user.id, {
      claimId: dispute.claim_id as string,
      disputeId: dispute.id as string,
      kind: "letter_dismissed",
      payload: { reason },
    });
  }

  return NextResponse.json({ status: "cancelled" });
}

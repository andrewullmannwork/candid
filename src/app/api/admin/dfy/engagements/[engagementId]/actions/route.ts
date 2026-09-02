/**
 * POST /api/admin/dfy/engagements/[engagementId]/actions — one operator act (S330).
 *
 * Body: { kind: OperatorActKind, disputeId?: string | null, ...refs }
 *   refs (all optional, all REFERENCES — validated, length-capped):
 *     channel, reference, trackingRef, phoneRef: short strings
 *     calledAt, receivedAt: YYYY-MM-DD
 *     amountCents (dfy_offer_relayed only): integer ≥ 0 — stored on the DISPUTE
 *       row's metadata, never in the event payload (the spine carries no money)
 *     determination (dfy_determination_recorded only): approved | denied | partial
 *
 * Every act passes the route-layer invariant (assertOperatorAction: active +
 * holder + the member's composition proof for executing acts), then writes a
 * tagged `actor: 'operator'` event onto the member's timeline. A response or
 * offer is recorded as NEW FACTS the member reviews on their own surfaces —
 * the operator never answers for them.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/admin/require-operator";
import { logAdminAction } from "@/lib/admin/audit-log";
import {
  assertOperatorAction,
  emitOperatorEvent,
  isOperatorActKind,
  operatorErrorResponse,
} from "@/lib/dfy/operator-action";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const REF_MAX = 120;
const DETERMINATIONS = new Set(["approved", "denied", "partial"]);

function ref(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= REF_MAX ? t : undefined;
}
function dateOnly(v: unknown): string | undefined {
  return typeof v === "string" && DATE_ONLY.test(v) ? v : undefined;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ engagementId: string }> }) {
  const auth = await requireOperator(req);
  if (!auth.ok) return auth.response;
  const { supabase, operatorUserId, operatorEmail, role, ip } = auth;
  const { engagementId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const kind = body.kind;
  if (!isOperatorActKind(kind)) {
    return NextResponse.json({ error: "Unknown act kind", code: "bad_kind" }, { status: 400 });
  }
  const disputeId = typeof body.disputeId === "string" && body.disputeId.length > 0 ? body.disputeId : null;

  try {
    const scope = await assertOperatorAction(supabase, operatorUserId, engagementId, kind);

    // A dispute named in the act must be one of THIS claim's letters (the scope
    // narrows dispute_outcomes to the engagement's claim, so a foreign id reads null).
    if (disputeId) {
      const { data } = await scope.table("dispute_outcomes").select("id").eq("id", disputeId).maybeSingle();
      if (!data) return NextResponse.json({ error: "Letter not found on this matter", code: "dispute_not_on_claim" }, { status: 404 });
    }

    const payload: Record<string, unknown> = {};
    for (const k of ["channel", "reference", "trackingRef", "phoneRef"] as const) {
      const v = ref(body[k]);
      if (v) payload[k] = v;
    }
    for (const k of ["calledAt", "receivedAt"] as const) {
      const v = dateOnly(body[k]);
      if (v) payload[k] = v;
    }

    if (kind === "dfy_offer_relayed" || kind === "dfy_determination_recorded") {
      if (!disputeId) return NextResponse.json({ error: "disputeId required for this act", code: "dispute_required" }, { status: 400 });
      const fact: Record<string, unknown> = { at: new Date().toISOString(), operatorUserId };
      if (kind === "dfy_offer_relayed") {
        const cents = body.amountCents;
        if (!(typeof cents === "number" && Number.isInteger(cents) && cents >= 0)) {
          return NextResponse.json({ error: "amountCents must be a non-negative integer", code: "bad_amount" }, { status: 400 });
        }
        fact.amountCents = cents;
      } else {
        const det = body.determination;
        if (typeof det !== "string" || !DETERMINATIONS.has(det)) {
          return NextResponse.json({ error: "determination must be approved | denied | partial", code: "bad_determination" }, { status: 400 });
        }
        fact.determination = det;
        payload.determinationRef = det;
      }
      // Read-merge-write on the dispute row's metadata — sibling keys survive
      // (the S326 wipe hazard is a REPLACE; this is a merge).
      const { data: row } = await scope.table("dispute_outcomes").select("metadata").eq("id", disputeId).maybeSingle();
      const meta = ((row as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
      const key = kind === "dfy_offer_relayed" ? "dfy_offer" : "dfy_determination";
      const { error: updErr } = await scope
        .table("dispute_outcomes")
        .update({ metadata: { ...meta, [key]: fact } })
        .eq("id", disputeId);
      if (updErr) {
        console.error("[dfy actions] dispute metadata write failed:", updErr);
        return NextResponse.json({ error: "Could not record the fact on the letter", code: "write_failed" }, { status: 500 });
      }
    }

    await emitOperatorEvent(supabase, scope, kind, payload, disputeId);
    await logAdminAction({
      adminUserId: operatorUserId,
      adminEmail: operatorEmail,
      action: `dfy_act:${kind}`,
      targetUserId: scope.engagement.user_id,
      targetTable: "claim_case_events",
      details: `engagement ${scope.engagement.id}${disputeId ? ` letter ${disputeId}` : ""} (${role})`,
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, kind, disputeId });
  } catch (err) {
    const { status, body: b } = operatorErrorResponse(err);
    return NextResponse.json(b, { status });
  }
}

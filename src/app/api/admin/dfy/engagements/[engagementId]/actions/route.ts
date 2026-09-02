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
import { signedInstruments } from "@/lib/dfy/paper";
import { buildPacket } from "@/lib/dfy/packet";
import { userScoped } from "@/lib/security/user-scoped";
import { sendDfyMatterUpdateEmail } from "@/lib/email/dfy-emails";

/** The member-facing plain-words line for the facts that notify them. */
const MEMBER_NOTIFY: Partial<Record<string, string>> = {
  dfy_response_recorded: "recorded a response from your plan on your appeal",
  dfy_offer_relayed: "relayed an offer from your plan on your appeal — the number is on your timeline, the decision is yours",
  dfy_determination_recorded: "recorded your plan's determination on your appeal",
  dfy_packet_prepared: "prepared the packet for the state-level step, which you file yourself if you choose to",
};

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
  const isChannel = kind === "dfy_channel_observed";

  try {
    const scope = await assertOperatorAction(supabase, operatorUserId, engagementId, kind);

    // The designation names ONE person (or the entity). A submission by an
    // operator the instrument does not name is not a valid designation — a
    // hand-off after signing needs a fresh instrument, never a silent swap.
    if (kind === "dfy_designation_submitted") {
      const des = signedInstruments(scope.engagement.consent_event_ids).dfy_authorized_representative_designation;
      if (!des) return NextResponse.json({ error: "The member has not signed the designation yet", code: "designation_unsigned" }, { status: 409 });
      if (des.namedParty !== "entity" && des.namedOperatorUserId && des.namedOperatorUserId !== operatorUserId) {
        return NextResponse.json({ error: "The signed designation names a different operator — the member must sign a new one", code: "designation_names_other_operator" }, { status: 409 });
      }
    }

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

    // The state-level packet: built on the Case File compiler, filed in the
    // member's documents; the act payload carries only the references.
    if (kind === "dfy_packet_prepared") {
      const forumId = ref(body.forumId);
      if (!forumId) return NextResponse.json({ error: "forumId required — pick the forum from the routed menu", code: "forum_required" }, { status: 400 });
      const [{ data: memberRow }, { data: opRow }] = await Promise.all([
        supabase.from("users").select("display_name, email").eq("id", scope.engagement.user_id).maybeSingle(),
        supabase.from("users").select("display_name, email").eq("id", operatorUserId).maybeSingle(),
      ]);
      const memberName = (memberRow as { display_name?: string | null; email?: string } | null)?.display_name || (memberRow as { email?: string } | null)?.email || "the member";
      const operatorName = (opRow as { display_name?: string | null; email?: string } | null)?.display_name || (opRow as { email?: string } | null)?.email || "the Candid operator";
      try {
        const built = await buildPacket(supabase, scope.engagement, forumId, disputeId, operatorName, memberName);
        payload.forumId = built.forumId;
        payload.documentId = built.documentId;
      } catch (err) {
        console.error("[dfy actions] packet build failed:", err);
        return NextResponse.json({ error: `Could not build the packet: ${err instanceof Error ? err.message : "unknown"}`, code: "packet_failed" }, { status: 500 });
      }
    }

    // Channel observations ride the EXISTING insurer-intelligence machinery:
    // a corrected appeals address/phone opens a proposed_changes row for admin
    // review (the same queue user corrections use); every observation is an
    // insurer_appeals_confirmations event (the log) — never a new pipeline.
    if (isChannel) {
      const insurerId = ref(body.insurerId);
      if (!insurerId) return NextResponse.json({ error: "insurerId required", code: "insurer_required" }, { status: 400 });
      const { data: insurer } = await supabase
        .from("insurer_catalog")
        .select("id, name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source")
        .eq("id", insurerId)
        .maybeSingle();
      if (!insurer) return NextResponse.json({ error: "Insurer not found", code: "insurer_not_found" }, { status: 404 });
      const ins = insurer as Record<string, string | null>;
      const observation: Record<string, unknown> = {
        submissionChannel: ref(body.submissionChannel) ?? null,          // mail | fax | portal | email
        designationFormRequired: body.designationFormRequired === true,
        wetInkRequired: body.wetInkRequired === true,
        formUrl: ref(body.formUrl) ?? null,
        faxNumber: ref(body.faxNumber) ?? null,
        portalUrl: ref(body.portalUrl) ?? null,
        note: typeof body.note === "string" ? body.note.trim().slice(0, 300) : null,
        observedBy: { operatorUserId, role, engagementId: scope.engagement.id },
      };
      await userScoped(supabase, scope.engagement.user_id).table("insurer_appeals_confirmations").insert({
        insurer_id: ins.id,
        action: "proposed_correction",
        metadata: { source: "dfy_operator", observation },
      });
      const addr = {
        address_line_1: ref(body.addressLine1),
        address_line_2: ref(body.addressLine2) ?? "",
        city: ref(body.city),
        state: ref(body.state),
        postal_code: ref(body.postalCode),
        phone: ref(body.phone),
      };
      if (addr.address_line_1 && addr.city && addr.state && addr.postal_code) {
        await supabase.from("insurer_appeals_proposed_changes").insert({
          insurer_id: ins.id,
          proposed_by: "user_correction",
          proposed_by_user_id: operatorUserId,
          source_document_id: null,
          source_excerpt: `DFY operator observation on engagement ${scope.engagement.id}: ${observation.note ?? "verified submission channel"}`,
          current_values: {
            address_line_1: ins.appeals_address_line_1, address_line_2: ins.appeals_address_line_2, city: ins.appeals_city,
            state: ins.appeals_state, postal_code: ins.appeals_postal_code, phone: ins.appeals_phone, source: ins.appeals_source,
          },
          proposed_values: { ...addr, phone: addr.phone ?? ins.appeals_phone ?? null, source: "dfy_operator" },
          confidence: 0.9,
          status: "pending",
        });
        payload.addressProposed = true;
      }
      payload.insurerId = ins.id;
      if (observation.submissionChannel) payload.submissionChannel = observation.submissionChannel;
      if (observation.wetInkRequired) payload.wetInkRequired = true;
    }

    await emitOperatorEvent(supabase, scope, kind, payload, disputeId);
    const notify = MEMBER_NOTIFY[kind];
    if (notify) {
      const { data: memberRow } = await supabase.from("users").select("email, display_name").eq("id", scope.engagement.user_id).maybeSingle();
      const mr = memberRow as { email?: string; display_name?: string | null } | null;
      if (mr?.email) void sendDfyMatterUpdateEmail({ to: mr.email, firstName: mr.display_name?.trim().split(/\s+/)[0] ?? null, claimId: scope.engagement.claim_id, what: notify });
    }
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

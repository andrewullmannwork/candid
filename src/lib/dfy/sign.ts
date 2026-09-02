/**
 * sign — the member signs one instrument (S330, handoff §3 "e-sign capture =
 * the existing consent mechanic").
 *
 * The whole pipeline is EXISTING machinery, in order:
 *   1. the instance text is composed from the registry template (paper.ts);
 *   2. a `consent_events` row records it — type, version, the INSTANCE hash,
 *      IP, user agent, timestamp — through userScoped, exactly like every
 *      other consent on the platform (the typed name rides the engagement's
 *      consent refs and the PDF);
 *   3. the executed instrument renders to PDF with @react-pdf/renderer and is
 *      stored through the EXISTING documents pipeline — a row OWNED BY THE
 *      MEMBER (`doc_type: 'other'`, `consent_event_id` = this very event), so
 *      the operator has a submittable artifact, the member sees it in their
 *      own document list, and the CHD right-to-erasure covers it natively;
 *   4. the engagement's consent refs gain the instrument; when every required
 *      instrument is present the engagement becomes `signed`, and activation
 *      is attempted (`maybeActivateEngagement`) — fee-free during the pilot,
 *      sponsor-paid with a code, or awaiting the one-time payment.
 */
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import { patchEngagement, type DfyEngagementRow } from "@/lib/security/operator-scoped";
import { emitCaseEvents } from "@/lib/case/case-events";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { assertTransition } from "./engagement-state";
import type { DfyConfig } from "./config";
import {
  PDF_INSTRUMENTS,
  ENTITY_NAME,
  defaultExpiryDate,
  designationChannelFor,
  paperComplete,
  renderInstrument,
  requiredDfyConsents,
  signedInstruments,
  todayDateOnly,
  type DfyInstrumentType,
  type InstrumentContext,
  type RenderedInstrument,
  type SignedInstrumentRef,
} from "./paper";
import { compositionComplete, loadCompositionProof } from "./operator-action";

export class DfySignError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 500;
  readonly code: string;
  constructor(status: 400 | 403 | 404 | 409 | 500, code: string, message: string) {
    super(message);
    this.name = "DfySignError";
    this.status = status;
    this.code = code;
  }
}

export interface MemberIdentity {
  id: string;
  email: string;
  displayName: string | null;
}

export function memberIsEligibleToSign(e: DfyEngagementRow): boolean {
  const decision = (e.intake as { decision?: { eligible?: boolean } }).decision;
  return e.status === "eligibility_pending" && decision?.eligible === true;
}

/** The facts the instruments name — read through the MEMBER's ownership. */
export async function buildInstrumentContext(
  supabase: SupabaseClient,
  e: DfyEngagementRow,
  member: MemberIdentity,
  config: DfyConfig,
  now: Date,
): Promise<InstrumentContext> {
  const scoped = userScoped(supabase, member.id);
  const [claimRes, opRes] = await Promise.all([
    scoped.table("claims").select("id, claim_number, date_of_service, insurance_plan_id").eq("id", e.claim_id).maybeSingle(),
    e.operator_user_id
      ? supabase.from("users").select("display_name, email").eq("id", e.operator_user_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const claim = claimRes.data as { id: string; claim_number: string | null; date_of_service: string | null; insurance_plan_id: string | null } | null;
  if (!claim) throw new DfySignError(404, "claim_not_found", "the engagement's claim is not the member's own");
  const planRes = claim.insurance_plan_id
    ? await scoped.table("insurance_plans").select("plan_name, insurer_name").eq("id", claim.insurance_plan_id).maybeSingle()
    : { data: null };
  const plan = planRes.data as { plan_name: string | null; insurer_name: string | null } | null;
  const op = opRes.data as { display_name?: string | null; email?: string | null } | null;
  const operatorName = op?.display_name || op?.email || "the Candid operator assigned to this matter";
  const cls = (e.plan_classification as { coverageType?: string } | null)?.coverageType ?? null;
  const channel = designationChannelFor(cls);
  return {
    memberName: member.displayName || member.email,
    memberEmail: member.email,
    planName: plan?.plan_name || "the plan named on the claim",
    insurerName: plan?.insurer_name || "the plan administrator named on the claim",
    claimRef: claim.claim_number || claim.id.slice(0, 8),
    dateOfService: claim.date_of_service || "the date of service on the bill",
    channel,
    namedParty: config.designationNamedParty[channel],
    operatorName,
    feeCents: e.payer === "member_paid" ? config.feeCents : 0,
    sponsorRef: e.sponsor_ref,
    effectiveDate: todayDateOnly(now),
    expiryDate: defaultExpiryDate(now),
  };
}

export interface SignInput {
  supabase: SupabaseClient;
  engagement: DfyEngagementRow;
  member: MemberIdentity;
  type: DfyInstrumentType;
  signedName: string;
  ip: string | null;
  userAgent: string | null;
  config: DfyConfig;
  now?: Date;
}

export interface SignResult {
  ref: SignedInstrumentRef;
  engagement: DfyEngagementRow;
  /** True when this signature completed the stack. */
  completed: boolean;
}

function counterpartyLine(type: DfyInstrumentType, ctx: InstrumentContext, when: string): string | null {
  if (type !== "dfy_authorized_representative_designation") return null;
  return ctx.namedParty === "entity"
    ? `Accepted for ${ENTITY_NAME} (the operator of Candid) by ${ctx.operatorName}, its employee, on ${when}.`
    : `Accepted by ${ctx.operatorName}, an employee of ${ENTITY_NAME} (the operator of Candid), on ${when}.`;
}

async function renderPdf(
  instrument: RenderedInstrument,
  signature: { signedName: string; signedAt: string; ip: string | null; userAgent: string | null; consentEventId: string },
  counterparty: string | null,
  engagementId: string,
): Promise<Buffer> {
  const [{ renderToBuffer }, { InstrumentPdf }, React] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./instrument-pdf"),
    import("react"),
  ]);
  const element = React.createElement(InstrumentPdf, { instrument, signature, counterparty, engagementId });
  return renderToBuffer(element as never);
}

export async function signInstrument(input: SignInput): Promise<SignResult> {
  const { supabase, member, type, config } = input;
  const now = input.now ?? new Date();
  let e = input.engagement;
  if (!memberIsEligibleToSign(e)) {
    throw new DfySignError(409, "not_signable", "this engagement is not open for signing (it must be screened eligible and not yet signed)");
  }
  const required = requiredDfyConsents(e.payer);
  if (!required.includes(type)) {
    throw new DfySignError(400, "instrument_not_required", "this instrument is not part of this engagement's paper stack");
  }
  const already = signedInstruments(e.consent_event_ids)[type];
  if (already) return { ref: already, engagement: e, completed: paperComplete(e.payer, e.consent_event_ids) };
  const signedName = input.signedName.trim();
  if (signedName.length < 2 || signedName.length > 120) {
    throw new DfySignError(400, "bad_signature", "type your full name to sign");
  }

  const ctx = await buildInstrumentContext(supabase, e, member, config, now);
  // The health-data consent is the platform's own document, signed as-is.
  const instrument: RenderedInstrument =
    type === "health_data_upload"
      ? (() => {
          const doc = getConsentDocument("health_data_upload");
          return { type, title: doc.title, version: doc.version, effectiveDate: doc.effectiveDate, text: doc.fullText, hash: doc.hash, authorizationForm: false };
        })()
      : renderInstrument(type, ctx);

  // 2. the consent event — the platform's own mechanic, through the member's ownership
  const scoped = userScoped(supabase, member.id);
  const { data: ev, error: evErr } = await scoped
    .table("consent_events")
    .insert({
      email: member.email,
      consent_type: type,
      consent_version: instrument.version,
      consent_text_hash: instrument.hash,
      granted: true,
      ip_address: input.ip,
      user_agent: input.userAgent,
    })
    .select("id, created_at")
    .single();
  if (evErr || !ev) {
    console.error("[dfy sign] consent_events insert failed:", evErr);
    throw new DfySignError(500, "consent_write_failed", "could not record the signature");
  }
  const eventId = (ev as { id: string }).id;
  const signedAt = ((ev as { created_at?: string }).created_at ?? now.toISOString());

  // 3. the executed instrument → PDF → the member's own documents
  let documentId: string | null = null;
  if (PDF_INSTRUMENTS.has(type)) {
    const when = new Date(signedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const pdf = await renderPdf(
      instrument,
      { signedName, signedAt, ip: input.ip, userAgent: input.userAgent, consentEventId: eventId },
      counterpartyLine(type, ctx, when),
      e.id,
    );
    const storagePath = `${member.id}/dfy/${e.id}/${type}-${eventId.slice(0, 8)}.pdf`;
    const { error: upErr } = await supabase.storage
      .from("documents")
      .upload(storagePath, pdf, { contentType: "application/pdf", upsert: false });
    if (upErr) {
      console.error("[dfy sign] storage upload failed:", upErr);
      throw new DfySignError(500, "storage_failed", "could not store the signed document");
    }
    const { data: doc, error: docErr } = await scoped
      .table("documents")
      .insert({
        storage_path: storagePath,
        file_name: `${instrument.title}.pdf`,
        file_size: pdf.byteLength,
        doc_type: "other",
        classified_type: "other",
        consent_event_id: eventId,
        status: "processed",
        file_hash: createHash("sha256").update(pdf).digest("hex"),
        metadata: { dfy: { engagementId: e.id, instrument: type, consentEventId: eventId, version: instrument.version, hash: instrument.hash } },
      })
      .select("id")
      .single();
    if (docErr || !doc) {
      console.error("[dfy sign] documents insert failed:", docErr);
      throw new DfySignError(500, "document_write_failed", "could not file the signed document");
    }
    documentId = (doc as { id: string }).id;
  }

  // 4. the engagement's consent refs (+ the designation's who-was-named record)
  const ref: SignedInstrumentRef = {
    eventId,
    documentId,
    signedName,
    signedAt,
    hash: instrument.hash,
    version: instrument.version,
    ...(type === "dfy_authorized_representative_designation"
      ? { namedParty: ctx.namedParty, namedOperatorUserId: e.operator_user_id, channel: ctx.channel }
      : {}),
  };
  const refs = { ...e.consent_event_ids, [type]: ref };
  const completed = paperComplete(e.payer, refs);
  const patched = await patchEngagement(
    supabase,
    e.id,
    { status: "eligibility_pending" },
    completed
      ? (() => { assertTransition("eligibility_pending", "signed"); return { consent_event_ids: refs, status: "signed" as const, signed_at: now.toISOString() }; })()
      : { consent_event_ids: refs },
  );
  if (!patched) throw new DfySignError(409, "sign_race", "the engagement changed while you were signing — reload");
  e = patched;
  await emitCaseEvents(supabase, member.id, [
    { claimId: e.claim_id, kind: "dfy_instrument_signed", actor: "user", payload: { engagementId: e.id, instrument: type, consentEventId: eventId, ...(documentId ? { documentId } : {}) } },
    ...(completed
      ? [{ claimId: e.claim_id, kind: "dfy_engagement_signed" as const, actor: "user" as const, payload: { engagementId: e.id, stackComplete: true } }]
      : []),
  ]);
  if (completed) e = await maybeActivateEngagement(supabase, e, config, now);
  return { ref, engagement: e, completed };
}

/**
 * Activation — idempotent, safe to call on every read of a `signed` engagement.
 * Requires the member's composition proof (the route-layer invariant, applied
 * at the lifecycle edge too) and the payer rule: sponsor_paid needs its
 * reference; member_paid activates fee-free while `feeCents` is 0 (the pilot)
 * or once the one-time payment succeeded (metadata.payment).
 */
export async function maybeActivateEngagement(
  supabase: SupabaseClient,
  e: DfyEngagementRow,
  config: DfyConfig,
  now: Date = new Date(),
): Promise<DfyEngagementRow> {
  if (e.status !== "signed") return e;
  const proof = await loadCompositionProof(supabase, e.user_id, e.claim_id);
  if (!compositionComplete(proof)) return e;
  const payment = (e.metadata as { payment?: { status?: string } }).payment;
  let feeWaived: string | null = null;
  if (e.payer === "sponsor_paid") {
    if (!e.sponsor_ref) return e;
    feeWaived = "sponsor_paid";
  } else if (config.feeCents === 0) {
    feeWaived = "free_pilot";
  } else if (payment?.status !== "succeeded") {
    return e;
  }
  assertTransition("signed", "active");
  const patched = await patchEngagement(
    supabase,
    e.id,
    { status: "signed" },
    {
      status: "active",
      activated_at: now.toISOString(),
      scope: { ...e.scope, lane: "insurer", memberFilesAtStateLevel: true, feeWaived, feeCents: feeWaived ? 0 : config.feeCents, activatedBy: { actor: "system" } },
    },
  );
  if (!patched) return e;
  await emitCaseEvents(supabase, e.user_id, [
    { claimId: e.claim_id, kind: "dfy_engagement_activated", actor: "system", payload: { engagementId: e.id, status: "active", feeWaived } },
  ]);
  return patched;
}

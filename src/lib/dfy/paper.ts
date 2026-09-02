/**
 * paper — the DFY paper stack, PURE (handoff §3 "the paper stack — FIVE
 * separate consents, never one bundled click").
 *
 * Which instruments a matter needs is a function of the PAYER (R17): the
 * member-paid lane signs the fee agreement; a sponsor code swaps it for the
 * sponsor-paid disclosure. The health-data consent is the platform's existing
 * one, re-affirmed at the current version.
 *
 * Each instrument is a TEMPLATE in the consent-document registry; this module
 * fills the slots for one engagement and returns the exact text the member
 * signs — that instance text is what the consent event hashes and the PDF
 * renders. The template's registry hash never changes; the instance hash is
 * per signing. No instrument text lives outside the registry.
 */
import { createHash } from "crypto";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import type { ConsentType } from "@/lib/supabase/types";
import type { EngagementPayer } from "@/lib/security/operator-scoped";

export type DfyInstrumentType = Extract<
  ConsentType,
  | "dfy_authorization_hipaa_cmia"
  | "dfy_authorized_representative_designation"
  | "dfy_scope_of_engagement"
  | "dfy_fee_agreement"
  | "dfy_sponsor_paid_disclosure"
  | "health_data_upload"
>;

/** The signing ORDER (the member reads the authorization first; the fee last). */
export function requiredDfyConsents(payer: EngagementPayer): DfyInstrumentType[] {
  // Order = the signing order on the member's page. The designation is LAST:
  // under individual naming it cannot be signed until a representative holds
  // the matter, so everything else is signed first (Andrew, S330 round 1).
  return [
    "dfy_authorization_hipaa_cmia",
    "dfy_scope_of_engagement",
    payer === "sponsor_paid" ? "dfy_sponsor_paid_disclosure" : "dfy_fee_agreement",
    "health_data_upload",
    "dfy_authorized_representative_designation",
  ];
}

/** Instruments that render to a PDF in the member's documents (the submittable artifacts). */
export const PDF_INSTRUMENTS: ReadonlySet<DfyInstrumentType> = new Set<DfyInstrumentType>([
  "dfy_authorization_hipaa_cmia",
  "dfy_authorized_representative_designation",
  "dfy_scope_of_engagement",
  "dfy_fee_agreement",
  "dfy_sponsor_paid_disclosure",
]);

/** The designation channel — which procedure recognizes the representative. */
export type DesignationChannel = "erisa_plan" | "plan_internal_grievance";

/** Who is named as the representative (the who-is-named variant seam; counsel Q2). */
export type NamedParty = "individual" | "entity";

export interface InstrumentContext {
  memberName: string;
  memberEmail: string;
  planName: string;
  insurerName: string;
  claimRef: string;
  dateOfService: string;
  channel: DesignationChannel;
  namedParty: NamedParty;
  /** The individual operator's name (used when namedParty = individual; also the "acting through" name). */
  operatorName: string;
  feeCents: number;
  sponsorRef: string | null;
  /** YYYY-MM-DD */
  effectiveDate: string;
  /** YYYY-MM-DD */
  expiryDate: string;
}

export const ENTITY_NAME = "Airgetlam Labs LLC";

/** The channel follows the plan class the documents put the plan in. */
export function designationChannelFor(coverageType: string | null | undefined): DesignationChannel {
  return coverageType === "employer_self_funded" || coverageType === "employer_self_funded_public"
    ? "erisa_plan"
    : "plan_internal_grievance";
}

function channelClause(ctx: InstrumentContext): string {
  if (ctx.channel === "erisa_plan") {
    return (
      "This designation is made for the plan's internal claims and appeals procedure under 29 CFR §2560.503-1(b)(4), " +
      "and for the federal external review that follows it if the internal appeal is denied. " +
      "The plan may establish reasonable procedures to verify this designation; I ask that it recognize my representative without delay."
    );
  }
  return (
    "This designation is made for the plan's internal grievance and appeal procedure for this claim. " +
    "It is limited to that plan-level procedure. It does not authorize my representative to file with the California Department of Managed Health Care, " +
    "the California Department of Insurance, or any other government agency; I will make any such filing myself (see Section 5)."
  );
}

function representativeName(ctx: InstrumentContext): string {
  return ctx.namedParty === "entity" ? ENTITY_NAME : ctx.operatorName;
}

function representativeKindClause(ctx: InstrumentContext): string {
  return ctx.namedParty === "entity"
    ? "a California limited liability company (the operator of Candid), acting through its employees"
    : `an employee of ${ENTITY_NAME} (the operator of Candid), acting under Candid's supervision`;
}

function feeClause(ctx: InstrumentContext): string {
  const dollars = (ctx.feeCents / 100).toFixed(2);
  return ctx.feeCents === 0
    ? "During Candid's pilot the fee for this matter is $0.00 — no charge. If a fee is ever introduced, it will apply only to matters signed after that date and only under a new fee agreement you sign."
    : `The fee for this matter is $${dollars}, charged once.`;
}

/** Fill the template's slots. Every slot is required; an unfilled slot is a build error, not a blank. */
export function fillInstrument(template: string, ctx: InstrumentContext): string {
  const values: Record<string, string> = {
    MEMBER_NAME: ctx.memberName,
    MEMBER_EMAIL: ctx.memberEmail,
    PLAN_NAME: ctx.planName,
    INSURER_NAME: ctx.insurerName,
    CLAIM_REF: ctx.claimRef,
    DATE_OF_SERVICE: ctx.dateOfService,
    REPRESENTATIVE_NAME: representativeName(ctx),
    REPRESENTATIVE_KIND_CLAUSE: representativeKindClause(ctx),
    CHANNEL_CLAUSE: channelClause(ctx),
    EFFECTIVE_DATE: ctx.effectiveDate,
    EXPIRY_DATE: ctx.expiryDate,
    FEE_CLAUSE: feeClause(ctx),
    SPONSOR_REF: ctx.sponsorRef ?? "—",
  };
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`paper: unknown instrument slot {{${key}}}`);
    return values[key];
  });
  if (/\{\{[A-Z_]+\}\}/.test(out)) throw new Error("paper: an instrument slot survived filling");
  return out;
}

export interface RenderedInstrument {
  type: DfyInstrumentType;
  title: string;
  version: string;
  effectiveDate: string;
  /** The exact text the member signs (the instance). */
  text: string;
  /** sha256 of `text` — what the consent event records. */
  hash: string;
  /** The §56.11 render form (14-point, separate) — the authorization only. */
  authorizationForm: boolean;
}

export function renderInstrument(type: DfyInstrumentType, ctx: InstrumentContext): RenderedInstrument {
  const doc = getConsentDocument(type);
  const text = fillInstrument(doc.fullText, ctx);
  return {
    type,
    title: doc.title,
    version: doc.version,
    effectiveDate: doc.effectiveDate,
    text,
    hash: createHash("sha256").update(text).digest("hex"),
    authorizationForm: type === "dfy_authorization_hipaa_cmia",
  };
}

/** The authorization expires one year after signing unless the engagement ends first. */
export function defaultExpiryDate(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

export function todayDateOnly(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The engagement's consent refs, one key per instrument. */
export interface SignedInstrumentRef {
  eventId: string;
  documentId: string | null;
  signedName: string;
  signedAt: string;
  hash: string;
  version: string;
  /** Designation only: who was named (so a hand-off can detect it names someone else). */
  namedParty?: NamedParty;
  namedOperatorUserId?: string | null;
  channel?: DesignationChannel;
}

export function signedInstruments(consentEventIds: Record<string, unknown>): Partial<Record<DfyInstrumentType, SignedInstrumentRef>> {
  const out: Partial<Record<DfyInstrumentType, SignedInstrumentRef>> = {};
  for (const [k, v] of Object.entries(consentEventIds ?? {})) {
    if (v && typeof v === "object" && typeof (v as SignedInstrumentRef).eventId === "string") {
      out[k as DfyInstrumentType] = v as SignedInstrumentRef;
    }
  }
  return out;
}

/** Every required instrument signed? */
export function paperComplete(payer: EngagementPayer, consentEventIds: Record<string, unknown>): boolean {
  const signed = signedInstruments(consentEventIds);
  return requiredDfyConsents(payer).every((t) => !!signed[t]);
}

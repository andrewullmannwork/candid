/**
 * dispute-readiness — ONE derivation of "is this letter ready to send" (S302).
 *
 * WHY THIS EXISTS. `computeDisputeStrength` was already shared, but the ~80
 * lines that assemble its inputs from a persisted dispute row were not: the
 * [disputeId] GET and the case-file route each hand-rolled them, and the two
 * had drifted with live consequences on the LEGAL export:
 *
 *   1. case-file passed `letterType: dispute.dispute_type` — the RAW vocab.
 *      The GET passes the RESOLVED type, with a comment explaining why. With
 *      `letter_requirements_v1` OFF (production today) the gap logic falls back
 *      to `letterType === "insurance_appeal"`, which raw "internal_appeal"
 *      fails — so the Case File asked an appeal for the PROVIDER's address and
 *      never for the appeals address it prints.
 *   2. Worse and flag-independent: `resolveLegalBasis()` switches on
 *      "insurance_appeal" with no normalization and no flag gate, so the raw
 *      vocab yielded NO legal basis — and `backedClaim` in the readiness floor
 *      is partly `legalBasis.length > 0`. The Case File could score a letter
 *      "nothing backs this charge" where the page scored it backed.
 *
 * Both routes now call this. The S302 send gate is the third caller: the route
 * that records "sent" refuses the transition when the floor is unmet, and it
 * must judge on the SAME definition the page shows or the two will disagree at
 * exactly the moment it matters.
 *
 * NOT a caller: `/api/disputes/generate` computes strength BEFORE a dispute row
 * exists, so it has no persisted row to resolve from. It is structurally
 * different, not an omission.
 *
 * Read-only. The GET's regeneration, drift, and coverage-diff logic stays in
 * the GET — this is the read half, which is all the other two callers need.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  resolvePlanContext,
  type PlanContext,
  type InsurerAddressOverride,
} from "@/lib/disputes/plan-context";
import { resolveEvidence, type DisputeEvidence } from "@/lib/disputes/evidence-resolver";
import {
  computeDisputeStrength,
  loadStrengthConfig,
  type StrengthResult,
} from "@/lib/disputes/strength-scoring";
import { letterRecipientKind } from "@/lib/disputes";
import { resolveLetterTypeFromDispute } from "@/lib/disputes/letter-type";
import { resolveAccountName } from "@/lib/disputes/rerender";

/**
 * Name comparison for the identity floor. Was a PRIVATE copy in BOTH the
 * [disputeId] GET and the case-file route — identical today, but two copies of
 * a normalization rule is one edit away from two answers. Both are deleted.
 */
function normalizeNameForCompare(name: string): string {
  return name.toLowerCase().replace(/[.,'"()]/g, "").replace(/\s+/g, " ").trim();
}

/** The dispute columns this resolver reads. Callers already hold these. */
export interface ReadinessDisputeRow {
  id: string;
  claim_id: string | null;
  dispute_type: string;
  insurance_plan_id?: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PatientNameMismatch {
  billName: string;
  profileName: string;
}

export interface DisputeReadinessResult {
  /** metadata.letterType, legacy vocab reverse-mapped. */
  resolvedLetterType: string;
  planContext: PlanContext | null;
  evidence: DisputeEvidence | null;
  /** Null only when the computation threw — never fatal to the caller. */
  strength: StrengthResult | null;
  /** Null when the names agree OR the user explicitly confirmed identity. */
  patientNameMismatch: PatientNameMismatch | null;
  /** users.display_name (email fallback) — the letter's attesting name. */
  accountName: string;
  /** Fetched here; returned so callers don't re-read the claim row. */
  claimMetadata: Record<string, unknown> | null;
}

/**
 * The patient-identity half of the readiness floor.
 *
 * Sticky by design (Block C2): once the user answers confirm-patient-identity,
 * the mismatch is suppressed regardless of the live name compare, so a later
 * profile-name edit cannot silently reopen a closed floor item.
 */
async function resolvePatientIdentity(
  supabase: SupabaseClient,
  userId: string,
  dispute: ReadinessDisputeRow,
): Promise<{
  patientNameMismatch: PatientNameMismatch | null;
  accountName: string;
  claimMetadata: Record<string, unknown> | null;
}> {
  let patientNameMismatch: PatientNameMismatch | null = null;
  let accountName = "";
  let claimMetadata: Record<string, unknown> | null = null;
  try {
    const [claimRes, userRes] = await Promise.all([
      dispute.claim_id
        ? userScoped(supabase, userId)
            .table("claims")
            .select("metadata")
            .eq("id", dispute.claim_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("users").select("display_name, email").eq("id", userId).maybeSingle(),
    ]);
    claimMetadata = (claimRes.data?.metadata as Record<string, unknown> | null) ?? null;
    const billName =
      (claimMetadata as { patient?: { name?: string } } | null)?.patient?.name?.trim() ?? "";
    accountName = resolveAccountName(userRes.data?.display_name, userRes.data?.email);
    if (
      billName &&
      accountName &&
      normalizeNameForCompare(billName) !== normalizeNameForCompare(accountName)
    ) {
      patientNameMismatch = { billName, profileName: accountName };
    }
  } catch (err) {
    console.warn("[dispute-readiness] patient-name compare failed (non-fatal):", err);
  }
  if ((dispute.metadata ?? {}).patientIdentityResolved === true) {
    patientNameMismatch = null;
  }
  return { patientNameMismatch, accountName, claimMetadata };
}

export async function resolveDisputeReadiness(
  supabase: SupabaseClient,
  params: {
    userId: string;
    dispute: ReadinessDisputeRow;
    /** The claim line items this letter covers; [] → the whole claim. */
    lineItemIds: string[];
  },
): Promise<DisputeReadinessResult> {
  const { userId, dispute, lineItemIds } = params;
  const meta = dispute.metadata ?? {};
  const resolvedLetterType = resolveLetterTypeFromDispute(dispute);

  const identity = await resolvePatientIdentity(supabase, userId, dispute);

  let planContext: PlanContext | null = null;
  let evidence: DisputeEvidence | null = null;
  if (dispute.claim_id) {
    try {
      // S109 PR #2 (Chunk B) — the user's same-insurer answer for the bill year
      // decides whether the fallback plan's coverage loads as a Case C proxy.
      const userConfirmedSamePlan = ((): "yes" | "no" | "not_sure" | null => {
        const v = meta.userConfirmedSamePlan;
        return v === "yes" || v === "no" || v === "not_sure" ? v : null;
      })();
      // S110 Chunk D / S111 D2 — read BEFORE resolvePlanContext so it can thread
      // through to planContext.boundCanonicalPlan.
      const canonicalPlanIdForBillYear = ((): string | null => {
        const v = meta.canonicalPlanIdForBillYear;
        return typeof v === "string" && v.length > 0 ? v : null;
      })();
      // Block C2 — service-not-rendered attestations reclassify their lines.
      const serviceAttestedLineIds = Array.isArray(meta.serviceAttestedLineIds)
        ? (meta.serviceAttestedLineIds as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
      // Block C2.2 (S152) — per-dispute appeals-address override.
      const insurerAddressOverride =
        (meta.insurerAddressOverride as InsurerAddressOverride | null) ?? null;
      planContext = await resolvePlanContext(supabase, {
        userId,
        claimId: dispute.claim_id,
        canonicalPlanIdForBillYear,
        insurerAddressOverride,
        // The dispute's EXPLICIT plan override; null → the claim's live
        // DOS-correct plan, so a later claim correction flows through.
        pinnedInsurancePlanId: dispute.insurance_plan_id ?? null,
      });
      evidence = await resolveEvidence(supabase, {
        userId,
        claimIds: [dispute.claim_id],
        lineItemIds: lineItemIds.length > 0 ? lineItemIds : undefined,
        planContext,
        // ⚠ The RESOLVED type, never the raw dispute_type vocab. resolveEvidence
        // gates the provider/insurer address gaps AND resolveLegalBasis on
        // `letterType === "insurance_appeal"`, so raw "internal_appeal" makes an
        // appeal ask for a provider address and carry no legal basis. This is
        // the case-file bug this module exists to end.
        letterType: resolvedLetterType,
        disputeId: dispute.id,
        userConfirmedSamePlan,
        canonicalPlanIdForBillYear,
        attestedLineItemIds: serviceAttestedLineIds,
      });
    } catch (err) {
      console.warn("[dispute-readiness] evidence resolve failed (non-fatal):", err);
    }
  }

  let strength: StrengthResult | null = null;
  try {
    strength = computeDisputeStrength(evidence, {
      config: await loadStrengthConfig(supabase),
      patientIdentityResolved: !identity.patientNameMismatch,
      recipientKind: letterRecipientKind(resolvedLetterType),
      // S301 — without this the floor keeps the legacy recipient mapping, where
      // `collector` falls to the both-addresses branch and a debt-validation
      // letter stays "Not ready to send" for two addresses it never prints.
      letterRequirementsOn: await isFeatureEnabled("letter_requirements_v1"),
    });
  } catch (err) {
    console.error("[dispute-readiness] strength computation failed (non-fatal):", err);
  }

  return {
    resolvedLetterType,
    planContext,
    evidence,
    strength,
    patientNameMismatch: identity.patientNameMismatch,
    accountName: identity.accountName,
    claimMetadata: identity.claimMetadata,
  };
}

/**
 * The SEND GATE (S302, Andrew: "make sure the letter can't be sent or used
 * until the required fields are added").
 *
 * Returns the missing floor items, or [] when the letter may be sent. Callers:
 * the letter page's spine (locks Download / Mail it certified / Mark it as
 * sent) and the outcome route (refuses the `filed` transition).
 *
 * Flag-gated on `letter_requirements_v1` IN LOCKSTEP with the floor's own
 * definition: OFF, the floor still uses the legacy recipient mapping, under
 * which a collector letter fails for a provider address it never prints —
 * enforcing that would lock a user out of sending a correct letter.
 */
export type ReadinessBlocker =
  | "data_trust"
  | "backed_claim"
  | "recipient_address"
  | "patient_identity";

/**
 * Gate copy, beside the gate it describes (the S301 `outcome-actions.ts`
 * idiom — splitting an operation's payload from its wording is how the rail
 * and the letter page ended up describing unsend differently).
 *
 * Each blocker names WHAT is missing and HOW to fix it, because "Not ready to
 * send" without a remedy is the state this gate exists to end.
 */
/**
 * The data-trust hard stop, in ONE place (S302, Andrew: "where does the data
 * trust string go? do we need a time estimate?").
 *
 * It already had both a home and a time estimate: DataTrustBanner has said
 * "Check back in 24 hours" since Block A. The gate's own first draft invented a
 * second sentence for the same condition — two voices, one fact. The banner now
 * renders these strings verbatim and the send gate reuses them, so the estimate
 * can only ever be changed in one place.
 *
 * WHERE EACH APPEARS. With `dispute_letter_v3_design` ON, a hard-stopped bill
 * serves NO letter at all and the page renders the BANNER instead of the spine
 * — so the gate line is the belt-and-braces path for the flag-OFF world. The
 * blocker stays in the list either way, because the server gate protects the
 * RECORD (clock, follow-ups, flywheel) and must not depend on a display flag.
 */
export const DATA_TRUST_HARD_STOP = {
  title: "Verifying this bill",
  body:
    "We noticed something unusual about this bill's totals and want to verify " +
    "before generating a dispute. Check back in 24 hours.",
  /** The same promise, compressed for the gate's one-line list. */
  gateFix: "we're verifying the totals first — check back in 24 hours",
} as const;

export const SEND_GATE_COPY = {
  /** 409 body — the client refetches and re-renders the locked state. */
  error: "This letter isn't ready to send yet.",
  heading: (n: number): string =>
    n === 1
      ? "One thing is still missing before this letter can go out"
      : `${n} things are still missing before this letter can go out`,
  blocker: (
    kind: ReadinessBlocker,
    recipientKind: "insurer" | "provider" | "collector" | "both",
  ): { what: string; fix: string } => {
    switch (kind) {
      case "recipient_address":
        return {
          what:
            recipientKind === "insurer"
              ? "Your insurer's appeals address"
              : recipientKind === "collector"
                ? "The collection agency's details"
                : "The provider's mailing address",
          fix: "the letter has nowhere to be mailed",
        };
      case "backed_claim":
        return {
          what: "Something to back the charge",
          fix: "add your plan document or the EOB",
        };
      case "patient_identity":
        return { what: "Who the patient is", fix: "confirm whether this bill is yours" };
      case "data_trust":
        // The banner's own words, not a second set for the same condition.
        return { what: DATA_TRUST_HARD_STOP.title, fix: DATA_TRUST_HARD_STOP.gateFix };
    }
  },
} as const;

/** The 409 body's `error` string, shared so the client can recognise it. */
export const SEND_GATE_ERROR = SEND_GATE_COPY.error;

export function sendBlockers(
  strength: StrengthResult | null,
  letterRequirementsOn: boolean,
): ReadinessBlocker[] {
  if (!letterRequirementsOn) return [];
  // No strength → the computation threw. Fail OPEN: a monitoring failure must
  // never become a wall between the user and their own letter.
  if (!strength) return [];
  const r = strength.readiness.required;
  const out: ReadinessBlocker[] = [];
  if (!r.dataTrustPass) out.push("data_trust");
  if (!r.backedClaim) out.push("backed_claim");
  if (!r.recipientAddress) out.push("recipient_address");
  if (!r.patientIdentity) out.push("patient_identity");
  return out;
}

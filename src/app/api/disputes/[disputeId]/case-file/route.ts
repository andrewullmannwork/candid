/**
 * GET /api/disputes/[disputeId]/case-file — structured Case File for a dispute.
 *
 * Assembles the dispute's evidence into a portable, structured view for the
 * Block C UI: the three-axis strength read-out, per-line findings + plan-coverage
 * evidence (with cite-grade quotes), legal basis, open evidence gaps, and the
 * user's dispute outcome history.
 *
 * This is a PURE READ — unlike GET /api/disputes/[disputeId], it does NOT
 * regenerate or persist the letter. Everything derives from the dispute row +
 * live (side-effect-free) evidence resolution, so the request is idempotent.
 *
 * Security (Block B; plans/dispute_letter_overhaul.md §5):
 *   - Auth: Firebase bearer token via requireAuthenticatedUser (B9-1 §C1).
 *   - Tier (P6): Stream-1 Pro gate — Case File compilation is a Pro feature
 *     (FEATURE_ACCESS.documentationAggregation). Checked BEFORE the resource is
 *     loaded so a free caller learns nothing about whether the dispute exists,
 *     and we skip the expensive evidence resolution.
 *   - IDOR (P4): the dispute is loaded scoped to the authenticated user; a
 *     non-owned (or non-existent) id returns 404.
 *
 * Data-trust HARD STOP (flag-gated on dispute_letter_v3_design, default OFF):
 *   when ON and the bill failed header reconciliation, the Case File is blocked
 *   (mirrors letter generation) — we never compile a legal artifact from a bill
 *   we couldn't reconcile. A sign-convention WARN is surfaced, not blocked.
 *
 * Cite-grade gate (CF-60 inv 1 / legal L3): raw evidence + the `gateUnverified`
 * flag are surfaced; cite-grade enforcement stays at the consumer-read/template
 * layer. This endpoint never strips or inlines citations server-side.
 *
 * Response: { headers: Cache-Control private, no-store } — the Case File is
 * per-user sensitive data and must not be cached by browser or proxy.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/security/require-authenticated-user";
import { loadServerSubscription } from "@/lib/subscription/server";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import {
  computeDisputeStrength,
  loadStrengthConfig,
  type StrengthResult,
} from "@/lib/disputes/strength-scoring";
import { letterRecipientKind } from "@/lib/disputes";
import { resolveAccountName } from "@/lib/disputes/rerender";
import { getUserDisputes } from "@/lib/disputes/persist";
import { isFeatureEnabled } from "@/lib/config/product-flags";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" } as const;

function normalizeNameForCompare(name: string): string {
  return name.toLowerCase().replace(/[.,'"()]/g, "").replace(/\s+/g, " ").trim();
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  // 1) Auth (B9-1 §C1) — authoritative user id from the verified Firebase token.
  const authedUser = await requireAuthenticatedUser(req);
  if (!authedUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();

  // 2) Tier gate (P6) — before resource load: a free caller can't probe dispute
  // existence, and we avoid resolving evidence for someone who can't read it.
  const subscription = await loadServerSubscription(supabase, authedUser.id);
  if (!subscription.isPro) {
    console.log(
      `[disputes/case-file] tier gate blocked: user ${authedUser.id} tier=${subscription.tier} status=${subscription.status} → 403`,
    );
    return NextResponse.json(
      { error: "subscription_required", requiredTier: "pro" },
      { status: 403, headers: PRIVATE_NO_STORE },
    );
  }

  // 3) Ownership / IDOR (P4) — scope the dispute to the authenticated user.
  const { disputeId } = await params;
  const { data: dispute, error } = await supabase
    .from("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .eq("user_id", authedUser.id)
    .single();
  if (error || !dispute) {
    return NextResponse.json(
      { error: "Dispute not found" },
      { status: 404, headers: PRIVATE_NO_STORE },
    );
  }

  // Linked line items (primary + metadata extras) — mirrors the [disputeId] GET.
  const extraIds =
    (dispute.metadata?.claimLineItemIds as string[] | undefined) || [];
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];

  // 4) Resolve plan context + structured evidence (pure reads; NO letter
  // regeneration or persistence). Non-fatal: a failure leaves them null and the
  // Case File still returns with whatever resolved.
  let planContext = null;
  let evidence = null;
  if (dispute.claim_id) {
    const userConfirmedSamePlan = ((): "yes" | "no" | "not_sure" | null => {
      const v = (dispute.metadata as Record<string, unknown> | null)
        ?.userConfirmedSamePlan;
      return v === "yes" || v === "no" || v === "not_sure" ? v : null;
    })();
    const canonicalPlanIdForBillYear = ((): string | null => {
      const v = (dispute.metadata as Record<string, unknown> | null)
        ?.canonicalPlanIdForBillYear;
      return typeof v === "string" && v.length > 0 ? v : null;
    })();
    // Block C2 — service-not-rendered attestations, threaded so the Case File's
    // evidence + strength reflect the user's attestations.
    const serviceAttestedLineIds = ((): string[] => {
      const v = (dispute.metadata as Record<string, unknown> | null)
        ?.serviceAttestedLineIds;
      return Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    })();
    try {
      planContext = await resolvePlanContext(supabase, {
        userId: authedUser.id,
        claimId: dispute.claim_id,
        canonicalPlanIdForBillYear,
      });
      evidence = await resolveEvidence(supabase, {
        userId: authedUser.id,
        claimIds: [dispute.claim_id],
        lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
        planContext,
        letterType: dispute.dispute_type,
        disputeId: dispute.id,
        userConfirmedSamePlan,
        canonicalPlanIdForBillYear,
        attestedLineItemIds: serviceAttestedLineIds,
      });
    } catch (err) {
      console.error(
        "[disputes/case-file] evidence resolve failed (non-fatal):",
        err,
      );
    }
  }

  // 5) Patient-identity resolution for the readiness axis — mirrors the
  // [disputeId] GET name-match (names match → identity resolved). Inlined to
  // keep Block B self-contained + zero-touch to the just-shipped GET; a shared
  // patient-identity helper is a logged follow-up.
  let patientNameMismatch: { billName: string; profileName: string } | null =
    null;
  try {
    const { data: userRow } = await supabase
      .from("users")
      .select("display_name, email")
      .eq("id", authedUser.id)
      .maybeSingle();
    let billName = "";
    if (dispute.claim_id) {
      const { data: claim } = await supabase
        .from("claims")
        .select("metadata")
        .eq("id", dispute.claim_id)
        .maybeSingle();
      billName =
        (claim?.metadata as { patient?: { name?: string } } | undefined)
          ?.patient?.name?.trim() ?? "";
    }
    const accountName = resolveAccountName(
      userRow?.display_name,
      userRow?.email,
    );
    if (
      billName &&
      accountName &&
      normalizeNameForCompare(billName) !== normalizeNameForCompare(accountName)
    ) {
      patientNameMismatch = { billName, profileName: accountName };
    }
  } catch (err) {
    console.warn(
      "[disputes/case-file] patient-name compare failed (non-fatal):",
      err,
    );
  }

  // Block C2 — sticky patient-identity confirmation (POST confirm-patient-identity):
  // suppress the mismatch so the readiness axis stays closed (mirrors the GET route).
  if (
    (dispute.metadata as Record<string, unknown> | null)
      ?.patientIdentityResolved === true
  ) {
    patientNameMismatch = null;
  }

  // 6) Three-axis strength — the single source of truth. Pure + never throws;
  // the readiness axis consumes the name-match resolved above.
  let strength: StrengthResult | null = null;
  try {
    const strengthConfig = await loadStrengthConfig(supabase);
    strength = computeDisputeStrength(evidence, {
      config: strengthConfig,
      patientIdentityResolved: !patientNameMismatch,
      recipientKind: letterRecipientKind(dispute.dispute_type),
    });
  } catch (err) {
    console.error(
      "[disputes/case-file] strength computation failed (non-fatal):",
      err,
    );
  }

  // 7) Data-trust HARD STOP (flag-gated; mirrors letter generation). A
  // sign-convention WARN is surfaced via strength.dataTrust below, NOT blocked.
  const v3DesignOn = await isFeatureEnabled(
    "dispute_letter_v3_design",
    authedUser.email ?? undefined,
  );
  if (v3DesignOn && strength?.dataTrust.gate === "hard_stop") {
    return NextResponse.json(
      { blocked: true, reason: strength.dataTrust.reason, strength },
      { headers: PRIVATE_NO_STORE },
    );
  }

  // 8) Cite-grade gate is consumer-applied (CF-60 inv 1): surface the flag,
  // never strip citations server-side.
  const gateUnverified = await isFeatureEnabled(
    "consumer_read_filter_v1",
    authedUser.email ?? undefined,
  );

  // 9) Outcome history — USER-OWNED data only (this dispute + the user's own
  // track record). Cross-user success-rate priors are a separate k-anon-gated
  // signal, out of Block B (and empty in PROD) → Data Rule #5 safe.
  let outcomeHistory: Awaited<ReturnType<typeof getUserDisputes>> | null = null;
  try {
    outcomeHistory = await getUserDisputes(supabase, authedUser.id);
  } catch (err) {
    console.error(
      "[disputes/case-file] outcome history failed (non-fatal):",
      err,
    );
  }

  // Structured Case File. Findings + per-line plan-coverage + cite-grade quotes
  // all live inside `evidence` (lineItemEvidence[].planBenefit + auditFindings);
  // the Block C UI renders them, applying the cite-grade 3-case gate via
  // `gateUnverified`.
  return NextResponse.json(
    {
      disputeId: dispute.id,
      disputeType: dispute.dispute_type,
      status: dispute.status,
      claimId: dispute.claim_id,
      // Three-axis strength is the single source for the data-trust banner +
      // evidence band + readiness rail.
      strength,
      dataTrust: strength?.dataTrust ?? null,
      // Structured evidence: findings, per-line plan-coverage, cite-grade
      // quotes, legal basis, gaps. Consumer applies cite-grade gating.
      evidence,
      gateUnverified,
      planContext: planContext
        ? {
            plan: planContext.plan,
            insurer: planContext.insurer,
            missingForYear: planContext.missingForYear,
            providerContact: planContext.providerContact,
          }
        : null,
      // This dispute's own outcome (from the row) + the user's track record.
      // Empty in PROD until the flywheel fills (S141 wipe) — the UI gates/hides.
      thisDisputeOutcome: {
        status: dispute.status,
        amountDisputed: dispute.amount_disputed ?? 0,
        amountRecovered: dispute.amount_recovered ?? 0,
        filedDate: dispute.filed_date ?? null,
        resolutionDate: dispute.resolution_date ?? null,
      },
      outcomeHistory,
      patientNameMismatch,
    },
    { headers: PRIVATE_NO_STORE },
  );
}

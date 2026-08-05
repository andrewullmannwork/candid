/**
 * POST /api/disputes/[disputeId]/redraft — Session 73 / S71 hotfix #4.
 *
 * User-triggered "Re-draft letter" path. Same evidence + letter regeneration
 * as the GET /api/disputes/[disputeId] route handler, but ALSO runs CF-20
 * re-parse-on-flag for any per-service rows whose `sbcExcerptVerified=false`.
 *
 * Why a separate endpoint vs adding CF-20 to the GET path: GET fires on every
 * dispute-page navigation. Adding Haiku re-parse there would burn the per-plan
 * daily cost cap on passive page views. POST /redraft is user-initiated, so
 * cost is bounded by explicit clicks (plus the existing per-reparse +
 * per-plan-daily caps in `consumer_read_filter_v1.config`).
 *
 * Use cases:
 *   - User uploaded an additional plan document after drafting the letter →
 *     wants to refresh the letter to incorporate new evidence.
 *   - User wants to re-attempt cite-grade upgrade for a no-cite field that
 *     might now have un-searched sections available for re-parse.
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute.
 * Returns: the updated letter content + planContext + evidence + cf20 summary.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { userScoped } from "@/lib/security/user-scoped";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { rerenderDisputeLetter } from "@/lib/disputes/rerender";
import { reparseField } from "@/lib/plan/reparse-field";
import { loadDecorationContext } from "@/lib/plan/analyze-decoration";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  computeEvidenceFingerprint,
  loadFingerprintInputForClaim,
} from "@/lib/disputes/evidence-fingerprint";
import { emitCaseEvent } from "@/lib/case/case-events";
import { loadServerSubscription } from "@/lib/subscription/server";
import { letterRequiresPro, evaluateLetterAccess } from "@/lib/disputes/letter-access";
import { resolveLetterTypeFromDispute, letterPatientIdentityFromMeta } from "@/lib/disputes/letter-type";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

// resolveLetterTypeFromDispute — consolidated to src/lib/disputes/letter-type.ts
// (S298). This route's private copy had DRIFTED from the [disputeId] GET's on
// legacy rows (complaint → overcharge here vs balance_billing there; default →
// insurance_appeal vs overcharge) — a legacy complaint letter would change
// template on redraft. One shared resolver ends the drift class.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const decoded = await getAuthUser(req);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { disputeId } = await params;
  const supabase = createServerClient();

  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("firebase_uid", decoded.uid)
    .single();
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: dispute, error } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .single();
  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }
  if (!dispute.claim_id) {
    return NextResponse.json({ error: "Dispute has no linked claim" }, { status: 400 });
  }

  // S292 (#12) — tier gate scoped to the LETTER TYPE, exactly like generate + the
  // GET ?refresh=1 path: core dispute letters are free (dispute-letters v2 S2 tier
  // flip — letter-access.ts is the single source of truth), only the escalation
  // letters (final_notice / external_review) require Pro. The prior blanket
  // `isPro` 403 predated the tier flip and made free users' Re-draft fail while
  // Refresh succeeded on the SAME letter. Dispute existence is not probeable
  // cross-user: the load above is userScoped (a foreign id 404s regardless of tier).
  const redraftLetterType = resolveLetterTypeFromDispute(dispute);
  if (letterRequiresPro(redraftLetterType)) {
    const subscription = await loadServerSubscription(supabase, user.id);
    const access = evaluateLetterAccess({
      letterType: redraftLetterType,
      isPro: subscription.isPro,
    });
    if (!access.allowed) {
      console.log(
        `[disputes/redraft] tier gate blocked: user ${user.id} tier=${subscription.tier} status=${subscription.status} letterType=${redraftLetterType} → 403`,
      );
      return NextResponse.json(
        { error: "subscription_required", requiredTier: "pro" },
        { status: 403 },
      );
    }
  }

  // S109 PR #2 — rate limit: 3 redrafts per dispute per rolling 24 hours.
  // Each redraft runs Haiku re-parse (CF-20 path) which has per-plan daily
  // cost caps downstream, but the user-facing cap prevents thrashing on a
  // single dispute. Stored as ISO timestamp array on dispute.metadata; older
  // entries pruned on each call.
  const REDRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const REDRAFT_LIMIT = 3;
  const rawHistory =
    (dispute.metadata?.redraftHistory as string[] | undefined) ?? [];
  const now = Date.now();
  const liveHistory = rawHistory.filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && now - t < REDRAFT_WINDOW_MS;
  });
  if (liveHistory.length >= REDRAFT_LIMIT) {
    const oldestLiveMs = Math.min(...liveHistory.map((iso) => Date.parse(iso)));
    const retryAtMs = oldestLiveMs + REDRAFT_WINDOW_MS;
    const hoursUntilReset = Math.max(1, Math.ceil((retryAtMs - now) / (60 * 60 * 1000)));
    return NextResponse.json(
      {
        error: `Re-draft limit reached (3 per 24 hours). Try again in ${hoursUntilReset} hour${hoursUntilReset === 1 ? "" : "s"}.`,
        retryAt: new Date(retryAtMs).toISOString(),
      },
      { status: 429 },
    );
  }

  const extraIds = (dispute.metadata?.claimLineItemIds as string[] | undefined) || [];
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];

  // S109 PR #2 (Chunk B) — read user's same-plan confirmation answer; passed
  // to resolveEvidence so fallback-plan coverage is loaded only when 'yes'.
  const userConfirmedSamePlan = ((): "yes" | "no" | "not_sure" | null => {
    const v = (dispute.metadata as Record<string, unknown> | null)?.userConfirmedSamePlan;
    return v === "yes" || v === "no" || v === "not_sure" ? v : null;
  })();
  // S110 Chunk D — read manual canonical bind. S111 D2: threaded into
  // resolvePlanContext so boundCanonicalPlan populates for templates.ts
  // citation rendering. Also threaded into both resolveEvidence calls below
  // so the coverage chain stays consistent across the CF-20 redraft cycle.
  const canonicalPlanIdForBillYear = ((): string | null => {
    const v = (dispute.metadata as Record<string, unknown> | null)?.canonicalPlanIdForBillYear;
    return typeof v === "string" && v.length > 0 ? v : null;
  })();
  // Block C2 — service-not-rendered attestations; threaded into both resolveEvidence
  // passes so the re-drafted letter preserves the attested reclassification.
  const serviceAttestedLineIds = ((): string[] => {
    const v = (dispute.metadata as Record<string, unknown> | null)?.serviceAttestedLineIds;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  })();
  // Step 1: resolve plan context + initial evidence pass. A re-draft resolves
  // with the dispute's explicit user override (or the claim's live DOS-correct
  // plan), so it never silently rebuilds on a wrong plan.
  const planContext = await resolvePlanContext(supabase, {
    userId: user.id,
    claimId: dispute.claim_id,
    canonicalPlanIdForBillYear,
    pinnedInsurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
  });
  let evidence = await resolveEvidence(supabase, {
    userId: user.id,
    claimIds: [dispute.claim_id],
    lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
    planContext,
    letterType: dispute.dispute_type,
    disputeId: dispute.id,
    userConfirmedSamePlan,
    canonicalPlanIdForBillYear,
    attestedLineItemIds: serviceAttestedLineIds,
  });

  // Step 2: CF-20 re-parse-on-flag — mirrors /api/disputes/generate logic.
  // Bounded by reparseField's existing cost caps. Skipped when flag off OR
  // no plan to attach to.
  let cf20TargetCount = 0;
  let cf20UpgradeCount = 0;
  if (planContext?.plan?.id) {
    try {
      const flagOn = await isFeatureEnabled("consumer_read_filter_v1", user.email ?? undefined);
      if (flagOn) {
        const planIdForReparse: string = planContext.plan.id;
        const targets = new Map<string, { serviceSlug: string; fieldName: string }>();
        for (const claim of evidence.claims) {
          for (const li of claim.lineItemEvidence) {
            if (li.planBenefit && !li.planBenefit.sbcExcerptVerified && li.serviceSlug) {
              const fieldName = li.planBenefit.copay !== null ? "in_copay" : "in_coinsurance";
              const key = `${li.serviceSlug}|${fieldName}`;
              if (!targets.has(key)) {
                targets.set(key, { serviceSlug: li.serviceSlug, fieldName });
              }
            }
          }
        }

        cf20TargetCount = targets.size;
        if (targets.size > 0) {
          const decoration = await loadDecorationContext(
            supabase,
            user.email ?? null,
            { canonical_plan_id: planContext.plan.canonicalPlanId ?? null },
          );
          if (decoration) {
            const reparseResults = await Promise.allSettled(
              Array.from(targets.values()).map((t) =>
                reparseField(
                  supabase,
                  user.id as string,
                  { planId: planIdForReparse, fieldName: t.fieldName, serviceSlug: t.serviceSlug },
                  decoration,
                ),
              ),
            );
            cf20UpgradeCount = reparseResults.filter(
              (r) => r.status === "fulfilled" && r.value.success,
            ).length;
            console.log(
              `[disputes/redraft] CF-20 re-parse-on-flag: ${cf20TargetCount} target(s), ${cf20UpgradeCount} upgraded`,
            );

            if (cf20UpgradeCount > 0) {
              evidence = await resolveEvidence(supabase, {
                userId: user.id,
                claimIds: [dispute.claim_id],
                lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
                planContext,
                letterType: dispute.dispute_type,
                disputeId: dispute.id,
                userConfirmedSamePlan,
                canonicalPlanIdForBillYear,
                attestedLineItemIds: serviceAttestedLineIds,
              });
            }
          }
        }
      }
    } catch (cf20Err) {
      console.error("[disputes/redraft] CF-20 path failed (non-fatal):", cf20Err);
    }
  }

  // Step 3: regenerate letter body using refreshed evidence.
  const letterTypeForRender = resolveLetterTypeFromDispute(dispute);
  // Block C2 item 1 — thread the adopted attesting name into String 2 on redraft.
  const attestingAsName = ((): string | undefined => {
    const v = (dispute.metadata as Record<string, unknown> | null)?.attestingAsName;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  })();
  // S306 (UX-2) — a redraft must compose from EVERYTHING the letter was born
  // with (same non-lossy rule as the GET regen): collector block, account
  // number, certified notation, exhaustion clause, §1692g window, identity
  // answer. All re-read from the dispute's own metadata.
  const redraftMeta = (dispute.metadata as Record<string, unknown> | null) ?? {};
  const redraftFirstContact =
    typeof redraftMeta.collectorFirstContactDate === "string"
      ? redraftMeta.collectorFirstContactDate
      : null;
  const redraftDeadlineEngineOn = await isFeatureEnabled("dispute_deadline_engine_v1");
  let redraftDebtWithinWindow: boolean;
  if (redraftDeadlineEngineOn) {
    const { evaluateDeadline, readDeadlineConfig } = await import(
      "@/lib/disputes/deadline-engine"
    );
    redraftDebtWithinWindow = evaluateDeadline(
      {
        letterType: letterTypeForRender,
        denialNoticeDate:
          typeof redraftMeta.denialNoticeDate === "string" ? redraftMeta.denialNoticeDate : null,
        collectorFirstContactDate: redraftFirstContact,
      },
      await readDeadlineConfig(supabase),
    ).debtWithinWindow;
  } else {
    // Legacy §1692g fallback — byte-identical to generate/escalate's flag-OFF math.
    const first = redraftFirstContact ? Date.parse(redraftFirstContact) : NaN;
    redraftDebtWithinWindow =
      !Number.isNaN(first) && Date.now() - first <= 30 * 24 * 60 * 60 * 1000;
  }
  const rerendered = await rerenderDisputeLetter(supabase, {
    // S306 — redraft composes THIS dispute's own letter; its id is excluded
    // from the prior-contact recital.
    composingDisputeId: dispute.id,
    userId: user.id,
    letterType: letterTypeForRender,
    claimId: dispute.claim_id,
    lineItemIds: allLineItemIds,
    planContext,
    evidence,
    attestingName: attestingAsName,
    patientIdentity: letterPatientIdentityFromMeta(redraftMeta),
    accountNumber:
      typeof redraftMeta.accountNumber === "string" && redraftMeta.accountNumber.trim()
        ? redraftMeta.accountNumber.trim()
        : undefined,
    collector:
      (redraftMeta.collector as { name: string; address?: string | null; originalCreditor?: string | null } | undefined) ??
      undefined,
    appealExhausted:
      (redraftMeta.appealExhausted as { attested: boolean; denialDate?: string | null } | undefined) ??
      undefined,
    certifiedMail:
      typeof redraftMeta.certifiedMail === "boolean" ? redraftMeta.certifiedMail : undefined,
    debtWithinWindow: redraftDebtWithinWindow,
  });

  if (!rerendered) {
    return NextResponse.json(
      { error: "Letter regeneration failed" },
      { status: 500 },
    );
  }
  const newBody = rerendered.body;

  // Step 4: persist updated letter content + extend redraft history.
  const newTimestamp = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    letter_content: newBody,
    metadata: {
      ...(dispute.metadata ?? {}),
      lastRedraftAt: newTimestamp,
      lastRedraftCf20: { targets: cf20TargetCount, upgrades: cf20UpgradeCount },
      // S109 PR #2 — rolling 24h redraft history for rate limit. Capped at
      // REDRAFT_LIMIT (3) entries to keep metadata bounded; older live entries
      // already pruned above before the limit check.
      redraftHistory: [newTimestamp, ...liveHistory].slice(0, REDRAFT_LIMIT),
    },
    updated_at: newTimestamp,
  };
  // §18 incr-4 Call B — once the user supplies the missing inputs and rebuilds, FLOAT the
  // headline to the rebuilt deductible-aware recovery so the list card + emails match the
  // stronger letter. Unsent only — a sent dispute's amount stays frozen.
  if (rerendered.recovery && dispute.sent_at == null) {
    updatePayload.amount_disputed = rerendered.recovery.total;
  }
  // UX-2 (S306) — restamp the fingerprint with the body it just rebuilt. The
  // redraft never stamped, so the stored hash stayed pre-redraft; harmless
  // under W4's serve-cached, but under live rebuild the very next view would
  // see a mismatch and regenerate a byte-identical letter — one wasted render
  // per redraft, forever. Same loader, same explicit dispute state as the GET.
  if (dispute.claim_id) {
    try {
      const fpInput = await loadFingerprintInputForClaim(
        supabase,
        dispute.claim_id as string,
        user.id,
        {
          sentAt: (dispute.sent_at as string | null) ?? null,
          metadata: updatePayload.metadata as Record<string, unknown>,
        },
      );
      if (fpInput) {
        updatePayload.evidence_fingerprint = computeEvidenceFingerprint(fpInput);
        updatePayload.last_refresh_at = newTimestamp;
      }
    } catch (err) {
      console.error("[disputes/redraft] fingerprint restamp failed (non-fatal):", err);
    }
  }
  await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .update(updatePayload)
    .eq("id", dispute.id);

  // Timeline unification Phase 0 (S298, mig 221) — the redraft moment.
  // Flag-gated + fail-soft inside the emitter; references only.
  if (dispute.claim_id) {
    await emitCaseEvent(supabase, user.id, {
      claimId: dispute.claim_id as string,
      disputeId: dispute.id as string,
      kind: "letter_redrafted",
      payload: { letterType: letterTypeForRender },
    });
  }

  return NextResponse.json({
    success: true,
    letterContent: newBody,
    letterType: letterTypeForRender,
    cf20: { targets: cf20TargetCount, upgrades: cf20UpgradeCount },
    // §18.10.D — which user-fixable inputs (if any) would strengthen the letter further.
    strengthenLetter: rerendered.recovery
      ? { weakened: rerendered.recovery.weakened, fields: rerendered.recovery.strengthenableFields }
      : null,
    planContext: planContext
      ? {
          plan: planContext.plan,
          insurer: planContext.insurer,
          missingForYear: planContext.missingForYear,
          fallbackPlan: planContext.fallbackPlan,
          providerContact: planContext.providerContact,
        }
      : null,
    evidence,
  });
}

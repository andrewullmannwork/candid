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
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { rerenderDisputeLetter } from "@/lib/disputes/rerender";
import { reparseField } from "@/lib/plan/reparse-field";
import { loadDecorationContext } from "@/lib/plan/analyze-decoration";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import type { DisputeLetterType } from "@/lib/billing/types";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

function resolveLetterTypeFromDispute(dispute: {
  dispute_type: string;
  metadata?: Record<string, unknown> | null;
}): DisputeLetterType {
  const metaType = dispute.metadata && typeof dispute.metadata === "object"
    ? (dispute.metadata as { letterType?: string }).letterType
    : undefined;
  if (metaType) return metaType as DisputeLetterType;
  switch (dispute.dispute_type) {
    case "internal_appeal": return "insurance_appeal";
    case "negotiation": return "negotiation";
    case "complaint": return "overcharge";
    default: return "insurance_appeal";
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

  const { data: dispute, error } = await supabase
    .from("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .eq("user_id", user.id)
    .single();
  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }
  if (!dispute.claim_id) {
    return NextResponse.json({ error: "Dispute has no linked claim" }, { status: 400 });
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

  // Step 1: resolve plan context + initial evidence pass.
  const planContext = await resolvePlanContext(supabase, {
    userId: user.id,
    claimId: dispute.claim_id,
  });
  let evidence = await resolveEvidence(supabase, {
    userId: user.id,
    claimIds: [dispute.claim_id],
    lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
    planContext,
    letterType: dispute.dispute_type,
    disputeId: dispute.id,
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
  const newBody = await rerenderDisputeLetter(supabase, {
    disputeId: dispute.id,
    userId: user.id,
    letterType: letterTypeForRender,
    claimId: dispute.claim_id,
    lineItemIds: allLineItemIds,
    planContext,
    evidence,
  });

  if (!newBody) {
    return NextResponse.json(
      { error: "Letter regeneration failed" },
      { status: 500 },
    );
  }

  // Step 4: persist updated letter content + extend redraft history.
  const newTimestamp = new Date().toISOString();
  await supabase
    .from("dispute_outcomes")
    .update({
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
    })
    .eq("id", dispute.id);

  return NextResponse.json({
    success: true,
    letterContent: newBody,
    letterType: letterTypeForRender,
    cf20: { targets: cf20TargetCount, upgrades: cf20UpgradeCount },
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

/**
 * GET /api/disputes/[disputeId] — Fetch single dispute with letter + evidence + linked bill lines.
 * Used by the Linked Disputes expansion on the claim detail page.
 *
 * Phase 1 + Phase 7 of t_dispute_letter_redesign:
 *   - Resolves plan context (insurer + appeals address + missing-plan-for-year)
 *     each time the letter is re-opened so newly-uploaded historical plans
 *     auto-fill the letter on the next focus.
 *   - Regenerates `letter_content` + persists it when planContext changes
 *     (tracked via metadata.planContextFingerprint).
 *
 * Auth: Firebase bearer token. Verifies user owns the dispute.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { resolvePlanContext } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import { resolveAccountName } from "@/lib/disputes/rerender";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  computeEvidenceFingerprint,
  decideDriftAction,
  loadFingerprintInputForClaim,
  type DriftDecision,
} from "@/lib/disputes/evidence-fingerprint";

async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return await getAdminAuth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

export async function GET(
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

  // Phase 4 Task 4-E: gateUnverified is server-authoritative. Resolve once per
  // request and surface in response so EvidenceBlock client component can apply
  // the 3-case cite-grade gating per Q-DR-4E-2 LOCK without duplicating flag
  // evaluation logic on the client side.
  const gateUnverified = await isFeatureEnabled(
    "consumer_read_filter_v1",
    user.email ?? undefined,
  );

  const { data: dispute, error } = await supabase
    .from("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .eq("user_id", user.id)
    .single();

  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // Linked line items — primary + any extras in metadata.claimLineItemIds
  const extraIds = (dispute.metadata?.claimLineItemIds as string[] | undefined) || [];
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];

  let lineItems: unknown[] = [];
  if (allLineItemIds.length > 0) {
    const { data: items } = await supabase
      .from("claim_line_items")
      .select("id, line_number, description, billing_code, billed_amount, insurance_paid, patient_owes, plan_year")
      .in("id", allLineItemIds);
    lineItems = items || [];
  }

  // S74 — resolved letter type is authoritative regardless of whether the claim
  // is linked. The client used to map data.disputeType → letterType locally with
  // an incomplete switch; surfacing the server-resolved letterType prevents the
  // recipient block from regressing for legacy dispute_type vocab.
  const resolvedLetterType = resolveLetterTypeFromDispute(dispute);

  // S74.5 D16 — sent_letter immutability + drift detection.
  // sent_at non-null means user clicked Mark-as-Sent; the sent_letter
  // snapshot becomes the immutable legal chain-of-custody record. We must
  // NOT regenerate letter_content in that case. Drift state is surfaced to
  // the client via driftDecision so the UI can render the banner + cooldown
  // CTA.
  const flywheelOn = await isFeatureEnabled(
    "s74_5_categorization_flywheel_v1",
  );
  const sentAt = dispute.sent_at ? new Date(dispute.sent_at as string) : null;
  const cooldownUntil = dispute.cooldown_until
    ? new Date(dispute.cooldown_until as string)
    : null;
  let driftDecision: DriftDecision | null = null;
  let currentEvidenceFingerprint: string | null = null;

  // Phase 1 + 7: live-resolve plan context from the linked claim, and
  // regenerate letter body if the user has uploaded new plan data since
  // the dispute was drafted.
  let planContext = null;
  let evidence = null;
  let regeneratedLetterContent: string | null = null;
  try {
    if (dispute.claim_id) {
      // S74.5 D16 — compute current evidence fingerprint + drift decision
      // BEFORE deciding whether to regenerate the letter. Always logged for
      // observability; only acted on when flag is ON.
      if (flywheelOn) {
        const fpInput = await loadFingerprintInputForClaim(
          supabase,
          dispute.claim_id as string,
        );
        if (fpInput) {
          currentEvidenceFingerprint = computeEvidenceFingerprint(fpInput);
          driftDecision = decideDriftAction({
            storedFingerprint:
              (dispute.evidence_fingerprint as string | null) ?? null,
            currentFingerprint: currentEvidenceFingerprint,
            sentAt,
            cooldownUntil,
            lastRefreshAt: dispute.last_refresh_at
              ? new Date(dispute.last_refresh_at as string)
              : null,
          });
        }
      }

      planContext = await resolvePlanContext(supabase, {
        userId: user.id,
        claimId: dispute.claim_id,
      });
      evidence = await resolveEvidence(supabase, {
        userId: user.id,
        claimIds: [dispute.claim_id],
        lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
        planContext,
        letterType: dispute.dispute_type,
        disputeId: dispute.id,
      });

      // Debug logging — helps diagnose why insurer resolution fails for a
      // specific dispute. Visible in `npm run dev` logs.
      console.log("[disputes/[disputeId]] planContext resolved:", {
        disputeId: dispute.id,
        claimId: dispute.claim_id,
        planYear: planContext.plan?.planYear,
        planName: planContext.plan?.planName,
        planInsurerName: planContext.plan?.insurerName,
        resolvedInsurer: planContext.insurer?.name ?? null,
        hasAppealsAddress: !!planContext.insurer?.appealsAddress,
        missingForYear: planContext.missingForYear,
        fallbackPlanYear: planContext.fallbackPlan?.planYear,
      });

      // S74.5 D16 — sent_letter immutability guard. Once user clicks
      // Mark-as-Sent, sent_letter is the legal chain-of-custody record.
      // Skip regeneration entirely; the client surfaces drift via
      // driftDecision and renders the (immutable) sent_letter content.
      // Pre-S74.5 behavior (always regenerate) is preserved when sent_at
      // is null OR when flag is OFF (sentAt won't gate anything since we
      // only compute the drift decision when flag is on).
      const skipRegenerateForSent = flywheelOn && sentAt != null;

      // For drafts: per Subplan §7.5, debounce regeneration when
      // last_refresh_at within 5 min. Pre-S74.5 always-regenerate behavior
      // is preserved when flag OFF.
      const skipRegenerateForDebounce =
        flywheelOn &&
        sentAt == null &&
        driftDecision?.action === "serve_cached_within_debounce";

      const shouldRegenerate = !skipRegenerateForSent && !skipRegenerateForDebounce;

      // Always regenerate on load (unless guarded above). Templating is
      // cheap, and the letter must reflect the latest plan context,
      // profile name, and evidence signals.
      //
      // CAREFUL: dispute_outcomes.dispute_type is a vocab category
      // (internal_appeal | negotiation | complaint). LETTER_TEMPLATES is
      // keyed by letter_type (insurance_appeal | overcharge | balance_billing
      // | duplicate_charge | negotiation | itemized_request). The original
      // letter_type is stashed on metadata.letterType at persist time;
      // fall back to a dispute_type → letter_type mapping for legacy rows.
      const fingerprint = buildFingerprint(planContext, evidence);
      if (shouldRegenerate) {
        const { rerenderDisputeLetter } = await import("@/lib/disputes/rerender");
        regeneratedLetterContent = await rerenderDisputeLetter(supabase, {
          disputeId: dispute.id,
          userId: user.id,
          letterType: resolvedLetterType,
          claimId: dispute.claim_id,
          lineItemIds: allLineItemIds,
          planContext,
          evidence,
        });
        if (regeneratedLetterContent) {
          console.log("[disputes/[disputeId]] regenerated letter body", {
            disputeId: dispute.id,
            bodyLength: regeneratedLetterContent.length,
            snippet: regeneratedLetterContent.slice(0, 120),
          });
          await supabase
            .from("dispute_outcomes")
            .update({
              letter_content: regeneratedLetterContent,
              metadata: {
                ...(dispute.metadata ?? {}),
                planContextFingerprint: fingerprint,
                planContextUpdatedAt: new Date().toISOString(),
              },
              // S74.5 D16 — fingerprint + debounce timer refresh on every
              // successful regenerate. Cooldown_until is set only at
              // Mark-as-Sent time.
              evidence_fingerprint:
                flywheelOn && currentEvidenceFingerprint
                  ? currentEvidenceFingerprint
                  : (dispute.evidence_fingerprint as string | null) ?? null,
              last_refresh_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", dispute.id);
        } else {
          console.warn("[disputes/[disputeId]] rerender returned empty body — keeping stored letter", {
            disputeId: dispute.id,
            letterType: dispute.dispute_type,
            claimId: dispute.claim_id,
          });
        }
      }
    }
  } catch (err) {
    console.error("[disputes/[disputeId]] plan-context resolve failed (non-fatal):", err);
  }

  // Surface a patient-name mismatch to the UI so the user can edit easily.
  // The letter body always uses the account name (per rerender.ts); this
  // field lets the UI show a subtle "we used your account name — bill said
  // X" note above the letter.
  let patientNameMismatch: { billName: string; profileName: string } | null = null;
  try {
    const [{ data: claim }, { data: userRow }] = await Promise.all([
      supabase
        .from("claims")
        .select("metadata")
        .eq("id", dispute.claim_id)
        .maybeSingle(),
      supabase
        .from("users")
        .select("display_name, email")
        .eq("id", user.id)
        .maybeSingle(),
    ]);
    const billName = (claim?.metadata as { patient?: { name?: string } } | undefined)?.patient?.name?.trim() ?? "";
    const accountName = resolveAccountName(userRow?.display_name, userRow?.email);
    if (billName && accountName && normalizeNameForCompare(billName) !== normalizeNameForCompare(accountName)) {
      patientNameMismatch = { billName, profileName: accountName };
    }
  } catch (err) {
    console.warn("[disputes/[disputeId]] patient-name compare failed (non-fatal):", err);
  }

  return NextResponse.json({
    id: dispute.id,
    disputeType: dispute.dispute_type,
    letterType: resolvedLetterType,
    status: dispute.status,
    amountDisputed: dispute.amount_disputed,
    amountRecovered: dispute.amount_recovered,
    filedDate: dispute.filed_date,
    resolutionDate: dispute.resolution_date,
    claimId: dispute.claim_id,
    // S74.5 D16 — if sent_at is set, serve the immutable sent_letter as the
    // letter content; UI surfaces drift banner via driftState when current
    // findings differ.
    letterContent:
      flywheelOn && sentAt && dispute.sent_letter
        ? typeof dispute.sent_letter === "string"
          ? (dispute.sent_letter as string)
          : ((dispute.sent_letter as Record<string, unknown>).body as string) ??
            (regeneratedLetterContent ?? dispute.letter_content)
        : regeneratedLetterContent ?? dispute.letter_content,
    evidencePackage: dispute.evidence_package,
    lineItems,
    planContext: planContext
      ? {
          plan: planContext.plan,
          insurer: planContext.insurer,
          missingForYear: planContext.missingForYear,
          fallbackPlan: planContext.fallbackPlan,
          providerContact: planContext.providerContact,
        }
      : null,
    missingPlanForYear: planContext?.missingForYear ?? null,
    evidence,
    patientNameMismatch,
    gateUnverified,
    // S74.5 D16 — drift state for the client to render the banner +
    // cooldown-gated follow-up CTA. Null when flag OFF.
    driftState: flywheelOn
      ? {
          decision: driftDecision,
          sentAt: dispute.sent_at as string | null,
          cooldownUntil: dispute.cooldown_until as string | null,
          currentFingerprint: currentEvidenceFingerprint,
          storedFingerprint:
            (dispute.evidence_fingerprint as string | null) ?? null,
        }
      : null,
  });
}

function normalizeNameForCompare(name: string): string {
  return name.toLowerCase().replace(/[.,'"()]/g, "").replace(/\s+/g, " ").trim();
}

// Map a stored dispute row back to a LETTER_TEMPLATES key.
// Source of truth (newer rows): metadata.letterType. Legacy rows fall back
// to a dispute_type → letter_type mapping.
function resolveLetterTypeFromDispute(dispute: { dispute_type: string; metadata?: Record<string, unknown> | null }): import("@/lib/billing/types").DisputeLetterType {
  const metaType = dispute.metadata && typeof dispute.metadata === "object"
    ? (dispute.metadata as { letterType?: string }).letterType
    : undefined;
  if (metaType) {
    return metaType as import("@/lib/billing/types").DisputeLetterType;
  }
  switch (dispute.dispute_type) {
    case "internal_appeal":
      return "insurance_appeal";
    case "negotiation":
      return "negotiation";
    case "complaint":
      return "balance_billing";
    case "external_appeal":
      return "insurance_appeal";
    default:
      return "overcharge";
  }
}

function buildFingerprint(
  planContext: unknown,
  evidence: unknown,
): string | null {
  try {
    return JSON.stringify({ planContext, evidenceCount: (evidence as { totals?: { lineItemCount?: number } })?.totals?.lineItemCount ?? 0 });
  } catch {
    return null;
  }
}

// Detects pre-Session-37 letters (or any letter) that still contain unfilled
// placeholder text. When true we force rerender even if the fingerprint
// matches the stored one.
function hasUnfilledPlaceholder(letterContent: string | null | undefined): boolean {
  if (!letterContent) return false;
  return /\[Insurance Company\]|\[Member ID\]|\[Insurance Appeals Department\]/i.test(letterContent);
}


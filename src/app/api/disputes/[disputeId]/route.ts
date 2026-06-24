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
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";
import { resolvePlanContext, type InsurerAddressOverride } from "@/lib/disputes/plan-context";
import { resolveEvidence } from "@/lib/disputes/evidence-resolver";
import {
  computeDisputeStrength,
  loadStrengthConfig,
  type StrengthResult,
} from "@/lib/disputes/strength-scoring";
import { resolveAccountName } from "@/lib/disputes/rerender";
import { letterRecipientKind } from "@/lib/disputes";
import {
  captureCoverageSnapshot,
  diffCoverageSnapshots,
  isMeaningfulCoverageDiff,
  type CoverageSnapshot,
  type CoverageDiff,
} from "@/lib/disputes/coverage-snapshot";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import {
  computeEvidenceFingerprint,
  decideDriftAction,
  loadFingerprintInputForClaim,
  appendLetterVersion,
  type DriftDecision,
  type LetterVersion,
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

  // Block A — dispute_letter_v3_design gates the data-trust HARD STOP (the
  // letterContent suppression below). Resolved once per request; default OFF →
  // today's behavior (letter always served). See plans/dispute_letter_overhaul.md §1a.
  const v3DesignOn = await isFeatureEnabled(
    "dispute_letter_v3_design",
    user.email ?? undefined,
  );

  // dispute_plan_pinning_v1 — per-user eval (email available here). When ON, the
  // resolver honors the dispute's pin, and a legacy un-pinned dispute is lazily
  // backfilled from its DOS-correct resolved plan on this first view.
  const planPinningEnabled = await isFeatureEnabled(
    "dispute_plan_pinning_v1",
    user.email ?? undefined,
  );

  const { data: dispute, error } = await userScoped(supabase, user.id)
    .table("dispute_outcomes")
    .select("*")
    .eq("id", disputeId)
    .single();

  if (error || !dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  // Linked line items — primary + any extras in metadata.claimLineItemIds
  const extraIds = (dispute.metadata?.claimLineItemIds as string[] | undefined) || [];
  // Block C2 (items 1+2) — the name the user adopted when attesting + whether they
  // have answered the attestation gate. Persisted by attest-service; read once
  // here for the rerender (String 2 threading) and the payload (UI hydration).
  const attestingAsName = ((): string | null => {
    const v = (dispute.metadata as Record<string, unknown> | null)?.attestingAsName;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  })();
  const serviceAttestationReviewed =
    (dispute.metadata as Record<string, unknown> | null)?.serviceAttestationReviewed === true;
  const allLineItemIds = Array.from(
    new Set([dispute.claim_line_item_id, ...extraIds].filter(Boolean)),
  ) as string[];

  let lineItems: unknown[] = [];
  if (allLineItemIds.length > 0 && dispute.claim_id) {
    // claim_line_items has no user_id — scope through the owned parent claim,
    // then narrow to the dispute's requested line ids. Op-equivalent: a dispute's
    // line items belong to its own claim; any foreign/cross-claim id resolves to [].
    const ownedLines = await selectOwnedChildren(
      supabase,
      user.id,
      "claim_line_items",
      [dispute.claim_id as string],
      "id, line_number, description, billing_code, billed_amount, insurance_paid, patient_owes, plan_year",
    );
    const requested = new Set(allLineItemIds);
    lineItems = ownedLines.filter((li) => requested.has(li.id as string));
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
  // W4 (recovery_cost_share_v2) — letters are persistent + never background-updated. When ON,
  // a GET serves the saved letter + an `isStale` flag; the body regenerates ONLY on an explicit
  // user refresh (?refresh=1), which also versions the prior letter. OFF = legacy behavior.
  const costShareV2 = await isFeatureEnabled("recovery_cost_share_v2");
  const refreshRequested =
    costShareV2 && req.nextUrl.searchParams.get("refresh") === "1";
  const sentAt = dispute.sent_at ? new Date(dispute.sent_at as string) : null;
  const cooldownUntil = dispute.cooldown_until
    ? new Date(dispute.cooldown_until as string)
    : null;
  let driftDecision: DriftDecision | null = null;
  let currentEvidenceFingerprint: string | null = null;
  // S111 smoke iteration 5 — coverage diff. Populated when the dispute has
  // a stored pre-bind snapshot and we successfully compute the post-bind
  // snapshot from current evidence. Cleared via
  // POST /api/disputes/[id]/clear-coverage-diff.
  let coverageDiff: CoverageDiff | null = null;
  // dispute_plan_pinning_v1 (Phase 3) — view-time plan-change banner (#1) payload.
  let planChangeBanner:
    | {
        previousPlanName: string | null;
        newPlanName: string | null;
        newPlanId: string;
        changedAt: string;
        serviceDate: string | null;
        recommend: "keep" | "rebuild" | null;
      }
    | null = null;

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
      // observability; only acted on when flag is ON. W4 also needs the
      // fingerprint to compute `isStale` for the persistent-letter banner.
      if (flywheelOn || costShareV2) {
        const fpInput = await loadFingerprintInputForClaim(
          supabase,
          dispute.claim_id as string,
          user.id,
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

      // S109 PR #2 (Chunk B) — read user's same-plan confirmation answer.
      // Drives whether resolveEvidence loads the fallback plan's coverage as
      // a Case C-fallback proxy citation source. Stored on dispute.metadata
      // via POST /api/disputes/[disputeId]/confirm-same-plan.
      const userConfirmedSamePlan = ((): "yes" | "no" | "not_sure" | null => {
        const v = (dispute.metadata as Record<string, unknown> | null)?.userConfirmedSamePlan;
        return v === "yes" || v === "no" || v === "not_sure" ? v : null;
      })();
      // S110 Chunk D — read user's manual canonical bind for the bill year.
      // S111 D2 — read BEFORE resolvePlanContext so it can be threaded in to
      // populate planContext.boundCanonicalPlan (powers templates.ts citation
      // rendering + the VerifStrip's bound-verified state via the API
      // response's top-level boundCanonicalPlan field).
      const canonicalPlanIdForBillYear = ((): string | null => {
        const v = (dispute.metadata as Record<string, unknown> | null)?.canonicalPlanIdForBillYear;
        return typeof v === "string" && v.length > 0 ? v : null;
      })();
      // Block C2 — read the user's service-not-rendered attestations (claim_line_item
      // ids) so resolveEvidence reclassifies each attested line to
      // `service_not_rendered`. Stored via POST /api/disputes/[disputeId]/attest-service.
      const serviceAttestedLineIds = ((): string[] => {
        const v = (dispute.metadata as Record<string, unknown> | null)?.serviceAttestedLineIds;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      })();
      // Block C2.2 (S152) — the user's per-dispute insurer appeals address
      // override (set via POST /api/disputes/[disputeId]/insurer-address).
      // Overlaid onto the resolved insurer so this letter uses the user's
      // address; changes the planContext fingerprint → body re-renders with it.
      const insurerAddressOverride =
        ((dispute.metadata as Record<string, unknown> | null)
          ?.insurerAddressOverride as InsurerAddressOverride | null) ?? null;
      // dispute_plan_pinning_v1 — honor the dispute's pin (the plan it was
      // written against). Explicit pin wins; null → the resolver defaults to the
      // claim's DOS-correct plan.
      const pinnedInsurancePlanId =
        (dispute.insurance_plan_id as string | null) ?? null;
      planContext = await resolvePlanContext(supabase, {
        userId: user.id,
        claimId: dispute.claim_id,
        canonicalPlanIdForBillYear,
        insurerAddressOverride,
        planPinningEnabled,
        pinnedInsurancePlanId,
      });
      // R5 — lazy backfill: persist the resolved pin for a legacy un-pinned
      // dispute so resolution is stable thereafter. Non-fatal + user-scoped;
      // never overwrites an existing pin.
      if (planPinningEnabled && !pinnedInsurancePlanId && planContext.plan?.id) {
        try {
          await userScoped(supabase, user.id)
            .table("dispute_outcomes")
            .update({ insurance_plan_id: planContext.plan.id })
            .eq("id", dispute.id);
        } catch (e) {
          console.error("[disputes] lazy pin backfill failed (non-fatal):", e);
        }
      }
      evidence = await resolveEvidence(supabase, {
        userId: user.id,
        claimIds: [dispute.claim_id],
        lineItemIds: allLineItemIds.length > 0 ? allLineItemIds : undefined,
        planContext,
        // Pass the RESOLVED letter type, not the raw dispute_outcomes.dispute_type
        // vocab ("internal_appeal"). resolveEvidence gates the provider/insurer
        // address gaps + resolveLegalBasis on `letterType === "insurance_appeal"`,
        // so feeding raw dispute_type made the provider-address gap wrongly fire on
        // appeals (and the insurer-address gap + appeal legal-basis wrongly absent).
        // Matches the generate-route path, which already passes the resolved type.
        letterType: resolvedLetterType,
        disputeId: dispute.id,
        userConfirmedSamePlan,
        canonicalPlanIdForBillYear,
        attestedLineItemIds: serviceAttestedLineIds,
      });

      // S111 smoke iteration 5 — compute coverage diff vs the stored
      // pre-bind snapshot. The snapshot was captured by bind-canonical
      // (or other transition endpoints) at the moment of the bind; we diff
      // against fresh evidence so the user sees what changed under the new
      // plan + whether the dispute is still valid. Failure here is
      // non-fatal — diff just doesn't surface.
      try {
        const preBindSnapshot = (dispute.metadata as Record<string, unknown> | null)
          ?.preBindCoverageSnapshot as CoverageSnapshot | undefined;
        if (preBindSnapshot && preBindSnapshot.lines) {
          const currentSnapshot = captureCoverageSnapshot(evidence, planContext);
          const computed = diffCoverageSnapshots(preBindSnapshot, currentSnapshot);
          if (isMeaningfulCoverageDiff(computed)) {
            coverageDiff = computed;
          } else {
            // S111 smoke #7 — suppress no-op diffs (same plan, same
            // coverage, $0→$0). Auto-clear the stale snapshot so subsequent
            // GETs don't keep recomputing the same empty diff. Non-fatal
            // failure if the update fails (diff is already filtered out
            // for this response).
            coverageDiff = null;
            try {
              const cleanedMetadata = {
                ...((dispute.metadata as Record<string, unknown>) ?? {}),
              };
              delete cleanedMetadata.preBindCoverageSnapshot;
              cleanedMetadata.coverageDiffAutoClearedAt =
                new Date().toISOString();
              await userScoped(supabase, user.id)
                .table("dispute_outcomes")
                .update({ metadata: cleanedMetadata })
                .eq("id", dispute.id);
            } catch (clearErr) {
              console.warn(
                "[disputes/[disputeId]] auto-clear of no-op diff snapshot failed (non-fatal):",
                clearErr,
              );
            }
          }
        }
      } catch (diffErr) {
        console.warn(
          "[disputes/[disputeId]] coverage diff computation failed (non-fatal):",
          diffErr,
        );
      }

      // dispute_plan_pinning_v1 (Phase 3) — view-time plan-change banner (#1).
      // Logbook-driven (R8): fire ONLY when the user switched AWAY from this
      // dispute's pinned plan AFTER drafting it — NOT a naive pin!=active, which
      // would nag on every old dispute. Silent on switch-then-revert (pin ==
      // active) and on a same-identity duplicate row. An explicit re-bind's
      // stored snapshot (coverageDiff above) takes precedence. Non-fatal.
      //
      // Cheap by design: a full coverage diff here (resolveEvidence on the active
      // plan) added seconds to every banner-showing GET for a marginal precision
      // gain — a genuinely different plan almost always differs in coverage. We
      // gate on the cheap signals (switch event + different plan identity); the
      // user confirms via Keep/Rebuild, and Rebuild's re-pin surfaces the exact
      // CoverageDiffPanel verdict.
      if (
        planPinningEnabled &&
        sentAt == null &&
        pinnedInsurancePlanId &&
        !coverageDiff &&
        dispute.claim_id
      ) {
        try {
          const { data: switchEvent } = await supabase
            .from("plan_change_events")
            .select("changed_at")
            .eq("user_id", user.id)
            .eq("previous_plan_id", pinnedInsurancePlanId)
            .gt("changed_at", dispute.created_at as string)
            .order("changed_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const { data: activePlan } = await userScoped(supabase, user.id)
            .table("insurance_plans")
            .select("id, plan_name, plan_year")
            .eq("is_active", true)
            .maybeSingle();
          const dismissedAt = (dispute.metadata as Record<string, unknown> | null)
            ?.planChangeBannerDismissedAt;
          const prevName = planContext.plan?.planName ?? null;
          const prevYear = planContext.plan?.planYear ?? null;
          // Cheap identity gate — suppress a same-plan duplicate row (same name +
          // year, different id); fire when the active plan is genuinely different.
          const identityDiffers =
            !!activePlan &&
            ((activePlan.plan_name as string | null) !== prevName ||
              (activePlan.plan_year as number | null) !== prevYear);
          if (
            switchEvent &&
            activePlan &&
            (activePlan.id as string) !== pinnedInsurancePlanId &&
            identityDiffers &&
            dismissedAt !== switchEvent.changed_at
          ) {
            const { data: claimRow } = await userScoped(supabase, user.id)
              .table("claims")
              .select("date_of_service")
              .eq("id", dispute.claim_id)
              .maybeSingle();
            const serviceDate = (claimRow?.date_of_service as string | null) ?? null;
            // D5 "recommended" — anchor on the approximate change date (R2/OQ2)
            // with a ~30-day buffer; suppress (null) in the fuzzy zone / unknown DOS.
            const changedAt = switchEvent.changed_at as string;
            let recommend: "keep" | "rebuild" | null = null;
            const dosT = serviceDate ? Date.parse(serviceDate) : NaN;
            const chgT = Date.parse(changedAt);
            const BUF = 30 * 24 * 60 * 60 * 1000;
            if (!Number.isNaN(dosT) && !Number.isNaN(chgT)) {
              if (dosT < chgT - BUF) recommend = "keep";
              else if (dosT > chgT + BUF) recommend = "rebuild";
            }
            planChangeBanner = {
              previousPlanName: prevName,
              newPlanName: (activePlan.plan_name as string | null) ?? null,
              newPlanId: activePlan.id as string,
              changedAt,
              serviceDate,
              recommend,
            };
          }
        } catch (bannerErr) {
          console.warn(
            "[disputes/[disputeId]] plan-change banner computation failed (non-fatal):",
            bannerErr,
          );
        }
      }

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
      // W4: sent letters stay immutable under EITHER the flywheel OR cost-share-v2 flag.
      const skipRegenerateForSent = (flywheelOn || costShareV2) && sentAt != null;

      // For drafts: per Subplan §7.5, debounce regeneration when
      // last_refresh_at within 5 min. Pre-S74.5 always-regenerate behavior
      // is preserved when flag OFF.
      const skipRegenerateForDebounce =
        flywheelOn &&
        sentAt == null &&
        driftDecision?.action === "serve_cached_within_debounce";

      // W4: when recovery_cost_share_v2 is ON, a GET (view) NEVER regenerates the body —
      // it serves the saved letter. The body regenerates ONLY on an explicit user refresh
      // (?refresh=1). OFF = the legacy always-regenerate-on-load (debounced) behavior.
      const shouldRegenerate = costShareV2
        ? refreshRequested && !skipRegenerateForSent
        : !skipRegenerateForSent && !skipRegenerateForDebounce;

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
          attestingName: attestingAsName ?? undefined,
        });
        if (regeneratedLetterContent) {
          console.log("[disputes/[disputeId]] regenerated letter body", {
            disputeId: dispute.id,
            bodyLength: regeneratedLetterContent.length,
            snippet: regeneratedLetterContent.slice(0, 120),
          });
          // Lost-update guard: re-read metadata immediately before this write so a
          // concurrent metadata change committed during the ~6s regenerate (e.g. a
          // plan-change-banner dismissal, an attestation, a same-plan confirm) is
          // NOT clobbered by this stale read-modify-write. Overlapping GETs would
          // otherwise overwrite each other's metadata flags wholesale.
          const { data: freshMetaRow } = await userScoped(supabase, user.id)
            .table("dispute_outcomes")
            .select("metadata")
            .eq("id", dispute.id)
            .maybeSingle();
          const baseMetadataForRegen =
            (freshMetaRow?.metadata as Record<string, unknown> | null) ??
            ((dispute.metadata as Record<string, unknown> | null) ?? {});
          // W4 — on an explicit user refresh, preserve the letter being superseded so the
          // user can revert (§13.4). Bounded history in metadata (cap 3, drop-oldest);
          // unchanged when OFF or for a non-refresh regenerate.
          const letterVersionHistory =
            costShareV2 && refreshRequested && dispute.letter_content
              ? appendLetterVersion(
                  baseMetadataForRegen.letterVersionHistory as LetterVersion[] | undefined,
                  {
                    content: dispute.letter_content as string,
                    fingerprint: (dispute.evidence_fingerprint as string | null) ?? null,
                    savedAt: new Date().toISOString(),
                  },
                )
              : (baseMetadataForRegen.letterVersionHistory as LetterVersion[] | undefined);
          await userScoped(supabase, user.id)
            .table("dispute_outcomes")
            .update({
              letter_content: regeneratedLetterContent,
              metadata: {
                ...baseMetadataForRegen,
                ...(letterVersionHistory ? { letterVersionHistory } : {}),
                planContextFingerprint: fingerprint,
                planContextUpdatedAt: new Date().toISOString(),
                // Block C2 item 4 — record which statutory backbone produced this
                // letter so the P2 flywheel can A/B framings once volume exists.
                // Only when v3 actually rendered the tree (OFF = legacy backbone).
                ...(v3DesignOn ? { letterBackbone: "commercial_v1" } : {}),
              },
              // S74.5 D16 — fingerprint + debounce timer refresh on every
              // successful regenerate. Cooldown_until is set only at
              // Mark-as-Sent time.
              evidence_fingerprint:
                (flywheelOn || costShareV2) && currentEvidenceFingerprint
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
  // Block C2 item 1 — the account holder's name (users.display_name) is the default
  // "Attesting as" name for the attestation flow; surfaced in the payload below.
  let accountName = "";
  try {
    const [{ data: claim }, { data: userRow }] = await Promise.all([
      userScoped(supabase, user.id)
        .table("claims")
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
    accountName = resolveAccountName(userRow?.display_name, userRow?.email);
    if (billName && accountName && normalizeNameForCompare(billName) !== normalizeNameForCompare(accountName)) {
      patientNameMismatch = { billName, profileName: accountName };
    }
  } catch (err) {
    console.warn("[disputes/[disputeId]] patient-name compare failed (non-fatal):", err);
  }

  // Block C2 — once the user confirms their identity (POST confirm-patient-identity),
  // the resolved state is sticky: suppress the mismatch regardless of the live name
  // compare, so patientIdentityResolved (= !patientNameMismatch below) stays true and
  // the MVDL readiness item is closed even across later profile-name changes. True
  // ONLY on explicit confirmation — distinct from a natural name match.
  const patientIdentityResolved =
    (dispute.metadata as Record<string, unknown> | null)?.patientIdentityResolved === true;
  if (patientIdentityResolved) {
    patientNameMismatch = null;
  }

  // Block A — three-axis strength for the payload + the data-trust HARD STOP.
  // Computed UNGATED (additive); letterContent suppression applies only when
  // dispute_letter_v3_design is ON. patientIdentityResolved reuses the
  // name-match check above. Non-fatal: failure leaves strength null + serves the
  // letter as before. See plans/dispute_letter_overhaul.md §1a.
  let strength: StrengthResult | null = null;
  try {
    const strengthConfig = await loadStrengthConfig(supabase);
    strength = computeDisputeStrength(evidence, {
      config: strengthConfig,
      patientIdentityResolved: !patientNameMismatch,
      recipientKind: letterRecipientKind(dispute.dispute_type),
    });
  } catch (err) {
    console.error("[disputes/[disputeId]] strength computation failed (non-fatal):", err);
  }

  // HARD STOP: when the flag is ON and a bill failed reconciliation, serve no
  // letter (the UI renders the banner). Suppression is display-only — the stored
  // dispute.letter_content is preserved for when the bill is later reconciled.
  const dataTrustHardStop =
    v3DesignOn && strength?.dataTrust.gate === "hard_stop";
  const resolvedLetterContent =
    flywheelOn && sentAt && dispute.sent_letter
      ? typeof dispute.sent_letter === "string"
        ? (dispute.sent_letter as string)
        : ((dispute.sent_letter as Record<string, unknown>).body as string) ??
          (regeneratedLetterContent ?? dispute.letter_content)
      : regeneratedLetterContent ?? dispute.letter_content;
  const letterContent = dataTrustHardStop ? null : resolvedLetterContent;

  // W4 — persistent-letter staleness for the draft banner + Refresh CTA. Stale = the saved
  // letter's evidence fingerprint no longer matches current evidence AND we served the cached
  // body (didn't just regenerate) on an unsent draft. `letterVersionCount` powers the
  // "prior versions" affordance. Sent letters keep using `driftDecision` (the cooldown banner).
  const fingerprintDrift =
    currentEvidenceFingerprint != null &&
    (dispute.evidence_fingerprint as string | null) !== currentEvidenceFingerprint;
  // served-the-cached-body = regeneratedLetterContent is null (we didn't regenerate, or a
  // refresh failed and we fell back to the saved letter — either way it may be stale).
  const isStale =
    costShareV2 && regeneratedLetterContent == null && fingerprintDrift && sentAt == null;
  const letterVersionCount = Array.isArray(
    (dispute.metadata as Record<string, unknown> | null)?.letterVersionHistory,
  )
    ? ((dispute.metadata as Record<string, unknown>).letterVersionHistory as unknown[]).length
    : 0;

  return NextResponse.json({
    id: dispute.id,
    disputeType: dispute.dispute_type,
    // W4 — persistent-letter signals, present ONLY when recovery_cost_share_v2 is ON (OFF =
    // byte-identical response). The client shows the stale banner + Refresh CTA off `isStale`.
    ...(costShareV2 ? { isStale, letterVersionCount } : {}),
    letterType: resolvedLetterType,
    status: dispute.status,
    amountDisputed: dispute.amount_disputed,
    amountRecovered: dispute.amount_recovered,
    filedDate: dispute.filed_date,
    resolutionDate: dispute.resolution_date,
    claimId: dispute.claim_id,
    // S74.5 D16 — if sent_at is set, serve the immutable sent_letter as the
    // letter content; UI surfaces drift banner via driftState when current
    // findings differ. Block A — null when the data-trust HARD STOP fires (flag
    // ON); resolved above into `letterContent`.
    letterContent,
    evidencePackage: dispute.evidence_package,
    lineItems,
    planContext: planContext
      ? {
          plan: planContext.plan,
          insurer: planContext.insurer,
          missingForYear: planContext.missingForYear,
          fallbackPlan: planContext.fallbackPlan,
          providerContact: planContext.providerContact,
          // S110 Chunk C — surface archive auto-lookup result so PlanSearchModal
          // can highlight it as a best-match suggestion. S111 D1: this is a UI
          // hint only — never drives letter citations (those flow through
          // boundCanonicalPlan below).
          archiveCanonicalPlan: planContext.archiveCanonicalPlan,
        }
      : null,
    // S111 D2 — top-level boundCanonicalPlan for VerifStrip rendering. Holds
    // the canonical the user explicitly bound via PlanSearchModal (with
    // insurer name + Pattern 1 #16 badge level). Null when nothing bound.
    boundCanonicalPlan: planContext?.boundCanonicalPlan ?? null,
    missingPlanForYear: planContext?.missingForYear ?? null,
    evidence,
    patientNameMismatch,
    // Block C2 — sticky patient-identity confirmation flag (set via POST
    // confirm-patient-identity). True ONLY when the user explicitly confirmed (lets
    // the rail offer "Undo"); distinct from a natural name match (mismatch null,
    // flag false). patientNameMismatch is nulled above when this is true.
    patientIdentityResolved,
    // Block C2 — the user's current service-not-rendered attestation set
    // (claim_line_item ids). The per-line `serviceNotRenderedAttested` flags on
    // `evidence` derive from this; surfaced as an array for the attestation UI state.
    serviceAttestedLineIds: ((): string[] => {
      const v = (dispute.metadata as Record<string, unknown> | null)?.serviceAttestedLineIds;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    })(),
    // Block C2 (item 2) — persist-all-input: the gate-reviewed flag (so the
    // attestation gate does not re-prompt once answered) + the adopted attesting
    // name (the client defaults to the account name when null). Both hydrate the
    // ServiceAttestationFlow on load.
    serviceAttestationReviewed,
    attestingAsName,
    // Block C2 item 1 — default attesting name (account holder; users.display_name).
    accountName,
    gateUnverified,
    // Block C (dispute_letter_v3_design) — surface the already-computed,
    // per-user-targeted flag so the client can branch the v3 reskin. Mirrors
    // gateUnverified above (also a flag-derived boolean in this payload).
    // Correct for Block F staged rollout: v3DesignOn uses user.email targeting.
    v3DesignOn,
    // Block A — additive three-axis strength + data-trust state. Consumed by the
    // Block C v3 UI (data-trust banner + evidence band + readiness rail); ignored
    // by today's frontend. dataTrust surfaced even when the flag is OFF (G7
    // fire/non-fire telemetry).
    strength,
    dataTrust: strength?.dataTrust ?? null,
    // S109 PR #2 (Chunk B) — current same-plan-confirmation answer, used by
    // VerifStrip to derive question / fallback / bound-proxy / confirm-archive.
    userConfirmedSamePlan: ((): "yes" | "no" | "not_sure" | null => {
      const v = (dispute.metadata as Record<string, unknown> | null)?.userConfirmedSamePlan;
      return v === "yes" || v === "no" || v === "not_sure" ? v : null;
    })(),
    // S111 smoke #2 — explicit proxy choice flag. Distinguishes
    // "userConfirmedSamePlan=yes, awaiting archive decision" (confirm-archive
    // strip OR upload-or-proxy strip) from "userConfirmedSamePlan=yes, user
    // explicitly chose proxy" (bound-proxy strip). Set via POST
    // /api/disputes/[id]/confirm-same-plan with acceptedProxy=true.
    userAcceptedProxy: ((): boolean => {
      const v = (dispute.metadata as Record<string, unknown> | null)?.userAcceptedProxy;
      return v === true;
    })(),
    // S111 smoke iteration 5 — wrong-year banner dismissal flag. When true,
    // VerifStrip suppresses the banner and renders a small clickable badge
    // instead. Reset to false on each new bind so the banner re-evaluates.
    wrongYearBannerDismissed: ((): boolean => {
      const v = (dispute.metadata as Record<string, unknown> | null)?.wrongYearBannerDismissed;
      return v === true;
    })(),
    // S111 smoke iteration 5 — coverage diff payload. Computed below from
    // metadata.preBindCoverageSnapshot if present. Surfaces what changed
    // between the previous bind state and the current bind, plus a verdict
    // on whether the dispute is still valid.
    coverageDiff,
    planChangeBanner,
    // S110 Chunk D — surface the bound canonical id (if any) so the UI
    // can hide the strip's pre-bind affordances once a canonical is bound.
    canonicalPlanIdForBillYear: ((): string | null => {
      const v = (dispute.metadata as Record<string, unknown> | null)?.canonicalPlanIdForBillYear;
      return typeof v === "string" && v.length > 0 ? v : null;
    })(),
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


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
import { resolveCollectorContact } from "@/lib/disputes/plan-context";
import {
  readUserPatientPaidOverride,
  readServicesConfirmedAt,
} from "@/lib/claims/effective-totals";
import {
  loadDisputeLineResolutions,
  type DisputeLineResolution,
} from "@/lib/disputes/dispute-ground-basis";
import type { StrengthResult } from "@/lib/disputes/strength-scoring";
import { letterRecipientKind } from "@/lib/disputes";
import {
  resolveLetterTypeFromDispute,
  letterPatientIdentityFromMeta,
  letterPatientName,
  pickPatientName,
} from "@/lib/disputes/letter-type";
import { resolveDisputeReadiness } from "@/lib/disputes/dispute-readiness";
import {
  captureCoverageSnapshot,
  diffCoverageSnapshots,
  isMeaningfulCoverageDiff,
  type CoverageSnapshot,
  type CoverageDiff,
} from "@/lib/disputes/coverage-snapshot";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { loadCaseTimelinePayload } from "@/lib/case/load-case-timeline";
import {
  evaluateDeadline,
  readDeadlineConfig,
  computeFollowupSchedule,
  type DeadlineGuard,
} from "@/lib/disputes/deadline-engine";
import {
  computeEvidenceFingerprint,
  decideDriftAction,
  driftMachineryApplies,
  isDisputeStale,
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

  // Unified case timeline (S286) — the claim's full dispute ladder, chronological.
  // Read-only rows so the "What you need to do" spine can render previous/next
  // letters as segments. Additive: [] when the dispute has no linked claim
  // (legacy rows) — the client degrades to a single-letter spine.
  let siblings: Array<{
    id: string;
    letterType: string;
    status: string | null;
    filedDate: string | null;
    sentAt: string | null;
    resolutionDate: string | null;
    governingDeadlineDate: string | null;
    createdAt: string | null;
  }> = [];
  if (dispute.claim_id) {
    const { data: sibRows } = await userScoped(supabase, user.id)
      .table("dispute_outcomes")
      .select(
        "id, dispute_type, status, filed_date, sent_at, resolution_date, governing_deadline_date, created_at, metadata",
      )
      .eq("claim_id", dispute.claim_id)
      .order("created_at", { ascending: true });
    siblings = ((sibRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      letterType: resolveLetterTypeFromDispute(
        r as { dispute_type: string; metadata?: Record<string, unknown> | null },
      ),
      status: (r.status as string | null) ?? null,
      filedDate: (r.filed_date as string | null) ?? null,
      sentAt: (r.sent_at as string | null) ?? null,
      resolutionDate: (r.resolution_date as string | null) ?? null,
      governingDeadlineDate: (r.governing_deadline_date as string | null) ?? null,
      createdAt: (r.created_at as string | null) ?? null,
    }));
  }

  // S299 phase 2a — the dispute GET joins the one-derivation contract (agenda
  // §1): the letter page reads the SAME projection the claim rail renders
  // (breadcrumb step identity, insurer display names, wait state). Null when
  // case_rail_v1 is OFF → byte-identical payload.
  const caseTimeline = dispute.claim_id
    ? await loadCaseTimelinePayload(supabase, user.id, dispute.claim_id as string)
    : null;

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
  // §18.10.D — read on the GET so the "confirm to strengthen" prompt can be computed on a
  // PLAIN load (not only on regenerate); with costShareV2 ON a plain GET never regenerates.
  const disputeGroundsOn = await isFeatureEnabled("dispute_grounds_v1");

  // dispute-letters v2 (Zone-2) — deadline surface, flag-gated on dispute_deadline_engine_v1.
  // The GUARD (deadlineWarning) is recomputed fresh every load: it's anchored to FIXED dates
  // (denial notice + 180d / collector contact + 30d), so daysRemaining counts down correctly.
  // The GOVERNING deadline + follow-ups are READ from the persisted col/rows — the plan_response
  // clock is generation-anchored (now + 60d), so a fresh recompute would drift forward daily.
  // Null/empty when OFF (additive → existing consumers ignore the fields).
  const deadlineEngineOn = await isFeatureEnabled(
    "dispute_deadline_engine_v1",
    user.email ?? undefined,
  );
  let deadlineWarning: DeadlineGuard | null = null;
  let filingDeadlineDate: string | null = null;
  let followups: Array<{ dueDate: string; kind: string; parentLetterType: string | null }> = [];
  let followupPlan: Array<{ dueDate: string; kind: string }> = [];
  // S306 (UX-2) — the §1692g window for a REGENERATED letter. Engine path
  // captures the engine's own verdict (config-driven window); the legacy
  // fallback below mirrors generate/escalate exactly. Without this, a live
  // rebuild of a debt_validation draft silently lost its in-window teeth.
  let composeDebtWithinWindow = false;
  const governingDeadlineDate = deadlineEngineOn
    ? ((dispute.governing_deadline_date as string | null) ?? null)
    : null;
  const deadlineType = deadlineEngineOn
    ? ((dispute.deadline_type as string | null) ?? null)
    : null;
  if (!deadlineEngineOn) {
    // Legacy §1692g fallback — byte-identical to generate/escalate's flag-OFF math.
    const meta = dispute.metadata as Record<string, unknown> | null;
    const first =
      typeof meta?.collectorFirstContactDate === "string"
        ? Date.parse(meta.collectorFirstContactDate)
        : NaN;
    composeDebtWithinWindow =
      !Number.isNaN(first) && Date.now() - first <= 30 * 24 * 60 * 60 * 1000;
  }
  if (deadlineEngineOn) {
    const meta = dispute.metadata as Record<string, unknown> | null;
    const denial = typeof meta?.denialNoticeDate === "string" ? meta.denialNoticeDate : null;
    const collector =
      typeof meta?.collectorFirstContactDate === "string" ? meta.collectorFirstContactDate : null;
    const deadlineConfig = await readDeadlineConfig(supabase);
    const dr = evaluateDeadline(
      { letterType: resolvedLetterType, denialNoticeDate: denial, collectorFirstContactDate: collector },
      deadlineConfig,
    );
    deadlineWarning = dr.guard.severity === "ok" ? null : dr.guard;
    composeDebtWithinWindow = dr.debtWithinWindow;
    // The guard reports daysRemaining but not the filing-deadline DATE — derive it (denial +
    // ERISA window) so the UI can show "file before <date>".
    if (denial && dr.guard.deadlineType === "erisa_appeal_180") {
      const anchor = Date.parse(denial);
      if (!Number.isNaN(anchor)) {
        filingDeadlineDate = new Date(anchor + deadlineConfig.windowDays.erisa_appeal_180 * 86_400_000)
          .toISOString()
          .slice(0, 10);
      }
    }
    // Persisted graduated follow-ups (deadline-anchored) for this dispute — owner-scoped.
    const { data: fuRows } = await userScoped(supabase, user.id)
      .table("dispute_followups")
      .select("due_date, metadata")
      .eq("dispute_id", disputeId)
      .order("due_date", { ascending: true });
    followups = ((fuRows ?? []) as Array<{ due_date: string; metadata: Record<string, unknown> | null }>)
      .filter((r) => {
        const k = r.metadata?.followup_kind;
        return k === "deadline_interim" || k === "deadline_final";
      })
      .map((r) => ({
        dueDate: r.due_date,
        kind: (r.metadata?.followup_kind as string) ?? "",
        parentLetterType: (r.metadata?.parent_letter_type as string | null) ?? null,
      }));
    // No persisted rows yet but a governing deadline exists → a computed PREVIEW of the plan.
    if (followups.length === 0 && governingDeadlineDate) {
      followupPlan = computeFollowupSchedule(governingDeadlineDate, deadlineConfig).map((e) => ({
        dueDate: e.dueDate,
        kind: e.kind,
      }));
    }
  }

  const refreshRequested =
    costShareV2 && req.nextUrl.searchParams.get("refresh") === "1";
  const sentAt = dispute.sent_at ? new Date(dispute.sent_at as string) : null;
  // S308 — void rows (cancelled, or closed without ever being sent) are
  // read-only exhibits: the whole live-document apparatus below (fingerprint,
  // drift decision, view-driven regeneration — flagged AND legacy paths) is
  // skipped for them. A cancelled letter has null sent_at, so the sent-only
  // guard alone counted it as an unsent draft and a plain view rebuilt it.
  const liveApparatus = driftMachineryApplies(
    (dispute.status as string | null) ?? null,
    sentAt,
  );
  const cooldownUntil = dispute.cooldown_until
    ? new Date(dispute.cooldown_until as string)
    : null;
  let driftDecision: DriftDecision | null = null;
  let currentEvidenceFingerprint: string | null = null;
  // UX-2 (S306, tracker AF) — "a draft letter is a live document; a sent letter
  // is a record" (Andrew). ON: an unsent letter regenerates on view whenever
  // its fingerprint drifts — no banner, no explicit refresh required — so the
  // draft is always the letter today's inputs would produce. Sent letters keep
  // the drift banner unchanged.
  let liveRebuildOn = false;
  // S111 smoke iteration 5 — coverage diff. Populated when the dispute has
  // a stored pre-bind snapshot and we successfully compute the post-bind
  // snapshot from current evidence. Cleared via
  // POST /api/disputes/[id]/clear-coverage-diff.
  let coverageDiff: CoverageDiff | null = null;

  // Phase 1 + 7: live-resolve plan context from the linked claim, and
  // regenerate letter body if the user has uploaded new plan data since
  // the dispute was drafted.
  let planContext = null;
  let evidence = null;
  // S302 — the shared readiness bundle (plan context + evidence + patient
  // identity + strength), resolved ONCE for this request.
  //
  // Called UNCONDITIONALLY, outside the claim-linked block below: the identity
  // half (account name, name compare) does not need a claim, and nesting it
  // would have quietly emptied "Attesting as" for a legacy dispute with no
  // claim link. The resolver guards the claim-dependent half internally.
  const readiness = await resolveDisputeReadiness(supabase, {
    userId: user.id,
    dispute,
    lineItemIds: allLineItemIds,
  });
  let regeneratedLetterContent: string | null = null;
  // §18.10.D — which user-fixable inputs (deductible/oop/network) would strengthen the
  // letter, surfaced so the page can show the "confirm to strengthen + rebuild" prompt.
  let strengthenLetter: { weakened: boolean; fields: Array<"deductible" | "oop" | "network"> } | null = null;
  // S312 (F2-S312.1) — noRemainingLetterDemand over the fold, from whichever branch
  // ran (regenerate or plain load). Sent letters never set it (both branches are
  // draft-scoped), so the banner is drafts-only by construction.
  let demandEmpty = false;
  try {
    if (dispute.claim_id) {
      // S74.5 D16 — compute current evidence fingerprint + drift decision
      // BEFORE deciding whether to regenerate the letter. Always logged for
      // observability; only acted on when flag is ON. W4 also needs the
      // fingerprint to compute `isStale` for the persistent-letter banner.
      // S308 — `liveApparatus` scopes all of it to live drafts + sent letters;
      // a void row gets no fingerprint, no drift banner, and (below) no regen.
      if ((flywheelOn || costShareV2) && liveApparatus) {
        liveRebuildOn =
          costShareV2 && (await isFeatureEnabled("dispute_draft_live_rebuild_v1"));
        // UX-2 — the dispute state is passed EXPLICITLY: unsent + flag ON makes
        // the hash compose-inclusive (name, addresses, collector), so an edit
        // that changes only those still drifts it. Sent → evidence-only, which
        // is the same shape mark-as-sent stamps.
        const fpInput = await loadFingerprintInputForClaim(
          supabase,
          dispute.claim_id as string,
          user.id,
          {
            sentAt: (dispute.sent_at as string | null) ?? null,
            metadata: (dispute.metadata as Record<string, unknown> | null) ?? null,
            insurancePlanId: (dispute.insurance_plan_id as string | null) ?? null,
          },
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
            // UX-2 — a live draft never waits out a debounce: serving a
            // just-changed address as stale for up to 5 minutes defeats
            // "viable to send". Mismatch → regenerate, every time.
            ...(liveRebuildOn ? { debounceMinutes: 0 } : {}),
          });
        }
      }

      // S302 — plan context + evidence come from the ONE shared resolver above
      // (src/lib/disputes/dispute-readiness.ts). This route's block was the
      // correct version and the case-file route's hand-rolled twin had drifted
      // from it; the extraction is a faithful move, so behaviour here is
      // unchanged. Regeneration, drift and coverage-diff stay HERE — the
      // resolver is the read half only.
      planContext = readiness.planContext;
      evidence = readiness.evidence;
      // The resolver catches its own failures and returns nulls; the inline
      // version let them throw into this block's outer catch, skipping
      // everything below. Rethrowing preserves that EXACTLY — regeneration and
      // the coverage diff must not run on a plan context that failed to resolve.
      if (!planContext) throw new Error("plan context unresolved");

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

      // Plan-change banner DEPRECATED (removed with the explicit-override model).
      // It alerted "your active plan changed since drafting — rebuild on the new
      // one?", which is obsolete now that a dispute is anchored to its claim's
      // DOS-correct plan: switching the user's *active* plan no longer affects an
      // existing dispute, and "rebuild on the active plan" was the wrong action
      // for a historical claim. The deliberate way to change a dispute's plan is
      // the per-dispute re-bind control (/repin), which remains.

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
      // UX-2 — under dispute_draft_live_rebuild_v1, the route finally HONORS the
      // decision function's regenerate_draft branch (W4 suppressed it behind the
      // explicit ?refresh=1). Drafts self-heal on view; sent letters still never
      // regenerate here.
      // S308 — `liveApparatus` prefixes BOTH branches: a void row never
      // regenerates, whether via the flag path, an explicit ?refresh=1, or
      // the legacy always-regenerate-on-load branch.
      const shouldRegenerate =
        liveApparatus &&
        (costShareV2
          ? (refreshRequested ||
              (liveRebuildOn && driftDecision?.action === "regenerate_draft")) &&
            !skipRegenerateForSent
          : !skipRegenerateForSent && !skipRegenerateForDebounce);

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
        // S306 (UX-2) — a regenerate must compose from EVERYTHING the letter was
        // born with. This path used to pass only attestingName, so a rebuild of
        // a ladder letter silently dropped its collector block, account number,
        // certified notation, exhaustion clause and §1692g teeth (renderGated
        // omission — invisible until live rebuild made regens routine). All are
        // re-read from the dispute's own metadata, the same rows the birth
        // wrote, and the same fields the compose-basis hash watches.
        const composeMeta = (dispute.metadata as Record<string, unknown> | null) ?? {};
        const rerendered = await rerenderDisputeLetter(supabase, {
          // S306 — this render composes THIS dispute's own letter (redraft), so
          // its id is the one the recital must exclude.
          composingDisputeId: dispute.id,
          userId: user.id,
          letterType: resolvedLetterType,
          claimId: dispute.claim_id,
          lineItemIds: allLineItemIds,
          planContext,
          evidence,
          attestingName: attestingAsName ?? undefined,
          patientIdentity: letterPatientIdentityFromMeta(composeMeta),
          accountNumber:
            typeof composeMeta.accountNumber === "string" && composeMeta.accountNumber.trim()
              ? composeMeta.accountNumber.trim()
              : undefined,
          collector:
            (composeMeta.collector as { name: string; address?: string | null; originalCreditor?: string | null } | undefined) ??
            undefined,
          appealExhausted:
            (composeMeta.appealExhausted as { attested: boolean; denialDate?: string | null } | undefined) ??
            undefined,
          certifiedMail:
            typeof composeMeta.certifiedMail === "boolean" ? composeMeta.certifiedMail : undefined,
          debtWithinWindow: composeDebtWithinWindow,
        });
        regeneratedLetterContent = rerendered?.body ?? null;
        if (rerendered?.recovery) {
          strengthenLetter = {
            weakened: rerendered.recovery.weakened,
            fields: rerendered.recovery.strengthenableFields,
          };
          // S312 — the demand signal was computed INSIDE rerender from the SAME
          // fold this regenerate just rendered (and floated into amount_disputed).
          demandEmpty = rerendered.recovery.noRemainingDemand;
        }
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
              // §18 incr-4 Call B — keep the headline in lockstep with the regenerated
              // deductible-aware body (unsent only; a sent dispute's amount stays frozen).
              ...(rerendered?.recovery && dispute.sent_at == null
                ? { amount_disputed: rerendered.recovery.total }
                : {}),
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
      } else if (disputeGroundsOn && !skipRegenerateForSent && evidence && dispute.claim_id) {
        // §18.10.D — plain load (costShareV2 ON → the block above did NOT regenerate): compute
        // the strengthen signal so the prompt shows whenever the CURRENT letter omits a precise
        // dollar. Unsent only (a sent letter is frozen → no rebuild). Mirrors generate's signal.
        const { loadDisputeGroundBasis } = await import("@/lib/disputes/dispute-ground-basis");
        const { resolveLetterRecovery, noRemainingLetterDemand } = await import("@/lib/disputes/dispute-grounds");
        const rec = resolveLetterRecovery(
          evidence,
          await loadDisputeGroundBasis(supabase, user.id, [dispute.claim_id as string]),
          letterRecipientKind(dispute.dispute_type),
        );
        strengthenLetter = rec.weakened
          ? { weakened: rec.weakened, fields: rec.strengthenableFields }
          : null;
        // S312 — same signal on the plain-view path (no drift → no regenerate),
        // so the banner shows on every view of a zero-demand draft, not only
        // the view that happened to rebuild it.
        demandEmpty = noRemainingLetterDemand(rec);
      }
    }
  } catch (err) {
    console.error("[disputes/[disputeId]] plan-context resolve failed (non-fatal):", err);
  }

  // Surface a patient-name mismatch to the UI so the user can edit easily.
  // The letter body always uses the account name (per rerender.ts); this
  // field lets the UI show a subtle "we used your account name — bill said
  // X" note above the letter.
  // S302 — the name compare + the sticky confirm-patient-identity suppression
  // moved into the shared readiness resolver, alongside the strength axis that
  // consumes them. This route and the case-file route each had a PRIVATE
  // `normalizeNameForCompare`; both are gone.
  const patientNameMismatch = readiness.patientNameMismatch;
  // Block C2 item 1 — the account holder's name is the default "Attesting as".
  const accountName = readiness.accountName;
  // The claim metadata the resolver already read — reused rather than re-fetched.
  const claimMetadataForPayload = readiness.claimMetadata;
  // Dispute Letters v2 (Z1.1c) — the user's confirmed amount-paid override.
  const userPatientPaid = readUserPatientPaidOverride(claimMetadataForPayload);
  // S292 (#7) — the CLAIM-page service confirmation, adopted when the dispute
  // has no explicit answer of its own.
  const servicesConfirmedAtClaim = readServicesConfirmedAt(claimMetadataForPayload);
  // S292 (#10) — the parsed EOB issue date, prefilling the denial-date input.
  const denialDatePrefill: { date: string; source: "eob_parse" } | null = (() => {
    const raw = (claimMetadataForPayload as { eob_date?: unknown } | null)?.eob_date;
    return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? { date: raw, source: "eob_parse" as const }
      : null;
  })();

  // S292 (#7) — effective attestation: the dispute's own explicit answer wins;
  // otherwise the claim-page confirmation is adopted (same human act — the user
  // reviewed the billed services and confirmed them performed; no letter clause
  // derives from it, so fail-closed gating is untouched — String 2 still requires
  // an explicit per-service attestation). Source lets the panel label provenance.
  const effectiveServiceAttestationReviewed =
    serviceAttestationReviewed || servicesConfirmedAtClaim != null;
  const serviceAttestationSource: "dispute" | "claim_page" | null =
    serviceAttestationReviewed
      ? "dispute"
      : servicesConfirmedAtClaim != null
        ? "claim_page"
        : null;

  // S292 (#7) — per-line cost-share resolutions THROUGH THE CLAIM PAGE'S OWN
  // recipe (loadDisputeLineResolutions → resolveLineCostShare, strategy "detail").
  // Powers the needs-panel plan-cost rows so a cost the claim page already
  // resolved (exact SBC row, secondary category match, ACA preventive) arrives
  // prefilled instead of re-asked. Non-fatal: empty map (flag OFF / load failure)
  // → the client falls back to today's evidence-derived rows.
  let lineCostShare: DisputeLineResolution[] = [];
  try {
    if (dispute.claim_id) {
      const resolutions = await loadDisputeLineResolutions(supabase, user.id, [
        dispute.claim_id as string,
      ]);
      const wanted = new Set(allLineItemIds);
      lineCostShare = Array.from(resolutions.values()).filter(
        (r) => wanted.size === 0 || wanted.has(r.lineItemId),
      );
    }
  } catch (err) {
    console.warn("[disputes/[disputeId]] line cost-share resolution failed (non-fatal):", err);
  }

  // S302 — the sticky confirm-patient-identity suppression and the three-axis
  // strength both live in the shared resolver now. `patientIdentityResolved` is
  // still surfaced in the payload, so it is read here from the same row.
  const patientIdentityResolved =
    (dispute.metadata as Record<string, unknown> | null)?.patientIdentityResolved === true;
  // S307 (tracker AT) — the stored identity answer, read ONCE and reused by
  // both payload fields below (the derived display name + the raw answer for
  // the edit widget), so the two can never come from different reads.
  const storedPatientIdentity = letterPatientIdentityFromMeta(
    dispute.metadata as Record<string, unknown> | null,
  );
  const claimPatientName = (readiness.claimMetadata as { patient?: { name?: string } } | null)
    ?.patient?.name;
  // Non-fatal by contract: the resolver returns null strength on failure and the
  // letter still serves, exactly as the inline version did.
  const strength: StrengthResult | null = readiness.strength;

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
  // served-the-cached-body = regeneratedLetterContent is null (we didn't regenerate, or a
  // refresh failed and we fell back to the saved letter — either way it may be stale).
  // §17.4 — the staleness rule is the SHARED isDisputeStale helper so this letter page
  // and the dispute card (claim GET) can never disagree about "out of date".
  const isStale =
    costShareV2 &&
    isDisputeStale({
      currentFingerprint: currentEvidenceFingerprint,
      storedFingerprint: (dispute.evidence_fingerprint as string | null) ?? null,
      sentAt,
      justRegenerated: regeneratedLetterContent != null,
    });
  const letterVersionCount = Array.isArray(
    (dispute.metadata as Record<string, unknown> | null)?.letterVersionHistory,
  )
    ? ((dispute.metadata as Record<string, unknown>).letterVersionHistory as unknown[]).length
    : 0;

  // S312 (F2-S312.1, Andrew's ruling) — "this letter may no longer be needed":
  // a live, never-sent draft whose own demand fell to $0 (noRemainingLetterDemand
  // over the same fold the asks and amount_disputed render from). Folded to ONE
  // boolean server-side so the client renders dumbly: the
  // dispute_draft_live_rebuild_v1 gate (this is the "a draft is a live document"
  // family; OFF in PROD until the flip) and the user's standing "Keep letter"
  // answer (metadata.zeroDemandKeptAt — durable by design; if dollars return the
  // demand condition is false anyway, so no clearing machinery exists).
  const zeroDemandKept = Boolean(
    (((dispute.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>)
      .zeroDemandKeptAt,
  );
  const noRemainingDemand =
    liveRebuildOn && liveApparatus && sentAt == null && demandEmpty && !zeroDemandKept;

  return NextResponse.json({
    id: dispute.id,
    // §18.10.D — non-null only when the deductible-aware letter omitted a precise dollar;
    // `fields` tells the page which cost-share inputs to prompt for (then Rebuild).
    strengthenLetter,
    // S312 (F2-S312.1) — drives the letter page's "may no longer be needed"
    // banner (Dismiss / Keep). Always present; true only for live zero-demand
    // drafts under dispute_draft_live_rebuild_v1.
    noRemainingDemand,
    disputeType: dispute.dispute_type,
    // W4 — persistent-letter signals, present ONLY when recovery_cost_share_v2 is ON (OFF =
    // byte-identical response). The client shows the stale banner + Refresh CTA off `isStale`.
    ...(costShareV2 ? { isStale, letterVersionCount } : {}),
    letterType: resolvedLetterType,
    status: dispute.status,
    // S312 (F2-S311.6) — the cancelled band's "cancelled on {date}". A void
    // row's updated_at is stable (the S311 guards froze every writer), so the
    // last write IS the cancellation stamp.
    updatedAt: (dispute.updated_at as string | null) ?? null,
    // Zone-3 (S266) — the persisted nested outcome; the page re-derives suggestNextStep
    // from it on load so the stage-action bar's escalate CTA survives a page refresh.
    outcomeDetail:
      (dispute.metadata as Record<string, unknown> | null)?.outcomeDetail ?? null,
    amountDisputed: dispute.amount_disputed,
    amountRecovered: dispute.amount_recovered,
    filedDate: dispute.filed_date,
    // Unified case timeline (S286) — the raw Mark-as-Sent timestamp. Distinct
    // from filed_date (set at draft time); the client prefers this for every
    // "Sent {date}" readout so the displayed date matches the real send.
    sentAt: (dispute.sent_at as string | null) ?? null,
    resolutionDate: dispute.resolution_date,
    claimId: dispute.claim_id,
    // Unified case timeline (S286) — persisted checklist check-offs (previously
    // session-local in the UnifiedTodo). {[rowKey]: boolean}.
    checklist:
      (((dispute.metadata as Record<string, unknown> | null)?.checklist as
        | Record<string, boolean>
        | undefined) ?? {}),
    // Guided Steps v1 (S297) — short per-row notes beside the booleans
    // (packC:receipt tracking number). ⚠ S303: the regulator complaint's
    // confirmation number is NO LONGER here — filing with a regulator is an
    // act against the BILL, so it moved to the claim's guided steps, per
    // agency (`packD:filed:<doorId>`). Any `packD:filed` still sitting in a
    // dispute's checklist/checklistNotes is pre-S303 residue and is read by
    // nothing.
    checklistNotes:
      (((dispute.metadata as Record<string, unknown> | null)?.checklistNotes as
        | Record<string, string>
        | undefined) ?? {}),
    // Unified case timeline (S286) — the claim's dispute ladder (see above).
    siblings,
    // S299 phase 2a — the shared projection (absent when case_rail_v1 OFF).
    ...(caseTimeline ? { caseTimeline } : {}),
    // S299 phase 2a — the letter's OWN collector (metadata), so the Sent-to
    // cell reads the LETTER, not claim/track defaults (§5 banked defect #1).
    collector:
      (((dispute.metadata as Record<string, unknown> | null)?.collector as
        | { name?: string; address?: string | null }
        | undefined) ?? null),
    // §0.9 rule 4 (S299 phase 2a) — the letter version stack (labels + dates
    // + bodies; bodies are small and few). The unsent label is §0.9b-approved.
    sentVersions:
      (((dispute.metadata as Record<string, unknown> | null)?.sentVersions as
        | Array<{ body: string; sentAt: string; unsentAt?: string }>
        | undefined) ?? []),
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
          // S301 — the claim-scoped collector knowledge layer. This payload picks
          // fields EXPLICITLY, so a new PlanContext field is invisible to the
          // client until it is named here; CaseNeedsPanel's collections rows and
          // the collector edit modal's prefill both read it.
          //
          // ⚠ FALLS BACK to the dispute's own collector. Cases created before the
          // knowledge layer existed carry the agency only on the dispute row
          // (escalate wrote it there), so a claim-only read showed an EMPTY name
          // in the edit modal for a collector we plainly knew — Andrew hit exactly
          // that on Ballard. Resolved server-side, once, so the panel and the
          // modal cannot disagree about what is on file.
          collectorContact: resolveCollectorContact(
            planContext.collectorContact,
            dispute.metadata as Record<string, unknown> | null,
          ),
          // S110 Chunk C — surface archive auto-lookup result so PlanSearchModal
          // can highlight it as a best-match suggestion. S111 D1: this is a UI
          // hint only — never drives letter citations (those flow through
          // boundCanonicalPlan below).
          archiveCanonicalPlan: planContext.archiveCanonicalPlan,
          // S311 (tree 13.3) — the sender-block address. S310 added it to
          // PlanContext but never named it in this explicit pick, so the
          // letter printed the address while the claim-details row showed
          // "Add" on every fresh load (the S310 build test passed only via
          // the editor's own optimistic value). The row and the letter now
          // read the same resolver output.
          userAddress: planContext.userAddress,
        }
      : null,
    // S111 D2 — top-level boundCanonicalPlan for VerifStrip rendering. Holds
    // the canonical the user explicitly bound via PlanSearchModal (with
    // insurer name + Pattern 1 #16 badge level). Null when nothing bound.
    boundCanonicalPlan: planContext?.boundCanonicalPlan ?? null,
    missingPlanForYear: planContext?.missingForYear ?? null,
    evidence,
    patientNameMismatch,
    // S307 (tracker AT) — the LETTER's patient name, computed through the ONE
    // derivation the compose uses (letterPatientName + pickPatientName, same
    // inputs: the identity answer off dispute metadata, the bill's patient,
    // the account-holder default). The claim-details block renders THIS, so
    // the block and the letter can never show two different names — two
    // surfaces, one derivation, executed once server-side.
    letterPatientName: letterPatientName(
      storedPatientIdentity,
      claimPatientName,
      pickPatientName(claimPatientName, readiness.accountName),
    ),
    // S307 (tracker AT, round 2) — the RAW stored answer, for the edit
    // widget's pre-fill (PatientIdentityChoices initialIdentity). The widget
    // hardcoded "me" as its starting state, asserting an answer the user never
    // gave; a re-confirm from that lie would clobber the real one. Same single
    // metadata read as the derived name above.
    patientIdentity: storedPatientIdentity,
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
    // S292 (#7) — the claim-page "All services look right" confirmation
    // (claims.metadata.servicesConfirmedAt) is adopted when the dispute has no
    // explicit answer; serviceAttestationSource carries provenance for the panel.
    serviceAttestationReviewed: effectiveServiceAttestationReviewed,
    serviceAttestationSource,
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
    // Dispute Letters v2 (Z1.1c) — Zone-1 read-signals. Additive; these are user inputs,
    // always surfaced (no flag gate). userPatientPaid prefills the amount-paid row;
    // deadlineInputs prefill the denial-notice + collector-first-contact date inputs
    // (persisted via POST …/deadline-inputs).
    userPatientPaid,
    // S292 (#7) — the claim page's own per-line cost-share resolution, projected for
    // the needs-panel: `known` when the shared recipe resolved a concrete copay or
    // coinsurance; `humanReviewed` when a human asserted or confirmed it (manual
    // entry / confirm-coverage mark). coinsurance arrives DECIMAL from the engine →
    // integer percent here (panel contract). Empty when recovery_cost_share_v2 OFF.
    lineCostShare: lineCostShare.map((r) => {
      const copay = r.coverage?.copay ?? null;
      const coins = r.coverage?.coinsurance ?? null;
      const known = r.coverage != null && (copay != null || coins != null);
      const source = r.coverageSource ?? null;
      const humanReviewed =
        source === "manual" || source === "user_correction" || r.coverageUserConfirmed;
      return {
        lineItemId: r.lineItemId,
        serviceSlug: r.serviceSlug,
        description: r.description,
        known,
        copay,
        coinsurancePercent: coins != null ? Math.round(coins * 100) : null,
        source,
        humanReviewed,
        confirmed: r.coverageUserConfirmed,
        rejected: r.coverageUserRejected,
        secondaryMatchedSlug: r.secondaryMatchedSlug,
      };
    }),
    // S292 (#10) — parsed EOB issue date (claims.metadata.eob_date) for the
    // denial-date prefill: editable, parsed provenance, insurer track only
    // (client-gated); null when no EOB/denial parse carried a date → question remains.
    denialDatePrefill,
    deadlineInputs: {
      denialNoticeDate: ((): string | null => {
        const v = (dispute.metadata as Record<string, unknown> | null)?.denialNoticeDate;
        return typeof v === "string" ? v : null;
      })(),
      collectorFirstContactDate: ((): string | null => {
        const v = (dispute.metadata as Record<string, unknown> | null)
          ?.collectorFirstContactDate;
        return typeof v === "string" ? v : null;
      })(),
    },
    // dispute-letters v2 (Zone-2) — deadline surface (flag-gated; null/empty when OFF).
    // deadlineWarning is recomputed fresh; governingDeadlineDate/deadlineType/followups are
    // read from the persisted col/rows; followupPlan is a computed preview when none persisted.
    deadlineWarning,
    governingDeadlineDate,
    deadlineType,
    filingDeadlineDate,
    followups,
    followupPlan,
  });
}

// resolveLetterTypeFromDispute — consolidated to src/lib/disputes/letter-type.ts
// (S298): this route's private copy + redraft's had drifted on legacy rows,
// and the legacy external_appeal guess is corrected there (→ external_review).

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


"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import type { DisputeLetter } from "@/lib/billing/types";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { useFeatureFlag } from "@/lib/config/use-feature-flag";
import { LockedOverlay } from "@/components/shared/LockedOverlay";
import { InlineSubscribePanel } from "@/components/billing/InlineSubscribePanel";
import { downloadCaseFile } from "@/lib/casefile";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { letterRecipientKind } from "@/lib/disputes";
import { DisputeLetterHero } from "@/components/disputes/DisputeLetterHero";
import { EvidenceStrengthModal } from "@/components/disputes/EvidenceStrengthModal";
import { DisputeRecipientCard } from "@/components/disputes/DisputeRecipientCard";
import { VerifStrip } from "@/components/disputes/VerifStrip";
import {
  CoverageDiffPanel,
  type CoverageDiff,
} from "@/components/disputes/CoverageDiffPanel";
import {
  PlanSearchModal,
  type PlanSearchModalMode,
} from "@/components/disputes/PlanSearchModal";
import { DisputePlanChooser, type DisputePlanChooserPlan } from "@/components/disputes/DisputePlanChooser";
import { StrengthenLetterPrompt, type StrengthField } from "@/components/disputes/StrengthenLetterPrompt";
import { DownloadWarningModal } from "@/components/disputes/DownloadWarningModal";
import { InsurerAddressCorrectionModal } from "@/components/disputes/InsurerAddressCorrectionModal";
import { ProviderAddressModal } from "@/components/disputes/ProviderAddressModal";
import { OutcomeReportingModal } from "@/components/disputes/OutcomeReportingModal";
import { CollectorModal } from "@/components/disputes/CollectorModal";
import { ExhaustionAttestModal } from "@/components/disputes/ExhaustionAttestModal";
import { suggestNextStep, isOutcomeDetail, mapOutcomeToStatus, type NextStepSuggestion } from "@/lib/disputes/outcome-taxonomy";
import {
  CaseNeedsPanel,
  isClaimDetailsConfirmed,
  type PlanCostService,
} from "@/components/disputes/CaseNeedsPanel";
import { UnifiedTodo, type CaseLetterSummary } from "@/components/disputes/UnifiedTodo";
import { CaseSummary } from "@/components/disputes/CaseSummary";
import { AddPlanDetailsModal } from "@/components/claims/AddPlanDetailsModal";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useDisputeDraftOverlay } from "@/lib/loading/dispute-draft-overlay";
import type {
  BoundCanonicalPlan,
  PlanContext,
} from "@/lib/disputes/plan-context";
import type { DisputeEvidence } from "@/lib/disputes/evidence-resolver";
// Block C (dispute_letter_v3_design) — the three-axis strength readouts.
import { DataTrustBanner } from "@/components/disputes/DataTrustBanner";
import type { StrengthResult } from "@/lib/disputes/strength-scoring";

export default function DisputesPage() {
  const { isPro, loading, waitFor } = useSubscription();
  const { enabled: freeStart, loading: freeStartLoading } = useFeatureFlag(
    "dispute_letters_free_start_v1",
  );
  const [subscribing, setSubscribing] = useState(false);

  if (loading || freeStartLoading) {
    // S132 iter-8 — unified cube loader.
    return <CubeLoaderBuilding />;
  }

  // Free to start (dispute_letters_free_start_v1 ON): render the workspace for
  // all authed users — free users draft/download first-contact letters (the
  // backend already permits this; only escalation needs Pro). Escalation CTAs
  // 403 → the "your dispute letters are always free" toast. Flag OFF keeps
  // today's Pro-wall (byte-identical).
  if (!isPro && !freeStart) {
    return (
      <LockedOverlay
        title="Dispute Letters requires Candid Pro"
        description="Upgrade to draft appeal letters grounded in your plan benefits, track dispute outcomes, and escalate to the attorney marketplace when needed."
        ctaLabel="Subscribe to Pro"
        onCta={() => setSubscribing(true)}
        tone="pro"
        replaceCta={
          subscribing ? (
            <InlineSubscribePanel
              triggerSurface="dispute"
              subtitle="Unlimited dispute letters, drafted from your plan benefits."
              contextRibbon={{
                headline: "Unlock unlimited dispute letters",
                subline: "Evidence-backed appeal templates drafted from your plan benefits.",
              }}
              onSuccess={async () => {
                // Wait for the webhook to flip tier → pro before dismissing
                // the form. Otherwise LockedOverlay re-renders with the
                // upgrade prompt (tier still reads 'free' in the row the
                // next refresh() fetches).
                await waitFor((s) => s.tier === "pro" && (s.status === "active" || s.status === "trialing"));
                setSubscribing(false);
              }}
              onCancel={() => setSubscribing(false)}
            />
          ) : undefined
        }
      >
        <SampleDisputeLetterPreview />
      </LockedOverlay>
    );
  }

  return (
    <Suspense>
      <DisputesContent />
    </Suspense>
  );
}

/**
 * Background preview rendered behind the upgrade CTA so free users see what
 * a real dispute letter looks like (instead of staring at a blank interstitial).
 */
function SampleDisputeLetterPreview() {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Dispute Letter</h1>
      <p className="text-gray-600 mb-6">
        Review and edit your letter below. When ready, download or copy it and
        send it yourself.
      </p>

      <div className="bg-white rounded-lg shadow p-5 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Type:</span>{" "}
            <span className="font-medium">Appeal to Insurer</span>
          </div>
          <div>
            <span className="text-gray-500">To:</span>{" "}
            <span className="font-medium">Aetna Member Services — Appeals</span>
          </div>
          <div>
            <span className="text-gray-500">Action:</span>{" "}
            <span className="font-medium">Reprocess claim at in-network rate</span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">Formal Appeal — Claim #AET-2026-0428</h2>
          <div className="flex gap-2">
            <span className="text-sm px-3 py-1.5 rounded border border-gray-300">Edit</span>
            <span className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white">
              Download Case File
            </span>
          </div>
        </div>
        <div className="p-6 whitespace-pre-wrap font-mono text-sm leading-relaxed">
{`Aetna Member Services — Appeals
PO Box 14463
Lexington, KY 40512

Re: Formal appeal of claim denial
Member: Jane Sample · Member ID: W123456789
Date of service: June 1, 2026 · Claim #AET-2026-0428

To Whom It May Concern:

I am appealing the denial of the above claim for an established office visit
(CPT 99214) at Swedish Providence on June 1, 2026. My plan documents (Aetna PPO
Select, plan year 2026) specify a $20 copay for this service when rendered
in-network. The provider is listed as in-network on your published directory.

The EOB shows $428.00 billed, $0.00 insurance paid, and $0.00 patient
responsibility — with no line-item allocation. Per 29 CFR §2560.503-1, I am
entitled to a written explanation of the adverse benefit determination,
including the specific plan provision on which the denial is based.

Community data from anonymized, aggregated Candid user reports shows 14 other
members of this plan have been charged the $20 copay for this service in 2026.
This supports that the denial is inconsistent with plan terms.

I request that this claim be reprocessed at the in-network rate and that I be
credited for the $20 copay I have already paid. Please respond within 30
business days as required by 29 CFR §2560.503-1(i).

Sincerely,
Jane Sample`}
        </div>
      </div>
    </div>
  );
}

function DisputesContent() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [letter, setLetter] = useState<DisputeLetter | null>(() => {
    const letterParam = searchParams.get("letter");
    if (letterParam) {
      try {
        return JSON.parse(decodeURIComponent(letterParam));
      } catch {
        // Invalid letter data
      }
    }
    return null;
  });
  const [editedBody, setEditedBody] = useState(() => {
    const letterParam = searchParams.get("letter");
    if (letterParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(letterParam));
        return parsed.body || "";
      } catch {
        // Invalid letter data
      }
    }
    return "";
  });
  // S132 iter-2 — initialize true when ?dispute=ID present so the in-page
  // loader renders synchronously on first paint (before the fetch useEffect
  // toggles it). Avoids a single-frame blank flash under the layout-level
  // DisputeDraftOverlay (which dismisses once disputeFetching → false).
  const [disputeFetching, setDisputeFetching] = useState(
    () => !!searchParams.get("dispute"),
  );
  const [planContext, setPlanContext] = useState<PlanContext | null>(null);
  const [evidence, setEvidence] = useState<DisputeEvidence | null>(null);
  const [downloadWarnOpen, setDownloadWarnOpen] = useState(false);
  const [nameMismatch, setNameMismatch] = useState<{ billName: string; profileName: string } | null>(null);
  // Phase 4 Task 4-E: server-authoritative flag state for cite-grade gating on
  // EvidenceBlock UI. Resolved server-side in /api/disputes/[disputeId] GET so
  // we don't duplicate flag-evaluation logic on the client.
  // (S293 #5 — gateUnverified state removed with the EvidenceBlock sidebar,
  // its only consumer; the letter-side gating happens server-side at compose.)
  // S74 — dispute lifecycle state for the Mark-as-Sent flow.
  const [disputeStatus, setDisputeStatus] = useState<string | null>(null);
  const [disputeFiledDate, setDisputeFiledDate] = useState<string | null>(null);
  // Cost-Share v2 (W4 / Finding 4) — letter-page staleness. isStale gates the
  // banner; collapsed = the user chose "Keep as-is" (banner → small re-openable
  // "May need update" tag, never a permanent dismiss); refreshingLetter guards
  // the regenerate.
  const [isStale, setIsStale] = useState(false);
  const [staleBannerCollapsed, setStaleBannerCollapsed] = useState(false);
  const [refreshingLetter, setRefreshingLetter] = useState(false);
  // §18.10.D — the "confirm to strengthen" signal from the dispute GET/redraft. Non-null +
  // fields populated only when the deductible-aware letter omitted a precise dollar.
  const [strengthenLetter, setStrengthenLetter] = useState<{ weakened: boolean; fields: StrengthField[] } | null>(null);
  // Collapse owned at the page (like staleBannerCollapsed) so "minimize after rebuild" persists
  // across the refetch and the user can reopen it; re-expands on a fresh navigation.
  const [strengthenCollapsed, setStrengthenCollapsed] = useState(false);
  // S109 PR #2 (Chunk B) — current same-plan-confirmation answer; drives
  // SamePlanConfirmBanner visibility and the letter's fallback-cite framing.
  const [userConfirmedSamePlan, setUserConfirmedSamePlan] = useState<
    "yes" | "no" | "not_sure" | null
  >(null);
  // S111 D2 — server-resolved bound canonical (insurer + plan name + badge).
  // Surfaced at the top level of the GET response so VerifStrip can render
  // bound-verified state directly without a follow-up fetch. The raw
  // canonical id lives on the server (dispute.metadata.canonicalPlanIdForBillYear);
  // the client doesn't need to track it separately since boundCanonicalPlan
  // is the read surface for both the strip + templates.
  const [boundCanonicalPlan, setBoundCanonicalPlan] =
    useState<BoundCanonicalPlan | null>(null);
  // S111 smoke #2 — proxy-acceptance flag. Distinguishes "Yes, deciding"
  // (confirm-archive or upload-or-proxy strip) from "Yes, chose proxy"
  // (bound-proxy strip). Persisted in dispute.metadata.userAcceptedProxy.
  const [userAcceptedProxy, setUserAcceptedProxy] = useState(false);
  // S111 smoke #5 — wrong-year banner dismissal flag (from response).
  const [wrongYearBannerDismissed, setWrongYearBannerDismissed] = useState(false);
  // S111 smoke #5 — coverage diff payload (from response). Rendered above
  // the letter via CoverageDiffPanel when present. Cleared via the
  // clear-coverage-diff endpoint when user proceeds with the dispute.
  const [coverageDiff, setCoverageDiff] = useState<CoverageDiff | null>(null);
  // Block C (dispute_letter_v3_design) — the reskin gate + the 3-axis strength
  // payload it renders. v3DesignOn is server-resolved (per-user-targeted) and
  // surfaced on the [disputeId] GET; strength carries the data-trust / evidence
  // band / readiness axes. Both default to today's behavior when absent: flag
  // OFF → v3DesignOn false → current single-column UI; strength ignored.
  const [v3DesignOn, setV3DesignOn] = useState(false);
  const [strength, setStrength] = useState<StrengthResult | null>(null);
  // Block C2 — sticky patient-identity confirmation + the service-not-rendered
  // attestation set, both from the GET payload. Drive the resolve banner/rail CTAs
  // and the attestation flow + per-line markers.
  const [patientIdentityResolved, setPatientIdentityResolved] = useState(false);
  const [serviceAttestedLineIds, setServiceAttestedLineIds] = useState<string[]>(
    [],
  );
  // Block C2 item 2 — persisted attestation gate state + adopted name + the
  // account-holder default, all hydrated from the GET payload (no re-prompt).
  const [serviceAttestationReviewed, setServiceAttestationReviewed] = useState(false);
  const [attestingAsName, setAttestingAsName] = useState<string | null>(null);
  const [accountName, setAccountName] = useState("");
  // S111 — unified modal state. Replaces the S110 SearchCanonicalPlanModal
  // open boolean; mode controls the 5-mode morph in PlanSearchModal.
  const [planSearchModalOpen, setPlanSearchModalOpen] = useState(false);
  const [planSearchModalMode, setPlanSearchModalMode] =
    useState<PlanSearchModalMode>("search");
  // S74 — InsurerAddressCorrectionModal open state.
  const [insurerCorrectionOpen, setInsurerCorrectionOpen] = useState(false);
  // Z1.3 — provider address modal (Zone-1 owns both address surfaces now).
  const [providerAddressOpen, setProviderAddressOpen] = useState(false);
  // S74 — Mark-sent button state + transient toast.
  const [markingSent, setMarkingSent] = useState(false);
  // Surface 4 (clarity redesign) — the letter-card footer "I've sent this"
  // inline confirm; shares the same mark-sent flow as the UnifiedTodo row.
  const [footerConfirming, setFooterConfirming] = useState(false);
  const [markSentToast, setMarkSentToast] = useState<string | null>(null);
  // S74.6 D5 §E.2 — outcome reporting modal state.
  const [outcomeModalOpen, setOutcomeModalOpen] = useState(false);
  // Zone-3 (S266) — advisory next rung surfaced after an outcome is reported.
  const [suggestedNextStep, setSuggestedNextStep] = useState<NextStepSuggestion | null>(null);
  // Zone-3 (S266) — ladder-advance capture modals + in-flight guard.
  const [collectorModalOpen, setCollectorModalOpen] = useState(false);
  const [exhaustionModalOpen, setExhaustionModalOpen] = useState(false);
  const [escalating, setEscalating] = useState(false);
  // Bugbash Item 3 — "Why {band}?" evidence-strength explanation modal.
  const [evidenceModalOpen, setEvidenceModalOpen] = useState(false);
  const [outcomeToast, setOutcomeToast] = useState<string | null>(null);
  // Dispute Letters v2 (Z1.2) — Zone-1 read-signals + AddPlanDetailsModal state.
  const [userPatientPaid, setUserPatientPaid] = useState<number | null>(null);
  // S292 (#7) — the claim page's own per-line cost-share resolution (server
  // `lineCostShare`): the needs panel derives its plan-cost rows from THIS (the
  // shared recipe), not from the letter-citation loader, so a cost the claim page
  // already resolved arrives prefilled instead of re-asked.
  const [lineCostShare, setLineCostShare] = useState<LineCostShareRow[]>([]);
  // S292 (#7) — attestation provenance ("claim_page" = adopted from the claim
  // page's "All services look right" confirmation).
  const [attestationSource, setAttestationSource] = useState<"dispute" | "claim_page" | null>(null);
  // S292 (#10) — parsed EOB issue date for the denial-date prefill.
  const [denialDatePrefill, setDenialDatePrefill] = useState<{ date: string; source: string } | null>(null);
  // S292 (#8) — optimistic plan-cost saves: holds only the IN-FLIGHT TARGET per
  // service slug (the ClaimDetail svcPendingConfirm idiom) so a burst of saves
  // renders instantly; ONE debounced reconcile refetch then yields to server truth.
  const [pendingCostShare, setPendingCostShare] = useState<
    Map<string, { copay: number | null; coinsurancePercent: number | null }>
  >(new Map());
  const [deadlineInputs, setDeadlineInputs] = useState<{
    denialNoticeDate: string | null;
    collectorFirstContactDate: string | null;
  }>({ denialNoticeDate: null, collectorFirstContactDate: null });
  // Dispute Letters v2 (Zone-2) — recovery estimate + deadline surface hydrated from the GET.
  const [amountDisputed, setAmountDisputed] = useState<number | null>(null);
  const [deadlineData, setDeadlineData] = useState<{
    deadlineWarning: {
      severity: "urgent" | "past";
      deadlineType: string | null;
      daysRemaining: number | null;
      nextStep: string | null;
    } | null;
    governingDeadlineDate: string | null;
    deadlineType: string | null;
    filingDeadlineDate: string | null;
    followups: Array<{ dueDate: string; kind: string }>;
    followupPlan: Array<{ dueDate: string; kind: string }>;
  } | null>(null);
  const [addPlanModal, setAddPlanModal] = useState<{
    serviceSlug: string;
    serviceLabel: string;
    initialCopay: number | null;
    initialCoinsurancePercent: number | null;
  } | null>(null);
  // Unified case timeline (S286) — raw sent_at (preferred over filed_date for
  // every "Sent {date}" readout), the claim's dispute ladder, and the persisted
  // checklist check-offs. All hydrated from the GET.
  const [disputeSentAt, setDisputeSentAt] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<SiblingLetter[]>([]);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const disputeId = searchParams.get("dispute");
  // Stretch 2 — enriched Case File rollout flag (case_file_enriched_v1), read
  // via /api/feature-flags (a browser-Supabase read returns [] under Firebase auth).
  const [caseFileEnrichedEnabled, setCaseFileEnrichedEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/feature-flags/case_file_enriched_v1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setCaseFileEnrichedEnabled(!!d.enabled); })
      .catch(() => { /* OFF → legacy text export */ });
    return () => { cancelled = true; };
  }, []);

  // dispute_plan_pinning_v1 (Phase 4) — re-bind control gate + chooser state.
  const [planPinningEnabled, setPlanPinningEnabled] = useState(false);
  const [rebindOpen, setRebindOpen] = useState(false);
  const [rebindPlans, setRebindPlans] = useState<DisputePlanChooserPlan[]>([]);
  const [rebindBusy, setRebindBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/feature-flags/dispute_plan_pinning_v1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPlanPinningEnabled(!!d.enabled); })
      .catch(() => { /* OFF → no re-bind control */ });
    return () => { cancelled = true; };
  }, []);

  // S132 iter-2 — drop the layout-level DisputeDraftOverlay once the fetch
  // settles (letter ready OR fetch errored). Cleanup on unmount as safety so
  // mid-flow nav-away can't leave the overlay stuck.
  const { stop: stopDisputeDraftOverlay } = useDisputeDraftOverlay();
  useEffect(() => {
    if (!disputeFetching) stopDisputeDraftOverlay();
  }, [disputeFetching, stopDisputeDraftOverlay]);
  useEffect(() => () => stopDisputeDraftOverlay(), [stopDisputeDraftOverlay]);

  // S74 — bearer-token fetch helper shared by the inline forms (InsurerAddressCorrectionModal,
  // ProviderAddressForm) so they don't need to know about useAuth() internals.
  const getAuthToken = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    return user.firebaseUser.getIdToken();
  }, [user]);

  // Fetch dispute + plan context + evidence (reused for refetch-on-focus).
  // S266 (#3) — mutation generation. Optimistic handlers bump this; a background
  // refetch that started before a newer mutation is DROPPED, so a slow stale reload
  // can't clobber the fresher optimistic state (the undo→won→awaiting flicker).
  const mutationGenRef = useRef(0);
  // S293 (#13) — the last letter body the SERVER sent. The optimistic todo
  // actions reconcile through a debounced background fetchDispute; resetting
  // `editedBody` on every reload wiped local letter edits (the resolve-name
  // fill, mid-edit text) a second after each background reconcile — and on
  // every tab-refocus. The working copy now resets only when the server letter
  // actually changed (redraft / ?refresh=1 / a different dispute).
  const lastServerLetterRef = useRef<string | null>(null);
  const fetchDispute = useCallback(async (id: string, opts?: { refresh?: boolean }) => {
    if (!user) return;
    const startGen = mutationGenRef.current;
    const token = await user.firebaseUser.getIdToken();
    // ?refresh=1 regenerates the letter server-side (versioning the prior) and
    // returns the recomputed isStale (W4 / Finding 4). A plain load reads current.
    const res = await fetch(
      opts?.refresh ? `/api/disputes/${id}?refresh=1` : `/api/disputes/${id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return;
    const data = await res.json();
    // Drop a superseded reload (a newer optimistic mutation happened mid-fetch).
    if (mutationGenRef.current !== startGen) return;
    // Cost-Share v2 (W4) — staleness for the letter-page banner. A fresh
    // navigation re-expands the banner; a refresh keeps the user's collapse
    // state (the refreshed letter is no longer stale anyway).
    setIsStale(data.isStale === true);
    if (!opts?.refresh) { setStaleBannerCollapsed(false); setStrengthenCollapsed(false); }
    setPlanContext(data.planContext ?? null);
    setEvidence(data.evidence ?? null);
    setNameMismatch(data.patientNameMismatch ?? null);
    setStrengthenLetter(
      data.strengthenLetter && Array.isArray(data.strengthenLetter.fields)
        ? { weakened: data.strengthenLetter.weakened === true, fields: data.strengthenLetter.fields as StrengthField[] }
        : null,
    );
    setDisputeStatus(typeof data.status === "string" ? data.status : null);
    setDisputeFiledDate(typeof data.filedDate === "string" ? data.filedDate : null);
    // Unified case timeline (S286) — sent_at + ladder + persisted checks.
    setDisputeSentAt(typeof data.sentAt === "string" ? data.sentAt : null);
    setSiblings(Array.isArray(data.siblings) ? (data.siblings as SiblingLetter[]) : []);
    setChecklist(
      data.checklist && typeof data.checklist === "object" && !Array.isArray(data.checklist)
        ? (data.checklist as Record<string, boolean>)
        : {},
    );
    // S109 PR #2 (Chunk B) — banner visibility + letter framing both gated
    // on this state. API normalizes to 'yes' | 'no' | 'not_sure' | null.
    setUserConfirmedSamePlan(
      data.userConfirmedSamePlan === "yes" ||
        data.userConfirmedSamePlan === "no" ||
        data.userConfirmedSamePlan === "not_sure"
        ? data.userConfirmedSamePlan
        : null,
    );
    // S111 D2 — top-level boundCanonicalPlan from the response. Drives
    // VerifStrip's bound-verified state without a follow-up fetch. Trust the
    // server shape (server validates canonical exists before populating).
    setBoundCanonicalPlan(
      (data.boundCanonicalPlan as BoundCanonicalPlan | null) ?? null,
    );
    // S111 smoke #2 — proxy-acceptance flag from response top level.
    setUserAcceptedProxy(data.userAcceptedProxy === true);
    // S111 smoke #5 — wrong-year banner dismissal + coverage diff.
    setWrongYearBannerDismissed(data.wrongYearBannerDismissed === true);
    setCoverageDiff((data.coverageDiff as CoverageDiff | null) ?? null);
    // Block C — flag gate + 3-axis strength (additive; ignored by the OLD UI).
    setV3DesignOn(data.v3DesignOn === true);
    setStrength((data.strength as StrengthResult | null) ?? null);
    // Block C2 — sticky identity confirmation + attestation set from the payload.
    setPatientIdentityResolved(data.patientIdentityResolved === true);
    setServiceAttestedLineIds(
      Array.isArray(data.serviceAttestedLineIds)
        ? (data.serviceAttestedLineIds as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [],
    );
    // Block C2 item 2 — gate-reviewed flag + adopted name + account default.
    setServiceAttestationReviewed(data.serviceAttestationReviewed === true);
    setAttestingAsName(
      typeof data.attestingAsName === "string" ? data.attestingAsName : null,
    );
    setAccountName(typeof data.accountName === "string" ? data.accountName : "");
    // Dispute Letters v2 (Z1.2) — Zone-1 prefill signals.
    setUserPatientPaid(typeof data.userPatientPaid === "number" ? data.userPatientPaid : null);
    // S292 (#7/#10) — claim-page cost-share resolution rows + attestation
    // provenance + parsed denial-date prefill. Server truth arrived → drop any
    // in-flight optimistic plan-cost targets (pending-target idiom: server wins).
    setLineCostShare(Array.isArray(data.lineCostShare) ? (data.lineCostShare as LineCostShareRow[]) : []);
    setPendingCostShare(new Map());
    setAttestationSource(
      data.serviceAttestationSource === "dispute" || data.serviceAttestationSource === "claim_page"
        ? data.serviceAttestationSource
        : null,
    );
    setDenialDatePrefill(
      data.denialDatePrefill && typeof data.denialDatePrefill.date === "string"
        ? { date: data.denialDatePrefill.date, source: String(data.denialDatePrefill.source ?? "eob_parse") }
        : null,
    );
    setDeadlineInputs({
      denialNoticeDate:
        typeof data.deadlineInputs?.denialNoticeDate === "string"
          ? data.deadlineInputs.denialNoticeDate
          : null,
      collectorFirstContactDate:
        typeof data.deadlineInputs?.collectorFirstContactDate === "string"
          ? data.deadlineInputs.collectorFirstContactDate
          : null,
    });
    // Dispute Letters v2 (Zone-2) — recovery estimate + deadline surface (flag-gated fields are
    // null when dispute_deadline_engine_v1 is OFF → CaseSummary renders only what's present).
    setAmountDisputed(typeof data.amountDisputed === "number" ? data.amountDisputed : null);
    setDeadlineData({
      deadlineWarning:
        data.deadlineWarning && typeof data.deadlineWarning === "object"
          ? (data.deadlineWarning as {
              severity: "urgent" | "past";
              deadlineType: string | null;
              daysRemaining: number | null;
              nextStep: string | null;
            })
          : null,
      governingDeadlineDate:
        typeof data.governingDeadlineDate === "string" ? data.governingDeadlineDate : null,
      deadlineType: typeof data.deadlineType === "string" ? data.deadlineType : null,
      filingDeadlineDate:
        typeof data.filingDeadlineDate === "string" ? data.filingDeadlineDate : null,
      followups: Array.isArray(data.followups)
        ? (data.followups as Array<{ dueDate: string; kind: string }>)
        : [],
      followupPlan: Array.isArray(data.followupPlan)
        ? (data.followupPlan as Array<{ dueDate: string; kind: string }>)
        : [],
    });
    if (data.letterContent) {
      // Server-resolved letter type (S74). Authoritative — reads metadata.letterType
      // first, then maps from legacy dispute_type vocab. Without this, the recipient
      // block + DisputeLetterHero eyebrow would regress on legacy rows.
      const resolvedLetterType: DisputeLetter["letterType"] =
        (data.letterType as DisputeLetter["letterType"] | undefined) ?? "insurance_appeal";
      const synthesized: DisputeLetter = {
        id: data.id,
        auditReportId: data.claimId || "",
        userId: "",
        letterType: resolvedLetterType,
        findingIds: [],
        recipient: recipientFromPlanContext(data.planContext, resolvedLetterType),
        subject: `Formal appeal — dispute ${data.id.slice(0, 8)}`,
        body: data.letterContent,
        supportingFacts: [],
        requestedAction: "Reprocess the claim and issue a refund where applicable.",
        status: "draft",
        createdAt: data.filedDate || new Date().toISOString(),
        updatedAt: data.filedDate || new Date().toISOString(),
        planContext: data.planContext?.plan
          ? {
              planName: data.planContext.plan.planName ?? null,
              planYear: data.planContext.plan.planYear ?? null,
              insurerName: data.planContext.insurer?.name ?? data.planContext.plan.insurerName ?? null,
            }
          : null,
        missingPlanForYear: data.missingPlanForYear ?? null,
      };
      setLetter(synthesized);
      // S293 (#13) — reset the working copy ONLY when the server letter
      // actually changed; a reconcile refetch returning the same letter must
      // not wipe the user's local edits (see lastServerLetterRef above).
      if (lastServerLetterRef.current !== data.letterContent) {
        setEditedBody(data.letterContent);
      }
      lastServerLetterRef.current = data.letterContent;
      // Zone-3 (S266) — re-derive the advisory next rung from the persisted outcome so
      // the stage-action bar's escalate CTA survives a refresh (not just in-session).
      const persistedOutcome = data.outcomeDetail;
      setSuggestedNextStep(
        isOutcomeDetail(persistedOutcome)
          ? suggestNextStep(resolvedLetterType, persistedOutcome)
          : null,
      );
    }
  }, [user]);

  // S292 (#8) — the ONE debounced reconcile refetch behind every optimistic
  // handler on this page (plan-cost saves, and since S293 #13 the identity /
  // attestation / coverage-verify rows too): coalesces a burst of writes into
  // a single dispute re-resolve instead of one per save.
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // S293 (#6) — a reconcile can be upgraded to a LETTER-REFRESHING reconcile
  // (?refresh=1: server re-resolves evidence, recomposes + persists the body,
  // versioning the prior letter). Handlers whose write changes what the letter
  // SAYS (coverage confirms/rejects, service attestations, amount-paid) pass
  // {refresh:true} so the confirmation and the clause it produces land in the
  // SAME user action — the S292 aggregate confirm previously wrote the marks
  // and then plain-reloaded the stored (stale, zero-clause) letter, waiting on
  // a "next render" that nothing ever scheduled. The flag is OR-accumulated
  // across the debounce window so a later plain reconcile can't downgrade a
  // pending refresh.
  const reconcileRefreshRef = useRef(false);
  const scheduleReconcile = useCallback((opts?: { refresh?: boolean }) => {
    if (!disputeId) return;
    if (opts?.refresh) reconcileRefreshRef.current = true;
    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    reconcileTimerRef.current = setTimeout(() => {
      reconcileTimerRef.current = null;
      const refresh = reconcileRefreshRef.current;
      reconcileRefreshRef.current = false;
      void fetchDispute(disputeId, refresh ? { refresh: true } : undefined);
    }, 1200);
  }, [disputeId, fetchDispute]);
  useEffect(() => () => {
    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
  }, []);

  // Block C2 — confirm/undo patient identity (POST confirm-patient-identity).
  // S293 (#13) — optimistic: the todo row flips in the click's own render
  // (pending-target idiom — local state mirrors the intended server truth and
  // the mutationGen bump keeps a stale in-flight reload from clobbering it);
  // the write + ONE debounced reconcile run in the background, replacing the
  // awaited full dispute re-resolve that made "Resolve name" feel dead for
  // seconds. Snaps back to the pre-click value if the write fails. Never
  // rejects (callers fire-and-forget); returns whether the write landed so
  // the letter name-fill only runs on success.
  const handleResolvePatientIdentity = useCallback(
    async (
      confirmed: boolean,
      // S294 — the flywheel payload: WHICH resolution, persisted server-side
      // (metadata.patientIdentityChoice / patientCorrectedName) instead of
      // being discarded at the click.
      choice?: "me" | "dependent" | "wrong",
      correctedName?: string,
    ): Promise<boolean> => {
      if (!user || !disputeId) return false;
      const prev = patientIdentityResolved;
      mutationGenRef.current += 1;
      setPatientIdentityResolved(confirmed);
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/disputes/${disputeId}/confirm-patient-identity`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirmed, choice, correctedName }),
        });
        if (!res.ok) throw new Error(`confirm-patient-identity ${res.status}`);
        scheduleReconcile();
        return true;
      } catch (err) {
        console.error("[confirm-patient-identity] failed:", err);
        mutationGenRef.current += 1;
        setPatientIdentityResolved(prev);
        scheduleReconcile();
        return false;
      }
    },
    [user, disputeId, patientIdentityResolved, scheduleReconcile],
  );

  /**
   * S294 — THE patient-identity resolution, shared by both surfaces that ask
   * (UnifiedTodo rail + CaseNeedsPanel row, both rendering the shared
   * PatientIdentityChoices form). "me" -> letter uses the account name;
   * "wrong" -> the typed name; "dependent" keeps the bill name. The choice is
   * persisted through confirm-patient-identity; the letter name-fill runs only
   * when the write lands (S293 #13 optimistic pattern preserved).
   */
  const resolvePatientChoice = useCallback(
    async (choice: "me" | "dependent" | "wrong", correctedName?: string) => {
      const mismatch = nameMismatch;
      const to =
        mismatch == null
          ? null
          : choice === "me"
            ? mismatch.profileName
            : choice === "wrong"
              ? (correctedName ?? "").trim()
              : null;
      const ok = await handleResolvePatientIdentity(true, choice, correctedName);
      if (ok && mismatch && to && to !== mismatch.billName) {
        setEditedBody((body: string) =>
          body
            .split(mismatch.billName)
            .join(to)
            .split(mismatch.billName.toUpperCase())
            .join(to.toUpperCase()),
        );
      }
    },
    [nameMismatch, handleResolvePatientIdentity],
  );


  // Block C2 — commit the full service-not-rendered attestation set (POST
  // attest-service). S293 (#13) — optimistic: the needs-panel row + per-line
  // evidence markers flip in the click's own render (mirroring exactly what
  // the reconcile GET will return), the POST runs in the background, and ONE
  // debounced reconcile replaces the awaited full dispute re-resolve. Snaps
  // everything back if the write fails. Never rejects — the attestation gate
  // buttons fire-and-forget this.
  const handleAttestServices = useCallback(
    async (payload: {
      attestedLineItemIds: string[];
      serviceAttestationReviewed: boolean;
      attestingAsName?: string;
    }) => {
      if (!user || !disputeId) return;
      const prev = {
        ids: serviceAttestedLineIds,
        reviewed: serviceAttestationReviewed,
        name: attestingAsName,
        source: attestationSource,
        evidence,
      };
      mutationGenRef.current += 1;
      const attestedSet = new Set(payload.attestedLineItemIds);
      setServiceAttestedLineIds(payload.attestedLineItemIds);
      setServiceAttestationReviewed(payload.serviceAttestationReviewed);
      if (payload.attestingAsName) setAttestingAsName(payload.attestingAsName);
      setAttestationSource("dispute");
      setEvidence((prevEv) =>
        prevEv
          ? {
              ...prevEv,
              claims: prevEv.claims.map((c) => ({
                ...c,
                lineItemEvidence: c.lineItemEvidence.map((li) => ({
                  ...li,
                  serviceNotRenderedAttested: attestedSet.has(li.lineItemId),
                })),
              })),
            }
          : prevEv,
      );
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/disputes/${disputeId}/attest-service`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`attest-service ${res.status}`);
        // S293 (#6) — an attestation adds/removes the service-not-rendered
        // clause spine → recompose the letter in this same action.
        scheduleReconcile({ refresh: true });
      } catch (err) {
        console.error("[attest-service] failed:", err);
        mutationGenRef.current += 1;
        setServiceAttestedLineIds(prev.ids);
        setServiceAttestationReviewed(prev.reviewed);
        setAttestingAsName(prev.name);
        setAttestationSource(prev.source);
        setEvidence(prev.evidence);
        scheduleReconcile();
      }
    },
    [
      user,
      disputeId,
      serviceAttestedLineIds,
      serviceAttestationReviewed,
      attestingAsName,
      attestationSource,
      evidence,
      scheduleReconcile,
    ],
  );

  // (S293 #5 — the per-line EvidenceBand map fed only the removed EvidenceBlock
  // sidebar; deleted with it.)

  // ?dispute=<id> flow — initial fetch.
  useEffect(() => {
    if (!disputeId || letter || !user) return;
    let cancelled = false;
    (async () => {
      setDisputeFetching(true);
      try {
        await fetchDispute(disputeId);
      } catch (err) {
        console.error("Failed to load persisted dispute letter:", err);
      }
      if (!cancelled) setDisputeFetching(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [disputeId, letter, user, fetchDispute]);

  // Phase 7: refetch-on-focus so newly-uploaded historical plans auto-update
  // the letter when the user tabs back.
  useEffect(() => {
    if (!disputeId || !user) return;
    const onFocus = () => {
      fetchDispute(disputeId).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [disputeId, user, fetchDispute]);

  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editedBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      if (textRef.current) {
        textRef.current.select();
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleDownload = () => {
    const blob = new Blob([editedBody], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `candid-dispute-letter-${letter?.letterType || "general"}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Stretch 2 — enriched PDF export via the Pro-gated evidence-package route.
  // Falls back to the legacy text file on any failure so the user always gets a
  // download. claimId is carried on letter.auditReportId (set from data.claimId).
  async function downloadEnrichedCaseFile() {
    if (!user || !letter) return;
    const claimId = letter.auditReportId;
    try {
      if (!claimId) throw new Error("no claimId");
      const idToken = await user.firebaseUser.getIdToken();
      const params = new URLSearchParams({ claimId, format: "pdf" });
      if (disputeId) params.set("disputeId", disputeId);
      const res = await fetch(`/api/legal/evidence-package?${params.toString()}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) throw new Error(`evidence-package ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `candid-case-file-${letter.letterType || "claim"}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      downloadCaseFile({ ...letter, body: editedBody });
    }
  }

  const handleDownloadCaseFile = () => {
    if (!letter) return;
    // Phase 3: warn-not-block when plan missing for claim year.
    // S111 smoke #4 — also skip the warning when the user has bound a
    // canonical OR explicitly accepted proxy, since either path addresses
    // the missing-plan gap (letter cites the bound canonical or current
    // plan as proxy, respectively).
    const missingYear = letter.missingPlanForYear ?? planContext?.missingForYear ?? null;
    const planGapAddressed = !!boundCanonicalPlan || userAcceptedProxy;
    if (missingYear && !planGapAddressed) {
      setDownloadWarnOpen(true);
      return;
    }
    // Stretch 2 — enriched PDF when the rollout flag is ON; legacy text otherwise.
    if (caseFileEnrichedEnabled) { void downloadEnrichedCaseFile(); return; }
    // Use the edited body so any user edits are included
    downloadCaseFile({ ...letter, body: editedBody });
  };

  const forceDownloadCaseFile = () => {
    if (!letter) return;
    setDownloadWarnOpen(false);
    if (caseFileEnrichedEnabled) { void downloadEnrichedCaseFile(); return; }
    downloadCaseFile({ ...letter, body: editedBody });
  };

  const handleConfirmAddress = async (insurerId: string) => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    await fetch(`/api/disputes/insurer-appeals/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ insurerId, action: "confirmed" }),
    });
    if (disputeId) await fetchDispute(disputeId);
  };

  // S71 hotfix #4 (Session 73) — Re-draft button. Calls the dedicated
  // /api/disputes/[disputeId]/redraft endpoint which re-resolves evidence,
  // runs CF-20 re-parse-on-flag against any no-cite per-service rows, then
  // regenerates the letter body via rerenderDisputeLetter. Use case: user
  // uploaded an additional plan document after the dispute was drafted, OR
  // wants to re-attempt cite-grade upgrade for a no-cite field whose
  // un-searched sections might now have available data.
  const [redrafting, setRedrafting] = useState(false);
  // S109 PR #2 — toast tracks kind so error cases (e.g., 3/24h rate limit
  // 429) render amber instead of success-green emerald.
  const [redraftToast, setRedraftToast] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  // Cost-Share v2 (W4) — user-initiated letter refresh (regenerate + version the
  // prior via ?refresh=1; the regenerated letter is no longer stale).
  const handleRefreshLetter = useCallback(async () => {
    if (!user || !disputeId || refreshingLetter) return;
    setRefreshingLetter(true);
    try {
      await fetchDispute(disputeId, { refresh: true });
    } catch (err) {
      console.error("Refresh letter failed:", err);
    } finally {
      setRefreshingLetter(false);
    }
  }, [user, disputeId, refreshingLetter, fetchDispute]);
  const handleRedraft = async () => {
    if (!user || !disputeId || redrafting) return;
    setRedrafting(true);
    setRedraftToast(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/${disputeId}/redraft`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `redraft failed (${res.status})`);
      }
      const data = await res.json();
      const upgrades = data?.cf20?.upgrades ?? 0;
      const targets = data?.cf20?.targets ?? 0;
      setRedraftToast({
        text: targets === 0
          ? "Letter re-drafted with current plan + evidence."
          : upgrades > 0
            ? `Letter re-drafted — ${upgrades} of ${targets} citation${targets === 1 ? "" : "s"} upgraded to cite-grade.`
            : `Letter re-drafted — ${targets} citation${targets === 1 ? "" : "s"} attempted; none upgraded this run.`,
        kind: "success",
      });
      await fetchDispute(disputeId);
    } catch (err) {
      setRedraftToast({
        text: err instanceof Error ? err.message : "Re-draft failed",
        kind: "error",
      });
    } finally {
      setRedrafting(false);
      setTimeout(() => setRedraftToast(null), 6000);
    }
  };

  // S74 — Mark-as-Sent button. POSTs to /api/disputes/outcome with status='filed'
  // (the lifecycle hop from `dispute_letter_drafted` → `filed` per persist.ts).
  // Once filed, T2.2 follow-up reminders fire on their schedule and the toolbar
  // button rotates to a read-only "Sent on <date>" pill.
  const alreadySent = isSentStatus(disputeStatus);
  const handleMarkSent = async () => {
    if (!user || !disputeId || markingSent || alreadySent) return;
    // Optimistic (S266) — flip status locally so the stage-action bar advances
    // instantly; reconcile in the background (rollback on failure). No confirm dialog
    // (undo covers a mis-click).
    const prevStatus = disputeStatus;
    mutationGenRef.current += 1;
    setDisputeStatus("filed");
    setMarkingSent(true);
    setMarkSentToast(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/outcome`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ disputeId, status: "filed" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `mark-sent failed (${res.status})`);
      }
      setMarkSentToast("Marked as sent. Follow-up reminders are scheduled.");
      void fetchDispute(disputeId);
    } catch (err) {
      setDisputeStatus(prevStatus);
      setMarkSentToast(err instanceof Error ? err.message : "Failed to mark as sent");
    } finally {
      setMarkingSent(false);
      setTimeout(() => setMarkSentToast(null), 6000);
    }
  };

  // Zone-3 (S266) — undo (clicked in error). Optimistic + background reconcile.
  const handleUndoSent = async () => {
    if (!user || !disputeId || !alreadySent) return;
    const prevStatus = disputeStatus;
    mutationGenRef.current += 1;
    setDisputeStatus("dispute_letter_drafted");
    setSuggestedNextStep(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ disputeId, status: "dispute_letter_drafted", clearSentAt: true, clearOutcomeDetail: true }),
      });
      if (!res.ok) throw new Error("undo failed");
      void fetchDispute(disputeId);
    } catch {
      setDisputeStatus(prevStatus);
      setMarkSentToast("Couldn't undo — please try again.");
      setTimeout(() => setMarkSentToast(null), 6000);
    }
  };

  const handleUndoOutcome = async () => {
    if (!user || !disputeId) return;
    const prevStatus = disputeStatus;
    mutationGenRef.current += 1;
    setDisputeStatus("filed");
    setSuggestedNextStep(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ disputeId, status: "filed", clearOutcomeDetail: true }),
      });
      if (!res.ok) throw new Error("undo failed");
      void fetchDispute(disputeId);
    } catch {
      setDisputeStatus(prevStatus);
      setOutcomeToast("Couldn't undo — please try again.");
      setTimeout(() => setOutcomeToast(null), 6000);
    }
  };

  // Zone-3 (S266) — user-triggered ladder advance. POST /escalate spawns the
  // next-rung letter as a new dispute row (server-side render) and we navigate to
  // it. A 403 means the escalation letter is Pro; other errors surface a toast.
  const handleEscalate = async (
    targetLetterType: "external_review" | "final_notice" | "debt_validation",
    extra: Record<string, unknown> = {},
  ) => {
    if (!user || !disputeId || escalating) return;
    setEscalating(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      if (!token) {
        setOutcomeToast("You are not signed in. Refresh and try again.");
        setTimeout(() => setOutcomeToast(null), 6000);
        return;
      }
      const res = await fetch(`/api/disputes/${disputeId}/escalate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ targetLetterType, ...extra }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const msg =
          res.status === 403
            ? "Escalation letters are a Candid Pro feature — your dispute letters are always free."
            : e.reason || e.error || "We couldn't create that letter. Please try again.";
        setOutcomeToast(msg);
        setTimeout(() => setOutcomeToast(null), 7000);
        return;
      }
      const data = await res.json();
      if (data?.disputeId) {
        // Navigate to the newly created next-rung dispute (each rung = its own row).
        window.location.href = `/disputes?dispute=${data.disputeId}`;
      }
    } catch {
      setOutcomeToast("We couldn't create that letter. Please try again.");
      setTimeout(() => setOutcomeToast(null), 7000);
    } finally {
      setEscalating(false);
    }
  };

  // Route the advisory next-rung CTA: external_review needs the exhaustion
  // attestation first; final_notice escalates directly (reciting the sent letter's
  // date as the prior contact). Reads suggestedNextStep from state to avoid
  // closure-narrowing on the nullable value.
  const handleSuggestedNextStep = () => {
    const sns = suggestedNextStep;
    if (!sns) return;
    if (sns.nextLetterType === "external_review") {
      setExhaustionModalOpen(true);
    } else if (sns.nextLetterType === "final_notice") {
      void handleEscalate("final_notice", {
        priorContactDates: disputeFiledDate ? [disputeFiledDate] : undefined,
        certifiedMail: true,
      });
    }
  };

  // Dispute Letters v2 (Z1.2) — Zone-1 inline saves (optimistic; refetch reconciles).
  const handleSaveAmountPaid = useCallback(
    async (amount: number | null) => {
      if (!user || !letter?.auditReportId) return;
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/claims/${letter.auditReportId}/cost-share-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ field: "patient_paid", amount }),
      });
      if (!res.ok) throw new Error("Failed to save amount paid");
      // Optimistic — reflect the value immediately + reconcile in the background so Save
      // doesn't block on the full dispute re-resolve (S265 Andrew feedback: saves felt slow).
      // S293 (#6) — refresh:1 so the letter's refund ask absorbs the confirmed
      // amount in this same action (the override is a recovery input the
      // composer reads; it is now also part of the evidence fingerprint).
      setUserPatientPaid(amount);
      // S295 — through the SHARED debounced reconcile instead of firing its own
      // immediate fetchDispute. An un-debounced reload racing the debounced one
      // is a real flicker vector: it lands mid-window, clears `pendingCostShare`
      // and overwrites `lineCostShare` with a payload from before the pending
      // write, so a just-typed plan cost disappears — and then reappears when
      // the debounced reconcile fires 1.2s later. One reconcile path, one paint.
      // The POST stays awaited: AmountEditor surfaces its error state off the
      // throw, so this must keep rejecting.
      scheduleReconcile({ refresh: true });
    },
    [user, letter?.auditReportId, scheduleReconcile],
  );
  const handleSaveDeadlineDate = useCallback(
    async (
      field: "denialNoticeDate" | "collectorFirstContactDate",
      value: string | null,
    ) => {
      if (!user || !disputeId) return;
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/${disputeId}/deadline-inputs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error("Failed to save date");
      // Optimistic + background reconcile (S265 Andrew feedback — don't block Save on refetch).
      // S295 — onto the shared debounced reconcile; see handleSaveAmountPaid for
      // why an immediate second fetch is a flicker vector. DateEditor reads its
      // error state off the throw, so the POST stays awaited.
      setDeadlineInputs((prev) => ({ ...prev, [field]: value }));
      scheduleReconcile();
    },
    [user, disputeId, scheduleReconcile],
  );

  // ── S292 (#8) — batched/optimistic service-cost saves ────────────────────────
  // A burst of plan-cost saves (modal or aggregate confirm) updates the panel
  // instantly via `pendingCostShare` (in-flight targets only; server truth wins on
  // reconcile — the ClaimDetail svcPendingConfirm idiom) and coalesces into ONE
  // reconcile refetch (scheduleReconcile — declared up by fetchDispute since
  // S293 #13 put the identity/attestation handlers on the same machinery)
  // instead of one full dispute re-resolve per save.

  /** Optimistic target for one service's plan cost + the single reconcile. */
  const applyOptimisticCostShare = useCallback(
    (serviceSlug: string, values: { copay: number | null; coinsurancePercent: number | null }) => {
      mutationGenRef.current += 1; // a stale in-flight reload must not clobber this
      setPendingCostShare((prev) => {
        const next = new Map(prev);
        next.set(serviceSlug, values);
        return next;
      });
      scheduleReconcile();
    },
    [scheduleReconcile],
  );

  // ── S292 (#7) — the ONE aggregate "looks right?" confirm ────────────────────
  // Fans out the EXISTING per-line confirm-coverage write (the recorded human
  // glance) for every parser-extracted plan cost, then ONE reconcile refetch.
  // Confirmed secondary borrows become citable (S154 confirmed branch) → the
  // letter absorbs them on its next render.
  const handleConfirmParsedCosts = useCallback(
    async (services: PlanCostService[]) => {
      if (!user || !letter?.auditReportId) return;
      const claimId = letter.auditReportId;
      const lineIds = Array.from(
        new Set(services.flatMap((s) => s.lineItemIds ?? [])),
      );
      if (lineIds.length === 0) return;
      // S295 — PAINT FIRST, exactly the handleAttestServices idiom this call is
      // fired alongside (CaseNeedsPanel's confirmDetails runs both). It used to
      // await one confirm-coverage round-trip PER LINE before flipping anything,
      // and each of those does ~5 DB round-trips server-side (users → claim
      // ownership → selectOwnedChildren over ALL the claim's lines →
      // updateOwnedChildren). On a 6-line bill that is 6 × 5 sequential DB hops
      // the user waits on with the button stuck at "Saving…" — the slow
      // "These look right". Now the rows flip in the click's own render, the
      // writes run in the background, and a failure snaps everything back.
      //
      // Consequence, deliberate: this no longer REJECTS (same contract as
      // handleAttestServices / handleResolvePatientIdentity). The snap-back IS
      // the failure signal — the block returns to its unconfirmed state.
      const prevRows = lineCostShare;
      mutationGenRef.current += 1;
      const confirmedIds = new Set(lineIds);
      setLineCostShare((prev) =>
        prev.map((r) =>
          confirmedIds.has(r.lineItemId) ? { ...r, humanReviewed: true, confirmed: true } : r,
        ),
      );
      try {
        const token = await user.firebaseUser.getIdToken();
        const results = await Promise.allSettled(
          lineIds.map((lineItemId) =>
            fetch(`/api/claims/${claimId}/line-items/${lineItemId}/confirm-coverage`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ decision: "match" }),
            }).then((r) => {
              if (!r.ok) throw new Error(`confirm-coverage ${r.status}`);
            }),
          ),
        );
        if (results.some((r) => r.status === "rejected")) {
          throw new Error("confirm failed");
        }
        // S293 (#6) — refresh:true so the SAME action recomposes the letter: the
        // confirmed values become citations (clauses) in this reconcile, not on a
        // hypothetical "next render" (dispute 80a705ac shipped zero clauses
        // because nothing ever scheduled that render).
        scheduleReconcile({ refresh: true });
      } catch (err) {
        console.error("[confirm-coverage] failed:", err);
        mutationGenRef.current += 1;
        setLineCostShare(prevRows);
        scheduleReconcile();
      }
    },
    [user, letter?.auditReportId, lineCostShare, scheduleReconcile],
  );

  /** S292 (#7) — per-item "Doesn't match" on a secondary-borrowed value. */
  const handleRejectParsedCost = useCallback(
    async (svc: PlanCostService) => {
      if (!user || !letter?.auditReportId) return;
      const claimId = letter.auditReportId;
      const lineIds = svc.lineItemIds ?? [];
      if (lineIds.length === 0) return;
      // S295 — same paint-first treatment as its confirm twin, plus the writes
      // now run CONCURRENTLY: this was a sequential for-loop, so a service
      // spanning k lines cost k serial round-trips before the row moved. Both
      // call sites already fire this with `void` (no throw contract to keep).
      const prevRows = lineCostShare;
      mutationGenRef.current += 1;
      const rejectedIds = new Set(lineIds);
      setLineCostShare((prev) =>
        prev.map((r) =>
          rejectedIds.has(r.lineItemId)
            ? { ...r, known: false, humanReviewed: false, confirmed: false, rejected: true }
            : r,
        ),
      );
      try {
        const token = await user.firebaseUser.getIdToken();
        const results = await Promise.allSettled(
          lineIds.map((lineItemId) =>
            fetch(`/api/claims/${claimId}/line-items/${lineItemId}/confirm-coverage`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ decision: "no_match" }),
            }).then((r) => {
              if (!r.ok) throw new Error(`confirm-coverage ${r.status}`);
            }),
          ),
        );
        if (results.some((r) => r.status === "rejected")) {
          throw new Error("reject failed");
        }
        // S293 (#6) — a rejection EXCLUDES a citation → recompose in this action.
        scheduleReconcile({ refresh: true });
      } catch (err) {
        console.error("[confirm-coverage no_match] failed:", err);
        mutationGenRef.current += 1;
        setLineCostShare(prevRows);
        scheduleReconcile();
      }
    },
    [user, letter?.auditReportId, lineCostShare, scheduleReconcile],
  );

  // Unified case timeline (S286) — persist a checklist check-off. Optimistic
  // local update; fire-and-forget POST (a lost write only regresses a cosmetic
  // check on next load, never blocks the flow).
  const handlePersistCheck = useCallback(
    (key: string, done: boolean) => {
      setChecklist((prev) => ({ ...prev, [key]: done }));
      if (!user || !disputeId) return;
      void (async () => {
        try {
          const token = await user.firebaseUser.getIdToken();
          await fetch(`/api/disputes/${disputeId}/checklist`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ key, done }),
          });
        } catch (err) {
          console.error("[dispute-checklist] persist failed:", err);
        }
      })();
    },
    [user, disputeId],
  );

  // S74 — InsurerAddressCorrectionModal callbacks. (S265 Z1 refine d — the recipient card
  // no longer proposes corrections; Zone-1's onAddInsurerAddress opens the modal directly.)
  const refetchAfterChange = async () => {
    if (disputeId) await fetchDispute(disputeId);
  };

  if (!letter) {
    if (disputeFetching) {
      // S132 iter-8 — unified cube loader.
      return <CubeLoaderBuilding />;
    }
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Dispute Letters</h1>
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-6xl mb-4">📝</div>
          <h2 className="text-xl font-semibold mb-2">No letter generated yet</h2>
          <p className="text-gray-600 mb-4">
            Run an{" "}
            <a href="/audit" className="text-blue-600 hover:underline">
              audit on your bill
            </a>{" "}
            first, then select findings to generate a dispute letter.
          </p>
          <p className="text-gray-500 text-sm">
            You can also request an itemized bill without an audit.
          </p>
          <RequestItemizedBill />
        </div>
      </div>
    );
  }

  // B-LOAD.1 (S131): during Re-draft, replace letter content with Audit flow
  // loader per Andrew direction ("waiting for a dispute letter to be created and
  // load → audit loading page"). Page chrome + sidebar from (app)/layout.tsx
  // stay visible. Existing redraftToast pattern preserved for outcome surfacing.
  if (redrafting) {
    // S132 iter-8 — unified cube loader.
    return <CubeLoaderBuilding />;
  }

  const missingYear = letter.missingPlanForYear ?? planContext?.missingForYear ?? null;
  const planLabel = planContext?.plan?.planName
    ? `${planContext.plan.planName}${planContext.plan.planYear ? `, ${planContext.plan.planYear}` : ""}`
    : null;
  const providerName = evidence?.claims?.[0]?.providerName ?? null;
  const serviceDate = evidence?.claims?.[0]?.dateOfService ?? letter.createdAt;
  const potentialRecovery = evidence?.totals?.totalDiscrepancy ?? null;
  const letterTypeLabel = LETTER_TYPE_LABELS[letter.letterType] ?? letter.letterType;

  const shortRef = letter.id.slice(0, 8).toUpperCase();

  // ===================================================================
  // Block C node extraction. Each middle section is defined once as a
  // node, then arranged two ways below and branched on `v3DesignOn`:
  //   - flag OFF → the OLD single-column order (byte-identical to before;
  //     heroNode gets strength=undefined so the hero is unchanged).
  //   - flag ON  → the v3 two-column reskin (letter-stack + rail) with the
  //     three strength readouts (data-trust banner / evidence band in the
  //     hero / readiness rail).
  // Single source per node — no forked wiring, no duplicated handlers.
  // ===================================================================

  // Readout 1 (data-trust banner) — v3-only. (Readout 3, the readiness rail, was retired
  // at S265: the unified readiness indicator now lives at the top of Zone-1's CaseNeedsPanel,
  // combining the required-to-send floor with the soft strengtheners — one signal, not two.)
  const dataTrustBannerNode = <DataTrustBanner dataTrust={strength?.dataTrust} />;

  const heroNode = (
    <DisputeLetterHero
      letter={letter}
      providerName={providerName}
      serviceDate={serviceDate}
      askSummary={buildAskSummary(letter, potentialRecovery)}
      potentialRecovery={potentialRecovery}
      evidence={evidence}
      // Readout 2 (evidence band) — only fed in v3 so the OLD hero is unchanged.
      strength={v3DesignOn ? strength : undefined}
      onRedraft={handleRedraft}
      redraftInFlight={redrafting}
      // Item 3 — band chip becomes a button only when the band is shown (v3 + strength).
      onBandClick={v3DesignOn && strength ? () => setEvidenceModalOpen(true) : undefined}
    />
  );

  // Cost-Share v2 (W4 / Finding 4) — letter-page staleness banner. The /claim
  // card routes users here to act. Full banner = Refresh letter / Keep as-is;
  // "Keep as-is" collapses to a small re-openable "May need update" tag so the
  // warning is never fully hidden. Only present when the backend reports isStale
  // (flag ON).
  const staleBannerNode = isStale ? (
    staleBannerCollapsed ? (
      <button
        type="button"
        onClick={() => setStaleBannerCollapsed(false)}
        className="inline-flex items-center gap-1 self-start rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-200"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
        May need update
      </button>
    ) : (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs leading-relaxed text-amber-900">
          Your plan details changed since this was drafted — based on your current plan details, this
          charge may now be correct. We&apos;ve kept your draft; refresh it to match your latest info,
          or keep it as-is.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleRefreshLetter}
            disabled={refreshingLetter}
            className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {refreshingLetter ? "Refreshing…" : "Refresh letter"}
          </button>
          <button
            type="button"
            onClick={() => setStaleBannerCollapsed(true)}
            className="rounded border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
          >
            Keep as-is
          </button>
        </div>
      </div>
    )
  ) : null;

  // §18.10.D — the "confirm to strengthen + rebuild" prompt. Present only when the deductible-
  // aware letter omitted a precise dollar AND there are user-fixable inputs. Confirming writes
  // the same cost-share overrides the claim page uses; Rebuild reuses handleRefreshLetter
  // (GET ?refresh=1 → re-resolves the basis with the new overrides → precise figure).
  const strengthenPromptNode =
    strengthenLetter?.weakened && strengthenLetter.fields.length > 0 && letter?.auditReportId ? (
      <StrengthenLetterPrompt
        claimId={letter.auditReportId}
        fields={strengthenLetter.fields}
        getToken={async () => {
          const t = await getAuthToken();
          if (!t) throw new Error("no auth token");
          return t;
        }}
        onRebuild={handleRefreshLetter}
        rebuilding={refreshingLetter}
        collapsed={strengthenCollapsed}
        onToggleCollapsed={setStrengthenCollapsed}
      />
    ) : null;

  const recipientNode = (
    <DisputeRecipientCard
      recipient={letter.recipient}
      insurer={planContext?.insurer ?? null}
      requestedAction={letter.requestedAction}
      letterTypeLabel={letterTypeLabel}
      planYear={planContext?.plan?.planYear ?? null}
      referenceId={letter.id}
      onConfirmAddress={handleConfirmAddress}
      // S265 (Z1 refine d) — the recipient card is display-only for the address now.
      // Zone-1's "Insurer appeals address" row owns Add + Edit (same modal), so the card
      // no longer duplicates them; it keeps only the lightweight "Looks right" confirm for a
      // parsed-but-unconfirmed appeals address (Zone-1 has no confirm equivalent).
      onProposeCorrection={undefined}
      allowAddressEdit={false}
    />
  );

  // S293 (#5, Andrew) — evidenceNode ("Why this should be covered", EvidenceBlock)
  // removed with the sidebar; the attestation flow it hosted moved into the
  // claim-details block in CaseNeedsPanel (same anchor id, same onAttest).

  // S265 — coverage-verify + re-run-audit moved from the retired EvidenceGaps card into Zone-1.
  // S293 (#13) — the row clears right after the POST lands (either decision
  // resolves the gap) with ONE debounced reconcile, instead of pinning the
  // control on "Saving…" through a full dispute re-resolve. Still THROWS on
  // failure — CoverageVerifyControl's own error state is the surface here, and
  // nothing was dropped optimistically before the write.
  const handleCoverageVerify = async (
    claimId: string,
    lineItemId: string,
    decision: "match" | "no_match",
  ) => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch(
      `/api/claims/${claimId}/line-items/${lineItemId}/confirm-coverage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision }),
      },
    );
    if (!res.ok) throw new Error("confirm-coverage failed");
    mutationGenRef.current += 1;
    setEvidence((prevEv) =>
      prevEv
        ? {
            ...prevEv,
            gaps: (prevEv.gaps ?? []).filter(
              (g) =>
                !(
                  g.kind === "service_coverage_verify" &&
                  g.claimId === claimId &&
                  g.lineItemId === lineItemId
                ),
            ),
          }
        : prevEv,
    );
    // S293 (#6) — a match confirm turns a verify-gate into a citation (and a
    // no_match excludes it) → the letter must recompose in this same action.
    scheduleReconcile({ refresh: true });
  };
  const handleAuditRerun = async () => {
    if (!user || !disputeId) return;
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch(`/api/disputes/${disputeId}/rerun-audit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("rerun-audit failed");
    await fetchDispute(disputeId);
  };

  // Z1.3 — name-mismatch banner removed; Zone-1's "Verify the patient name" row now owns
  // the confirm/edit actions + surfaces the bill-vs-account detail inline.

  const toolbarNode = (
    <div className="sticky top-4 z-10 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/70">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {letterTypeLabel}
          </div>
          <div className="truncate text-sm font-semibold text-slate-900">
            Formal appeal · Ref {shortRef}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToolbarButton
            onClick={() => setIsEditing(!isEditing)}
            icon={isEditing ? "preview" : "edit"}
            label={isEditing ? "Preview" : "Edit"}
          />
          <ToolbarButton
            onClick={handleRedraft}
            icon="redraft"
            label={redrafting ? "Re-drafting…" : "Re-draft"}
          />
          <ToolbarButton
            onClick={handleCopy}
            icon="copy"
            label={copied ? "Copied" : "Copy"}
            tone={copied ? "success" : "default"}
          />
          <ToolbarButton
            onClick={handleDownload}
            icon="letter"
            label="Download letter"
          />
          {/* Zone-3 (S266) — case ACTIONS (Mark as sent / Report result / escalate) moved
              to the stage-action bar in "The case" timeline. The toolbar keeps letter
              actions + this at-a-glance sent-status pill. */}
          {alreadySent ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
              <SentCheckIcon />
              {/* S286 — prefer sent_at (real send) over filed_date (draft time). */}
              Sent{(disputeSentAt ?? disputeFiledDate) ? ` ${formatFiledDate((disputeSentAt ?? disputeFiledDate) as string)}` : ""}
            </span>
          ) : null}
        </div>
      </div>
      {redraftToast && (
        <div
          className={`mt-2 rounded-md px-3 py-2 text-xs ${
            redraftToast.kind === "error"
              ? "bg-amber-50 text-amber-800"
              : "bg-emerald-50 text-emerald-800"
          }`}
        >
          {redraftToast.text}
        </div>
      )}
      {markSentToast && (
        <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {markSentToast}
        </div>
      )}
      {outcomeToast && (
        <div className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {outcomeToast}
        </div>
      )}
    </div>
  );

  // S293 (#3) — while the letter's REQUIRED inputs are still missing, the
  // preview must read as pending, not as a finished letter that happens to be
  // incomplete. The signal is the SAME server-computed readiness floor the
  // needs panel's "Not ready to send" pill reads (strength.readiness — one
  // derivation, the two surfaces cannot disagree); null readiness (legacy /
  // flag-off payloads) → no treatment, and a sent letter is never dimmed.
  // Visuals reuse the LockedOverlay dim recipe (blur + opacity + inert), the
  // codebase's canonical "present but not usable yet" treatment.
  const letterPending =
    strength?.readiness?.state === "attention" && !alreadySent;

  const articleNode = (
    <article id="dispute-letter-article" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {isEditing ? (
        <div className="relative">
          <div className="absolute right-4 top-3 text-[11px] font-medium text-slate-400">
            Saved · just now
          </div>
          <textarea
            ref={textRef}
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            className="block w-full resize-y bg-transparent px-10 py-12 font-serif text-[15px] leading-[1.7] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-300/60"
            style={{ minHeight: 620 }}
          />
        </div>
      ) : letterPending ? (
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none select-none whitespace-pre-wrap px-10 py-12 font-serif text-[15px] leading-[1.7] text-slate-900 opacity-40 blur-[2px] md:px-14 md:py-14"
          >
            {editedBody}
          </div>
          <div className="absolute inset-0 flex items-start justify-center px-4 pt-12 sm:pt-16">
            {/* TODO(copy — Andrew approval): both strings below are NEW copy
                (from the S293 brief's example wording). Swap here if the
                approved phrasing differs. */}
            <div className="rounded-xl border border-amber-200 bg-amber-50/95 px-4 py-3 text-center shadow-sm">
              <p className="text-[13px] font-semibold text-amber-900">Waiting on your answers above</p>
              <p className="mt-0.5 text-[12px] text-amber-800">
                This draft updates as you answer — finish the items above to complete it.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap px-10 py-12 font-serif text-[15px] leading-[1.7] text-slate-900 md:px-14 md:py-14">
          {editedBody}
        </div>
      )}
      {letter.legalBasis ? (
        <div className="border-t border-slate-100 px-10 py-3 text-xs text-slate-500 md:px-14">
          Legal basis referenced: <span className="text-slate-700">{letter.legalBasis}</span>
        </div>
      ) : null}
      {/* Surface 4 — letter footer bar (v3 only): download + "I've sent this"
          sharing the same sent state as the UnifiedTodo. No draft lock —
          editing stays available post-send (existing behavior preserved). */}
      {v3DesignOn && (
        <div className="border-t border-slate-100 bg-slate-50/50 px-6 py-4 md:px-8">
          {alreadySent ? (
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
                <SentCheckIcon />
                Marked as sent{(disputeSentAt ?? disputeFiledDate) ? ` · ${formatFiledDate((disputeSentAt ?? disputeFiledDate) as string)}` : ""}
              </span>
              <span>Track the response and report the outcome in &ldquo;The case&rdquo; above.</span>
            </div>
          ) : footerConfirming ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-slate-600">
                <strong className="font-semibold text-slate-900">Did you actually mail it?</strong>{" "}
                Confirming starts the response clock and your follow-up reminders.
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFooterConfirming(false)}
                  className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Not yet
                </button>
                <button
                  type="button"
                  disabled={markingSent}
                  onClick={() => {
                    setFooterConfirming(false);
                    handleMarkSent();
                  }}
                  className="rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {markingSent ? "Saving…" : "Yes — start the clock"}
                </button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-500">
                Send by certified mail (USPS Form 3811) so you keep a paper trail.
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Download letter
                </button>
                <button
                  type="button"
                  onClick={() => setFooterConfirming(true)}
                  className="rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700"
                >
                  I&rsquo;ve sent this
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </article>
  );

  const nextStepsNode = (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-7">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            What to do next
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Five steps once your letter looks right. Download the full Case File below.
          </p>
        </div>
      </div>
      <ol className="mt-5 space-y-3.5 text-sm text-slate-700">
        <NextStep n={1} title="Review the letter" body="Scan above and make any edits you want before downloading." />
        <NextStep n={2} title="Send by certified mail" body="Use USPS Form 3811 (return receipt requested) so you have a paper trail." />
        <NextStep n={3} title="Keep your copy" body="File the signed letter and the downloaded Case File with your records." />
        <NextStep n={4} title="Follow up in 30 days" body="Most insurers must respond within 30 days. If they don't, call to escalate." />
        <NextStep
          n={5}
          title="Escalate if unresolved"
          body={
            <>
              Contact your state Insurance Commissioner or a healthcare attorney. Track outcomes on the{" "}
              <a href="/claim" className="font-medium text-blue-600 underline-offset-2 hover:underline">
                Claims page
              </a>{" "}
              so Candid can improve for everyone.
            </>
          }
        />
      </ol>
    </section>
  );

  const caseFileNode = (
    <section className="@container rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-6 shadow-sm md:p-7">
      <div className="flex flex-col gap-4 @md:flex-row @md:items-center @md:justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">Download your full Case File</h3>
          <p className="mt-1 text-sm text-slate-600">
            Dispute letter, audit findings, evidence log, follow-up checklist, and escalation guide — one styled PDF.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDownloadCaseFile}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow"
        >
          <ToolbarIcon name="casefile" />
          Download Case File
        </button>
      </div>
    </section>
  );

  // Zone-3 (S266) — the "Did you hear back?" tracking (Got a response / Sent to
  // collections / escalate CTA) is now the stage-action bar at the bottom of the
  // "The case" timeline (CaseSummary), driven by computeCaseStage. See the
  // <CaseSummary> render below.

  // Dispute Letters v2 (Z1.2) — Zone-1 panel inputs.
  //
  // S292 (#7) — plan-cost rows come from the CLAIM PAGE'S OWN cost-share
  // resolution (server `lineCostShare`, the shared resolveLineCostShare recipe),
  // not the letter-citation loader: anything the claim page already resolved
  // (exact SBC row, secondary category match, ACA preventive) arrives prefilled;
  // human-reviewed values (manual entry / confirmed) arrive DONE; only services
  // the platform genuinely can't resolve remain asks. Falls back to the legacy
  // evidence-derived rows when the server payload is absent (flag OFF).
  const zone1Services: PlanCostService[] = (() => {
    // slug → display name from evidence (the panel's existing label source).
    const nameBySlug = new Map<string, string>();
    for (const c of evidence?.claims ?? []) {
      for (const li of c.lineItemEvidence ?? []) {
        if (li.serviceSlug && !nameBySlug.has(li.serviceSlug)) {
          nameBySlug.set(li.serviceSlug, li.serviceName);
        }
      }
    }

    // S293 (#5) — per-line billed amounts from evidence, summed per service for
    // the one-block claim-details list.
    const billedByLineId = new Map<string, number>();
    for (const c of evidence?.claims ?? []) {
      for (const li of c.lineItemEvidence ?? []) {
        billedByLineId.set(li.lineItemId, li.billedAmount ?? 0);
      }
    }

    if (lineCostShare.length > 0) {
      const bySlug = new Map<string, LineCostShareRow[]>();
      for (const r of lineCostShare) {
        if (!r.serviceSlug) continue;
        const arr = bySlug.get(r.serviceSlug) ?? [];
        arr.push(r);
        bySlug.set(r.serviceSlug, arr);
      }
      const out: PlanCostService[] = [];
      for (const [slug, rows] of bySlug) {
        const pending = pendingCostShare.get(slug);
        // A rejected secondary borrow is NOT known (the user said the match is
        // wrong) — the ask returns until a manual value lands.
        const live = rows.filter((r) => !(r.rejected && !r.humanReviewed));
        const knownRow = live.find((r) => r.known) ?? null;
        const known = pending != null || knownRow != null;
        out.push({
          serviceSlug: slug,
          serviceLabel: nameBySlug.get(slug) ?? rows[0]?.description ?? slug.replace(/_/g, " "),
          known,
          copay: pending ? pending.copay : knownRow?.copay ?? null,
          coinsurancePercent: pending
            ? pending.coinsurancePercent
            : knownRow?.coinsurancePercent ?? null,
          source: pending ? "manual" : knownRow?.source ?? null,
          // pending (just typed) counts as human-reviewed; otherwise every known
          // line must be human-reviewed for the DONE bucket.
          humanReviewed:
            pending != null || (knownRow != null && live.filter((r) => r.known).every((r) => r.humanReviewed)),
          lineItemIds: rows.map((r) => r.lineItemId),
          claimId: letter?.auditReportId ?? null,
          secondaryMatchedSlug: knownRow?.secondaryMatchedSlug ?? null,
          billedAmount: rows.reduce((s, r) => s + (billedByLineId.get(r.lineItemId) ?? 0), 0),
        });
      }
      return out;
    }

    // Legacy fallback — evidence planBenefit (pre-S292 shape; known → DONE).
    const seen = new Set<string>();
    const out: PlanCostService[] = [];
    for (const c of evidence?.claims ?? []) {
      for (const li of c.lineItemEvidence ?? []) {
        if (!li.serviceSlug || seen.has(li.serviceSlug)) continue;
        seen.add(li.serviceSlug);
        const pb = li.planBenefit;
        const pending = pendingCostShare.get(li.serviceSlug);
        out.push({
          serviceSlug: li.serviceSlug,
          serviceLabel: li.serviceName,
          known: pending != null || pb != null,
          copay: pending ? pending.copay : pb?.copay ?? null,
          coinsurancePercent: pending
            ? pending.coinsurancePercent
            : pb?.coinsurance != null
              ? Math.round(pb.coinsurance * 100)
              : null,
          source: pending ? "manual" : pb?.source ?? null,
        });
      }
    }
    return out;
  })();

  // S292 (#9) — the bill's parsed amount-paid for the one-click confirm prefill
  // (evidence effectiveTotals: per-line sum when cite-grade, claim header otherwise).
  const zone1BillPatientPaid = (() => {
    let sum = 0;
    for (const c of evidence?.claims ?? []) {
      sum += c.effectiveTotals?.patientPaid ?? 0;
    }
    return sum > 0 ? Math.round(sum * 100) / 100 : null;
  })();
  const zone1ProviderAddressOnFile = planContext?.providerContact?.address != null;
  const zone1HasInsurer = planContext?.insurer != null;
  const zone1InsurerAddressOnFile = planContext?.insurer?.appealsAddress != null;
  const zone1EobPresent = (evidence?.claims ?? []).some((c) =>
    (c.lineItemEvidence ?? []).some((li) => li.insurancePaid != null || li.patientOwes != null),
  );
  // Insurance row shows only when a plan is bound (a missing-year claim is owned by
  // VerifStrip); the Change action is available only when re-pinning is enabled.
  const zone1ShowInsuranceRow = planContext?.plan != null;
  // S265 — service_coverage_verify gates + audit-findings-missing signal for Zone-1
  // (absorbed from the retired EvidenceGaps card).
  const coverageVerifyGaps = (evidence?.gaps ?? [])
    .filter((g) => g.kind === "service_coverage_verify" && g.claimId && g.lineItemId)
    .map((g) => ({
      claimId: g.claimId as string,
      lineItemId: g.lineItemId as string,
      matchedServiceName: g.matchedServiceName ?? "this service",
      description: g.description ?? "",
    }));
  const auditFindingsMissing = (evidence?.gaps ?? []).some(
    (g) => g.kind === "audit_findings_missing",
  );

  // ── Surface 4 (clarity redesign) — node consts shared by both layouts ─────
  // Zone-1 panel: standalone card in the legacy layout; embedded (chromeless,
  // one combined card) inside the UnifiedTodo claim-details expansion in v3.
  const renderCaseNeedsPanel = (embedded: boolean) => (
    <CaseNeedsPanel
      embedded={embedded}
      letterType={letter.letterType}
      planServices={zone1Services}
      nameMismatch={nameMismatch != null}
      nameResolved={patientIdentityResolved}
      billName={nameMismatch?.billName ?? null}
      profileName={nameMismatch?.profileName ?? null}
      attestationReviewed={serviceAttestationReviewed}
      attestationSource={attestationSource}
      hasInsurer={zone1HasInsurer}
      providerAddressOnFile={zone1ProviderAddressOnFile}
      insurerAddressOnFile={zone1InsurerAddressOnFile}
      eobPresent={zone1EobPresent}
      userPatientPaid={userPatientPaid}
      billPatientPaid={zone1BillPatientPaid}
      denialNoticeDate={deadlineInputs.denialNoticeDate}
      denialDatePrefill={denialDatePrefill}
      collectorFirstContactDate={deadlineInputs.collectorFirstContactDate}
      planLabel={planLabel}
      showInsuranceRow={zone1ShowInsuranceRow}
      canChangePlan={planPinningEnabled}
      readiness={strength?.readiness ?? null}
      coverageVerifyGaps={coverageVerifyGaps}
      onCoverageVerify={handleCoverageVerify}
      rerunAuditEnabled={false}
      auditFindingsMissing={auditFindingsMissing}
      onAuditRerun={handleAuditRerun}
      onConfirmParsedCosts={handleConfirmParsedCosts}
      onRejectParsedCost={handleRejectParsedCost}
      // S293 (#5) — the ONE claim-details block's inputs. Present only on the
      // v3 path (mirrors the removed sidebar's own onAttest gate); absent →
      // the panel falls back to the per-item confirmation rows.
      claimFacts={
        v3DesignOn
          ? {
              patientName: (nameMismatch?.billName ?? nameMismatch?.profileName ?? accountName) || null,
              providerName: evidence?.claims?.[0]?.providerName ?? null,
              serviceDate: evidence?.claims?.[0]?.dateOfService ?? null,
            }
          : null
      }
      attestationLines={
        v3DesignOn
          ? (evidence?.claims ?? []).flatMap((c) =>
              (c.lineItemEvidence ?? []).map((li) => ({
                lineItemId: li.lineItemId,
                serviceName: li.serviceName,
                codeLabel: li.billingCode ? `${li.billingCode.type} ${li.billingCode.value}` : null,
                billedAmount: li.billedAmount ?? 0,
              })),
            )
          : undefined
      }
      attestedLineItemIds={serviceAttestedLineIds}
      accountName={accountName}
      attestingAsName={attestingAsName}
      onAttest={disputeId && v3DesignOn ? handleAttestServices : undefined}
      onAddPlanDetails={(svc) =>
        setAddPlanModal({
          serviceSlug: svc.serviceSlug,
          serviceLabel: svc.serviceLabel,
          initialCopay: svc.copay,
          initialCoinsurancePercent: svc.coinsurancePercent,
        })
      }
      onResolvePatient={resolvePatientChoice}
      onEditLetter={() => setIsEditing(true)}
      onReviewAttestation={() => {
        // S293 (#11) — jump to the attestation STEP, not the evidence card.
        // The old target (#dispute-evidence with block:"center") centered a
        // card that is usually TALLER than its scrollport: centering a
        // too-tall element aligns its MIDDLE, which pushes its top — where the
        // "Were all of these services actually performed?" gate sits — out of
        // view. In the v3 layout the card also lives inside the sticky rail's
        // own overflow scroller, so the overshoot happened inside the rail.
        // The step itself is small, so centering it lands the whole question
        // on screen in both scrollers. Fallback (flag OFF / read-only letters
        // where the flow isn't mounted): align the card's START so its top —
        // where content begins — is what the user sees.
        const step = document.getElementById("dispute-service-attestation");
        if (step) {
          step.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          document
            .getElementById("dispute-evidence")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }}
      onAddProviderAddress={() => setProviderAddressOpen(true)}
      onAddInsurerAddress={() => setInsurerCorrectionOpen(true)}
      onUploadEob={() => window.location.assign("/upload")}
      onSaveAmountPaid={handleSaveAmountPaid}
      onChangePlan={async () => {
        if (!user || !planContext?.plan?.planYear) return;
        const token = await user.firebaseUser.getIdToken();
        const qp = new URLSearchParams({ year: String(planContext.plan.planYear) });
        if (planContext.plan.id) qp.set("pin", planContext.plan.id);
        const res = await fetch(`/api/plan/by-year?${qp.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const { plans } = (await res.json()) as { plans: DisputePlanChooserPlan[] };
          setRebindPlans(plans ?? []);
          setRebindOpen(true);
        }
      }}
      onSaveDeadlineDate={handleSaveDeadlineDate}
    />
  );

  // Zone-2 "The case" — status/outcome tracker (deadline countdown, timeline,
  // Mark as sent / Report the result / collections / escalation / undo). In v3
  // it sits directly under the UnifiedTodo (Option A: always visible).
  const caseSummaryNode = (
    <CaseSummary
      letterType={letter.letterType}
      status={disputeStatus}
      isSent={alreadySent}
      filedDate={disputeFiledDate}
      recoveryAmount={amountDisputed}
      deadlineWarning={deadlineData?.deadlineWarning ?? null}
      governingDeadlineDate={deadlineData?.governingDeadlineDate ?? null}
      deadlineType={deadlineData?.deadlineType ?? null}
      filingDeadlineDate={deadlineData?.filingDeadlineDate ?? null}
      followups={deadlineData?.followups ?? []}
      followupPlan={deadlineData?.followupPlan ?? []}
      onMarkSent={handleMarkSent}
      onReportOutcome={() => setOutcomeModalOpen(true)}
      onCollections={() => setCollectorModalOpen(true)}
      onEscalateNext={handleSuggestedNextStep}
      onUndoSent={handleUndoSent}
      onUndoOutcome={handleUndoOutcome}
      markingSent={markingSent}
      escalating={escalating}
      nextStepLabel={suggestedNextStep?.ctaLabel ?? null}
    />
  );

  // "What you need to do" — the v3 unified case timeline (S286): checklist +
  // real after-sent schedule + the claim's letter ladder in ONE spine. The
  // claim-details expansion embeds the real CaseNeedsPanel (children).
  //
  // Dates: sent_at preferred over filed_date everywhere (filed_date is set at
  // DRAFT time — it's why letters showed "Sent Jun 2" when the user actually
  // marked sent Jul 17). The +30d response fallback anchors to the same value.
  const sentAnchorIso = disputeSentAt ?? disputeFiledDate;
  const sentDateLabel = sentAnchorIso ? formatFiledDate(sentAnchorIso) : null;
  const responseDueLabel = deadlineData?.governingDeadlineDate
    ? formatFiledDate(deadlineData.governingDeadlineDate)
    : sentAnchorIso
      ? formatFiledDate(
          new Date(new Date(sentAnchorIso).getTime() + 30 * 86400000)
            .toISOString()
            .slice(0, 10),
        )
      : null;

  // The claim's ladder → CaseLetterSummary[] (segments render only for
  // multi-letter cases; single-letter/no-claim disputes degrade to []).
  const caseLetters: CaseLetterSummary[] = (() => {
    if (!disputeId || siblings.length <= 1) return [];
    return siblings.map((s, i) => {
      const term = SIBLING_TERMINAL.has(s.status ?? "");
      const sentish = isSentStatus(s.status);
      const sentIso = s.sentAt ?? s.filedDate;
      const outcomeWord = OUTCOME_WORDS[s.status ?? ""] ?? null;
      const resLabel = s.resolutionDate ? formatFiledDate(s.resolutionDate) : null;
      return {
        id: s.id,
        ordinal: i + 1,
        label:
          LETTER_TYPE_LABELS[s.letterType as DisputeLetter["letterType"]] ?? s.letterType,
        viewed: s.id === disputeId,
        latest: i === siblings.length - 1,
        sentDateLabel: sentish && sentIso ? formatFiledDate(sentIso) : null,
        // Approved pattern (2026-07-18): "closed — {outcome} {date}".
        statusLine:
          term && outcomeWord
            ? `closed — ${outcomeWord}${resLabel ? ` ${resLabel}` : ""}`
            : null,
        outcomeWord,
        live: sentish && !term,
        liveDueLabel: s.governingDeadlineDate
          ? formatFiledDate(s.governingDeadlineDate)
          : null,
        href: `/disputes?dispute=${s.id}`,
        // Standard step set for the segment history — which address row it had
        // depends on where that letter mails.
        steps: [
          letterRecipientKind(s.letterType as DisputeLetter["letterType"]) === "insurer"
            ? "Add your insurer's appeals address"
            : "Add the provider's mailing address",
          "Confirm the claim details",
          "Download & sign the letter",
          "Mail it certified",
          "Mark it as sent",
        ].map((t) => ({ title: t, done: sentish })),
      };
    });
  })();

  // Viewed letter's terminal summary line ("closed — denied Sep 4, 2026").
  const viewedOutcomeLine = (() => {
    const w = OUTCOME_WORDS[disputeStatus ?? ""];
    if (!w) return null;
    const own = siblings.find((s) => s.id === disputeId);
    const resLabel = own?.resolutionDate ? formatFiledDate(own.resolutionDate) : null;
    return `closed — ${w}${resLabel ? ` ${resLabel}` : ""}`;
  })();

  // Real after-sent schedule. Null when the deadline engine contributed
  // nothing (flag OFF / legacy rows) → UnifiedTodo falls back to the static
  // guidance trio, byte-identical to pre-S286 (§R.5 graceful degradation).
  const hasEngineData =
    deadlineData != null &&
    (deadlineData.governingDeadlineDate != null ||
      deadlineData.deadlineWarning != null ||
      deadlineData.followups.length > 0 ||
      deadlineData.followupPlan.length > 0);
  const caseEvents = hasEngineData
    ? {
        windowPassed: deadlineData.deadlineWarning?.severity === "past",
        windowPassedNextStep: deadlineData.deadlineWarning?.nextStep ?? null,
        daysRemaining:
          deadlineData.deadlineWarning?.severity === "urgent"
            ? deadlineData.deadlineWarning.daysRemaining
            : null,
        responseDueDateLabel: deadlineData.governingDeadlineDate
          ? formatFiledDate(deadlineData.governingDeadlineDate)
          : responseDueLabel,
        followups: (deadlineData.followups.length > 0
          ? deadlineData.followups
          : deadlineData.followupPlan
        ).map((f) => ({
          dueDate: f.dueDate,
          dateLabel: formatFiledDate(f.dueDate),
          kind: f.kind,
        })),
        externalReviewLocked:
          letter.letterType === "insurance_appeal" &&
          deadlineData.deadlineWarning?.severity !== "past",
      }
    : null;

  // Draft-stage filing guard (absorbed from the retired CaseSummary tiles).
  const filingWarning =
    !alreadySent && deadlineData?.deadlineWarning
      ? {
          passed: deadlineData.deadlineWarning.severity === "past",
          label: deadlineLabelText(deadlineData.deadlineWarning.deadlineType),
          daysRemaining: deadlineData.deadlineWarning.daysRemaining,
          dateLabel: deadlineData.filingDeadlineDate
            ? formatFiledDate(deadlineData.filingDeadlineDate)
            : deadlineData.governingDeadlineDate
              ? formatFiledDate(deadlineData.governingDeadlineDate)
              : null,
          nextStep: deadlineData.deadlineWarning.nextStep,
        }
      : null;

  const unifiedTodoNode = (
    <UnifiedTodo
      key={disputeId ?? "letter"}
      amountLabel={
        amountDisputed != null
          ? `$${amountDisputed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : null
      }
      sent={alreadySent}
      sentDateLabel={sentDateLabel}
      responseDueLabel={responseDueLabel}
      status={disputeStatus}
      outcomeLine={viewedOutcomeLine}
      recipientKind={letterRecipientKind(letter.letterType)}
      providerAddressOnFile={zone1ProviderAddressOnFile}
      onAddProviderAddress={() => setProviderAddressOpen(true)}
      insurerAddressOnFile={zone1InsurerAddressOnFile}
      onAddInsurerAddress={() => setInsurerCorrectionOpen(true)}
      // S291 (Andrew) — the plan-year strip is now a STEP in "What you need to
      // do" instead of a banner floating below it. Same component, same approved
      // copy (S111 §3c); only its placement changes, so a wrong-year plan is a
      // tracked item ticked off before the letter goes out.
      planYearMismatch={
        planContext && !planContext.plan && planContext.missingForYear != null && disputeId
          ? {
              billYear: planContext.missingForYear,
              planYear: planContext.fallbackPlan?.planYear ?? null,
              insurerName: planContext.insurer?.name ?? planContext.fallbackPlan?.insurerName ?? null,
            }
          : null
      }
      planYearResolved={userConfirmedSamePlan != null || userAcceptedProxy === true}
      planYearStrip={
        planContext && !planContext.plan && planContext.missingForYear != null && disputeId ? (
        <VerifStrip
        disputeId={disputeId}
        billYear={planContext.missingForYear}
        insurerName={
        planContext.insurer?.name ??
        planContext.fallbackPlan?.insurerName ??
        null
        }
        fallbackPlan={planContext.fallbackPlan}
        userConfirmedSamePlan={userConfirmedSamePlan}
        userAcceptedProxy={userAcceptedProxy}
        archiveCanonicalPlan={
        planContext.archiveCanonicalPlan
        ? {
        id: planContext.archiveCanonicalPlan.id,
        planName: planContext.archiveCanonicalPlan.planName,
        planYear: planContext.archiveCanonicalPlan.planYear,
        insurerName: planContext.archiveCanonicalPlan.insurerName,
        }
        : null
        }
        boundCanonicalPlan={boundCanonicalPlan}
        wrongYearBannerDismissed={wrongYearBannerDismissed}
        getAuthToken={getAuthToken}
        onConfirmed={async (answer) => {
        setUserConfirmedSamePlan(answer);
        await fetchDispute(disputeId);
        }}
        onOpenSearchModalAuto={() => {
        setPlanSearchModalMode("auto");
        setPlanSearchModalOpen(true);
        }}
        onOpenSearchModalSearch={() => {
        setPlanSearchModalMode("search");
        setPlanSearchModalOpen(true);
        }}
        onOpenUploadModal={() => {
        setPlanSearchModalMode("upload");
        setPlanSearchModalOpen(true);
        }}
        onDismissWrongYearBanner={async () => {
        // S111 smoke #5 — POST dismiss flag + refetch. Server resets
        // dismissal to false on each new bind so the banner reappears
        // if the user binds another wrong-year plan.
        if (!user) return;
        const token = await user.firebaseUser.getIdToken();
        await fetch(
        `/api/disputes/${disputeId}/dismiss-wrong-year-banner`,
        {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        },
        );
        await fetchDispute(disputeId);
        }}
        />
        ) : null
      }
      nameMismatch={nameMismatch}
      nameResolved={patientIdentityResolved}
      onResolvePatient={resolvePatientChoice}
      // S295 — the claim-details row reads the REAL confirmation state, the way
      // nameResolved / planYearResolved already do. Null when the details block
      // isn't rendering (same gate as its claimFacts / onAttest props), which
      // leaves the row on its persisted check rather than inventing a verdict.
      detailsConfirmed={
        v3DesignOn && disputeId
          ? isClaimDetailsConfirmed(zone1Services, serviceAttestationReviewed)
          : null
      }
      onOpenLetter={() =>
        document
          .getElementById("dispute-letter-article")
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
      onDownload={handleDownload}
      onMarkSent={handleMarkSent}
      markingSent={markingSent}
      initialChecks={checklist}
      onPersistCheck={handlePersistCheck}
      caseEvents={caseEvents}
      letters={caseLetters}
      filingWarning={filingWarning}
      nextStepLabel={suggestedNextStep?.ctaLabel ?? null}
      escalating={escalating}
      onReportOutcome={() => setOutcomeModalOpen(true)}
      onCollections={() => setCollectorModalOpen(true)}
      onEscalateNext={handleSuggestedNextStep}
      onUndoSent={handleUndoSent}
      onUndoOutcome={handleUndoOutcome}
    >
      {renderCaseNeedsPanel(true)}
    </UnifiedTodo>
  );

  return (
    <div className={v3DesignOn ? "mx-auto max-w-6xl space-y-5" : "max-w-4xl mx-auto space-y-5"}>
      {/* S109 PR #2 — Back link to claim view. Uses letter.auditReportId
          (set from data.claimId in fetchDispute) so the user always has a
          path back to the source bill; legacy disputes without a linked claim
          fall back to the claim list so the user is never stranded. */}
      <a
        href={letter.auditReportId ? `/claim?claim=${letter.auditReportId}` : "/claim"}
        className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
      >
        <span aria-hidden>←</span> Back to claim
      </a>

      {/* Dispute Letters v2 — Zone-1 "What we need from you" + Zone-2 "The
          case". Legacy layout keeps them here; v3 relocates Zone-1 inside the
          UnifiedTodo claim-details expansion and Zone-2 into the left column
          under the checklist (Option A — always visible). */}
      {!v3DesignOn && renderCaseNeedsPanel(false)}
      {!v3DesignOn && caseSummaryNode}

      {addPlanModal && letter.auditReportId && (
        <AddPlanDetailsModal
          open
          claimId={letter.auditReportId}
          planId={(planContext?.plan as { id?: string } | null | undefined)?.id ?? null}
          serviceSlug={addPlanModal.serviceSlug}
          serviceLabel={addPlanModal.serviceLabel}
          getAuthToken={getAuthToken}
          onClose={() => setAddPlanModal(null)}
          onSaved={(saved) => {
            // S292 (#8) — optimistic: the panel reflects the typed value instantly
            // (pending-target idiom); a burst of saves coalesces into ONE reconcile
            // refetch instead of a full dispute re-resolve per save.
            if (saved) {
              applyOptimisticCostShare(saved.serviceSlug, {
                copay: saved.copay,
                coinsurancePercent: saved.coinsurancePercent,
              });
            } else if (disputeId) {
              void fetchDispute(disputeId);
            }
          }}
          initialCopay={addPlanModal.initialCopay}
          initialCoinsurancePercent={addPlanModal.initialCoinsurancePercent}
        />
      )}

      {/* S111 D3 — VerifStrip replaces SamePlanConfirmBanner + "Strengthen
          this letter" blue CTA panel. Single morphing component covering
          question / checking / bound-verified / bound-proxy / fallback per
          Subplan §3d. Parent gates rendering when no exact-year user plan
          exists; the strip itself handles state derivation + optimistic
          updates. */}

      {/* S111 — unified PlanSearchModal. 5-mode morph; controlled by the
          page-level open + mode state. Bind success → refetch; upload
          success → refetch (planContext.plan should populate once Haiku
          finishes, after which the strip morphs away entirely). */}
      {disputeId && planContext?.missingForYear != null && (
        <PlanSearchModal
          open={planSearchModalOpen}
          initialMode={planSearchModalMode}
          disputeId={disputeId}
          billYear={planContext.missingForYear}
          userState={null}
          initialInsurerName={
            planContext.insurer?.name ??
            planContext.fallbackPlan?.insurerName ??
            null
          }
          archiveSuggestion={
            planContext.archiveCanonicalPlan
              ? {
                  id: planContext.archiveCanonicalPlan.id,
                  planName: planContext.archiveCanonicalPlan.planName,
                  planYear: planContext.archiveCanonicalPlan.planYear,
                  insurerName: planContext.archiveCanonicalPlan.insurerName,
                }
              : null
          }
          getAuthToken={getAuthToken}
          onBound={async () => {
            await fetchDispute(disputeId);
          }}
          onUploaded={async () => {
            await fetchDispute(disputeId);
          }}
          onSkipToProxy={async () => {
            // S111 smoke #4 — footer "Use current plan as evidence (weaker)"
            // POSTs confirm-same-plan with acceptedProxy=true so the strip
            // transitions to bound-proxy after modal close.
            if (!user) return;
            const token = await user.firebaseUser.getIdToken();
            await fetch(
              `/api/disputes/${disputeId}/confirm-same-plan`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  answer: "yes",
                  acceptedProxy: true,
                }),
              },
            );
            await fetchDispute(disputeId);
          }}
          onClose={() => setPlanSearchModalOpen(false)}
        />
      )}

      {/* S111 smoke #4 — MissingPlanBanner removed; VerifStrip above covers
          the "need plan" messaging across all branches (question /
          confirm-archive / upload-or-proxy / fallback / bound-*). Two
          parallel banners was redundant and confusing per the smoke. */}

      {/* Important notice — moved to top; softer styling, less boxy */}
      <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-4 py-3 text-xs leading-relaxed text-amber-800">
        <strong className="font-semibold">Important —</strong> Review this letter carefully and make any edits needed. You must send this letter yourself — Candid does not submit letters on your behalf. Consider consulting an attorney if your dispute involves significant amounts.
      </div>

      {/* S111 smoke #5 — coverage diff panel. Renders only when the GET
          handler computed a diff against a stored pre-bind snapshot.
          Cleared by Proceed or replaced by Cancel-dispute flow. */}
      {coverageDiff && disputeId && (
        <CoverageDiffPanel
          diff={coverageDiff}
          onProceed={async () => {
            if (!user) return;
            const token = await user.firebaseUser.getIdToken();
            await fetch(
              `/api/disputes/${disputeId}/clear-coverage-diff`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
              },
            );
            await fetchDispute(disputeId);
          }}
          onCancelDispute={async () => {
            // S111 smoke #6 — when the coverage diff verdict marks the
            // dispute as invalidated (new plan supports the bill / removes
            // the discrepancy), skip the outcome modal and auto-withdraw.
            // None of the modal's options ("Won / Lost / Settled / Won on
            // escalation") map to a "not applicable due to plan change"
            // cancellation — using one would mis-record the outcome.
            //
            // For other verdicts (still_valid / weakened), open the modal
            // so the user can record an outcome explicitly.
            if (!user) return;
            if (coverageDiff?.verdict === "invalidated") {
              const token = await user.firebaseUser.getIdToken();
              const notes = `Dispute withdrawn after coverage check: ${coverageDiff.verdictReason}`;
              try {
                await fetch(`/api/disputes/outcome`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    disputeId,
                    status: "withdrawn",
                    strategyNotes: notes,
                  }),
                });
                // Clear the coverage diff so the panel collapses + reflects
                // the new withdrawn state on next refetch.
                await fetch(
                  `/api/disputes/${disputeId}/clear-coverage-diff`,
                  {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                  },
                );
                await fetchDispute(disputeId);
              } catch (err) {
                console.error("[CoverageDiffPanel] auto-withdraw failed:", err);
              }
              return;
            }
            setOutcomeModalOpen(true);
          }}
        />
      )}


      {/* dispute_plan_pinning_v1 (Phase 4) — re-bind the dispute to a different
          one of the user's own plans. Draft-only; flag-gated; pin wins over a
          canonical-bind (R4). The chooser's "search library / upload" link
          routes to the existing PlanSearchModal — one "change plan" entry,
          own-plans primary + library/upload fallback. Legacy layout only —
          in v3 the UnifiedTodo claim-details "Insurance for this claim" row
          owns the same Change action (same chooser). */}
      {!v3DesignOn && planPinningEnabled && !alreadySent && disputeId && planContext?.plan?.id && planContext?.plan?.planYear && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
          <span className="min-w-0 text-slate-600">
            This letter uses{" "}
            <span className="font-medium text-slate-900">
              {planContext.plan.planName ?? "your plan"}
              {planContext.plan.planYear ? ` (${planContext.plan.planYear})` : ""}
            </span>
            .
          </span>
          <button
            type="button"
            onClick={async () => {
              if (!user || !planContext?.plan?.planYear) return;
              const token = await user.firebaseUser.getIdToken();
              const qp = new URLSearchParams({ year: String(planContext.plan.planYear) });
              if (planContext.plan.id) qp.set("pin", planContext.plan.id);
              const res = await fetch(`/api/plan/by-year?${qp.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (res.ok) {
                const { plans } = (await res.json()) as { plans: DisputePlanChooserPlan[] };
                setRebindPlans(plans ?? []);
                setRebindOpen(true);
              }
            }}
            className="flex-shrink-0 text-[13px] font-semibold text-blue-600 hover:text-blue-700 hover:underline"
          >
            Change plan for this dispute
          </button>
        </div>
      )}

      {disputeId && (
        <DisputePlanChooser
          open={rebindOpen}
          onClose={() => setRebindOpen(false)}
          plans={rebindPlans}
          defaultPlanId={planContext?.plan?.id ?? null}
          serviceDate={serviceDate ?? null}
          year={planContext?.plan?.planYear ?? null}
          submitting={rebindBusy}
          title="Change the plan for this dispute"
          subtitle="Pick the plan this dispute should use — your letter rebuilds on it."
          confirmLabel="Use this plan"
          onSearchLibrary={() => {
            setRebindOpen(false);
            setPlanSearchModalMode("search");
            setPlanSearchModalOpen(true);
          }}
          onConfirm={async (id) => {
            if (!user || !disputeId) return;
            setRebindBusy(true);
            try {
              const token = await user.firebaseUser.getIdToken();
              const res = await fetch(`/api/disputes/${disputeId}/repin`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ insurancePlanId: id }),
              });
              if (res.ok) {
                setRebindOpen(false);
                await fetchDispute(disputeId);
              }
            } finally {
              setRebindBusy(false);
            }
          }}
        />
      )}

      {/* ===== Letter + evidence + toolbar + next-steps (Block C) =====
          Single source per node (consts above). Branched on the per-user flag
          so each path renders the SAME nodes — no duplicated wiring.
          OLD (flag OFF): byte-identical node order to pre-Block-C.
          NEW (flag ON): two-column reskin (letter-stack + rail) + 3 readouts
          (data-trust banner + evidence band in hero + readiness rail). */}
      {v3DesignOn ? (
        /* Surface 4 (clarity redesign) — two-column: LEFT = ① UnifiedTodo
           ② "The case" (Option A) ③ orientation (hero + recipient) ④ letter
           (toolbar + article w/ footer bar); RIGHT rail (sticky, scrollable) =
           "Why this should be covered" evidence + case-file download. The old
           "What to do next" list is superseded by the UnifiedTodo. */
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5">
            {staleBannerNode}
            {strengthenPromptNode}
            {dataTrustBannerNode}
            {/* S286 — "The case" card retired in v3: its timeline, countdown,
                and stage actions live INSIDE the UnifiedTodo spine now. The
                legacy (flag-OFF) layout keeps CaseSummary unchanged. */}
            {unifiedTodoNode}
            {heroNode}
            {recipientNode}
            {toolbarNode}
            {articleNode}
          </div>
          {/* Block C2 — the rail is taller than the viewport on most letters;
              cap its height to the viewport and let it scroll its OWN overflow so
              hovering + wheeling over the rail reaches the lower cards (evidence,
              case file) instead of being scroll-trapped until the left column
              catches up. */}
          {/* S293 (#5, Andrew) — the "Why this should be covered" sidebar card
              (EvidenceBlock) is REMOVED as unused visual noise. The letter's own
              evidence section carries the same analysis; the attestation flow it
              hosted now lives inside the claim-details block in the needs panel.
              Reversible: EvidenceBlock.tsx + StrengthBand.tsx remain in the tree,
              unmounted — restore by re-adding the import + this placement. */}
          <aside className="space-y-5 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            {caseFileNode}
          </aside>
        </div>
      ) : (
        <>
          {staleBannerNode}
          {strengthenPromptNode}
          {heroNode}
          {recipientNode}
          {toolbarNode}
          {articleNode}
          {nextStepsNode}
          {caseFileNode}
        </>
      )}

      {missingYear ? (
        <DownloadWarningModal
          open={downloadWarnOpen}
          claimYear={missingYear}
          disputeId={letter.id}
          onCancel={() => setDownloadWarnOpen(false)}
          onDownloadAnyway={forceDownloadCaseFile}
        />
      ) : null}

      {/* S74.6 D5 §E.2 — outcome reporting modal. Rendered alongside the
          existing toolbar modals so state lives at the page level. */}
      <OutcomeReportingModal
        open={outcomeModalOpen}
        disputeId={letter.id}
        defaultAmount={null}
        onCancel={() => setOutcomeModalOpen(false)}
        onSubmitted={(detail) => {
          setOutcomeModalOpen(false);
          setOutcomeToast("Outcome saved. Thanks for closing the loop.");
          setTimeout(() => setOutcomeToast(null), 6000);
          // Optimistic (S266) — flip status + next rung locally so the stage-action bar
          // updates instantly (no lingering button); reconcile in the background.
          mutationGenRef.current += 1;
          setDisputeStatus(mapOutcomeToStatus(detail));
          setSuggestedNextStep(suggestNextStep(letter.letterType, detail));
          if (disputeId) {
            void fetchDispute(disputeId);
          }
        }}
        getIdToken={getAuthToken}
      />

      {/* Zone-3 (S266) — ladder-advance capture: collector details (→ debt_validation)
          + internal-appeal exhaustion attestation (→ external_review). Both POST
          /escalate and navigate to the new dispute. */}
      <CollectorModal
        open={collectorModalOpen}
        submitting={escalating}
        onCancel={() => setCollectorModalOpen(false)}
        onSubmit={(input) => {
          setCollectorModalOpen(false);
          void handleEscalate("debt_validation", {
            collector: input.collector,
            collectorFirstContactDate: input.collectorFirstContactDate,
          });
        }}
      />
      <ExhaustionAttestModal
        open={exhaustionModalOpen}
        submitting={escalating}
        onCancel={() => setExhaustionModalOpen(false)}
        onSubmit={(input) => {
          setExhaustionModalOpen(false);
          void handleEscalate("external_review", { appealExhausted: input.appealExhausted });
        }}
      />

      {/* Item 3 — "Why {band}?" evidence-strength explanation (v3 only). */}
      <EvidenceStrengthModal
        open={evidenceModalOpen}
        onClose={() => setEvidenceModalOpen(false)}
        band={strength?.evidenceStrength.band ?? "partially_supported"}
        evidence={evidence}
      />

      {planContext?.insurer && disputeId ? (
        <InsurerAddressCorrectionModal
          open={insurerCorrectionOpen}
          disputeId={disputeId}
          insurerName={planContext.insurer.name}
          insurerId={planContext.insurer.id}
          initialValues={{
            addressLine1: planContext.insurer.appealsAddress?.line1 ?? "",
            addressLine2: planContext.insurer.appealsAddress?.line2 ?? "",
            city: planContext.insurer.appealsAddress?.city ?? "",
            state: planContext.insurer.appealsAddress?.state ?? "",
            postalCode: planContext.insurer.appealsAddress?.postalCode ?? "",
            phone: planContext.insurer.appealsPhone ?? "",
          }}
          onClose={() => setInsurerCorrectionOpen(false)}
          onSubmitted={refetchAfterChange}
          getAuthToken={getAuthToken}
        />
      ) : null}

      {disputeId ? (
        <ProviderAddressModal
          open={providerAddressOpen}
          disputeId={disputeId}
          initialName={planContext?.providerContact?.name ?? null}
          initialAddressFields={planContext?.providerContact?.addressFields ?? null}
          initialPhone={planContext?.providerContact?.phone ?? null}
          initialNpi={planContext?.providerContact?.npi ?? null}
          getAuthToken={getAuthToken}
          onClose={() => setProviderAddressOpen(false)}
          onSaved={refetchAfterChange}
        />
      ) : null}
    </div>
  );
}

/**
 * S74 — statuses that mean the dispute has already left the user's hands. The
 * mark-sent button hides + the toolbar shows a "Sent on <date>" pill instead.
 * Source vocabulary in src/lib/disputes/persist.ts.
 */
function isSentStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return [
    "filed",
    "in_progress",
    "won",
    "lost",
    "settled",
    "withdrawn",
    "won_on_escalation",
    "settled_on_escalation",
  ].includes(status);
}

function formatFiledDate(iso: string): string {
  try {
    // S286 — date-only strings ("2026-06-02") parse as UTC midnight, which
    // renders as the PREVIOUS day in US timezones (the on-page "Sent Jun 1"
    // vs "Sent Jun 2" disagreement between the checklist and the old case
    // card). Pin date-only values to LOCAL midnight; full ISO timestamps
    // (sent_at) parse natively. Single formatter = one date truth per page.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function SentCheckIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function NextStep({ n, title, body }: { n: number; title: string; body: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
        {n}
      </span>
      <div className="min-w-0">
        <div className="font-semibold text-slate-900">{title}</div>
        <div className="text-slate-600">{body}</div>
      </div>
    </li>
  );
}

const LETTER_TYPE_LABELS: Record<DisputeLetter["letterType"], string> = {
  insurance_appeal: "Appeal to Insurer",
  overcharge: "Billing Dispute",
  balance_billing: "Balance Billing Dispute",
  duplicate_charge: "Duplicate Charge Dispute",
  itemized_request: "Itemized Bill Request",
  negotiation: "Self-Pay Negotiation",
  final_notice: "Final Notice",
  external_review: "External Review Request",
  debt_validation: "Debt Validation",
};

// ── S292 (#7) — server `lineCostShare` row (the claim page's own cost-share
// resolution per disputed line, projected by /api/disputes/[disputeId]) ────────
interface LineCostShareRow {
  lineItemId: string;
  serviceSlug: string | null;
  description: string | null;
  known: boolean;
  copay: number | null;
  coinsurancePercent: number | null;
  source: string | null;
  humanReviewed: boolean;
  confirmed: boolean;
  rejected: boolean;
  secondaryMatchedSlug: string | null;
}

// ── Unified case timeline (S286) helpers ─────────────────────────────────────

/** One row of the claim's dispute ladder from the GET's `siblings` array. */
interface SiblingLetter {
  id: string;
  letterType: string;
  status: string | null;
  filedDate: string | null;
  sentAt: string | null;
  resolutionDate: string | null;
  governingDeadlineDate: string | null;
  createdAt: string | null;
}

/** Terminal statuses (matches UnifiedTodo's TERMINAL + cancelled). */
const SIBLING_TERMINAL = new Set([
  "won",
  "lost",
  "settled",
  "withdrawn",
  "won_on_escalation",
  "settled_on_escalation",
  "cancelled",
]);

/** Short outcome words for segment summary lines + the viewing-past banner
 *  ("closed — denied Sep 4" pattern, approved 2026-07-18). */
const OUTCOME_WORDS: Record<string, string> = {
  won: "resolved in your favor",
  won_on_escalation: "resolved in your favor",
  lost: "denied",
  settled: "settled",
  settled_on_escalation: "settled",
  withdrawn: "withdrawn",
  cancelled: "cancelled",
};

/** deadline_type → friendly window label (carried from the retired CaseSummary). */
function deadlineLabelText(t: string | null | undefined): string {
  switch (t) {
    case "erisa_appeal_180":
      return "Appeal window";
    case "plan_response":
      return "Response window";
    case "fdcpa_validation_30":
      return "Validation window";
    default:
      return "Deadline";
  }
}

function buildAskSummary(letter: DisputeLetter, recovery: number | null): string | null {
  if (letter.requestedAction) return letter.requestedAction;
  if (recovery && recovery > 0) {
    return `Requesting ${formatUsd(recovery)} be reprocessed at plan terms.`;
  }
  return null;
}

function formatUsd(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Small icon set (stroke-based, matches Lucide aesthetic without the dep).
function ToolbarIcon({ name }: { name: "edit" | "preview" | "copy" | "letter" | "casefile" | "redraft" | "sent" }) {
  const common = { className: "h-4 w-4", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24" };
  switch (name) {
    case "sent":
      // Paper-plane icon — universally signals "send / sent" to consumers.
      return (
        <svg {...common}>
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      );
    case "redraft":
      return (
        <svg {...common}>
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      );
    case "preview":
      return (
        <svg {...common}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      );
    case "letter":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      );
    case "casefile":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
  }
}

function ToolbarButton({
  onClick,
  icon,
  label,
  tone = "default",
}: {
  onClick: () => void;
  icon: React.ComponentProps<typeof ToolbarIcon>["name"];
  label: string;
  tone?: "default" | "primary" | "success";
}) {
  const classes =
    tone === "primary"
      ? "inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow"
      : tone === "success"
      ? "inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700"
      : "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-all hover:-translate-y-px hover:border-slate-300 hover:shadow";
  return (
    <button type="button" onClick={onClick} className={classes}>
      <ToolbarIcon name={icon} />
      {label}
    </button>
  );
}

function recipientFromPlanContext(
  planContext: (PlanContext & { insurer: { name: string; appealsAddress: { line1: string; line2: string | null; city: string; state: string; postalCode: string } | null; appealsPhone: string | null } | null }) | null,
  letterType: DisputeLetter["letterType"],
): DisputeLetter["recipient"] {
  const insurer = planContext?.insurer ?? null;
  // Appeals go to the insurer; everything else (overcharge, balance billing,
  // duplicate charges, itemized requests, self-pay negotiation) goes to the
  // provider billing department. S74: the provider mailing address now flows
  // through planContext.providerContact so we can render it in the card.
  if (letterType === "insurance_appeal" && insurer) {
    const addr = insurer.appealsAddress;
    return {
      name: insurer.name,
      role: "Member Services — Appeals",
      address: addr
        ? [addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postalCode}`].filter(Boolean).join("\n")
        : undefined,
      phone: insurer.appealsPhone ?? undefined,
    };
  }
  const provider = planContext?.providerContact ?? null;
  if (provider && (provider.name || provider.address)) {
    return {
      name: provider.name ?? "Provider",
      role: "Billing Department",
      address: provider.address ?? undefined,
      phone: provider.phone ?? undefined,
    };
  }
  // Fallback when neither side resolved — preserves legacy behavior.
  if (letterType === "insurance_appeal") {
    return { name: "Insurance Appeals", role: "Appeals Department" };
  }
  return { name: "Provider", role: "Billing Department" };
}

function RequestItemizedBill() {
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({
    patientName: "",
    providerName: "",
    serviceDate: "",
    accountNumber: "",
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/disputes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, type: "itemized_request" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Itemized-bill requests don't go through the persistence path today
      // (no audit findings → no claim line items to dedupe on), so this
      // generally falls through to the legacy ?letter=<JSON> URL. The shared
      // helper still prefers ?dispute=<id> when persistence is enabled.
      window.location.href = disputeUrlForResult(data);
    } catch {
      alert("Failed to generate letter. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="mt-4 text-sm text-blue-600 hover:underline"
      >
        Request an itemized bill instead
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 text-left max-w-md mx-auto space-y-3">
      <input
        type="text"
        placeholder="Your full name"
        required
        value={form.patientName}
        onChange={(e) => setForm({ ...form, patientName: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Provider / Hospital name"
        required
        value={form.providerName}
        onChange={(e) => setForm({ ...form, providerName: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="date"
        required
        value={form.serviceDate}
        onChange={(e) => setForm({ ...form, serviceDate: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="Account # (optional)"
        value={form.accountNumber}
        onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
      >
        {loading ? "Generating..." : "Generate Itemized Bill Request"}
      </button>
    </form>
  );
}

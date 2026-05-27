"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import type { DisputeLetter } from "@/lib/billing/types";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { LockedOverlay } from "@/components/shared/LockedOverlay";
import { InlineSubscribePanel } from "@/components/billing/InlineSubscribePanel";
import { downloadCaseFile } from "@/lib/casefile";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { DisputeLetterHero } from "@/components/disputes/DisputeLetterHero";
import { DisputeRecipientCard } from "@/components/disputes/DisputeRecipientCard";
import { EvidenceBlock } from "@/components/disputes/EvidenceBlock";
import { VerifStrip } from "@/components/disputes/VerifStrip";
import {
  CoverageDiffPanel,
  type CoverageDiff,
} from "@/components/disputes/CoverageDiffPanel";
import {
  PlanSearchModal,
  type PlanSearchModalMode,
} from "@/components/disputes/PlanSearchModal";
import { DownloadWarningModal } from "@/components/disputes/DownloadWarningModal";
import { EvidenceGaps } from "@/components/disputes/EvidenceGaps";
import { InsurerAddressCorrectionModal } from "@/components/disputes/InsurerAddressCorrectionModal";
import { OutcomeReportingModal } from "@/components/disputes/OutcomeReportingModal";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useDisputeDraftOverlay } from "@/lib/loading/dispute-draft-overlay";
import type {
  BoundCanonicalPlan,
  PlanContext,
} from "@/lib/disputes/plan-context";
import type { DisputeEvidence } from "@/lib/disputes/evidence-resolver";

export default function DisputesPage() {
  const { isPro, loading, waitFor } = useSubscription();
  const [subscribing, setSubscribing] = useState(false);

  if (loading) {
    // S132 iter-8 — unified cube loader.
    return <CubeLoaderBuilding />;
  }

  if (!isPro) {
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
  const [gateUnverified, setGateUnverified] = useState(false);
  // S74 — dispute lifecycle state for the Mark-as-Sent flow.
  const [disputeStatus, setDisputeStatus] = useState<string | null>(null);
  const [disputeFiledDate, setDisputeFiledDate] = useState<string | null>(null);
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
  // S111 — unified modal state. Replaces the S110 SearchCanonicalPlanModal
  // open boolean; mode controls the 5-mode morph in PlanSearchModal.
  const [planSearchModalOpen, setPlanSearchModalOpen] = useState(false);
  const [planSearchModalMode, setPlanSearchModalMode] =
    useState<PlanSearchModalMode>("search");
  // S74 — InsurerAddressCorrectionModal open state.
  const [insurerCorrectionOpen, setInsurerCorrectionOpen] = useState(false);
  // S74 — Mark-sent button state + transient toast.
  const [markingSent, setMarkingSent] = useState(false);
  const [markSentToast, setMarkSentToast] = useState<string | null>(null);
  // S74.6 D5 §E.2 — outcome reporting modal state.
  const [outcomeModalOpen, setOutcomeModalOpen] = useState(false);
  const [outcomeToast, setOutcomeToast] = useState<string | null>(null);
  const disputeId = searchParams.get("dispute");

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
  const fetchDispute = useCallback(async (id: string) => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch(`/api/disputes/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    setPlanContext(data.planContext ?? null);
    setEvidence(data.evidence ?? null);
    setNameMismatch(data.patientNameMismatch ?? null);
    setGateUnverified(!!data.gateUnverified);
    setDisputeStatus(typeof data.status === "string" ? data.status : null);
    setDisputeFiledDate(typeof data.filedDate === "string" ? data.filedDate : null);
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
      setEditedBody(data.letterContent);
    }
  }, [user]);

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
    // Use the edited body so any user edits are included
    downloadCaseFile({ ...letter, body: editedBody });
  };

  const forceDownloadCaseFile = () => {
    if (!letter) return;
    setDownloadWarnOpen(false);
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
    if (!window.confirm("Mark this dispute as sent? We'll start the follow-up reminder schedule and you'll see status updates on your claim.")) {
      return;
    }
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
      await fetchDispute(disputeId);
    } catch (err) {
      setMarkSentToast(err instanceof Error ? err.message : "Failed to mark as sent");
    } finally {
      setMarkingSent(false);
      setTimeout(() => setMarkSentToast(null), 6000);
    }
  };

  // S74 — InsurerAddressCorrectionModal callbacks.
  const handleProposeInsurerCorrection = () => setInsurerCorrectionOpen(true);
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

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* S109 PR #2 — Back link to claim view. Uses letter.auditReportId
          (set from data.claimId in fetchDispute) so the user always has a
          path back to the source bill / claim list. Hidden when claim id
          is absent (e.g., legacy disputes that weren't linked to a claim). */}
      {letter.auditReportId && (
        <a
          href={`/claim?claim=${letter.auditReportId}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          <span aria-hidden>←</span> Back to claim
        </a>
      )}

      {/* S111 D3 — VerifStrip replaces SamePlanConfirmBanner + "Strengthen
          this letter" blue CTA panel. Single morphing component covering
          question / checking / bound-verified / bound-proxy / fallback per
          Subplan §3d. Parent gates rendering when no exact-year user plan
          exists; the strip itself handles state derivation + optimistic
          updates. */}
      {planContext &&
        !planContext.plan &&
        planContext.missingForYear != null &&
        disputeId && (
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
        )}

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

      <DisputeLetterHero
        letter={letter}
        providerName={providerName}
        serviceDate={serviceDate}
        askSummary={buildAskSummary(letter, potentialRecovery)}
        potentialRecovery={potentialRecovery}
        evidence={evidence}
        onRedraft={handleRedraft}
        redraftInFlight={redrafting}
      />

      <DisputeRecipientCard
        recipient={letter.recipient}
        insurer={planContext?.insurer ?? null}
        requestedAction={letter.requestedAction}
        letterTypeLabel={letterTypeLabel}
        planYear={planContext?.plan?.planYear ?? null}
        referenceId={letter.id}
        onConfirmAddress={handleConfirmAddress}
        onProposeCorrection={planContext?.insurer ? handleProposeInsurerCorrection : undefined}
      />

      <EvidenceBlock evidence={evidence} planLabel={planLabel} gateUnverified={gateUnverified} />

      <EvidenceGaps
        gaps={evidence?.gaps ?? []}
        onAuditRerun={
          disputeId
            ? async () => {
                if (!user) return;
                const token = await user.firebaseUser.getIdToken();
                const res = await fetch(
                  `/api/disputes/${disputeId}/rerun-audit`,
                  {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                  },
                );
                if (!res.ok) throw new Error("rerun-audit failed");
                await fetchDispute(disputeId);
              }
            : undefined
        }
        onRedraft={disputeId ? handleRedraft : undefined}
        disputeId={disputeId}
        providerSeed={planContext?.providerContact ?? null}
        getAuthToken={getAuthToken}
        onProviderContactSaved={refetchAfterChange}
        // S111 D6 — bound_canonical_coverage_thin CTA opens PlanSearchModal
        // in upload mode rather than navigating to /upload. Keeps the user
        // in-context on the dispute view.
        onUploadInModal={() => {
          setPlanSearchModalMode("upload");
          setPlanSearchModalOpen(true);
        }}
      />

      {nameMismatch ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 shadow-sm md:flex-row md:items-start md:justify-between">
          <div className="flex flex-1 items-start gap-3">
            <NameMismatchIcon />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-900">
                Verify the patient name before sending
              </div>
              <p className="mt-1 text-sm leading-relaxed text-amber-800">
                We&apos;re using your account name{" "}
                <span className="font-semibold">{nameMismatch.profileName}</span>{" "}
                in the letter. The bill listed{" "}
                <span className="font-semibold">&ldquo;{nameMismatch.billName}&rdquo;</span>{" "}
                — confirm this matches the patient of record. Edit the letter if a
                dependent or family member should be named instead.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-amber-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
          >
            Edit letter
          </button>
        </div>
      ) : null}

      {/* Toolbar — sticky on scroll; title uses uppercase ref id */}
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
            {alreadySent ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
                  <SentCheckIcon />
                  Sent{disputeFiledDate ? ` ${formatFiledDate(disputeFiledDate)}` : ""}
                </span>
                {/* S74.6 D5 §E.2 — let user report the outcome (won / lost /
                    won_on_escalation / settled) after sending. Captures
                    recodedAs when won_on_escalation so the §E.1 flywheel
                    vote fires server-side. */}
                <ToolbarButton
                  onClick={() => setOutcomeModalOpen(true)}
                  icon="sent"
                  label="Report outcome"
                />
              </>
            ) : (
              <ToolbarButton
                onClick={handleMarkSent}
                icon="sent"
                label={markingSent ? "Marking…" : "Mark as sent"}
                tone="primary"
              />
            )}
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

      {/* Letter body — paper card, serif, letter-style */}
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
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
      </article>

      {/* What to do next — merged Next Steps + Track + Case File download */}
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

      {/* Case File download — moved to bottom, single prominent CTA */}
      <section className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-6 shadow-sm md:p-7">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
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
        onSubmitted={() => {
          setOutcomeModalOpen(false);
          setOutcomeToast("Outcome saved. Thanks for closing the loop.");
          setTimeout(() => setOutcomeToast(null), 6000);
          // Refresh dispute state so the toolbar reflects the new status.
          if (disputeId) {
            void fetchDispute(disputeId);
          }
        }}
        getIdToken={getAuthToken}
      />


      {planContext?.insurer ? (
        <InsurerAddressCorrectionModal
          open={insurerCorrectionOpen}
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
    return new Date(iso).toLocaleDateString("en-US", {
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
};

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

function NameMismatchIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
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

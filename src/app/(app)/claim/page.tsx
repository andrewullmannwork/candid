"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useRef, useState } from "react";
import { BillCard } from "@/components/claims/BillCard";
import { VisitGroupCard } from "@/components/claims/VisitGroupCard";
import { ClaimDetail } from "@/components/claims/ClaimDetail";
import { FollowupBanner } from "@/components/disputes/FollowupBanner";
import { DisputeMetrics } from "@/components/disputes/DisputeMetrics";
import { EscalationCard } from "@/components/disputes/EscalationCard";
import { RecoveryHero, type NextStepView } from "@/components/claims/RecoveryHero";
import { ClaimPreviewEmptyState } from "@/components/claims/ClaimPreviewEmptyState";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { PageHeader } from "@/components/page-header";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useMinHoldLoading } from "@/lib/loading/use-min-hold";
import {
  useClaimPipeline,
  type PipelineClaimSummary,
  type PipelineDispute,
} from "@/lib/claims/use-claim-pipeline";
import type { BillState } from "@/lib/claims/derive-bill-state";
import { cn } from "@/lib/utils/cn";

// ── Types ────────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  internal_appeal: "Appeal to Insurer",
  external_appeal: "External Appeal",
  complaint: "Regulatory Complaint",
  legal: "Legal Action",
  negotiation: "Self-pay Negotiation",
};

// Session 35 lifecycle vocab + legacy values (NON-NEGOTIABLE preservation per D-§1.D.1-K).
const STATUS_STYLES: Record<string, string> = {
  flagged: "text-amber-700 bg-amber-50 ring-amber-200",
  filed: "text-blue-700 bg-blue-50 ring-blue-200",
  dispute_letter_drafted: "text-blue-700 bg-blue-50 ring-blue-200",
  court_documentation_drafted: "text-purple-700 bg-purple-50 ring-purple-200",
  in_progress: "text-amber-700 bg-amber-50 ring-amber-200",
  won: "text-green-700 bg-green-50 ring-green-200",
  lost: "text-red-700 bg-red-50 ring-red-200",
  settled: "text-green-700 bg-green-50 ring-green-200",
  withdrawn: "text-gray-700 bg-gray-50 ring-gray-200",
  won_on_escalation: "text-green-700 bg-green-50 ring-green-200",
  settled_on_escalation: "text-green-700 bg-green-50 ring-green-200",
};

const STATUS_LABELS: Record<string, string> = {
  flagged: "Flagged",
  filed: "Draft · ready to review",
  dispute_letter_drafted: "Draft · ready to review",
  court_documentation_drafted: "Court documentation drafted",
  in_progress: "In progress",
  won: "Won",
  lost: "Lost",
  settled: "Settled",
  withdrawn: "Withdrawn",
  won_on_escalation: "Won (on escalation)",
  settled_on_escalation: "Settled (on escalation)",
};

// Surface 2 — tabs renamed 1:1 with the next-steps tiles:
// All bills / Flagged / Need your input / Letters to send.
type Tab = "bills" | "flagged" | "input" | "letters";

/** Sanitize URL tab values, mapping the retired pre-redesign tab ids. */
function toTab(raw: string | null): Tab | null {
  if (raw === "bills" || raw === "flagged" || raw === "input" || raw === "letters") return raw;
  if (raw === "disputes") return "letters"; // legacy deep links
  if (raw === "discrepancies") return "bills"; // tab retired in Surface 2
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const match = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, y, m, d] = match;
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    }
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CandidClaimPage() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-driven selected-claim state (NON-NEGOTIABLE preserve per D-§1.D.1-E).
  const urlClaimId = searchParams.get("claim");
  const urlFocusId = searchParams.get("focus");
  const urlFromTab = toTab(searchParams.get("from"));

  const [tab, setTab] = useState<Tab>(urlFromTab || "bills");
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const selectedClaimId = urlClaimId;
  const focusLineItemId = urlFocusId;
  const tabBeforeDetail: Tab = urlFromTab || "bills";

  // Claims + discrepancies + disputes + 4-state derivation — shared with
  // /dashboard's Claim hero via useClaimPipeline (Surface 1) so both surfaces
  // read identical pipeline counts.
  const pipeline = useClaimPipeline();
  const {
    claims,
    disputeData,
    billStates,
    counts,
    totalRecovery,
    refetchClaims,
    setDisputeData,
  } = pipeline;

  const loading = useMinHoldLoading(pipeline.loading);

  // S139 — group claims by claim_group_id for VisitGroupCard rendering on the
  // All-bills tab. Singletons render BillCard; ≥2-member groups render
  // VisitGroupCard. Preserves original sort order via first-seen anchor.
  type Unit =
    | { kind: "singleton"; claim: PipelineClaimSummary }
    | { kind: "group"; groupId: string; bills: PipelineClaimSummary[] };
  const renderUnits: Unit[] = (() => {
    const groupBuckets = new Map<string, PipelineClaimSummary[]>();
    const order: Array<{ key: string; isGroup: boolean }> = [];
    for (const c of claims) {
      if (c.claim_group_id) {
        if (!groupBuckets.has(c.claim_group_id)) {
          groupBuckets.set(c.claim_group_id, []);
          order.push({ key: c.claim_group_id, isGroup: true });
        }
        groupBuckets.get(c.claim_group_id)!.push(c);
      } else {
        order.push({ key: c.id, isGroup: false });
      }
    }
    const units: Unit[] = [];
    for (const entry of order) {
      if (entry.isGroup) {
        const bills = groupBuckets.get(entry.key)!;
        if (bills.length >= 2) {
          units.push({ kind: "group", groupId: entry.key, bills });
        } else {
          units.push({ kind: "singleton", claim: bills[0] });
        }
      } else {
        const claim = claims.find((c) => c.id === entry.key);
        if (claim) units.push({ kind: "singleton", claim });
      }
    }
    return units;
  })();

  // needs_review "Answer N questions" count — reviewNeededCount when present,
  // else that claim's open tier-2/3 discrepancy count (min 1).
  function questionCountFor(claim: PipelineClaimSummary): number {
    if ((claim.reviewNeededCount ?? 0) > 0) return claim.reviewNeededCount!;
    const open = pipeline.discrepancies.filter(
      (d) =>
        d.claim_id === claim.id && (d.tier === 2 || d.tier === 3) && d.status !== "resolved",
    ).length;
    return Math.max(1, open);
  }

  function openClaimDetail(claimId: string, sourceTab: Tab) {
    router.push(`/claim?claim=${claimId}&from=${sourceTab}`);
  }

  function closeClaimDetail() {
    // S109 explicit push (NON-NEGOTIABLE preserve).
    router.push(`/claim?tab=${tabBeforeDetail}`);
  }

  // Tile click → set the matching list filter + scroll to the tabbar.
  // Post-commit setTimeout (~90ms) + instant scroll — smooth scroll raced the
  // React commit in the prototype, so behavior is deliberately "auto".
  function jumpTo(view: NextStepView) {
    setTab(view);
    setTimeout(() => {
      if (!tabsRef.current) return;
      const top = tabsRef.current.getBoundingClientRect().top + window.scrollY - 16;
      window.scrollTo({ top, behavior: "auto" });
    }, 90);
  }

  if (loading) {
    // S132 iter-8 — unified cube loader; audit loader retired.
    return <CubeLoaderBuilding />;
  }

  // If viewing claim detail, render that view only (NON-NEGOTIABLE preserve per D-§1.D.1-E).
  if (selectedClaimId) {
    return (
      <div className="mx-auto max-w-4xl">
        <ClaimDetail
          claimId={selectedClaimId}
          onBack={closeClaimDetail}
          focusLineItemId={focusLineItemId}
          backLabel="Back to bills"
          onClaimUpdated={refetchClaims}
          billState={billStates.get(selectedClaimId) ?? null}
        />
      </div>
    );
  }

  const hasBills = claims.length > 0;
  const hasDisputes = (disputeData?.disputes.length ?? 0) > 0;
  const activeDisputes =
    disputeData?.disputes.filter((d) =>
      ["filed", "in_progress", "dispute_letter_drafted", "court_documentation_drafted"].includes(d.status),
    ) ?? [];
  const resolvedDisputes =
    disputeData?.disputes.filter((d) =>
      ["won", "settled", "lost", "withdrawn", "won_on_escalation", "settled_on_escalation"].includes(
        d.status,
      ),
    ) ?? [];
  const lostDisputes = resolvedDisputes.filter((d) => d.status === "lost");

  // Ready-to-draft = flagged bills without a draft yet.
  const readyToDraftClaims = claims.filter(
    (c) => billStates.get(c.id) === "overcharge_no_draft",
  );
  const flaggedClaims = claims.filter((c) => {
    const s = billStates.get(c.id);
    return s === "overcharge_drafted" || s === "overcharge_no_draft";
  });
  const reviewClaims = claims.filter((c) => billStates.get(c.id) === "needs_review");

  return (
    <div className="mx-auto max-w-4xl">
      {/* PageHeader primitive — D-§1.D.1-B */}
      <PageHeader
        eyebrow="Candid Claim"
        title="Your claim, in plain English"
        sub="Every bill audited line by line. Every overcharge flagged. Every dollar tracked."
      />

      {/* FollowupBanner above hero — D-§1.D.1-F + Round 2 Item 1 Option A */}
      <FollowupBanner />

      {/* Empty state replaces hero + tabs entirely (Round 2 Item 2 render rule) */}
      {!hasBills && (
        <>
          <ClaimPreviewEmptyState />
          <Disclaimer variant="coverage_check" className="mt-6" />
        </>
      )}

      {hasBills && (
        <>
          {/* RecoveryHero — Surface 2: "Your next steps" clickable tiles that
              filter the bill list below. */}
          <RecoveryHero
            stats={{
              totalRecovery,
              billsCount: claims.length,
              issuesCount: counts.flagged,
              disputesCount: counts.drafted,
              reviewCount: counts.review,
            }}
            variant="calm"
            activeView={tab === "bills" ? null : tab}
            onStep={jumpTo}
          />

          {/* Tabbar — Surface 2 rename: All bills / Flagged / Need your input /
              Letters to send (1:1 with the next-steps tiles). */}
          <div ref={tabsRef} className="mb-5 mt-8 flex flex-wrap items-center justify-between gap-3">
            <div className="flex w-fit flex-wrap gap-1 rounded-2xl border border-gray-200 bg-white p-1">
              <TabButton active={tab === "bills"} onClick={() => setTab("bills")}>
                All bills
                <TabCount count={claims.length} active={tab === "bills"} />
              </TabButton>
              <TabButton active={tab === "flagged"} onClick={() => setTab("flagged")}>
                Flagged
                <TabCount count={counts.flagged} active={tab === "flagged"} />
              </TabButton>
              <TabButton active={tab === "input"} onClick={() => setTab("input")}>
                Need your input
                <TabCount count={counts.review} active={tab === "input"} />
              </TabButton>
              <TabButton active={tab === "letters"} onClick={() => setTab("letters")}>
                Letters to send
                <TabCount count={counts.drafted} active={tab === "letters"} />
              </TabButton>
            </div>

            <Link
              href="/upload"
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-300 hover:bg-gray-50 hover:text-blue-700"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                />
              </svg>
              Upload bill
            </Link>
          </div>

          {/* All bills tab — groups + singletons */}
          {tab === "bills" && (
            <div className="space-y-3">
              {renderUnits.map((unit) =>
                unit.kind === "singleton" ? (
                  <BillCard
                    key={unit.claim.id}
                    claim={unit.claim}
                    state={billStates.get(unit.claim.id) ?? "clean"}
                    reviewQuestionCount={questionCountFor(unit.claim)}
                    onSelect={(id) => openClaimDetail(id, "bills")}
                  />
                ) : (
                  <VisitGroupCard
                    key={unit.groupId}
                    bills={unit.bills}
                    billStates={billStates}
                    onSelectBill={(id) => openClaimDetail(id, "bills")}
                  />
                ),
              )}

              {/* "Upload another bill" full-width dashed add-tile — D-§1.D.1-H */}
              <Link
                href="/upload"
                className="group block rounded-2xl border-2 border-dashed border-gray-200 bg-white px-5 py-5 text-center transition-colors hover:border-blue-300 hover:bg-blue-50/30"
              >
                <p className="text-sm font-semibold text-gray-700 group-hover:text-blue-700">
                  + Upload another bill
                  <span className="ml-1 font-normal text-gray-500">— EOB, itemized bill, or statement</span>
                </p>
              </Link>
            </div>
          )}

          {/* Flagged tab — bills with a confirmed overcharge */}
          {tab === "flagged" && (
            <FilteredBillList
              claims={flaggedClaims}
              billStates={billStates}
              questionCountFor={questionCountFor}
              emptyCopy="No flagged bills right now — confirmed overcharges will show up here."
              onSelect={(id) => openClaimDetail(id, "flagged")}
            />
          )}

          {/* Need your input tab — bills awaiting review answers */}
          {tab === "input" && (
            <FilteredBillList
              claims={reviewClaims}
              billStates={billStates}
              questionCountFor={questionCountFor}
              emptyCopy="Nothing needs your input right now."
              onSelect={(id) => openClaimDetail(id, "input")}
            />
          )}

          {/* Letters to send tab — drafted letters + ready to draft + outcomes */}
          {tab === "letters" && (
            <>
              <DisputeMetrics />

              {!hasDisputes && readyToDraftClaims.length === 0 && (
                <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center">
                  <p className="mb-4 text-sm text-gray-500">
                    No disputes filed yet. Flag an issue on one of your bills to draft your first dispute letter.
                  </p>
                  <button
                    onClick={() => setTab("bills")}
                    className="inline-flex items-center gap-1 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    View bills
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
              )}

              {activeDisputes.length > 0 && (
                <div className="mb-6">
                  <SectionHeader>Letters to send</SectionHeader>
                  <div className="space-y-3">
                    {activeDisputes.map((d) => (
                      <DraftedDisputeCard
                        key={d.id}
                        dispute={d}
                        provider={claims.find((c) => c.id === d.claimId)?.providerName ?? ""}
                        onOpen={() => {
                          if (d.claimId) openClaimDetail(d.claimId, "letters");
                        }}
                        onUpdate={(update) => handleOutcomeUpdate(d.id, update)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* "Ready to draft" subhead between drafted + ready — design canvas line 376 */}
              {readyToDraftClaims.length > 0 && (
                <div className="mb-6">
                  <SectionHeader>Ready to draft</SectionHeader>
                  <div className="space-y-3">
                    {readyToDraftClaims.map((claim) => (
                      <BillCard
                        key={claim.id}
                        claim={claim}
                        state="overcharge_no_draft"
                        onSelect={(id) => openClaimDetail(id, "letters")}
                      />
                    ))}
                  </div>
                </div>
              )}

              {resolvedDisputes.length > 0 && (
                <div className="mb-6">
                  <SectionHeader>Resolved</SectionHeader>
                  <div className="space-y-3">
                    {resolvedDisputes.map((d) => (
                      <DraftedDisputeCard
                        key={d.id}
                        dispute={d}
                        provider={claims.find((c) => c.id === d.claimId)?.providerName ?? ""}
                        onOpen={() => {
                          if (d.claimId) openClaimDetail(d.claimId, "letters");
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Escalation cards for lost disputes — PRESERVED per D-§1.D.1-F */}
              {lostDisputes.length > 0 && (
                <div className="mb-6">
                  <SectionHeader>Next steps</SectionHeader>
                  <div className="space-y-3">
                    {lostDisputes.map((d) => (
                      <EscalationCard
                        key={`escalate-${d.id}`}
                        dispute={{
                          id: d.id,
                          disputeType: d.disputeType,
                          amountDisputed: d.amountDisputed,
                        }}
                        onEscalate={async (type) => {
                          try {
                            const token = await user!.firebaseUser.getIdToken();
                            await fetch("/api/disputes/escalate", {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                              body: JSON.stringify({ disputeId: d.id, escalationType: type }),
                            });
                          } catch {
                            /* non-blocking */
                          }
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Bottom disclaimer — D-§1.D.1-N */}
          <Disclaimer variant="coverage_check" className="mt-8" />
        </>
      )}
    </div>
  );

  async function handleOutcomeUpdate(disputeId: string, update: { status: string; amountRecovered?: number }) {
    try {
      if (!user) return;
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/disputes/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          disputeId,
          status: update.status,
          amountRecovered: update.amountRecovered,
          resolutionDate: new Date().toISOString().split("T")[0],
        }),
      });
      if (res.ok) {
        const refreshedRes = await fetch(`/api/disputes/outcome`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (refreshedRes.ok) {
          const refreshed = await refreshedRes.json();
          if (refreshed && Array.isArray(refreshed.disputes)) {
            setDisputeData(refreshed);
          }
        }
      }
    } catch (err) {
      console.error("Failed to update dispute:", err);
    }
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

/** Flat filtered bill list for the Flagged / Need-your-input tabs. */
function FilteredBillList({
  claims,
  billStates,
  questionCountFor,
  emptyCopy,
  onSelect,
}: {
  claims: PipelineClaimSummary[];
  billStates: Map<string, BillState>;
  questionCountFor: (claim: PipelineClaimSummary) => number;
  emptyCopy: string;
  onSelect: (claimId: string) => void;
}) {
  if (claims.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center">
        <p className="text-sm text-gray-500">{emptyCopy}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {claims.map((claim) => (
        <BillCard
          key={claim.id}
          claim={claim}
          state={billStates.get(claim.id) ?? "clean"}
          reviewQuestionCount={questionCountFor(claim)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// Design .tab + .tab-count (styles.css lines 219-231):
//   .tab { padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 500; color: var(--fg-4); }
//   .tab.is-active { background: var(--bg-3); color: var(--fg-2); font-weight: 600; }
//   .tab-count { background: var(--bg-3); color: var(--fg-3); }
//   .tab.is-active .tab-count { background: #fff; color: var(--candid-blue-700); }
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-[13px] transition-colors",
        active
          ? "bg-gray-100 font-semibold text-gray-900"
          : "font-medium text-gray-500 hover:text-gray-900",
      )}
    >
      {children}
    </button>
  );
}

function TabCount({ count, active }: { count: number; active: boolean }) {
  if (count === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-[1px] text-[10px] font-bold tabular-nums",
        active ? "bg-white text-blue-700" : "bg-gray-100 text-gray-600",
      )}
    >
      {count}
    </span>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-gray-500">
      {children}
    </h2>
  );
}

/**
 * Drafted dispute card — design chrome per claim-summary.jsx lines 342-410.
 * S138 (design fidelity sweep): adopts design's blue-tinted .billcard variant
 * for active drafts. Surface 2: the "Open draft" footer action becomes a big
 * solid-blue button matching the new bill-card buttons.
 * NON-NEGOTIABLE: preserves Session 35 T2.8 lifecycle vocab + outcome capture flows.
 */
function DraftedDisputeCard({
  dispute,
  provider,
  onOpen,
  onUpdate,
}: {
  dispute: PipelineDispute;
  provider: string;
  onOpen?: () => void;
  onUpdate?: (update: { status: string; amountRecovered?: number }) => void;
}) {
  const [showOutcome, setShowOutcome] = useState(false);
  const [recoveredAmount, setRecoveredAmount] = useState("");

  const isActive = ["filed", "in_progress", "dispute_letter_drafted", "court_documentation_drafted"].includes(
    dispute.status,
  );
  const typeLabel = TYPE_LABELS[dispute.disputeType] || dispute.disputeType;
  const statusLabel = STATUS_LABELS[dispute.status] || dispute.status;
  const statusClass = STATUS_STYLES[dispute.status] || "text-gray-700 bg-gray-50 ring-gray-200";
  const refId = dispute.id.slice(0, 8).toUpperCase();
  const filedDateLabel = formatShortDate(dispute.filedDate);

  const cardChromeCls = isActive
    ? "border-blue-100 bg-gradient-to-br from-blue-50/40 to-white hover:border-blue-200 hover:shadow-blue-100/40"
    : "border-gray-200 bg-white hover:border-gray-300";

  return (
    <div className={cn("overflow-hidden rounded-2xl border transition-all", cardChromeCls)}>
      {/* Header — design chrome with .billcard.flagged blue-tinted icon container */}
      <div
        className={cn(
          "flex items-start justify-between gap-3 border-b px-5 py-4",
          isActive ? "border-blue-100/60" : "border-gray-100",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              isActive ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600",
            )}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-snug text-gray-900">
              {typeLabel} · ${dispute.amountDisputed.toLocaleString()}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-500">
              <span className="font-mono text-[11px]">Ref {refId}</span>
              {provider && (
                <>
                  <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden="true" />
                  <span className="truncate">{provider}</span>
                </>
              )}
              <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden="true" />
              <span>
                {dispute.resolutionDate
                  ? `Resolved ${formatShortDate(dispute.resolutionDate)}`
                  : `Filed ${filedDateLabel}`}
              </span>
            </div>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset",
            statusClass,
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {statusLabel}
        </span>
      </div>

      {/* Footer */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 px-5 py-3",
          isActive && "bg-blue-50/30",
        )}
      >
        <span className="text-xs text-gray-500">
          {dispute.amountRecovered > 0
            ? `$${dispute.amountRecovered.toLocaleString()} recovered`
            : isActive
              ? "Awaiting response — log when it arrives"
              : ""}
        </span>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              isActive
                ? "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-600 px-[18px] py-2.5 text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15),0_8px_32px_hsla(217,91%,60%,0.10)] transition-all hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25),0_12px_40px_hsla(217,91%,60%,0.15)]"
                : "inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-all hover:gap-1.5 hover:text-blue-700",
            )}
          >
            {isActive ? "Open draft" : "Open"}
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={isActive ? 2.5 : 2} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={isActive ? "M5 12h14M12 5l7 7-7 7" : "M9 5l7 7-7 7"} />
            </svg>
          </button>
        )}
      </div>

      {/* Outcome capture — preserved per NON-NEGOTIABLE D-§1.D.1-K */}
      {isActive && onUpdate && !showOutcome && (
        <div className="flex flex-wrap gap-2 border-t border-gray-50 bg-gray-50/30 px-5 py-3">
          <button
            onClick={() => setShowOutcome(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-700 transition-colors hover:bg-green-100"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Mark as resolved
          </button>
          <button
            onClick={() => onUpdate({ status: "in_progress" })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Mark in progress
          </button>
        </div>
      )}

      {showOutcome && onUpdate && (
        <div className="border-t border-gray-50 bg-gray-50/30 px-5 py-3">
          <div className="mb-2 flex items-center gap-2">
            <label className="text-xs text-gray-600">Amount recovered:</label>
            <input
              type="number"
              value={recoveredAmount}
              onChange={(e) => setRecoveredAmount(e.target.value)}
              placeholder="0.00"
              className="w-28 rounded-lg border border-gray-200 px-2 py-1 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                onUpdate({ status: "won", amountRecovered: parseFloat(recoveredAmount) || 0 });
                setShowOutcome(false);
              }}
              className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
            >
              Won
            </button>
            <button
              onClick={() => {
                onUpdate({ status: "settled", amountRecovered: parseFloat(recoveredAmount) || 0 });
                setShowOutcome(false);
              }}
              className="rounded-lg border border-green-200 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-50"
            >
              Settled
            </button>
            <button
              onClick={() => {
                onUpdate({ status: "lost" });
                setShowOutcome(false);
              }}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
            >
              Lost
            </button>
            <button
              onClick={() => setShowOutcome(false)}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

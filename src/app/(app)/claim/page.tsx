"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BillCard } from "@/components/claims/BillCard";
import { ClaimDetail } from "@/components/claims/ClaimDetail";
import { DiscrepancyList } from "@/components/claims/DiscrepancyList";
import { FollowupBanner } from "@/components/disputes/FollowupBanner";
import { DisputeMetrics } from "@/components/disputes/DisputeMetrics";
import { EscalationCard } from "@/components/disputes/EscalationCard";
import { RecoveryHero, type RecoveryHeroStats } from "@/components/claims/RecoveryHero";
import { ClaimPreviewEmptyState } from "@/components/claims/ClaimPreviewEmptyState";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { PageHeader } from "@/components/page-header";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useMinHoldLoading } from "@/lib/loading/use-min-hold";
import {
  deriveBillState,
  type BillState,
  type AuditFinding,
} from "@/lib/claims/derive-bill-state";
import { cn } from "@/lib/utils/cn";

// ── Types ────────────────────────────────────────────────────────────────────

interface Dispute {
  id: string;
  disputeType: string;
  status: string;
  amountDisputed: number;
  amountRecovered: number;
  filedDate: string;
  resolutionDate: string | null;
  claimId: string | null;
}

interface DisputeData {
  disputes: Dispute[];
  totalRecovered: number;
  activeCount: number;
}

interface ClaimSummary {
  id: string;
  date_of_service: string | null;
  status: string;
  total_billed: number | null;
  total_patient_responsibility: number | null;
  total_insurance_adjusted?: number | null;
  lineItemCount: number;
  findingCount: number;
  providerName: string;
  created_at: string;
  potentialSavings?: number;
  reviewNeededCount?: number;
  reviewLineItems?: Array<{
    id: string;
    description: string | null;
    billing_code: string | null;
    service_slug: string | null;
    billed_amount: number | null;
  }>;
  topFindings?: Array<{ title: string; estimatedOvercharge: number; billingCode?: string | null }>;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
  };
}

interface ClaimStats {
  totalBills: number;
  flaggedBills: number;
  totalBilled: number;
  totalPatientResponsibility: number;
  totalPotentialSavings: number;
  totalIssuesFlagged: number;
  totalPotentialRecovery?: number;
  totalRefundComponent?: number;
  totalForgivenessComponent?: number;
  totalAlreadyPaid?: number;
}

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

type Tab = "bills" | "discrepancies" | "disputes";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the BillState for a single claim by translating the existing claim
 * shape into AuditFinding[] consumed by `deriveBillState()`. The derivation
 * lives in `src/lib/claims/derive-bill-state.ts` (B1.3b) so the same 4-state
 * vocab is reused by B4.2 ClaimDetail.
 */
function buildBillState(
  claim: ClaimSummary,
  allDiscrepancies: Array<{ claim_id?: string; tier?: number | null; status?: string | null }>,
  allDisputes: Dispute[],
): BillState {
  const claimDiscrepancies = allDiscrepancies.filter((d) => d.claim_id === claim.id);
  const claimDisputes = allDisputes.filter((d) => d.claimId === claim.id);

  const findings: AuditFinding[] = [];
  // B4.1-FIX1: recovery math is sufficient signal for overcharge — formal audit
  // findings are supplementary, not gating. A bill where plan-vs-bill math shows
  // shouldOwe < billed has a real recovery opportunity regardless of whether a
  // named audit rule fired. $10 minimum threshold filters cosmetic deltas from
  // user-actionable overcharges.
  const recovery = claim.recovery?.potentialRecovery ?? claim.potentialSavings ?? 0;
  const OVERCHARGE_THRESHOLD_USD = 10;
  if (recovery > OVERCHARGE_THRESHOLD_USD) {
    findings.push({ severity: "overcharge", recovery_amount: recovery, confidence: 1 });
  }
  // Surface uncertainty when any gap row remains unresolved (billed > 0,
  // no insurer payment, no patient assignment). Once a user resolves
  // coverage via the modal, the resulting line is treated identically to
  // a system-classified line — no separate uncategorized-count branch.
  if ((claim.reviewNeededCount ?? 0) > 0) {
    findings.push({ severity: "needs_review", confidence: 0.5 });
  }

  return deriveBillState(
    { audit_findings: findings },
    claimDiscrepancies.map((d) => ({ tier: d.tier ?? null, status: d.status ?? null })),
    claimDisputes.map((d) => ({ status: d.status })),
  );
}

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
  const urlFromTab = (searchParams.get("from") as Tab | null) ?? null;

  const [tab, setTab] = useState<Tab>(urlFromTab || "bills");
  const selectedClaimId = urlClaimId;
  const focusLineItemId = urlFocusId;
  const tabBeforeDetail: Tab = urlFromTab || "bills";

  // Claims data
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [claimStats, setClaimStats] = useState<ClaimStats | null>(null);
  const [claimsLoading, setClaimsLoading] = useState(true);

  // Discrepancies data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [discrepancies, setDiscrepancies] = useState<any[]>([]);
  const [discrepancySummary, setDiscrepancySummary] = useState({ total: 0, tier2: 0, tier3: 0, systemic: 0 });
  const [discrepanciesLoading, setDiscrepanciesLoading] = useState(true);

  // Disputes data
  const [disputeData, setDisputeData] = useState<DisputeData | null>(null);
  const [disputesLoading, setDisputesLoading] = useState(true);

  // S132 iter-6 Phase 1 — extracted to useCallback so ClaimDetail can trigger
  // a list-wide refetch after the user changes a line-item category. Without
  // this, the bill card on /claim list shows stale state (old coverageStatus,
  // old recovery math, old unknownCoverageCount) until the page is reloaded.
  const refetchClaims = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.firebaseUser.getIdToken();
      const headers = { Authorization: `Bearer ${token}` };

      const [claimsRes, discRes] = await Promise.all([
        fetch("/api/claims", { headers }),
        fetch("/api/claims/discrepancies", { headers }),
      ]);

      const claimsData = claimsRes.ok ? await claimsRes.json() : { claims: [], stats: null };
      setClaims(claimsData.claims || []);
      setClaimStats(claimsData.stats || null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let persistedDiscrepancies: any[] = [];
      if (discRes.ok) {
        const data = await discRes.json();
        persistedDiscrepancies = data.discrepancies || [];
      }
      // S132 iter-11 — frontend filter on user_corrected_at REMOVED. Root cause
      // now fixed at /api/claims/[claimId]/line-items/[lineId]/correct-category
      // (marks discrepancies on the line as 'resolved' on every category
      // change). The /api/claims/discrepancies endpoint excludes 'resolved'
      // rows from its default query, so stale entries no longer surface here.

      // Synthesize "review" discrepancies client-side from claims where
      // eob_discrepancy_detection didn't run (empty claim_discrepancies table).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const synthesized: any[] = [];
      for (const c of (claimsData.claims || []) as ClaimSummary[]) {
        for (const li of c.reviewLineItems || []) {
          const alreadyPersisted = persistedDiscrepancies.some(
            (d) => d.claim_line_item_id === li.id,
          );
          if (alreadyPersisted) continue;
          synthesized.push({
            id: `synth-${li.id}`,
            claim_id: c.id,
            claim_line_item_id: li.id,
            service_slug: li.service_slug || "unknown",
            tier: 2,
            field: "coverage_status",
            expected_value: "Covered — see plan",
            actual_value: `$${(li.billed_amount || 0).toLocaleString()} billed · $0 paid · $0 owed`,
            expected_source: "user_plan",
            expected_confidence: 0.5,
            status: "flagged",
            is_systemic: false,
            systemic_user_count: null,
            metadata: { synthesized: true, providerName: c.providerName, dateOfService: c.date_of_service },
            claim_line_items: {
              description: li.description,
              billing_code: li.billing_code,
              billing_code_type: null,
              billed_amount: li.billed_amount,
              patient_owes: 0,
            },
          });
        }
      }

      const allDiscrepancies = [...persistedDiscrepancies, ...synthesized];
      setDiscrepancies(allDiscrepancies);
      setDiscrepancySummary({
        total: allDiscrepancies.length,
        tier2: allDiscrepancies.filter((d) => d.tier === 2).length,
        tier3: allDiscrepancies.filter((d) => d.tier === 3).length,
        systemic: allDiscrepancies.filter((d) => d.is_systemic).length,
      });
    } catch (err) {
      console.error("Failed to load data:", err);
    }
    setClaimsLoading(false);
    setDiscrepanciesLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) return;

    // Load disputes. S74 (PR #66) hardened the endpoint to require a Firebase
    // bearer token + derive userId from the decoded claims.
    (async () => {
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/disputes/outcome`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const result = await res.json();
          if (result && Array.isArray(result.disputes)) {
            setDisputeData(result);
          }
        }
      } catch (err) {
        console.error("Failed to load disputes:", err);
      } finally {
        setDisputesLoading(false);
      }
    })();

    refetchClaims();
  }, [user, refetchClaims]);

  const dataLoading = claimsLoading || disputesLoading || discrepanciesLoading;
  const loading = useMinHoldLoading(dataLoading);

  // Derive per-claim BillState in one pass; reused by Bills list + Disputes tab + hero stats.
  const billStates = useMemo(() => {
    const map = new Map<string, BillState>();
    for (const c of claims) {
      map.set(c.id, buildBillState(c, discrepancies, disputeData?.disputes ?? []));
    }
    return map;
  }, [claims, discrepancies, disputeData]);

  async function handleDiscrepancyStatusChange(discrepancyId: string, newStatus: string) {
    try {
      const token = await user!.firebaseUser.getIdToken();
      const res = await fetch("/api/claims/discrepancies", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ discrepancyId, status: newStatus }),
      });
      if (res.ok) {
        if (newStatus === "ignored" || newStatus === "resolved") {
          setDiscrepancies((prev) => prev.filter((d) => d.id !== discrepancyId));
          setDiscrepancySummary((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
        } else {
          setDiscrepancies((prev) =>
            prev.map((d) => (d.id === discrepancyId ? { ...d, status: newStatus } : d))
          );
        }
      }
    } catch (err) {
      console.error("Failed to update discrepancy:", err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleDiscrepancyDispute(discrepancy: any) {
    if (discrepancy?.claim_id) {
      const focus = discrepancy.claim_line_item_id || "";
      router.push(
        `/claim?claim=${discrepancy.claim_id}&from=discrepancies${focus ? `&focus=${focus}` : ""}`,
      );
    } else {
      router.push(`/upload?dispute_from=${discrepancy.claim_id}`);
    }
  }

  function openClaimDetail(claimId: string, sourceTab: Tab) {
    router.push(`/claim?claim=${claimId}&from=${sourceTab}`);
  }

  function closeClaimDetail() {
    // S109 explicit push (NON-NEGOTIABLE preserve).
    router.push(`/claim?tab=${tabBeforeDetail}`);
  }

  if (loading) {
    // S132 iter-8 — unified cube loader; audit loader retired.
    return <CubeLoaderBuilding />;
  }

  // If viewing claim detail, render that view only (NON-NEGOTIABLE preserve per D-§1.D.1-E).
  // S138: detail container bumped to max-w-4xl (896px) — design uses 1120px content
  // area; the 8-col line-items grid needs ~880px minimum (488 fixed + 56 gaps + 40
  // padding + 296 service flex). Previously at max-w-3xl (768px) the service col
  // collapsed to 0px because fixed cols exceeded available width.
  if (selectedClaimId) {
    return (
      <div className="mx-auto max-w-4xl">
        <ClaimDetail
          claimId={selectedClaimId}
          onBack={closeClaimDetail}
          focusLineItemId={focusLineItemId}
          backLabel={tabBeforeDetail === "discrepancies" ? "Back to discrepancies" : "Back to bills"}
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

  // Aggregate bill-state counts for the hero. We count BILLS (not line items),
  // matching the design's stat semantics ("Issues flagged" = bills with overcharge,
  // "Need your input" = bills in review state, "Disputes drafted" = bills with draft).
  const stateCounts = { overcharge: 0, drafted: 0, review: 0 };
  for (const c of claims) {
    const s = billStates.get(c.id);
    if (s === "overcharge_no_draft" || s === "overcharge_drafted") stateCounts.overcharge += 1;
    if (s === "overcharge_drafted") stateCounts.drafted += 1;
    if (s === "needs_review") stateCounts.review += 1;
  }

  // Ready-to-draft = flagged bills without a draft yet (state === 'overcharge_no_draft').
  const readyToDraftClaims = claims.filter(
    (c) => billStates.get(c.id) === "overcharge_no_draft",
  );

  const heroStats: RecoveryHeroStats = {
    totalRecovery: claimStats?.totalPotentialRecovery ?? claimStats?.totalPotentialSavings ?? 0,
    billsCount: claims.length,
    issuesCount: stateCounts.overcharge,
    disputesCount: stateCounts.drafted,
    reviewCount: stateCounts.review,
  };

  // CTA destination: prefer drafted disputes tab; else surface flagged bills.
  function handleHeroPrimary() {
    if (stateCounts.drafted > 0 || readyToDraftClaims.length > 0) {
      setTab("disputes");
    }
  }

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
          {/* RecoveryHero — D-§1.D.1-A */}
          <RecoveryHero stats={heroStats} variant="calm" onPrimary={handleHeroPrimary} />

          {/* Tabbar with top-right Upload button per design canvas line 303-318
              + styles.css .tabs / .tab / .tab-count family.
              S138: white bg + gray border + larger padding to match design. */}
          <div className="mb-5 mt-8 flex flex-wrap items-center justify-between gap-3">
            <div className="flex w-fit gap-1 rounded-2xl border border-gray-200 bg-white p-1">
              <TabButton active={tab === "bills"} onClick={() => setTab("bills")}>
                Bills
                <TabCount count={claims.length} active={tab === "bills"} />
              </TabButton>
              <TabButton
                active={tab === "discrepancies"}
                onClick={() => setTab("discrepancies")}
              >
                Discrepancies
                <TabCount count={discrepancySummary.total} active={tab === "discrepancies"} />
              </TabButton>
              <TabButton active={tab === "disputes"} onClick={() => setTab("disputes")}>
                Disputes
                <TabCount count={disputeData?.disputes.length || 0} active={tab === "disputes"} />
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

          {/* Bills tab */}
          {tab === "bills" && (
            <div className="space-y-3">
              {claims.map((claim) => (
                <BillCard
                  key={claim.id}
                  claim={claim}
                  state={billStates.get(claim.id) ?? "clean"}
                  onSelect={(id) => openClaimDetail(id, "bills")}
                />
              ))}

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

          {/* Discrepancies tab — preserve DiscrepancyList (D-§1.D.1-J + Round 2 Item 3) */}
          {tab === "discrepancies" && (
            <DiscrepancyList
              discrepancies={discrepancies}
              summary={discrepancySummary}
              onStatusChange={handleDiscrepancyStatusChange}
              onDispute={handleDiscrepancyDispute}
            />
          )}

          {/* Disputes tab — design chrome adoption (D-§1.D.1-K) */}
          {tab === "disputes" && (
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
                  <SectionHeader>Active disputes</SectionHeader>
                  <div className="space-y-3">
                    {activeDisputes.map((d) => (
                      <DraftedDisputeCard
                        key={d.id}
                        dispute={d}
                        provider={claims.find((c) => c.id === d.claimId)?.providerName ?? ""}
                        onOpen={() => {
                          if (d.claimId) openClaimDetail(d.claimId, "disputes");
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
                        onSelect={(id) => openClaimDetail(id, "disputes")}
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
                          if (d.claimId) openClaimDetail(d.claimId, "disputes");
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
 * for active drafts (3 items would strengthen this letter copy + Open draft chev).
 * Visual chrome: icon + "Appeal to {insurer} · ${amount}" title + Ref ID monospace
 * + provider + filed/resolved date + status pill + footer with outcome capture.
 * NON-NEGOTIABLE: preserves Session 35 T2.8 lifecycle vocab + outcome capture flows.
 */
function DraftedDisputeCard({
  dispute,
  provider,
  onOpen,
  onUpdate,
}: {
  dispute: Dispute;
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

  // S138 — active drafts get the blue-tinted .billcard variant per design;
  // resolved disputes stay neutral white.
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
          "flex items-center justify-between gap-3 px-5 py-3",
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
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition-all hover:gap-1.5 hover:text-blue-700"
          >
            {isActive ? "Open draft" : "Open"}
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
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

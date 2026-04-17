"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useEffect, useState } from "react";
import { BillCard } from "@/components/claims/BillCard";
import { ClaimDetail } from "@/components/claims/ClaimDetail";
import { DiscrepancyList } from "@/components/claims/DiscrepancyList";
import { FollowupBanner } from "@/components/disputes/FollowupBanner";
import { DisputeMetrics } from "@/components/disputes/DisputeMetrics";
import { EscalationCard } from "@/components/disputes/EscalationCard";
import { ClaimImpactHero } from "@/components/claims/ClaimImpactHero";
import { ClaimPreviewEmptyState } from "@/components/claims/ClaimPreviewEmptyState";
import { Disclaimer } from "@/components/shared/Disclaimer";

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
}

interface ClaimStats {
  totalBills: number;
  flaggedBills: number;
  totalBilled: number;
  totalPatientResponsibility: number;
  totalPotentialSavings: number;
  totalIssuesFlagged: number;
}

const TYPE_LABELS: Record<string, string> = {
  internal_appeal: "Insurance Appeal",
  external_appeal: "External Appeal",
  complaint: "Complaint",
  legal: "Legal Action",
  negotiation: "Billing Dispute",
};

const STATUS_STYLES: Record<string, string> = {
  filed: "text-blue-700 bg-blue-50",
  in_progress: "text-amber-700 bg-amber-50",
  won: "text-green-700 bg-green-50",
  lost: "text-red-700 bg-red-50",
  settled: "text-green-700 bg-green-50",
  withdrawn: "text-gray-700 bg-gray-50",
};

const STATUS_LABELS: Record<string, string> = {
  filed: "Filed",
  in_progress: "Under Review",
  won: "Won",
  lost: "Lost",
  settled: "Settled",
  withdrawn: "Withdrawn",
};

type Tab = "bills" | "discrepancies" | "disputes";

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CandidClaimPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("bills");
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  // Optional line-item to auto-focus when opening from a discrepancy
  const [focusLineItemId, setFocusLineItemId] = useState<string | null>(null);
  // Remember which tab the user came from so the breakdown back-button returns
  // them to the same place (bills list or discrepancies list).
  const [tabBeforeDetail, setTabBeforeDetail] = useState<Tab>("bills");

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

  useEffect(() => {
    if (!user) return;

    // Load disputes
    fetch(`/api/disputes/outcome?userId=${user.userId}`)
      .then((res) => res.json())
      .then((result) => {
        setDisputeData(result);
        setDisputesLoading(false);
      })
      .catch(() => setDisputesLoading(false));

    // Load claims + discrepancies
    async function loadData() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const headers = { Authorization: `Bearer ${token}` };

        // Fetch claims + discrepancies in parallel
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

        // Synthesize "review" discrepancies client-side from claims where
        // eob_discrepancy_detection didn't run (empty claim_discrepancies table).
        // Fallback so users always see unverified-charge items, even before backfill.
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
    }
    loadData();
  }, [user]);

  const loading = claimsLoading || disputesLoading || discrepanciesLoading;

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
    // Open the ClaimDetail for this discrepancy's claim so the user can review
    // the full facts and trigger the dispute letter flow from the line-item view.
    if (discrepancy?.claim_id) {
      setTabBeforeDetail("discrepancies");
      setFocusLineItemId(discrepancy.claim_line_item_id || null);
      setSelectedClaimId(discrepancy.claim_id);
    } else {
      router.push(`/upload?dispute_from=${discrepancy.claim_id}`);
    }
  }

  function openClaimDetail(claimId: string, sourceTab: Tab) {
    setTabBeforeDetail(sourceTab);
    setFocusLineItemId(null);
    setSelectedClaimId(claimId);
  }

  function closeClaimDetail() {
    setSelectedClaimId(null);
    setFocusLineItemId(null);
    setTab(tabBeforeDetail);
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  // If viewing claim detail, render that view only
  if (selectedClaimId) {
    return (
      <div className="mx-auto max-w-3xl">
        <ClaimDetail
          claimId={selectedClaimId}
          onBack={closeClaimDetail}
          focusLineItemId={focusLineItemId}
          backLabel={tabBeforeDetail === "discrepancies" ? "Back to discrepancies" : "Back to bills"}
        />
      </div>
    );
  }

  const hasDisputes = disputeData && disputeData.disputes.length > 0;
  const hasBills = claims.length > 0;
  const activeDisputes = disputeData?.disputes.filter((d) => d.status === "filed" || d.status === "in_progress") || [];
  const resolvedDisputes = disputeData?.disputes.filter((d) => d.status === "won" || d.status === "settled" || d.status === "lost" || d.status === "withdrawn") || [];
  const lostDisputes = resolvedDisputes.filter((d) => d.status === "lost");

  // Hero stats
  const heroStats = {
    potentialSavings: claimStats?.totalPotentialSavings || 0,
    totalRecovered: disputeData?.totalRecovered || 0,
    billsAnalyzed: claimStats?.totalBills || 0,
    issuesFlagged: claimStats?.totalIssuesFlagged || 0,
    disputesFiled: disputeData?.disputes.length || 0,
  };

  return (
    <div className="mx-auto max-w-3xl">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Candid Claim</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every bill audited. Every error found. Every dollar tracked.
        </p>
      </div>

      {/* ── Follow-up banners ──────────────────────────────────────────── */}
      <FollowupBanner />

      {/* ── Hero impact card ──────────────────────────────────────────── */}
      <div className="mb-6">
        <ClaimImpactHero stats={heroStats} isEmpty={!hasBills} />
      </div>

      {/* ── Empty state ───────────────────────────────────────────────── */}
      {!hasBills && <ClaimPreviewEmptyState />}

      {/* ── Coverage-check disclaimer (persistent footer context) ─────── */}
      {!hasBills && <Disclaimer variant="coverage_check" className="mt-6" />}

      {/* ── Populated state ───────────────────────────────────────────── */}
      {hasBills && (
        <>
          {/* Tabs */}
          <div className="mb-4 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
            <TabButton active={tab === "bills"} onClick={() => setTab("bills")}>
              Bills
              <TabBadge count={claims.length} active={tab === "bills"} />
            </TabButton>
            <TabButton active={tab === "discrepancies"} onClick={() => setTab("discrepancies")}>
              Discrepancies
              <TabBadge count={discrepancySummary.total} active={tab === "discrepancies"} />
            </TabButton>
            <TabButton active={tab === "disputes"} onClick={() => setTab("disputes")}>
              Disputes
              <TabBadge count={disputeData?.disputes.length || 0} active={tab === "disputes"} />
            </TabButton>
          </div>

          {/* Bills tab */}
          {tab === "bills" && (
            <div className="space-y-3">
              {claims.map((claim) => (
                <BillCard
                  key={claim.id}
                  claim={claim}
                  onSelect={(id) => openClaimDetail(id, "bills")}
                />
              ))}

              {/* Upload another bill CTA */}
              <Link
                href="/upload"
                className="group block rounded-2xl border-2 border-dashed border-gray-200 bg-white p-5 text-center transition-colors hover:border-blue-300 hover:bg-blue-50/30"
              >
                <p className="text-sm font-semibold text-gray-700 group-hover:text-blue-700">
                  + Upload another bill
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  EOB, itemized bill, or statement
                </p>
              </Link>
            </div>
          )}

          {/* Discrepancies tab */}
          {tab === "discrepancies" && (
            <DiscrepancyList
              discrepancies={discrepancies}
              summary={discrepancySummary}
              onStatusChange={handleDiscrepancyStatusChange}
              onDispute={handleDiscrepancyDispute}
            />
          )}

          {/* Disputes tab */}
          {tab === "disputes" && (
            <>
              <DisputeMetrics />

              {!hasDisputes && (
                <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center">
                  <p className="mb-4 text-sm text-gray-500">
                    No disputes filed yet. Flag an issue on one of your bills to draft your first dispute letter.
                  </p>
                  <button
                    onClick={() => setTab("bills")}
                    className="inline-flex items-center gap-1 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    View bills
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
              )}

              {activeDisputes.length > 0 && (
                <div className="mb-6">
                  <h2 className="mb-3 text-base font-semibold text-gray-900">Active Disputes</h2>
                  <div className="space-y-2">
                    {activeDisputes.map((d) => (
                      <DisputeCard key={d.id} dispute={d} onUpdate={(update) => handleOutcomeUpdate(d.id, update)} />
                    ))}
                  </div>
                </div>
              )}

              {resolvedDisputes.length > 0 && (
                <div className="mb-6">
                  <h2 className="mb-3 text-base font-semibold text-gray-900">Resolved</h2>
                  <div className="space-y-2">
                    {resolvedDisputes.map((d) => (
                      <DisputeCard key={d.id} dispute={d} />
                    ))}
                  </div>
                </div>
              )}

              {/* Escalation cards for lost disputes */}
              {lostDisputes.length > 0 && (
                <div className="mb-6">
                  <h2 className="mb-3 text-base font-semibold text-gray-900">Next Steps</h2>
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
                          } catch { /* non-blocking */ }
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Legal disclaimer footer (always visible with data) ────────── */}
      {hasBills && <Disclaimer variant="coverage_check" className="mt-8" />}
    </div>
  );

  async function handleOutcomeUpdate(disputeId: string, update: { status: string; amountRecovered?: number }) {
    try {
      const res = await fetch("/api/disputes/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeId,
          status: update.status,
          amountRecovered: update.amountRecovered,
          resolutionDate: new Date().toISOString().split("T")[0],
        }),
      });
      if (res.ok) {
        const refreshed = await fetch(`/api/disputes/outcome?userId=${user?.userId}`).then((r) => r.json());
        setDisputeData(refreshed);
      }
    } catch (err) {
      console.error("Failed to update dispute:", err);
    }
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors ${
        active ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {children}
    </button>
  );
}

function TabBadge({ count, active }: { count: number; active: boolean }) {
  if (count === 0) return null;
  return (
    <span
      className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums ${
        active ? "bg-blue-50 text-blue-700" : "bg-gray-200 text-gray-600"
      }`}
    >
      {count}
    </span>
  );
}

function DisputeCard({ dispute, onUpdate }: { dispute: Dispute; onUpdate?: (update: { status: string; amountRecovered?: number }) => void }) {
  const [showOutcome, setShowOutcome] = useState(false);
  const [recoveredAmount, setRecoveredAmount] = useState("");
  const isActive = dispute.status === "filed" || dispute.status === "in_progress";
  const [daysAgo] = useState(() => Math.floor((Date.now() - new Date(dispute.filedDate).getTime()) / (1000 * 60 * 60 * 24)));

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-gray-900">
              {TYPE_LABELS[dispute.disputeType] || dispute.disputeType}
            </p>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[dispute.status] || "text-gray-700 bg-gray-50"}`}>
              {STATUS_LABELS[dispute.status] || dispute.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Filed {dispute.filedDate} ({daysAgo} days ago)
            {dispute.resolutionDate && ` · Resolved ${dispute.resolutionDate}`}
          </p>
        </div>
        <div className="ml-4 shrink-0 text-right">
          <p className="text-sm font-bold text-gray-900">${dispute.amountDisputed.toLocaleString()}</p>
          {dispute.amountRecovered > 0 && (
            <p className="text-xs font-semibold text-green-600">-${dispute.amountRecovered.toLocaleString()} recovered</p>
          )}
        </div>
      </div>

      {isActive && onUpdate && !showOutcome && (
        <div className="mt-3 flex gap-2 border-t border-gray-100 pt-3">
          <button onClick={() => setShowOutcome(true)} className="text-xs font-medium text-green-600 hover:text-green-700">Mark as resolved</button>
          <button onClick={() => onUpdate({ status: "in_progress" })} className="text-xs font-medium text-amber-600 hover:text-amber-700">Mark in progress</button>
        </div>
      )}

      {showOutcome && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 flex items-center gap-2">
            <label className="text-xs text-gray-500">Amount recovered:</label>
            <input type="number" value={recoveredAmount} onChange={(e) => setRecoveredAmount(e.target.value)} placeholder="0.00" className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => { onUpdate?.({ status: "won", amountRecovered: parseFloat(recoveredAmount) || 0 }); setShowOutcome(false); }} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700">Won</button>
            <button onClick={() => { onUpdate?.({ status: "settled", amountRecovered: parseFloat(recoveredAmount) || 0 }); setShowOutcome(false); }} className="rounded-lg border border-green-200 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-50">Settled</button>
            <button onClick={() => { onUpdate?.({ status: "lost" }); setShowOutcome(false); }} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">Lost</button>
            <button onClick={() => setShowOutcome(false)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

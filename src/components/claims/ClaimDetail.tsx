"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { CategoryCorrectionModal } from "@/components/claims/CategoryCorrectionModal";

interface CodeIdentityState {
  identityId: string | null;
  communitySlug: string | null;
  promotionState: "proposed" | "corroborated" | "admin_verified" | null;
  confidence: number | null;
  conflictsWithCommunity: boolean;
  userCorrectedAt: string | null;
  userCorrectionLockedAt: string | null;
}

interface LineItem {
  id: string;
  line_number: number;
  billing_code: string | null;
  billing_code_type: string | null;
  service_slug: string | null;
  billing_code_identity_id: string | null;
  user_corrected_at: string | null;
  user_correction_locked_at: string | null;
  description: string | null;
  units: number;
  billed_amount: number | null;
  allowed_amount: number | null;
  insurance_paid: number | null;
  patient_owes: number | null;
  amount_still_outstanding: number | null;
  metadata: Record<string, unknown>;
  coverageStatus: "covered" | "not_covered" | "unknown" | null;
  planCoverage: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    source: string | null;
  } | null;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
  };
  codeIdentity?: CodeIdentityState | null;
}

interface CatalogSlug {
  slug: string;
  name: string;
  category: string;
}

interface AuditFinding {
  id: string;
  type: string;
  severity: string;
  estimatedOvercharge: number;
  title: string;
  actionable: boolean;
  // S74.5 D15 Q-E LOCK — set by /api/claims/[claimId]/findings/[findingId]/dismiss.
  // Dismissed findings are filtered out of the default display; reason corpus
  // analyzed for false-positive pattern detection (Pattern P-9 candidate).
  dismissed?: boolean;
  dismissed_at?: string;
  dismissed_reason?: string;
  dismissed_note?: string | null;
}

interface ClaimData {
  claim: Record<string, unknown>;
  lineItems: LineItem[];
  disputes: Array<{ id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number }>;
  relatedClaims: Array<{ id: string; date_of_service: string; status: string; total_billed: number }>;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
  };
  flags?: {
    categorizationFlywheelV1?: boolean;
  };
}

interface DisputeDetail {
  id: string;
  disputeType: string;
  status: string;
  amountDisputed: number;
  amountRecovered: number;
  filedDate: string | null;
  resolutionDate: string | null;
  claimId: string | null;
  letterContent: string | null;
  evidencePackage: Record<string, unknown> | null;
  lineItems: Array<{
    id: string;
    line_number: number;
    description: string | null;
    billing_code: string | null;
    billed_amount: number | null;
    insurance_paid: number | null;
    patient_owes: number | null;
  }>;
}

const COVERAGE_BADGE: Record<string, { label: string; className: string }> = {
  covered: { label: "Covered", className: "text-green-700 bg-green-50" },
  not_covered: { label: "Not Covered", className: "text-red-700 bg-red-50" },
  unknown: { label: "Unknown", className: "text-gray-500 bg-gray-100" },
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-700 bg-red-50 border-red-200",
  high: "text-orange-700 bg-orange-50 border-orange-200",
  medium: "text-amber-700 bg-amber-50 border-amber-200",
  low: "text-yellow-700 bg-yellow-50 border-yellow-200",
};

// Lifecycle labels for disputes. Legacy statuses (filed, in_progress, settled,
// withdrawn, *_on_escalation) still occur in the DB and are mapped here.
const DISPUTE_STATUS_LABEL: Record<string, string> = {
  flagged: "Flagged",
  filed: "Dispute Letter Drafted",
  dispute_letter_drafted: "Dispute Letter Drafted",
  court_documentation_drafted: "Court Documentation Drafted",
  in_progress: "In Progress",
  won: "Won",
  lost: "Lost",
  settled: "Settled",
  withdrawn: "Withdrawn",
  won_on_escalation: "Won (on escalation)",
  settled_on_escalation: "Settled (on escalation)",
};

const DISPUTE_STATUS_BADGE: Record<string, string> = {
  flagged: "text-amber-700 bg-amber-50",
  filed: "text-blue-700 bg-blue-50",
  dispute_letter_drafted: "text-blue-700 bg-blue-50",
  court_documentation_drafted: "text-purple-700 bg-purple-50",
  in_progress: "text-blue-700 bg-blue-50",
  won: "text-green-700 bg-green-50",
  lost: "text-red-700 bg-red-50",
  settled: "text-green-700 bg-green-50",
  withdrawn: "text-gray-600 bg-gray-100",
  won_on_escalation: "text-green-700 bg-green-50",
  settled_on_escalation: "text-green-700 bg-green-50",
};

const DISPUTE_TYPE_LABEL: Record<string, string> = {
  internal_appeal: "Appeal to Insurer",
  external_appeal: "External Appeal",
  complaint: "Regulatory Complaint",
  legal: "Legal Action",
  negotiation: "Self-pay Negotiation",
};

function disputeTypeLabel(type: string): string {
  return (
    DISPUTE_TYPE_LABEL[type] ||
    type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Quality-reporting codes (CPT Category II like "3074F" and HCPCS G-codes with
// zero charges) clutter the main breakdown. Hide them in a collapsible section.
function isQualityReporting(item: LineItem, findingCount: number): boolean {
  const code = (item.billing_code || "").toUpperCase();
  const isCatII = /^\d{4}F$/.test(code);
  const billed = item.billed_amount || 0;
  const paid = item.insurance_paid || 0;
  const owed = item.patient_owes || 0;
  const noCharges = billed === 0 && paid === 0 && owed === 0;
  return isCatII || (noCharges && findingCount === 0);
}

export function ClaimDetail({
  claimId,
  onBack,
  focusLineItemId,
  backLabel = "Back to claims",
}: {
  claimId: string;
  onBack: () => void;
  focusLineItemId?: string | null;
  backLabel?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedItem, setExpandedItem] = useState<string | null>(focusLineItemId || null);
  const [disputeLoading, setDisputeLoading] = useState(false);

  // S74.5 D6 — CategoryCorrectionModal state.
  // Catalog fetched lazily on first modal open + cached for subsequent opens.
  const [catalog, setCatalog] = useState<CatalogSlug[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [correctionModalLineId, setCorrectionModalLineId] = useState<string | null>(null);
  // G5 LOCK — bill-wide "Looks right?" prompt; localStorage-keyed per claim so
  // it never reappears once dismissed. Dismissal-only — never logs corroboration.
  const looksRightStorageKey = `claim-${claimId}-looks-right-dismissed`;
  const [looksRightDismissed, setLooksRightDismissed] = useState(false);
  // G5 LOCK — when user clicks "No", expand correction affordance to ALL
  // line items on the bill (not just needsReview ones).
  const [expandCorrectionToAll, setExpandCorrectionToAll] = useState(false);
  // Case C/D LOCK (§7.2) — nudge banner dismissal also keyed per claim.
  const nudgeStorageKey = `claim-${claimId}-plan-doc-nudge-dismissed`;
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  // G4 LOCK — community-vs-user conflict modal queue.
  // snoozedConflicts is a Set of line IDs the user clicked "Later" on; we
  // suppress those for the rest of the page mount and surface them again on
  // the next page load if still unresolved.
  const [snoozedConflicts, setSnoozedConflicts] = useState<Set<string>>(new Set());

  // D15 Q-E LOCK — dismiss-finding modal state.
  // dismissTarget = the finding to dismiss; null when modal closed.
  const [dismissTarget, setDismissTarget] = useState<AuditFinding | null>(null);
  // Show-dismissed toggle so users can see hidden findings if they want to
  // un-dismiss (un-dismiss is a Phase 2 follow-up; for now this is read-only).
  const [showDismissed, setShowDismissed] = useState(false);

  // Read localStorage once on mount per claim.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setLooksRightDismissed(
      window.localStorage.getItem(looksRightStorageKey) === "1",
    );
    setNudgeDismissed(
      window.localStorage.getItem(nudgeStorageKey) === "1",
    );
  }, [looksRightStorageKey, nudgeStorageKey]);

  const flywheelEnabled = Boolean(data?.flags?.categorizationFlywheelV1);

  // Prefetch catalog as soon as flywheel flag is detected as ON, so the
  // modal opens without a loading delay on the first click. Idempotent —
  // ensureCatalog short-circuits if catalog already populated.
  useEffect(() => {
    if (flywheelEnabled && !catalog && !catalogLoading) {
      void (async () => {
        setCatalogLoading(true);
        try {
          const res = await fetch("/api/service-catalog");
          if (res.ok) {
            const json = (await res.json()) as { items?: CatalogSlug[] };
            setCatalog(json.items ?? []);
          } else {
            setCatalog([]);
          }
        } catch {
          setCatalog([]);
        } finally {
          setCatalogLoading(false);
        }
      })();
    }
  }, [flywheelEnabled, catalog, catalogLoading]);

  // Lazy-load service_catalog on first modal open (kept as fallback for
  // the rare race where prefetch hasn't completed yet).
  const ensureCatalog = useCallback(async () => {
    if (catalog || catalogLoading) return;
    setCatalogLoading(true);
    try {
      const res = await fetch("/api/service-catalog");
      if (res.ok) {
        const json = (await res.json()) as { items?: CatalogSlug[] };
        setCatalog(json.items ?? []);
      } else {
        setCatalog([]);
      }
    } catch {
      setCatalog([]);
    } finally {
      setCatalogLoading(false);
    }
  }, [catalog, catalogLoading]);

  const openCorrectionModal = useCallback(
    (lineId: string) => {
      setCorrectionModalLineId(lineId);
      void ensureCatalog();
    },
    [ensureCatalog],
  );

  const getAuthToken = useCallback(async () => {
    if (!user) return null;
    return user.firebaseUser.getIdToken();
  }, [user]);

  // Refetch claim after a correction lands so the row reflects new slug + the
  // audit-status=stale mark triggers D7 re-audit on next view (separate todo).
  const refetchClaim = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/claims/${claimId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setData(await res.json());
      }
    } catch (err) {
      console.error("Refetch after correction failed:", err);
    }
  }, [user, claimId]);

  const handleCorrectionSubmitted = useCallback(async () => {
    await refetchClaim();
  }, [refetchClaim]);

  const dismissLooksRight = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(looksRightStorageKey, "1");
    }
    setLooksRightDismissed(true);
  }, [looksRightStorageKey]);

  const dismissNudge = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(nudgeStorageKey, "1");
    }
    setNudgeDismissed(true);
  }, [nudgeStorageKey]);

  // When a focus line item is provided, scroll it into view after data loads.
  // The expanded state is already initialized from focusLineItemId via useState,
  // so we only need the scroll side-effect here (no setState needed).
  useEffect(() => {
    if (!focusLineItemId || !data) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-line-item-id="${focusLineItemId}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(t);
  }, [focusLineItemId, data]);

  useEffect(() => {
    if (!user || !claimId) return;

    async function loadClaim() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch(`/api/claims/${claimId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        // S74.5 D11 — 410 Gone with mergedIntoClaimId means the URL points
        // to a merge-loser; the API tells us the canonical winner id.
        // Re-fetch under the winner id; preserves any in-flight focusLineItemId
        // because line items themselves stay attached to the loser, but the
        // user-visible row resolves to the winner.
        if (res.status === 410) {
          const body = (await res.json().catch(() => ({}))) as {
            mergedIntoClaimId?: string;
          };
          if (body.mergedIntoClaimId) {
            const retry = await fetch(
              `/api/claims/${body.mergedIntoClaimId}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (retry.ok) setData(await retry.json());
          }
        } else if (res.ok) {
          setData(await res.json());
        }
      } catch (err) {
        console.error("Failed to load claim:", err);
      }
      setLoading(false);
    }
    loadClaim();
  }, [user, claimId]);

  if (loading) {
    return <div className="p-8 text-center text-sm text-gray-500">Loading claim details...</div>;
  }

  if (!data) {
    return <div className="p-8 text-center text-sm text-gray-500">Claim not found.</div>;
  }

  const claim = data.claim as Record<string, unknown>;
  const providerName = ((claim.metadata as Record<string, unknown>)?.provider as Record<string, unknown>)?.name as string || "Unknown Provider";

  // Split line items — quality-reporting codes (CPT Cat II, zero-charge
  // HCPCS entries) are hidden in a collapsible section so the main breakdown
  // stays focused on actual charges.
  const primaryLineItems: LineItem[] = [];
  const qualityLineItems: LineItem[] = [];
  for (const item of data.lineItems) {
    const findingCount = ((item.metadata?.auditFindings || []) as AuditFinding[]).length;
    if (isQualityReporting(item, findingCount)) qualityLineItems.push(item);
    else primaryLineItems.push(item);
  }

  // S74.5 D6 — detect triggers for surface elements.
  //
  // G5 "Looks right?" trigger: at least one primary line item has a
  // promoted (corroborated or admin_verified) identity row + bill not yet
  // dismissed. Per Subplan §3 Layer C — surfaces a single bill-level prompt.
  const hasPromotedLineItem = primaryLineItems.some(
    (li) =>
      li.codeIdentity?.promotionState === "corroborated" ||
      li.codeIdentity?.promotionState === "admin_verified",
  );
  const showLooksRightPrompt =
    flywheelEnabled && !looksRightDismissed && hasPromotedLineItem;

  // Case C/D nudge trigger: flag ON + primary line items exist + NONE have
  // planCoverage (plan_covered_services empty for this insurance_plan_id, or
  // claim has no insurance_plan_id at all → Case D).
  const hasAnyPlanCoverage = primaryLineItems.some(
    (li) => li.planCoverage !== null,
  );
  const showCaseCDNudge =
    flywheelEnabled &&
    !nudgeDismissed &&
    primaryLineItems.length > 0 &&
    !hasAnyPlanCoverage;

  // G4 conflict-modal queue: any line items where codeIdentity flagged a
  // community-vs-user mismatch (post-promotion backfill) that hasn't been
  // resolved yet (no user_correction_locked_at) AND hasn't been snoozed
  // this session.
  const conflictingLines = primaryLineItems.filter(
    (li) =>
      li.codeIdentity?.conflictsWithCommunity === true &&
      !snoozedConflicts.has(li.id),
  );
  const activeConflictLine = conflictingLines[0] ?? null;
  const modalLineItem =
    correctionModalLineId != null
      ? primaryLineItems.find((li) => li.id === correctionModalLineId) ?? null
      : null;

  return (
    <div>
      {/* Back button + header */}
      <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-700 mb-4 flex items-center gap-1">
        <span>&larr;</span> {backLabel}
      </button>

      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900">{providerName}</h2>
        <p className="text-xs text-gray-500">
          {claim.date_of_service as string || "Unknown date"} · {data.lineItems.length} line items · Total: ${((claim.total_billed as number) || 0).toLocaleString()}
        </p>
      </div>

      {/* Related claims */}
      {data.relatedClaims.length > 0 && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-100 rounded-xl">
          <p className="text-xs font-semibold text-blue-700">
            Related documents ({data.relatedClaims.length}): This bill is linked to other documents from the same provider/date.
          </p>
        </div>
      )}

      {/* S74.5 D6 — Case C/D plan-doc nudge banner. Soft prompt for /claim
          per Q-C LOCK; HARD gate for dispute generation lives elsewhere. */}
      {showCaseCDNudge && (
        <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-900">
                We can&apos;t audit what we can&apos;t see.
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                Upload a Plan Document or Summary of Benefits and we&apos;ll find
                what you&apos;re owed.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => router.push("/upload?type=plan")}
                className="rounded bg-amber-700 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-800"
              >
                Upload plan
              </button>
              <button
                type="button"
                onClick={dismissNudge}
                className="text-xs text-amber-700 hover:text-amber-900"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* S74.5 D6 G5 LOCK — bill-wide "Looks right?" prompt. Triggers when at
          least one line item has a promoted identity row (corroborated or
          admin_verified). Yes-click is dismissal-only — NEVER logs a
          corroboration signal. No-click expands inline category editing to
          every line on the bill. */}
      {showLooksRightPrompt && (
        <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-blue-900">
              Does this categorization look right?
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  dismissLooksRight();
                  setExpandCorrectionToAll(true);
                }}
                className="rounded border border-blue-300 bg-white px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
              >
                No, let me fix it
              </button>
              <button
                type="button"
                onClick={dismissLooksRight}
                className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Line items table — 7-col layout per user preference.
          Code, Coverage, Flags each get their own column. Numbers right-aligned. */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden mb-4">
        <div className="grid grid-cols-12 gap-4 items-center px-5 py-3 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          <div className="col-span-4">Service</div>
          <div className="col-span-2">Code</div>
          <div className="col-span-1 text-right">Billed</div>
          <div className="col-span-1 text-right">Paid</div>
          <div className="col-span-1 text-right">You Owe</div>
          <div className="col-span-2 text-center">Coverage</div>
          <div className="col-span-1 text-center">Flags</div>
        </div>

        {primaryLineItems.map((item) => {
          const allFindings = ((item.metadata?.auditFindings || []) as AuditFinding[]);
          // S74.5 D15 Q-E LOCK — filter dismissed findings unless user
          // toggled showDismissed. Dismissed entries are preserved on the
          // row metadata for flywheel telemetry but hidden from default view.
          const findings = showDismissed
            ? allFindings
            : allFindings.filter((f) => !f.dismissed);
          const dismissedCount = allFindings.length - findings.length;
          const isExpanded = expandedItem === item.id;
          const coverageBadge = item.coverageStatus ? COVERAGE_BADGE[item.coverageStatus] : null;

          // Paid column = derived alreadyPaid (billed − stillOutstanding) so
          // it matches BillCard + ClaimImpactHero at claim level. Falls back
          // to raw insurance_paid for legacy payloads without recovery.
          //
          // hasGap uses RAW insurance_paid because the gap explanation
          // literally says "$X billed · $0 insurance paid · $0 insurance owed"
          // — that's an EOB observation, not a derived number. Using derived
          // `paid` here would hide gaps on any line where the API pro-rated
          // a non-zero "already paid" from the claim header.
          const billed = item.billed_amount || 0;
          const paid = item.recovery?.alreadyPaid ?? (item.insurance_paid || 0);
          const owed = item.patient_owes || 0;
          const rawInsurancePaid = item.insurance_paid || 0;
          const hasGap = billed > 0 && rawInsurancePaid === 0 && owed === 0;
          const gapRelevant = hasGap && item.coverageStatus !== "not_covered";

          // S74.5 D6 — category pill state per Subplan §3 Layer C. Only
          // renders when flywheel flag ON. Click opens correction modal
          // without bubbling to the row-expand toggle.
          const showCategoryPill =
            flywheelEnabled &&
            (item.codeIdentity != null ||
              expandCorrectionToAll ||
              item.user_corrected_at != null);
          const pillState: "user_corrected" | "needs_review" | "auto" =
            item.user_corrected_at
              ? "user_corrected"
              : item.codeIdentity?.promotionState === "proposed" ||
                  (item.codeIdentity != null &&
                    item.codeIdentity.identityId == null)
                ? "needs_review"
                : "auto";
          const pillClass =
            pillState === "user_corrected"
              ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
              : pillState === "needs_review"
                ? "bg-yellow-50 text-yellow-800 border-yellow-200 hover:bg-yellow-100"
                : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100";
          const pillLabel =
            pillState === "user_corrected"
              ? "Your update"
              : pillState === "needs_review"
                ? "Needs review"
                : "Edit category";

          return (
            <div key={item.id} data-line-item-id={item.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpandedItem(isExpanded ? null : item.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpandedItem(isExpanded ? null : item.id);
                  }
                }}
                className="w-full grid grid-cols-12 gap-4 items-center px-5 py-3.5 text-left transition-colors border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
              >
                <div className="col-span-4 text-xs text-gray-900">
                  <div className="truncate">
                    {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
                  </div>
                  {showCategoryPill && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCorrectionModal(item.id);
                        }}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${pillClass}`}
                        title={
                          pillState === "user_corrected"
                            ? "You changed this category. Click to edit again."
                            : pillState === "needs_review"
                              ? "We couldn't auto-categorize this. Click to set."
                              : "Click to change category"
                        }
                      >
                        <svg
                          className="h-2.5 w-2.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                        {pillLabel}
                      </button>
                      {item.service_slug && (
                        <span className="font-mono text-[10px] text-gray-400">
                          {item.service_slug}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="col-span-2 text-xs text-gray-500 font-mono truncate">
                  {item.billing_code || "—"}
                </div>
                <div className="col-span-1 text-xs text-gray-900 text-right tabular-nums">
                  ${billed.toLocaleString()}
                </div>
                <div className="col-span-1 text-xs text-gray-500 text-right tabular-nums">
                  ${paid.toLocaleString()}
                </div>
                <div className="col-span-1 text-xs font-semibold text-gray-900 text-right tabular-nums">
                  ${owed.toLocaleString()}
                </div>
                <div className="col-span-2 flex items-center justify-center">
                  {coverageBadge && (
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className}`}>
                      {coverageBadge.label}
                    </span>
                  )}
                </div>
                <div className="col-span-1 flex items-center justify-center">
                  {findings.length > 0 && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-red-700 bg-red-50">
                      {findings.length}
                    </span>
                  )}
                  {findings.length === 0 && gapRelevant && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-amber-700 bg-amber-100" title="Billed but nothing paid or owed — likely a denial or missing allocation">
                      Review
                    </span>
                  )}
                </div>
              </div>

              {/* Inline gap explanation when expanded and there's a gap.
                  Amber replaced with white per user preference — colors were
                  too busy. Green "YOUR PLAN SAYS" and red "EOB SHOWS" boxes
                  kept because they carry semantic meaning. */}
              {isExpanded && gapRelevant && findings.length === 0 && (
                <div className="px-4 py-4 bg-white border-t border-gray-100 space-y-3">
                  {/* Header */}
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      Unexplained ${billed.toLocaleString()} charge
                    </p>
                    <p className="mt-1 text-xs text-gray-600">
                      {buildGapExplanation(billed, item.planCoverage)}
                    </p>
                  </div>

                  {/* Fact grid: plan says vs EOB says */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-green-100 bg-green-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700">Your plan says</p>
                      <p className="mt-0.5 text-xs font-semibold text-green-900">
                        {buildPlanSays(item.planCoverage)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-red-100 bg-red-50 p-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-red-700">EOB shows</p>
                      <p className="mt-0.5 text-xs font-semibold text-red-900">
                        ${billed.toLocaleString()} billed · $0 insurance paid · $0 insurance owed
                      </p>
                    </div>
                  </div>

                  {/* Actionable steps */}
                  <div className="rounded-lg border border-gray-200 bg-white p-3">
                    <p className="text-xs font-semibold text-gray-900">How to dispute</p>
                    <ol className="mt-1.5 space-y-1 text-xs text-gray-600">
                      <li>1. Call the insurer claim number on your card and ask why no payment was made for this line.</li>
                      <li>2. If denied, request a written explanation citing the plan provision.</li>
                      <li>3. Draft a formal appeal with the letter below and mail it to the insurer&apos;s appeals address.</li>
                    </ol>
                  </div>

                  {/* Dispute CTA */}
                  <button
                    disabled={disputeLoading}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setDisputeLoading(true);
                      try {
                        const token = await user!.firebaseUser.getIdToken();
                        const claimMeta = data!.claim as Record<string, unknown>;
                        // Synthesize a finding for this gap line so we can reuse the
                        // existing dispute-letter generator (insurance_appeal flow).
                        const syntheticFindingId = `gap-${item.id}`;
                        const syntheticFinding = {
                          id: syntheticFindingId,
                          type: "missing_adjustment",
                          severity: "high",
                          estimatedOvercharge: billed,
                          title: `Unexplained $${billed.toLocaleString()} charge for ${item.description || item.service_slug?.replace(/_/g, " ") || "service"}`,
                          description: `Service covered by plan but EOB records $0 insurance payment and $0 patient responsibility. Provider billed $${billed.toLocaleString()}. Code: ${item.billing_code || "N/A"}.`,
                          actionable: true,
                          billedAmount: billed,
                          lineItems: [item.line_number],
                        };
                        const auditReport = {
                          id: claimId,
                          documentId: (claimMeta.source_document_id as string) || "",
                          userId: (claimMeta.user_id as string) || "",
                          parsedBill: {
                            provider: (claimMeta.metadata as Record<string, unknown>)?.provider || { name: "Unknown" },
                            patient: (claimMeta.metadata as Record<string, unknown>)?.patient || { name: "Unknown" },
                            serviceDate: (claimMeta.date_of_service as string) || "",
                            lineItems: data!.lineItems.map((li) => ({
                              lineNumber: li.line_number,
                              description: li.description,
                              procedureCode: li.billing_code,
                              category: li.service_slug,
                              billedAmount: li.billed_amount || 0,
                              allowedAmount: li.allowed_amount,
                              insurancePaid: li.insurance_paid,
                              patientResponsibility: li.patient_owes,
                            })),
                            totals: {
                              totalBilled: (claimMeta.total_billed as number) || 0,
                              totalAllowed: (claimMeta.total_allowed as number) || undefined,
                              totalInsurancePaid: (claimMeta.total_insurance_paid as number) || undefined,
                              totalPatientResponsibility: (claimMeta.total_patient_responsibility as number) || undefined,
                            },
                          },
                          findings: [syntheticFinding],
                          summary: {
                            totalFindings: 1,
                            totalEstimatedOvercharge: billed,
                            highSeverityCount: 1,
                            actionableCount: 1,
                          },
                          createdAt: new Date().toISOString(),
                        };

                        const res = await fetch("/api/disputes/generate", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                          body: JSON.stringify({
                            auditReport,
                            findingIds: [syntheticFindingId],
                            letterType: "insurance_appeal",
                            claimId,
                            claimLineItemIds: [item.id],
                            insurancePlanId: (claimMeta.insurance_plan_id as string) || undefined,
                          }),
                        });

                        if (res.ok) {
                          const result = await res.json();
                          router.push(disputeUrlForResult(result));
                        }
                      } catch (err) {
                        console.error("Dispute generation failed:", err);
                      }
                      setDisputeLoading(false);
                    }}
                    className="w-full rounded-lg bg-blue-600 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {disputeLoading ? "Generating letter..." : "Draft dispute letter"}
                  </button>
                </div>
              )}

              {/* Expanded: show findings */}
              {isExpanded && (findings.length > 0 || (showDismissed && dismissedCount > 0)) && (
                <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-2">
                  {/* S74.5 D15 Q-E LOCK — dismissed count + show/hide toggle */}
                  {flywheelEnabled && dismissedCount > 0 && (
                    <div className="flex items-center justify-between text-[10px] text-gray-500 px-1">
                      <span>
                        {dismissedCount} dismissed finding{dismissedCount === 1 ? "" : "s"} hidden
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowDismissed((v) => !v);
                        }}
                        className="text-blue-600 hover:text-blue-700"
                      >
                        {showDismissed ? "Hide dismissed" : "Show dismissed"}
                      </button>
                    </div>
                  )}
                  {findings.map((f) => (
                    <div
                      key={f.id}
                      className={`p-3 rounded-lg border text-xs ${
                        f.dismissed
                          ? "text-gray-500 bg-gray-100 border-gray-200 opacity-70"
                          : SEVERITY_COLORS[f.severity] || "text-gray-700 bg-gray-50 border-gray-200"
                      }`}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold">{f.title}</p>
                          <p className="mt-0.5 opacity-80">
                            {f.type.replace(/_/g, " ")} · {f.severity}
                            {f.dismissed && f.dismissed_reason && (
                              <>
                                {" "}· dismissed:{" "}
                                <span className="italic">
                                  {f.dismissed_reason.replace(/_/g, " ")}
                                </span>
                              </>
                            )}
                          </p>
                        </div>
                        <div className="flex items-start gap-2 shrink-0">
                          {f.estimatedOvercharge > 0 && (
                            <p className="font-bold">
                              -${f.estimatedOvercharge.toLocaleString()}
                            </p>
                          )}
                          {flywheelEnabled && !f.dismissed && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDismissTarget(f);
                              }}
                              className="rounded border border-current px-2 py-0.5 text-[10px] font-medium opacity-70 hover:opacity-100"
                              title="Hide this finding with a reason"
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Dispute this charge button */}
                  {findings.some((f) => f.actionable) && (
                    <button
                      disabled={disputeLoading}
                      onClick={async (e) => {
                        e.stopPropagation();
                        setDisputeLoading(true);
                        try {
                          const token = await user!.firebaseUser.getIdToken();
                          // Reconstruct minimal audit report from claim metadata
                          const claimMeta = data!.claim as Record<string, unknown>;
                          const auditReport = {
                            id: claimId,
                            documentId: (claimMeta.source_document_id as string) || "",
                            userId: (claimMeta.user_id as string) || "",
                            parsedBill: {
                              provider: (claimMeta.metadata as Record<string, unknown>)?.provider || { name: "Unknown" },
                              patient: (claimMeta.metadata as Record<string, unknown>)?.patient || { name: "Unknown" },
                              serviceDate: (claimMeta.date_of_service as string) || "",
                              lineItems: data!.lineItems.map((li) => ({
                                lineNumber: li.line_number,
                                description: li.description,
                                procedureCode: li.billing_code,
                                category: li.service_slug,
                                billedAmount: li.billed_amount || 0,
                                allowedAmount: li.allowed_amount,
                                insurancePaid: li.insurance_paid,
                                patientResponsibility: li.patient_owes,
                              })),
                              totals: {
                                totalBilled: claimMeta.total_billed as number || 0,
                                totalAllowed: claimMeta.total_allowed as number || undefined,
                                totalInsurancePaid: claimMeta.total_insurance_paid as number || undefined,
                                totalPatientResponsibility: claimMeta.total_patient_responsibility as number || undefined,
                              },
                            },
                            findings: findings.map((f) => ({
                              ...f,
                              billedAmount: item.billed_amount || 0,
                              benchmarkAmount: undefined,
                              description: f.title,
                              lineItems: [item.line_number],
                            })),
                            summary: {
                              totalFindings: findings.length,
                              totalEstimatedOvercharge: findings.reduce((s, f) => s + f.estimatedOvercharge, 0),
                              highSeverityCount: findings.filter((f) => f.severity === "high" || f.severity === "critical").length,
                              actionableCount: findings.filter((f) => f.actionable).length,
                            },
                            createdAt: new Date().toISOString(),
                          };

                          const res = await fetch("/api/disputes/generate", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                            body: JSON.stringify({
                              auditReport,
                              findingIds: findings.filter((f) => f.actionable).map((f) => f.id),
                              claimId,
                              claimLineItemIds: [item.id],
                              insurancePlanId: (claimMeta.insurance_plan_id as string) || undefined,
                            }),
                          });

                          if (res.ok) {
                            const result = await res.json();
                            router.push(disputeUrlForResult(result));
                          }
                        } catch (err) {
                          console.error("Dispute generation failed:", err);
                        }
                        setDisputeLoading(false);
                      }}
                      className="w-full py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {disputeLoading ? "Generating..." : "Dispute this charge"}
                    </button>
                  )}

                  {/* Plan coverage details */}
                  {item.planCoverage && (
                    <div className="p-3 rounded-lg border border-blue-200 bg-blue-50 text-xs text-blue-700">
                      <p className="font-semibold">Your plan says:</p>
                      <p>
                        {item.planCoverage.copay != null && `Copay: $${item.planCoverage.copay}`}
                        {item.planCoverage.copay != null && item.planCoverage.coinsurance != null && " · "}
                        {item.planCoverage.coinsurance != null && `Coinsurance: ${(item.planCoverage.coinsurance * 100).toFixed(0)}%`}
                        {!item.planCoverage.copay && !item.planCoverage.coinsurance && "Covered (details not extracted)"}
                      </p>
                      <p className="mt-1 opacity-70">Source: {item.planCoverage.source || "plan document"}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Quality-reporting codes — collapsed by default */}
      {qualityLineItems.length > 0 && (
        <QualityMeasuresSection items={qualityLineItems} />
      )}

      {/* Disputes on this bill — new lifecycle vocabulary, clickable expansion */}
      {data.disputes.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Disputes</h3>
          <div className="space-y-2">
            {data.disputes.map((d) => (
              <DisputeRow key={d.id} dispute={d} />
            ))}
          </div>
          {/* T2.7 — bundle related bills into one consolidated dispute */}
          <button
            disabled
            className="mt-3 w-full rounded-lg border border-dashed border-gray-200 bg-gray-50/60 px-3 py-2.5 text-left text-xs text-gray-500 cursor-not-allowed"
            title="Coming soon — bundle related bills from the same visit into one consolidated dispute letter."
          >
            <span className="font-semibold text-gray-700">+ Bundle with a related bill</span>
            <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-400">Coming soon</span>
            <span className="mt-0.5 block text-[11px] text-gray-500">
              Group bills from the same visit (hospital + anesthesia + lab + radiology) into one dispute letter.
            </span>
          </button>
        </div>
      )}

      <Disclaimer variant="coverage_check" />

      {/* S74.5 D6 — Category correction modal. Lazy-renders when
          correctionModalLineId is set AND catalog is loaded. Catalog is
          pre-fetched on data load (useEffect above) so first-click delay
          is rare. */}
      {flywheelEnabled && modalLineItem && catalog && (
        <CategoryCorrectionModal
          open={true}
          claimId={claimId}
          lineItemId={modalLineItem.id}
          billingCode={modalLineItem.billing_code}
          description={modalLineItem.description}
          currentSlug={modalLineItem.service_slug}
          catalog={catalog}
          onClose={() => setCorrectionModalLineId(null)}
          onSubmitted={handleCorrectionSubmitted}
          getAuthToken={getAuthToken}
        />
      )}

      {/* S74.5 D6 G4 LOCK — community-vs-user conflict modal. Surfaces when
          a community/admin promotion landed a slug that differs from the
          user's prior correction. Endpoint resolution wired below. */}
      {flywheelEnabled && activeConflictLine && (
        <CommunityConflictModal
          claimId={claimId}
          lineItem={activeConflictLine}
          onClose={() =>
            setSnoozedConflicts((prev) => {
              const next = new Set(prev);
              next.add(activeConflictLine.id);
              return next;
            })
          }
          onResolved={async () => {
            await refetchClaim();
          }}
          getAuthToken={getAuthToken}
        />
      )}

      {/* S74.5 D15 Q-E LOCK — dismiss-finding modal. Reason logged to
          flywheel telemetry; finding hidden on subsequent renders. */}
      {flywheelEnabled && dismissTarget && (
        <DismissFindingModal
          claimId={claimId}
          finding={dismissTarget}
          onClose={() => setDismissTarget(null)}
          onSubmitted={async () => {
            setDismissTarget(null);
            await refetchClaim();
          }}
          getAuthToken={getAuthToken}
        />
      )}
    </div>
  );
}

// ── S74.5 D6 G4 LOCK — Community-vs-user conflict modal ───────────────────
//
// Surfaces when a Pattern 1 #3 promotion lands a different slug than the
// user previously chose. Per Subplan §3 Layer C, the auto-switch already
// happened server-side during backfill; this modal lets the user revert
// (sets user_correction_locked_at sticky per-account) or keep the community
// value. Resolution endpoint: POST /api/claims/[claimId]/line-items/[lineId]/resolve-conflict

function CommunityConflictModal({
  claimId,
  lineItem,
  onClose,
  onResolved,
  getAuthToken,
}: {
  claimId: string;
  lineItem: LineItem;
  onClose: () => void;
  onResolved: () => Promise<void> | void;
  getAuthToken: () => Promise<string | null>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userOriginalSlug =
    (lineItem.metadata?.user_correction_pre_backfill_slug as
      | string
      | undefined) ?? null;
  const communitySlug = lineItem.codeIdentity?.communitySlug ?? null;

  async function submit(action: "revert" | "accept") {
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(
        `/api/claims/${claimId}/line-items/${lineItem.id}/resolve-conflict`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Resolve failed (${res.status})`);
      }
      await onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="community-conflict-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 id="community-conflict-title" className="mb-2 text-base font-semibold text-gray-900">
          The community updated this category
        </h2>
        <p className="mb-4 text-sm text-gray-700">
          We&apos;ve updated <span className="font-mono">{lineItem.billing_code}</span>{" "}
          to <span className="font-mono">{communitySlug}</span> based on
          corroboration from other users. You previously set it
          {userOriginalSlug ? (
            <>
              {" "}
              to <span className="font-mono">{userOriginalSlug}</span>.
            </>
          ) : (
            " yourself."
          )}
        </p>
        <p className="mb-4 text-xs text-gray-500">
          Revert to keep your choice for this account (your direct evidence wins;
          future community shifts won&apos;t auto-override).
        </p>

        {error && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => submit("accept")}
            disabled={submitting}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Keep community value
          </button>
          <button
            type="button"
            onClick={() => submit("revert")}
            disabled={submitting}
            className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Revert to my choice
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
            aria-label="Decide later"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Copy templates for the unexplained-charge callout ─────────────────────
//
// Each helper returns a string assembled from available fields. Missing data
// causes the corresponding clause or sentence to be omitted — no "undefined",
// no empty interpolations.

function buildGapExplanation(
  billed: number,
  planCoverage: LineItem["planCoverage"],
): string {
  const coverageSentence = planCoverage?.covered !== false
    ? "Your plan covers this service, but the EOB records $0 insurance payment and $0 patient responsibility."
    : "The EOB records $0 insurance payment and $0 patient responsibility.";

  const amountSentence = billed > 0
    ? `The $${billed.toLocaleString()} charge is likely a denial, write-off, or missing EOB data.`
    : "";

  return [coverageSentence, amountSentence].filter(Boolean).join(" ");
}

function buildPlanSays(planCoverage: LineItem["planCoverage"]): string {
  if (!planCoverage) return "Covered (contact insurer to confirm)";
  if (planCoverage.covered === false) return "Not covered";

  const parts: string[] = [];
  if (planCoverage.copay != null) parts.push(`$${planCoverage.copay} copay`);
  if (planCoverage.coinsurance != null) parts.push(`${(planCoverage.coinsurance * 100).toFixed(0)}% coinsurance`);

  if (parts.length === 0) return "Covered";
  return `Covered · ${parts.join(" · ")}`;
}

// ── Quality reporting codes ───────────────────────────────────────────────
//
// CPT Category II and zero-charge HCPCS codes are quality measures that
// clutter the main breakdown. Show a collapsible section so they're
// discoverable without crowding the charges view.

function QualityMeasuresSection({ items }: { items: LineItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50/60 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100/60 transition-colors"
      >
        <div>
          <p className="text-xs font-semibold text-gray-700">
            Quality measures ({items.length}) · no charge
          </p>
          <p className="text-[11px] text-gray-500">
            Reporting codes filed alongside the main service. Always $0.
          </p>
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {items.map((item) => (
            <div key={item.id} className="grid grid-cols-12 gap-2 px-4 py-2 items-center">
              <div className="col-span-8 text-xs text-gray-600 truncate">
                {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
              </div>
              <div className="col-span-2 text-xs text-gray-500 font-mono">
                {item.billing_code || "—"}
              </div>
              <div className="col-span-2 text-xs text-gray-400 text-right">No charge</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Linked Disputes row ──────────────────────────────────────────────────
//
// Clickable row. Expansion fetches the full dispute (letter text, evidence
// package, linked bill line items) and renders inline with links back to
// /disputes and /small-claims where the full artifacts live.

function DisputeRow({
  dispute,
}: {
  dispute: { id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number };
}) {
  const { user } = useAuth();
  const { isPro } = useSubscription();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // S71 hotfix #4 (Session 73) — Re-draft inline on the claim-detail dispute card.
  // Same handler as /disputes page; allows users to re-draft without leaving the
  // claim view. CF-20 re-parse-on-flag fires server-side; toast surfaces outcome.
  const [redrafting, setRedrafting] = useState(false);
  const [redraftToast, setRedraftToast] = useState<string | null>(null);

  const statusLabel = DISPUTE_STATUS_LABEL[dispute.status] || dispute.status;
  const statusBadgeClass = DISPUTE_STATUS_BADGE[dispute.status] || "text-gray-700 bg-gray-100";
  const typeLabel = disputeTypeLabel(dispute.dispute_type);

  async function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail || detailLoading || !user) return;
    setDetailLoading(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/${dispute.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setDetail(await res.json());
      }
    } catch (err) {
      console.error("Failed to load dispute detail:", err);
    }
    setDetailLoading(false);
  }

  async function handleRedraft() {
    if (!user || redrafting) return;
    setRedrafting(true);
    setRedraftToast(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/disputes/${dispute.id}/redraft`, {
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
      setRedraftToast(
        targets === 0
          ? "Letter re-drafted with current plan + evidence."
          : upgrades > 0
            ? `Letter re-drafted — ${upgrades} of ${targets} citation${targets === 1 ? "" : "s"} upgraded.`
            : `Letter re-drafted — ${targets} citation${targets === 1 ? "" : "s"} attempted; none upgraded this run.`,
      );
      // Refetch the dispute detail to show the updated letter content.
      const refetch = await fetch(`/api/disputes/${dispute.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (refetch.ok) setDetail(await refetch.json());
    } catch (err) {
      setRedraftToast(err instanceof Error ? err.message : "Re-draft failed");
    } finally {
      setRedrafting(false);
      setTimeout(() => setRedraftToast(null), 6000);
    }
  }

  const hasLetter = !!detail?.letterContent;
  const hasEvidence = !!detail?.evidencePackage;
  const hasReachedLetterStage = dispute.status !== "flagged";
  const hasReachedCourtStage =
    dispute.status === "court_documentation_drafted" ||
    dispute.status === "won" ||
    dispute.status === "lost" ||
    dispute.status === "settled" ||
    dispute.status === "won_on_escalation" ||
    dispute.status === "settled_on_escalation";

  return (
    <div className="rounded-xl border border-gray-100 bg-white overflow-hidden">
      <button
        onClick={toggleOpen}
        className="w-full flex items-center justify-between px-3 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusBadgeClass}`}>
            {statusLabel}
          </span>
          <div>
            <p className="text-xs font-semibold text-gray-900">{typeLabel}</p>
            <p className="text-[10px] text-gray-500">Click for details</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs font-bold">${dispute.amount_disputed.toLocaleString()}</p>
            {dispute.amount_recovered > 0 && (
              <p className="text-[10px] text-green-600">+${dispute.amount_recovered.toLocaleString()}</p>
            )}
          </div>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50/40">
          {/* Bill being disputed */}
          <div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
              Bill being disputed
            </p>
            {detailLoading && <p className="text-xs text-gray-400">Loading bill details...</p>}
            {!detailLoading && detail && detail.lineItems.length === 0 && (
              <p className="text-xs text-gray-400">No line items linked.</p>
            )}
            {!detailLoading && detail && detail.lineItems.length > 0 && (
              <div className="space-y-1">
                {detail.lineItems.map((li) => (
                  <div key={li.id} className="flex items-center justify-between text-xs text-gray-700">
                    <span className="truncate">
                      {li.description || "Line item"}
                      {li.billing_code && (
                        <span className="ml-2 text-gray-400 font-mono">{li.billing_code}</span>
                      )}
                    </span>
                    <span className="font-semibold ml-2">
                      ${(li.billed_amount || 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Letter */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Dispute letter
              </p>
              {hasLetter && isPro && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRedraft}
                    disabled={redrafting}
                    className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                  >
                    {redrafting ? "Re-drafting…" : "Re-draft"}
                  </button>
                  <span className="text-[10px] text-gray-300">·</span>
                  <a
                    href={`/disputes?dispute=${dispute.id}`}
                    className="text-[10px] font-semibold text-blue-600 hover:text-blue-700"
                  >
                    View full letter →
                  </a>
                </div>
              )}
            </div>
            {redraftToast && (
              <div className="mb-1 rounded-md bg-emerald-50 px-2 py-1 text-[10px] text-emerald-800">
                {redraftToast}
              </div>
            )}
            {hasLetter && isPro ? (
              <pre className="p-2 bg-white border border-gray-100 rounded-lg text-[11px] text-gray-700 whitespace-pre-wrap font-sans line-clamp-4">
                {detail!.letterContent}
              </pre>
            ) : (
              <LetterTeaser
                isPro={isPro}
                hasReachedLetterStage={hasReachedLetterStage}
                disputeId={dispute.id}
              />
            )}
          </div>

          {/* Court documents */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Court documentation
              </p>
              {hasEvidence && detail?.claimId && (
                <a
                  href={`/small-claims?claim=${detail.claimId}`}
                  className="text-[10px] font-semibold text-blue-600 hover:text-blue-700"
                >
                  View evidence package →
                </a>
              )}
            </div>
            <p
              className={`p-2 rounded-lg text-xs italic ${
                hasReachedCourtStage && hasEvidence
                  ? "bg-purple-50 text-purple-800 not-italic"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {hasEvidence
                ? "9-section court-ready evidence package prepared."
                : hasReachedCourtStage
                  ? "Evidence package reference available on the Small Claims page."
                  : "Evidence not prepared yet."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Locked letter preview shown when the user can't see the real letter:
 * either because they're on the Free plan, or because this is a legacy
 * dispute that predates letter persistence (letter_content is NULL).
 *
 * Shows a blurred sample letter with an upgrade CTA overlayed so users
 * understand the value of Pro and have a clear path to unlock it.
 */
function LetterTeaser({
  isPro,
  hasReachedLetterStage,
  disputeId,
}: {
  isPro: boolean;
  hasReachedLetterStage: boolean;
  disputeId: string;
}) {
  const sampleLetter = `Aetna Member Services — Appeals
PO Box 14463
Lexington, KY 40512

Re: Formal appeal of claim denial
Member: Jane Sample · Member ID: W123456789
Date of service: June 1, 2026 · Claim #AET-2026-0428

To Whom It May Concern:

I am appealing the denial of the above claim for an established office visit
(CPT 99214) at Swedish Providence. My plan documents specify a $20 copay for
this service when rendered in-network...`;

  return (
    <div className="relative rounded-lg border border-gray-100 overflow-hidden">
      <pre
        aria-hidden
        className="pointer-events-none select-none p-2 bg-white text-[11px] text-gray-700 whitespace-pre-wrap font-sans filter blur-[3px] opacity-60 max-h-32 overflow-hidden"
      >
        {sampleLetter}
      </pre>
      <div className="absolute inset-0 flex items-center justify-center bg-white/50">
        <div className="flex flex-col items-center gap-1.5">
          {!isPro ? (
            <>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                🔒 Pro only
              </span>
              {/* Route to /disputes?dispute=<id>. That page already has the
                  LockedOverlay billing interstitial (blurred sample letter +
                  Subscribe button → Stripe Checkout). After subscription
                  Stripe redirects back to the same URL, and /disputes picks
                  up the dispute ID to render the real letter. */}
              <a
                href={`/disputes?dispute=${disputeId}`}
                className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
              >
                Subscribe to view your dispute letter
              </a>
            </>
          ) : hasReachedLetterStage ? (
            <>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                Legacy dispute
              </span>
              <p className="text-[11px] text-gray-600 text-center max-w-xs">
                This letter predates text persistence. Regenerate it from the
                bill&apos;s Draft Dispute Letter button to see the text here.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-gray-500 italic">Letter not drafted yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── S74.5 D15 Q-E LOCK — Dismiss-finding modal ────────────────────────────
//
// Lets the user hide a finding with a reason. The reason corpus is preserved
// on the row metadata (auditFindings[].dismissed_reason) for flywheel
// telemetry — false-positive pattern detection feeds future Pattern P-9
// promotion (e.g., "always dismiss zero_cost_share_overcharge on prompt_pay
// codes" → admin queue → registry update).
//
// Reason picker matches the Subplan §7.3 LOCK exactly + "other" free-text
// fallback per Q-E.

const DISMISS_REASONS: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  {
    value: "legitimate_adjustment",
    label: "Legitimate adjustment",
    hint: "I confirmed with the provider this adjustment is correct.",
  },
  {
    value: "prior_balance_carryover",
    label: "Prior balance carryover",
    hint: "This is a leftover balance from a different claim.",
  },
  {
    value: "prompt_pay_discount",
    label: "Prompt-pay discount",
    hint: "I got an early-payment discount that explains the gap.",
  },
  {
    value: "state_mandate_adjustment",
    label: "State-mandate adjustment",
    hint: "State law required this specific adjustment.",
  },
  {
    value: "other",
    label: "Other (tell us)",
    hint: "Help us improve — explain in one line.",
  },
];

function DismissFindingModal({
  claimId,
  finding,
  onClose,
  onSubmitted,
  getAuthToken,
}: {
  claimId: string;
  finding: AuditFinding;
  onClose: () => void;
  onSubmitted: () => Promise<void> | void;
  getAuthToken: () => Promise<string | null>;
}) {
  const [reason, setReason] = useState<string>("legitimate_adjustment");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (reason === "other" && !note.trim()) {
      setError("Please add a short note so we can learn from this.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(
        `/api/claims/${claimId}/findings/${finding.id}/dismiss`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ reason, note: note.trim() || undefined }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Dismiss failed (${res.status})`);
      }
      await onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dismiss failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dismiss-finding-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h2
            id="dismiss-finding-title"
            className="text-lg font-semibold text-gray-900"
          >
            Hide this finding?
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
          <div className="font-medium text-gray-900">{finding.title}</div>
          <div className="mt-1 text-xs text-gray-600">
            {finding.type.replace(/_/g, " ")} · {finding.severity}
            {finding.estimatedOvercharge > 0 && (
              <> · ${finding.estimatedOvercharge.toLocaleString()}</>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <p className="mb-2 text-xs text-gray-600">
            Why are you hiding this? Your answer helps us tune the audit.
          </p>

          <fieldset className="mb-4 space-y-2">
            {DISMISS_REASONS.map((r) => (
              <label
                key={r.value}
                className={`flex cursor-pointer items-start gap-2 rounded border p-2 text-sm transition-colors ${
                  reason === r.value
                    ? "border-blue-300 bg-blue-50"
                    : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <input
                  type="radio"
                  name="dismiss-reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-gray-900">{r.label}</span>
                  <span className="block text-xs text-gray-500">{r.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {reason === "other" && (
            <div className="mb-4">
              <label
                htmlFor="dismiss-note"
                className="mb-1 block text-xs font-medium text-gray-700"
              >
                Tell us what&apos;s going on
              </label>
              <textarea
                id="dismiss-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="One short sentence is plenty."
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {error && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Hiding..." : "Hide finding"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

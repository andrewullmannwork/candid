"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { CategoryCorrectionModal } from "@/components/claims/CategoryCorrectionModal";
import { legacyCategoryReviewHint } from "@/lib/billing/code-categories";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useDisputeDraftOverlay } from "@/lib/loading/dispute-draft-overlay";

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
  // Mig 092 — distinct from insurance_paid (contractual writeoff, not payment).
  insurance_adjusted_amount?: number | null;
  patient_owes: number | null;
  // Mig 092 — patient OOP payments (separate from patient_owes which is total responsibility).
  patient_paid_amount?: number | null;
  amount_still_outstanding: number | null;
  metadata: Record<string, unknown>;
  coverageStatus: "covered" | "not_covered" | "unknown" | null;
  planCoverage: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    source: string | null;
  } | null;
  // S74.6 D2 — which path produced the line's coverage row. Drives the §A.2
  // ACA tooltip on the Coverage badge (only when 'aca_zero_cost_share').
  coverageSource?: string | null;
  recovery?: {
    billed: number;
    // Mig 092 / Session 85 — patient-aware fields take precedence; legacy
    // alreadyPaid / stillOutstanding retained for back-compat with legacy
    // UI surfaces.
    patientPaid?: number;
    patientResponsibility?: number;
    remainingBalance?: number;
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
  description?: string;
  benchmarkSource?: string;
  // S74.5 D15 Q-E LOCK — set by /api/claims/[claimId]/findings/[findingId]/dismiss.
  // Dismissed findings are filtered out of the default display; reason corpus
  // analyzed for false-positive pattern detection (Pattern P-9 candidate).
  dismissed?: boolean;
  dismissed_at?: string;
  dismissed_reason?: string;
  dismissed_note?: string | null;
}

// S74.5c §1.7 — claim-level findings persisted to
// claim.metadata.auditSummary.claimLevelFindings. Same dismiss-flag shape as
// AuditFinding so the dismiss modal can take a synthetic AuditFinding cast.
interface ClaimLevelFindingMeta extends AuditFinding {
  description?: string;
  benchmarkSource?: string;
}

// S74.5c §3.8 — re-audit throttle outcome shape surfaced by /api/claims/[claimId].
interface ReauditOutcome {
  reaudited: boolean;
  reason: string;
}

interface PlanCoverageEntry {
  slug: string;
  covered: boolean | null;
  copay: number | null;
  coinsurance: number | null;
}

interface ClaimData {
  claim: Record<string, unknown>;
  lineItems: LineItem[];
  disputes: Array<{ id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number }>;
  relatedClaims: Array<{ id: string; date_of_service: string; status: string; total_billed: number }>;
  // S132 iter-6 Phase 1 — slugs present in user's plan_covered_services for
  // this claim's plan_id. Drives CategoryCorrectionModal filtering + best-
  // guess "Use this" gating. Empty array when no plan uploaded.
  userPlanCoverage?: PlanCoverageEntry[];
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
  reaudit?: ReauditOutcome | null;
  // S74.6 D1 §A.2 — plan-level ACA basis + excerpt for Coverage badge tooltip.
  // null when plan is not ACA-compliant.
  acaCompliance?: {
    isAcaCompliant: boolean;
    basis: string | null;
    excerpt: string | null;
  } | null;
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
  // S132 iter-5 — "Unknown" reframed as "Not in plan." Semantic: parser
  // didn't find this service_slug in plan_covered_services for the user's
  // plan. Could mean (a) plan doesn't cover it, (b) parser missed the
  // benefit, OR (c) slug-vocabulary mismatch between bill-side and plan-side
  // parsers (no synonym layer yet — tracked as cross-workstream FE→BE).
  // "Not in plan" frames the user's next step (verify / re-categorize /
  // upload more) without making a policy claim ("Not Covered") we can't back.
  unknown: { label: "Not in plan", className: "text-gray-500 bg-gray-100" },
};

// S74.6 D1 §A.2 — Coverage-badge tooltip copy for lines covered via the
// ACA-mandated zero-cost-share registry (coverageSource === 'aca_zero_cost_share').
// Copy varies by the plan's aca_compliance_basis so the user knows how
// confident we are about ACA applicability — "explicit_attestation" is the
// strongest claim, "unknown" is the weakest. When an excerpt is available
// it's appended as supporting evidence.
function buildAcaTooltip(
  basis: string | null,
  excerpt: string | null,
): string {
  let body: string;
  switch (basis) {
    case "explicit_attestation":
      body = "Your plan documents confirm ACA-compliant coverage for this service at $0.";
      break;
    case "inferred_marketplace":
      body =
        "Your plan was purchased through the ACA marketplace, so this service is covered at $0 by federal law. Confirm with your insurer if uncertain.";
      break;
    case "inferred_employer_post_2010":
      body =
        "Your employer-sponsored plan is presumed ACA-compliant (effective ≥2010, no grandfathered language). Confirm with your insurer if uncertain.";
      break;
    case "unknown":
    case null:
    default:
      body =
        "We assumed ACA coverage for this preventive service. Confirm with your insurer if uncertain.";
  }
  if (excerpt && excerpt.length > 0) {
    return `${body}\n\nEvidence from your plan: "${excerpt}"`;
  }
  return body;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-700 bg-red-50 border-red-200",
  high: "text-orange-700 bg-orange-50 border-orange-200",
  medium: "text-amber-700 bg-amber-50 border-amber-200",
  low: "text-yellow-700 bg-yellow-50 border-yellow-200",
};

// Session 85 — user-friendly finding-type labels. Replaces the previous
// `type.replace("_", " ")` + severity rendering (which surfaced "missing
// adjustment · medium" — opaque jargon). Severity is dropped from the
// subtitle entirely; the colored card border + recovery amount carry the
// urgency signal.
const FRIENDLY_FINDING_TYPE: Record<string, string> = {
  overcharge: "Possible overcharge",
  duplicate: "Duplicate charge",
  unbundling: "Bundled service issue",
  upcoding: "Code level review",
  balance_billing: "Balance billing",
  missing_adjustment: "Contractual adjustment review",
  stale_claim: "Late filing",
  zero_cost_share_overcharge: "Should be $0 — ACA preventive / vaccine",
  unallocated_balance: "Unallocated balance",
  insurance_underpayment: "Insurance under-payment",
};
function friendlyFindingType(type: string): string {
  return FRIENDLY_FINDING_TYPE[type] ?? type.replace(/_/g, " ");
}

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
  onClaimUpdated,
}: {
  claimId: string;
  onBack: () => void;
  focusLineItemId?: string | null;
  backLabel?: string;
  /**
   * S132 iter-6 Phase 1 — parent /claim page passes its claims-list refetch
   * here. ClaimDetail calls it after any mutation that affects bill state
   * (currently: line-item category correction). Without this, the /claim
   * list shows stale coverageStatus + unknownCoverageCount + bill chrome.
   */
  onClaimUpdated?: () => Promise<void> | void;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  // Session 85 — default to ALL primary rows expanded so Plan-says/Bill-shows
  // + Dispute CTA surface on first render (Andrew's direction: bill-specific
  // modal page; the recovery story + paid-subscription gateway are the
  // primary value, keep them maximally visible). User can collapse individual
  // rows via the chevron in the row header.
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  const toggleRowCollapsed = (id: string) =>
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // disputeLoading state removed Session 86 round 2 — dispute is now bill-level
  // only; BulkDisputeButton manages its own loading state internally.

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
  // S74.5c §3.9 — 24-hour snooze backed by localStorage. Map<lineId, expiryMs>.
  // Loaded on mount; expired entries are filtered on read. Updates persist.
  const conflictSnoozeStorageKey = `claim-${claimId}-conflict-snooze`;
  const [snoozedConflicts, setSnoozedConflicts] = useState<Map<string, number>>(
    new Map(),
  );
  // S74.5c §3.8 — throttle dismissal state for the re-audit toast. localStorage
  // is overkill (toast should re-appear if user navigates back); keep in-memory
  // and re-derive from the API response on each load.
  const [throttleToastDismissed, setThrottleToastDismissed] = useState(false);
  // C-8 — stable callback ref so ThrottleToast's useEffect doesn't restart
  // the 8s auto-dismiss timer on every parent re-render.
  const dismissThrottleToast = useCallback(
    () => setThrottleToastDismissed(true),
    [],
  );

  // D15 Q-E LOCK — dismiss-finding modal state.
  // dismissTarget = the finding to dismiss; null when modal closed.
  const [dismissTarget, setDismissTarget] = useState<AuditFinding | null>(null);

  // S132 Item 2: re-draft prompt surfaces after a category change IF a dispute
  // letter was already drafted with the previous categorization. Captures the
  // dispute ID at submit time (closure over the pre-refetch `data.disputes`)
  // so the toast deep-links to the right letter even after refetch updates
  // the page. User clicks Re-draft → /disputes Re-draft button (intentional —
  // they should see strengthen signals before re-drafting).
  const [redraftPromptDisputeId, setRedraftPromptDisputeId] = useState<string | null>(null);
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
    // §3.9 — restore 24-hour conflict snooze map; drop expired entries.
    try {
      const raw = window.localStorage.getItem(conflictSnoozeStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      const live = new Map<string, number>();
      for (const [lineId, expiry] of Object.entries(parsed)) {
        if (typeof expiry === "number" && expiry > now) live.set(lineId, expiry);
      }
      if (live.size > 0) setSnoozedConflicts(live);
    } catch {
      // Corrupt JSON in localStorage; skip silently.
    }
  }, [looksRightStorageKey, nudgeStorageKey, conflictSnoozeStorageKey]);

  // §3.9 — persist snooze map whenever it changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (snoozedConflicts.size === 0) {
      window.localStorage.removeItem(conflictSnoozeStorageKey);
      return;
    }
    const obj: Record<string, number> = {};
    for (const [lineId, expiry] of snoozedConflicts.entries()) {
      obj[lineId] = expiry;
    }
    window.localStorage.setItem(conflictSnoozeStorageKey, JSON.stringify(obj));
  }, [snoozedConflicts, conflictSnoozeStorageKey]);

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
    // S132 Item 2: capture existing dispute BEFORE refetch so the re-draft
    // prompt deep-links to the letter that was drafted with the prior slug.
    // Non-cancelled disputes only — withdrawn/cancelled disputes don't need
    // a re-draft (the user has moved on from that letter).
    const existing = data?.disputes.find((d) => d.status !== "cancelled");
    if (existing) setRedraftPromptDisputeId(existing.id);
    await refetchClaim();
    // S132 iter-6 Phase 1: also refetch parent /claim list so the BillCard
    // chrome (state badge, recovery, unknown count) reflects the new coverage.
    if (onClaimUpdated) await onClaimUpdated();
  }, [data, refetchClaim, onClaimUpdated]);

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
    // S132 iter-8 — unified cube loader.
    return <CubeLoaderBuilding />;
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
  // within the last 24 hours (§3.9 — Map<lineId, expiryMs> in localStorage).
  const nowMs = Date.now();
  const conflictingLines = primaryLineItems.filter((li) => {
    if (li.codeIdentity?.conflictsWithCommunity !== true) return false;
    const expiry = snoozedConflicts.get(li.id);
    return !expiry || expiry <= nowMs;
  });
  const activeConflictLine = conflictingLines[0] ?? null;
  const modalLineItem =
    correctionModalLineId != null
      ? primaryLineItems.find((li) => li.id === correctionModalLineId) ?? null
      : null;

  // §3.10 — human-readable slug name map (client-side; uses already-prefetched
  // catalog so no extra server round-trip). Falls back to the raw slug when
  // the catalog hasn't loaded yet or the slug isn't in the catalog.
  const slugNameMap = new Map<string, string>(
    (catalog ?? []).map((c) => [c.slug, c.name]),
  );
  const humanizeSlug = (slug: string | null): string =>
    slug ? slugNameMap.get(slug) ?? slug : "";

  // §1.7 — claim-level findings live on claim.metadata.auditSummary.claimLevelFindings.
  // Same dismiss filter as line-level (showDismissed toggles visibility).
  const claimMetadata = (claim.metadata as Record<string, unknown> | null) ?? null;
  const auditSummary =
    (claimMetadata?.auditSummary as
      | { claimLevelFindings?: ClaimLevelFindingMeta[] }
      | undefined
      | null) ?? null;
  const allClaimLevelFindings = (auditSummary?.claimLevelFindings ?? []) as ClaimLevelFindingMeta[];
  const visibleClaimLevelFindings = showDismissed
    ? allClaimLevelFindings
    : allClaimLevelFindings.filter((f) => !f.dismissed);
  const dismissedClaimLevelCount =
    allClaimLevelFindings.length - visibleClaimLevelFindings.length;

  // §3.8 — throttle toast state. /api/claims/[claimId] surfaces re-audit
  // outcome reasons; we surface a friendly toast for the two throttle paths
  // so the user understands why their changes "didn't refresh."
  const reauditReason = data.reaudit?.reason ?? null;
  const throttleMinuteRemainingMatch = reauditReason?.match(
    /^throttle_per_minute \((\d+)s remaining\)$/,
  );
  const throttleMinuteSecondsRemaining = throttleMinuteRemainingMatch
    ? Number(throttleMinuteRemainingMatch[1])
    : null;
  const throttleDailyExceeded = reauditReason === "throttle_daily_cap_5";
  const showThrottleToast =
    !throttleToastDismissed &&
    flywheelEnabled &&
    (throttleMinuteSecondsRemaining !== null || throttleDailyExceeded);

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

      {/* S132 Item 2 — re-draft prompt after categorization change. Surfaces
          ONLY when the user had a non-cancelled dispute drafted before the
          change. Deep-links to /disputes?dispute=<id>; user re-drafts there
          (intentional — strengthen signals live on /disputes). Manual dismiss
          via X; auto-clears when user navigates away from ClaimDetail. */}
      {redraftPromptDisputeId && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50 p-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-blue-900">
              Categorization updated
            </p>
            <p className="mt-0.5 text-xs text-blue-800">
              Your dispute letter was drafted with the previous category.
              Re-draft to use the new one.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/disputes?dispute=${redraftPromptDisputeId}`)}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              Re-draft letter
            </button>
            <button
              type="button"
              onClick={() => setRedraftPromptDisputeId(null)}
              className="text-xs text-blue-700 hover:text-blue-900"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* S74.5c §3.8 — re-audit throttle toast. Two cases:
          (a) per-minute cooldown: short auto-dismiss after 8s.
          (b) daily cap (5/day): persists until manual dismiss; surfaces a
              support link for exception requests. */}
      {showThrottleToast && (
        <ThrottleToast
          minuteSecondsRemaining={throttleMinuteSecondsRemaining}
          dailyExceeded={throttleDailyExceeded}
          onDismiss={dismissThrottleToast}
        />
      )}

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

      {/* S74.5c §1.7 — Claim-level issues (lineItems=[] findings). D15
          unallocated_balance lives here; future claim-header findings (cross-
          claim aggregation, frequency violations) will too. Filtered by the
          same showDismissed toggle as the line-level findings list. */}
      {flywheelEnabled && (visibleClaimLevelFindings.length > 0 || dismissedClaimLevelCount > 0) && (
        <div className="mb-4 rounded-xl border border-gray-100 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              Claim-level issues
              {visibleClaimLevelFindings.length > 0 && (
                <span className="ml-2 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-50 px-1.5 text-[10px] font-semibold text-red-700">
                  {visibleClaimLevelFindings.length}
                </span>
              )}
            </h3>
            {dismissedClaimLevelCount > 0 && (
              <button
                type="button"
                onClick={() => setShowDismissed((s) => !s)}
                className="text-[10px] text-gray-500 hover:text-gray-700"
              >
                {showDismissed
                  ? "Hide dismissed"
                  : `Show ${dismissedClaimLevelCount} dismissed`}
              </button>
            )}
          </div>
          <div className="space-y-2">
            {visibleClaimLevelFindings.map((f) => (
              <div
                key={f.id}
                className={`p-3 rounded-lg border text-xs ${
                  f.dismissed
                    ? "text-gray-500 bg-gray-100 border-gray-200 opacity-70"
                    : SEVERITY_COLORS[f.severity] ||
                      "text-gray-700 bg-gray-50 border-gray-200"
                }`}
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">{f.title}</p>
                    {f.description && (
                      <p className="mt-1 opacity-80">{f.description}</p>
                    )}
                    <p className="mt-1 opacity-60">
                      {friendlyFindingType(f.type)}
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
                    {!f.dismissed && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Cast to AuditFinding shape; DismissFindingModal
                          // reads only id/title/type/severity/estimatedOvercharge.
                          setDismissTarget(f as unknown as AuditFinding);
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
          </div>
        </div>
      )}

      {/* Session 86 round 6 — responsive layout strategy:
          • md+ (≥768px) → 7-column table with single-line headers, raw
            "Billed" amount, all numeric columns aligned. Math explained
            in the Plan-says/Bill-shows compare in the expansion panel.
          • mobile (<768px) → vertical card per line item with stacked
            label/value pairs. Horizontal scroll dropped (bad UX); user
            scans down each metric naturally. */}
      <div className="bg-white border border-gray-100 rounded-xl mb-4">
        {/* Desktop table header — hidden at mobile */}
        <div className="hidden md:grid grid-cols-[minmax(0,_1fr)_55px_70px_70px_50px_75px_minmax(95px,_1.4fr)] gap-3 items-center px-5 py-3 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          <div className="min-w-0">Service</div>
          <div className="min-w-0">Code</div>
          <div
            className="text-right"
            title="Amount the provider billed before insurance write-off. The breakdown below shows what your insurer wrote off and what you actually paid."
          >
            Billed
          </div>
          <div className="text-right">Paid</div>
          <div className="text-right" title="What your plan says you should owe — copay, coinsurance, or deductible.">Plan</div>
          <div className="text-right" title="Money you're owed when your insurer corrects an under-payment.">Recovery</div>
          <div className="text-center">Coverage</div>
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
          const isExpanded = !collapsedRows.has(item.id);
          const coverageBadge = item.coverageStatus ? COVERAGE_BADGE[item.coverageStatus] : null;
          // S74.6 D1 §A.2 — surface ACA basis tooltip when the badge stems
          // from the registry fallback. Plan-covered rows (planCoverage row
          // from the user's plan_covered_services) don't get this tooltip
          // because the coverage is direct evidence, not ACA-mandate inferred.
          const acaTooltip =
            item.coverageSource === "aca_zero_cost_share" && data?.acaCompliance
              ? buildAcaTooltip(data.acaCompliance.basis, data.acaCompliance.excerpt)
              : undefined;

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
          // Session 86 — "Billed (adj.)" column = billed minus the insurer's
          // contractual write-off. Reconciles with the rest of the row math
          // (Paid + Plan + Recovery) which all operate on the post-adjustment
          // balance. Falls back to raw billed when insurance_adjusted_amount
          // is null/0 (legacy rows pre-mig 092).
          const insuranceAdjusted = Number(item.insurance_adjusted_amount ?? 0);
          const billedAdjusted = Math.max(0, billed - insuranceAdjusted);
          // Session 85 round 5 — "Paid" column = insurance_paid + patient_paid
          // (total cleared on this line by either party). For Bill 1 with
          // insurance_paid=$0 and patient_paid=$292.41, this reads $292.41
          // — matches Andrew's expectation. For Bill 2 99214 with ins=$168.79
          // and OOP=$48.25, reads $217.04 (the allowed amount). The breakdown
          // ("Your insurer actually paid" vs "You paid OOP") lives in the
          // red box for full transparency.
          const paid =
            Number(item.insurance_paid ?? 0) +
            Number(item.patient_paid_amount ?? 0);
          const owed = item.patient_owes || 0;
          // Session 85 — new column values:
          //   shouldOwe = plan-defined cost share (copay / coinsurance applied to billed)
          //   owedRecovery = total recoverable (= refund + forgiveness)
          //   patientPaid = OOP payments (mig 092 column; defaults 0 on legacy rows)
          //   remainingBalance = patient_owes − patient_paid (still due on the bill)
          const shouldOwe = item.recovery?.shouldOwe ?? 0;
          const owedRecovery = item.recovery?.potentialRecovery ?? 0;
          const patientPaid = item.recovery?.patientPaid ?? Number(item.patient_paid_amount ?? 0);
          const refundComponent = item.recovery?.refundComponent ?? Math.max(0, patientPaid - shouldOwe);
          const forgivenessComponent = item.recovery?.forgivenessComponent ?? Math.max(0, owedRecovery - refundComponent);
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
              item.user_corrected_at != null ||
              // S132 iter-3: always show the category subtitle on Unknown
              // coverage rows so the secondary re-categorize affordance is
              // visible alongside the primary Unknown-badge click target.
              // Important after the user picks a category that produces
              // known coverage — the Unknown badge disappears, so the
              // subtitle pencil becomes the only re-edit route.
              item.coverageStatus === "unknown");
          const pillState: "user_corrected" | "needs_review" | "auto" =
            item.user_corrected_at
              ? "user_corrected"
              : item.codeIdentity?.promotionState === "proposed" ||
                  (item.codeIdentity != null &&
                    item.codeIdentity.identityId == null)
                ? "needs_review"
                : "auto";
          // F-7 — pillClass + pillLabel removed; the click target is now the
          // Coverage badge itself with a built-in pencil icon. pillState still
          // drives the tooltip text on hover.

          return (
            <div key={item.id} data-line-item-id={item.id}>
              {/* Session 86 round 6 — Mobile card layout (<768px). Stacked
                  label/value pairs per line item; no horizontal scroll.
                  Mirrors the desktop row's click behavior (whole card toggles
                  expansion; category subtitle stopPropagation triggers modal). */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleRowCollapsed(item.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleRowCollapsed(item.id);
                  }
                }}
                className="md:hidden block w-full text-left px-5 py-4 border-t border-gray-100 transition-colors hover:bg-gray-50 cursor-pointer"
              >
                <div className="mb-3">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
                  </div>
                  {showCategoryPill && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCorrectionModal(item.id);
                      }}
                      title={
                        pillState === "user_corrected"
                          ? "You changed this category. Click to edit again."
                          : pillState === "needs_review"
                            ? "We couldn't auto-categorize this. Click to set."
                            : "Click to change category"
                      }
                      className="mt-1 inline-flex items-center gap-1 -ml-1 rounded px-1 py-0.5 text-xs text-blue-600 hover:bg-blue-50 hover:text-blue-700 transition-colors group/cat-mobile"
                    >
                      <span className={item.service_slug ? "" : "italic"}>
                        {item.service_slug
                          ? humanizeSlug(item.service_slug)
                          : item.billing_code
                            ? legacyCategoryReviewHint(item.billing_code)
                            : "Set category"}
                      </span>
                      <svg className="h-3 w-3 opacity-60 group-hover/cat-mobile:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  )}
                </div>
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Code</dt>
                    <dd className="font-mono text-gray-700">{item.billing_code || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Billed</dt>
                    <dd className="tabular-nums text-gray-900">${billed.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Paid</dt>
                    <dd className="tabular-nums text-gray-600">${paid.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Plan</dt>
                    <dd className={`tabular-nums font-semibold ${shouldOwe === 0 ? "text-green-600" : "text-gray-900"}`}>${shouldOwe.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Recovery</dt>
                    <dd className="tabular-nums font-bold">
                      {refundComponent + forgivenessComponent >= 1 ? (
                        <span className="text-green-700">+${(refundComponent + forgivenessComponent).toLocaleString()}</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between items-center gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Coverage</dt>
                    <dd className="flex items-center gap-1.5">
                      {coverageBadge ? (
                        flywheelEnabled && (item.coverageStatus === "unknown" || item.user_corrected_at != null) ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openCorrectionModal(item.id);
                            }}
                            title={item.user_corrected_at ? "Click to change your pick" : "Click to pick the right category"}
                            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className} cursor-pointer ring-1 ring-blue-300 hover:ring-blue-400 hover:bg-blue-50 transition-colors`}
                          >
                            <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            {coverageBadge.label}
                          </button>
                        ) : (
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className}${acaTooltip ? " cursor-help underline decoration-dotted decoration-1 underline-offset-2" : ""}`}
                            title={acaTooltip}
                          >
                            {coverageBadge.label}
                          </span>
                        )
                      ) : <span className="text-gray-300">—</span>}
                      {pillState === "user_corrected" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCorrectionModal(item.id);
                          }}
                          title="Click to change your pick"
                          className="rounded-sm bg-blue-100 px-1 py-px text-[9px] font-semibold text-blue-700 cursor-pointer ring-1 ring-blue-200 hover:bg-blue-200 hover:ring-blue-300 transition-colors"
                        >
                          Your pick
                        </button>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              {/* Desktop table row — hidden at mobile. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleRowCollapsed(item.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleRowCollapsed(item.id);
                  }
                }}
                className="hidden md:grid w-full grid-cols-[minmax(0,_1fr)_55px_70px_70px_50px_75px_minmax(95px,_1.4fr)] gap-3 items-center px-5 py-3.5 text-left transition-colors border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
              >
                <div className="min-w-0 text-xs text-gray-900">
                  <div className="truncate">
                    {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
                  </div>
                  {/* Session 86 — category subtitle is the click target for
                      CategoryCorrectionModal. Was on the Coverage badge in
                      Session 85; moved here per Andrew's direction so the
                      subtitle ALSO advertises clickability (button-style hover
                      + pencil icon). Stops row-toggle propagation. */}
                  {showCategoryPill && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCorrectionModal(item.id);
                      }}
                      title={
                        pillState === "user_corrected"
                          ? "You changed this category. Click to edit again."
                          : pillState === "needs_review"
                            ? "We couldn't auto-categorize this. Click to set."
                            : "Click to change category"
                      }
                      className="mt-1 inline-flex items-center gap-1 -ml-1 rounded px-1 py-0.5 text-[10px] text-blue-600 hover:bg-blue-50 hover:text-blue-700 transition-colors group/cat"
                    >
                      <span className={item.service_slug ? "" : "italic"}>
                        {item.service_slug
                          ? humanizeSlug(item.service_slug)
                          : item.billing_code
                            ? legacyCategoryReviewHint(item.billing_code)
                            : "Set category"}
                      </span>
                      <svg
                        className="h-2.5 w-2.5 opacity-60 group-hover/cat:opacity-100 transition-opacity"
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
                    </button>
                  )}
                </div>
                <div className="min-w-0 text-xs text-gray-500 font-mono truncate">
                  {item.billing_code || "—"}
                </div>
                {/* Session 86 round 5 — Billed column shows the RAW provider-
                    billed amount. The Plan-says/Bill-shows compare below
                    explains the insurer write-off and what the user actually
                    paid OOP. BillCard list view keeps "Billed Adjusted" since
                    its top-level summary number needs the post-writeoff value. */}
                <div
                  className="text-xs text-gray-900 text-right tabular-nums whitespace-nowrap"
                  title={
                    (item.insurance_adjusted_amount ?? 0) > 0
                      ? `Provider billed $${billed.toLocaleString()}; insurer wrote off $${(item.insurance_adjusted_amount ?? 0).toLocaleString()}, leaving an adjusted balance of $${billedAdjusted.toLocaleString()}.`
                      : `$${billed.toLocaleString()} billed.`
                  }
                >
                  ${billed.toLocaleString()}
                </div>
                <div className="text-xs text-gray-500 text-right tabular-nums whitespace-nowrap">
                  ${paid.toLocaleString()}
                </div>
                {/* Plan Share — what your plan says you should owe. */}
                <div
                  className={`text-xs font-semibold text-right tabular-nums whitespace-nowrap ${shouldOwe === 0 ? "text-green-600" : "text-gray-900"}`}
                  title={`Per your plan, you should owe $${shouldOwe.toLocaleString()} for this service.`}
                >
                  ${shouldOwe.toLocaleString()}
                </div>
                {/* Recovery — single combined value (refund + insured).
                    The breakdown into Refund vs Insured surfaces in the
                    amber-card explanation below; the column itself stays
                    clean with one bold green number per line. */}
                <div
                  className="text-right text-xs font-bold tabular-nums whitespace-nowrap"
                  title={
                    refundComponent + forgivenessComponent >= 1
                      ? `Total recoverable: $${(refundComponent + forgivenessComponent).toLocaleString()} ($${refundComponent.toLocaleString()} refund + $${forgivenessComponent.toLocaleString()} insurer should have insured).`
                      : "Nothing recoverable on this line — bill is within plan share."
                  }
                >
                  {refundComponent + forgivenessComponent >= 1 ? (
                    <span className="text-green-700">+${(refundComponent + forgivenessComponent).toLocaleString()}</span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </div>
                {/* Coverage badge — Session 86: static display by default.
                    S132 Item 2: when coverageStatus === 'unknown' AND
                    flywheel flag ON, the badge becomes a click target opening
                    CategoryCorrectionModal so the user can try a different
                    service category. UI gated on flywheelEnabled because the
                    backend endpoint requires the same flag (mig 087). */}
                <div className="flex items-center justify-center gap-1.5">
                  {coverageBadge ? (
                    flywheelEnabled && (item.coverageStatus === "unknown" || item.user_corrected_at != null) ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCorrectionModal(item.id);
                        }}
                        title={item.user_corrected_at ? "Click to change your pick" : "Click to pick the right category"}
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className} cursor-pointer ring-1 ring-blue-300 hover:ring-blue-400 hover:bg-blue-50 transition-colors`}
                      >
                        <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        {coverageBadge.label}
                      </button>
                    ) : (
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className}${acaTooltip ? " cursor-help underline decoration-dotted decoration-1 underline-offset-2" : ""}`}
                        title={acaTooltip}
                      >
                        {coverageBadge.label}
                      </span>
                    )
                  ) : null}
                  {pillState === "user_corrected" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openCorrectionModal(item.id);
                      }}
                      title="Click to change your pick"
                      className="rounded-sm bg-blue-100 px-1 py-px text-[9px] font-semibold text-blue-700 cursor-pointer ring-1 ring-blue-200 hover:bg-blue-200 hover:ring-blue-300 transition-colors"
                    >
                      Your pick
                    </button>
                  )}
                </div>
                {/* Flags column dropped in Session 85 round 3 — finding count
                    info now surfaces via the Refund/Forgive green numbers and
                    the expanded-row state. */}
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

                  {/* Actionable steps — S132 iter-5: refreshed to mirror the
                      Candid product flow (Claim drafts the letter, Case
                      escalates to attorneys) instead of generic "mail your
                      appeal" copy. */}
                  <div className="rounded-lg border border-gray-200 bg-white p-3">
                    <p className="text-xs font-semibold text-gray-900">How to dispute</p>
                    <ol className="mt-1.5 space-y-1 text-xs text-gray-600">
                      <li>1. Call the insurer claim number on your card and ask why no payment was made for this service.</li>
                      <li>2. If they deny or stall, use Candid Claim to draft a dispute letter or information request using the Dispute button below.</li>
                      <li>3. If still denied, use Candid Case to connect with attorneys who specialize in medical billing disputes.</li>
                    </ol>
                  </div>

                  {/* Session 86 round 2 — per-line dispute button removed.
                      Dispute is bill-level only; the BulkDisputeButton at the
                      bottom of the table aggregates this gap line (synthesized
                      as a missing_adjustment finding) along with everything
                      else worth disputing. */}
                </div>
              )}

              {/* Session 85 — show expansion panel when there's something to
                  put in it. Need EITHER findings to render the amber card OR
                  planCoverage + recovery values to render the green/red
                  compare. Without either, the panel would be empty save for
                  a lonely "Hide details" link, which is confusing. */}
              {isExpanded && (
                findings.length > 0 ||
                (item.planCoverage != null && (refundComponent >= 1 || forgivenessComponent >= 1)) ||
                (showDismissed && dismissedCount > 0)
              ) && (
                <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-3">
                  {/* Session 85 round 3 — bring back the Plan-says / Bill-shows
                      green/red compare at the TOP of the findings expansion.
                      Andrew called this out as the most useful visual; it was
                      previously gated on the no-findings gap case only. Now
                      it renders whenever the row is expanded AND we have plan
                      coverage info. */}
                  {item.planCoverage && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700">Your plan says</p>
                        <p className="mt-1 text-sm font-bold text-green-900">
                          {buildPlanSays(item.planCoverage)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-red-700">Bill shows</p>
                        <p className="mt-1 text-sm font-bold text-red-900">
                          Billed ${billed.toLocaleString()}
                        </p>
                        {/* Session 85 — user-centric fields per Andrew's
                            direction: what they were charged + insurer's
                            expected vs actual payment. Drop the contractual-
                            adjustment line (low value to users) and the
                            "amount you can recover" line (lives in the amber
                            box below; would be redundant). */}
                        <p className="mt-1.5 text-xs text-red-800">
                          Your insurer should have paid: ${(() => {
                            // Insurer's contractual share = allowed − plan cost-share
                            // allowed = billed − insurance_adjusted
                            const allowed = billed - (item.insurance_adjusted_amount ?? 0);
                            return Math.max(0, allowed - shouldOwe).toLocaleString();
                          })()}
                        </p>
                        <p className="mt-0.5 text-xs text-red-800">
                          Your insurer actually paid: ${(item.insurance_paid ?? 0).toLocaleString()}
                        </p>
                        {patientPaid > 0 && (
                          <p className="mt-0.5 text-xs text-red-800">
                            You paid: ${patientPaid.toLocaleString()} OOP
                          </p>
                        )}
                      </div>
                    </div>
                  )}
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
                  {/* Session 85 — Amber finding card restructure per Andrew:
                      • Headline (the rule's title) preserved at top
                      • Conditional Refund + Insured breakdown sentence (built
                        from line-level recovery values, not the finding's
                        own description text)
                      • Two static CTA lines (call insurer first; dispute as
                        fallback)
                      • No Dismiss button (we want the user to see + act, not
                        hide)
                      • No taxonomy subtitle ("INSURANCE UNDER-PAYMENT" line)
                        — internal type slug doesn't help the user. */}
                  {findings.map((f) => (
                    <div
                      key={f.id}
                      className={`p-4 rounded-lg border text-xs ${
                        f.dismissed
                          ? "text-gray-500 bg-gray-100 border-gray-200 opacity-70"
                          : SEVERITY_COLORS[f.severity] || "text-gray-700 bg-gray-50 border-gray-200"
                      }`}
                    >
                      <p className="text-sm font-bold">{f.title}</p>
                      {!f.dismissed && (refundComponent > 0 || forgivenessComponent > 0) && (
                        <p className="mt-2 text-[12px] leading-relaxed opacity-90">
                          {refundComponent > 0 && forgivenessComponent > 0
                            ? `This includes a $${refundComponent.toLocaleString()} refund and $${forgivenessComponent.toLocaleString()} your insurer should have insured.`
                            : refundComponent > 0
                              ? `This is a $${refundComponent.toLocaleString()} refund.`
                              : `This is $${forgivenessComponent.toLocaleString()} your insurer should have insured.`}
                        </p>
                      )}
                      {!f.dismissed && (
                        <p className="mt-2 text-[12px] leading-relaxed opacity-90">
                          Call your insurer first. Many under-payments resolve with one phone call. If that doesn&apos;t work, click &ldquo;Dispute this charge&rdquo; below and we&apos;ll draft a formal letter for you.
                        </p>
                      )}
                      {f.dismissed && f.dismissed_reason && (
                        <p className="mt-1.5 text-[10px] uppercase tracking-wider opacity-60">
                          Dismissed: <span className="italic normal-case">{f.dismissed_reason.replace(/_/g, " ")}</span>
                        </p>
                      )}
                    </div>
                  ))}

                  {/* Session 86 round 2 — per-line dispute button removed.
                      Dispute is always bill-level; the single CTA at the
                      bottom of the table aggregates every actionable finding
                      on this bill into one letter. Keeps the UX consistent:
                      multiple charges = multiple rows under the same header,
                      one shared dispute action below. */}

                  {/* Bottom plan-says box removed Session 85 round 3 — its
                      info is surfaced at the TOP of this expansion via the
                      Plan-says/Bill-shows green/red compare. Source line
                      ("Source: sbc_parsed") was low-value to end users. */}

                  {/* Session 85 — explicit "Hide details" affordance. Default
                      is expanded (Andrew's direction); user can collapse a
                      row's detail panel without having to remember the
                      whole-row click toggle. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRowCollapsed(item.id);
                    }}
                    className="mt-1 self-end text-[10px] font-medium text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                    Hide details
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>{/* /table outer (rounded-xl) */}

      {/* Session 86 — bill-level "Dispute all charges" button. Surfaces when
          there are ≥2 actionable un-dismissed findings on the bill (line-level
          + claim-level combined). Per the design write-up: aggregates all
          findings + claimLineItemIds into ONE letter + ONE dispute_outcomes
          row. Per-line buttons remain for users who want to chase recoveries
          one at a time. */}
      <BulkDisputeButton
        claimId={claimId}
        claim={claim}
        primaryLineItems={primaryLineItems}
        claimLevelFindings={visibleClaimLevelFindings}
        showDismissed={showDismissed}
        getAuthToken={getAuthToken}
        onGenerated={(result) => router.push(disputeUrlForResult(result))}
        // S132 Item 3: if a non-cancelled dispute already exists for this
        // claim, the button switches to "View Dispute Letter" + navigates
        // straight to the most recent letter (no re-draft). Re-draft entry
        // point stays exclusively on /disputes Re-draft toolbar button so
        // user can review strengthen-this-letter signals first.
        existingDisputeId={
          data.disputes.find((d) => d.status !== "cancelled")?.id ?? null
        }
      />

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
          userPlanCoverage={data?.userPlanCoverage ?? []}
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
              const next = new Map(prev);
              // §3.9 — 24-hour snooze. Long enough to skip a single workday
              // session; short enough that unresolved conflicts resurface next day.
              next.set(activeConflictLine.id, Date.now() + 24 * 60 * 60 * 1000);
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
  // S132 iter-5: planCoverage=null now framed as "Not in your uploaded plan"
  // (matches the COVERAGE_BADGE.unknown label change). Previous "we don't
  // have coverage info" was accurate but too vague — "Not in plan" tells
  // the user what to do (verify or re-categorize) without overclaiming
  // ("Not Covered" implies an insurer policy we can't back from missing data).
  const coverageSentence = planCoverage == null
    ? "This service isn't in your uploaded plan. The EOB records $0 insurance payment and $0 patient responsibility."
    : planCoverage.covered === false
      ? "The EOB records $0 insurance payment and $0 patient responsibility."
      : "Your plan covers this service, but the EOB records $0 insurance payment and $0 patient responsibility.";

  const amountSentence = billed > 0
    ? `The $${billed.toLocaleString()} charge is likely a denial, write-off, or missing EOB data.`
    : "";

  return [coverageSentence, amountSentence].filter(Boolean).join(" ");
}

function buildPlanSays(planCoverage: LineItem["planCoverage"]): string {
  // S132 iter-5: null planCoverage → "Not in plan." Same reframe as the
  // COVERAGE_BADGE.unknown label — "Not in plan" gives the user a clear
  // next step (re-categorize / verify with insurer / upload plan supplement)
  // without overclaiming ("Not covered" is an insurer policy assertion we
  // can't back from missing data).
  if (planCoverage == null) return "Not in plan";
  if (planCoverage.covered === false) return "Not covered";

  const parts: string[] = [];
  if (planCoverage.copay != null) parts.push(`$${planCoverage.copay} copay`);
  if (planCoverage.coinsurance != null) parts.push(`${normalizeCoinsurancePct(planCoverage.coinsurance)}% coinsurance`);

  if (parts.length === 0) return "Covered · $0";
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
  // S109 PR #2 — toast tracks kind so error cases (e.g., 3/24h rate limit
  // 429) render amber instead of success-green emerald.
  const [redraftToast, setRedraftToast] = useState<{ text: string; kind: "success" | "error" } | null>(null);

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
      setRedraftToast({
        text: targets === 0
          ? "Letter re-drafted with current plan + evidence."
          : upgrades > 0
            ? `Letter re-drafted — ${upgrades} of ${targets} citation${targets === 1 ? "" : "s"} upgraded.`
            : `Letter re-drafted — ${targets} citation${targets === 1 ? "" : "s"} attempted; none upgraded this run.`,
        kind: "success",
      });
      // Refetch the dispute detail to show the updated letter content.
      const refetch = await fetch(`/api/disputes/${dispute.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (refetch.ok) setDetail(await refetch.json());
    } catch (err) {
      setRedraftToast({
        text: err instanceof Error ? err.message : "Re-draft failed",
        kind: "error",
      });
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
              <div
                className={`mb-1 rounded-md px-2 py-1 text-[10px] ${
                  redraftToast.kind === "error"
                    ? "bg-amber-50 text-amber-800"
                    : "bg-emerald-50 text-emerald-800"
                }`}
              >
                {redraftToast.text}
              </div>
            )}
            {detailLoading ? (
              // S109 PR #2 — show a loader during the async dispute-detail
              // fetch so the LetterTeaser's "Legacy dispute" placeholder
              // doesn't flash before letterContent populates. The teaser is
              // legitimately shown only when loading completes AND letter
              // content is confirmed absent (legacy pre-persistence row).
              <div className="p-2 bg-white border border-gray-100 rounded-lg">
                <div className="flex items-center justify-center py-6">
                  <div
                    className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
                    aria-label="Loading dispute letter"
                  />
                </div>
              </div>
            ) : hasLetter && isPro ? (
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
            {friendlyFindingType(finding.type)}
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

// ── S74.5c §3.8 — Re-audit throttle toast ─────────────────────────────────
//
// Surfaces the two G3 LOCK throttle paths (1/min + 5/day per claim) so the
// user understands why their last category correction didn't refresh the
// audit. Per-minute case auto-dismisses after 8s; daily-cap case persists
// until manual dismiss (+ surfaces support link for exception requests).

function ThrottleToast({
  minuteSecondsRemaining,
  dailyExceeded,
  onDismiss,
}: {
  minuteSecondsRemaining: number | null;
  dailyExceeded: boolean;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (minuteSecondsRemaining == null) return;
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [minuteSecondsRemaining, onDismiss]);

  if (dailyExceeded) {
    return (
      <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-900">
              You&apos;ve reached today&apos;s re-audit limit (5/day).
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              Your changes are saved. Findings will refresh tomorrow, or{" "}
              <a
                href="mailto:support@candidclaim.com"
                className="underline hover:text-amber-900"
              >
                reach out to support
              </a>{" "}
              for an exception.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 text-xs text-amber-700 hover:text-amber-900"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-blue-900">
            Just a moment — we&apos;re applying your last change.
          </p>
          <p className="mt-0.5 text-xs text-blue-800">
            Findings will refresh in {minuteSecondsRemaining}s.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-xs text-blue-700 hover:text-blue-900"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ── Session 86 — BulkDisputeButton ────────────────────────────────────────
//
// SOLE dispute affordance on /claim. Per-line dispute buttons were removed
// in round 2 — every contestable line on the bill rolls into ONE letter +
// ONE dispute_outcomes row.
//
// Aggregation sources:
//   1. Line-level actionable un-dismissed findings (auditFindings on the row)
//   2. Claim-level actionable un-dismissed findings (D15 unallocated_balance,
//      future claim-header rules)
//   3. Gap lines — billed > $0 + insurance_paid == 0 + patient_owes == 0 +
//      coverage != "not_covered". Synthesized as missing_adjustment findings
//      so the bundle covers them even when no audit rule fired (universal
//      "we don't know what's going on with this line; help me dispute it" path).
//
// Visibility: anything aggregates → button shows. Label is singular for
// n=1 contested line, plural for n≥2.
//
// Dedup behavior (inherited from persist.ts): keyed on the first
// claimLineItemId in the bundle. A second bulk-dispute click updates the
// same row's letter_content + amount_disputed. Multi-line linkage preserved
// in metadata.claimLineItemIds[].
//
// Letter type: picks the dominant finding type when one is present; falls
// back to "insurance_appeal" for mixed bundles (template renders each
// finding block independently).

function BulkDisputeButton({
  claimId,
  claim,
  primaryLineItems,
  claimLevelFindings,
  showDismissed,
  getAuthToken,
  onGenerated,
  existingDisputeId,
}: {
  claimId: string;
  claim: Record<string, unknown>;
  primaryLineItems: LineItem[];
  claimLevelFindings: ClaimLevelFindingMeta[];
  showDismissed: boolean;
  getAuthToken: () => Promise<string | null>;
  onGenerated: (result: { disputeId?: string | null; deduplicated?: boolean }) => void;
  existingDisputeId?: string | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // S132 iter-2 — overlay is hoisted to (app)/layout.tsx so it survives the
  // /claim → /disputes navigation as a single persistent React mount (no
  // carousel/microcopy reset). BulkDisputeButton drives start()/stop();
  // disputes/page.tsx stops the overlay when its letter is ready.
  const disputeDraftOverlay = useDisputeDraftOverlay();

  // 1. Per-line actionable findings keyed back to their owning line item.
  const lineLevelActionable: Array<{ lineItemId: string; lineNumber: number; finding: AuditFinding; billedAmount: number }> = [];
  for (const li of primaryLineItems) {
    const all = ((li.metadata?.auditFindings || []) as AuditFinding[]);
    const live = showDismissed ? all : all.filter((f) => !f.dismissed);
    for (const f of live) {
      if (!f.actionable) continue;
      lineLevelActionable.push({
        lineItemId: li.id,
        lineNumber: li.line_number,
        finding: f,
        billedAmount: li.billed_amount || 0,
      });
    }
  }

  // 2. Claim-level actionable un-dismissed findings.
  const claimActionable = claimLevelFindings.filter((f) => !f.dismissed && f.actionable);

  // 3. Gap lines — synthesize a missing_adjustment finding so the bulk
  //    dispute bundle can cover lines no audit rule fired on. Two shapes:
  //      a. Mystery gap: billed > 0 + $0 insurance + $0 patient. No money
  //         moved despite a charge; universal "help me dispute" case.
  //      b. Recovery story: insurer under-paid relative to plan benefits and
  //         the recovery-math computed refund/forgiveness ≥ $1. Mirrors the
  //         row-expansion render gate at line 1210-1212 — whenever the row
  //         shows the green/red "Your insurer should have paid X" panel, the
  //         bulk dispute button must surface the same finding. Previously
  //         only (a) qualified, which silently hid the dispute CTA on the
  //         common "insurer paid $0 + you paid OOP" pattern.
  //    Skip lines that already have a real audit finding (avoid double-
  //    counting the same dollar value) and skip explicitly not-covered lines.
  const linesWithRealFindings = new Set(lineLevelActionable.map((e) => e.lineItemId));
  const gapSynthetic: Array<{ lineItemId: string; lineNumber: number; finding: AuditFinding; billedAmount: number }> = [];
  for (const li of primaryLineItems) {
    if (linesWithRealFindings.has(li.id)) continue;
    if (li.coverageStatus === "not_covered") continue;
    const billed = li.billed_amount || 0;
    const ins = li.insurance_paid || 0;
    const owed = li.patient_owes || 0;
    const refund = li.recovery?.refundComponent ?? 0;
    const forgiveness = li.recovery?.forgivenessComponent ?? 0;
    const isMysteryGap = billed > 0 && ins === 0 && owed === 0;
    const hasRecoveryStory = li.planCoverage != null && (refund >= 1 || forgiveness >= 1);
    if (!isMysteryGap && !hasRecoveryStory) continue;

    const syntheticId = `gap-${li.id}`;
    const serviceLabel = li.description || li.service_slug?.replace(/_/g, " ") || "service";
    let title: string;
    let description: string;
    let estimatedOvercharge: number;
    if (isMysteryGap) {
      title = `Unexplained $${billed.toLocaleString()} charge for ${serviceLabel}`;
      description = `Service ${li.coverageStatus === "covered" ? "covered by plan" : "with no coverage data"} but EOB records $0 insurance payment and $0 patient responsibility. Provider billed $${billed.toLocaleString()}. Code: ${li.billing_code || "N/A"}.`;
      estimatedOvercharge = billed;
    } else {
      const recoveryAmount = refund + forgiveness;
      const patientPaid = li.recovery?.patientPaid ?? li.patient_paid_amount ?? 0;
      const shouldOwe = li.recovery?.shouldOwe ?? 0;
      title = `Insurer under-paid $${recoveryAmount.toLocaleString()} for ${serviceLabel}`;
      description = `Service covered by plan. Insurance paid $${ins.toLocaleString()} on a $${billed.toLocaleString()} charge; patient paid $${patientPaid.toLocaleString()} out-of-pocket. Plan-stated patient cost-share: $${shouldOwe.toLocaleString()}. Code: ${li.billing_code || "N/A"}.`;
      estimatedOvercharge = recoveryAmount;
    }
    gapSynthetic.push({
      lineItemId: li.id,
      lineNumber: li.line_number,
      finding: {
        id: syntheticId,
        type: "missing_adjustment",
        severity: "high",
        estimatedOvercharge,
        title,
        actionable: true,
        description,
      },
      billedAmount: billed,
    });
  }

  const aggregated = [...lineLevelActionable, ...gapSynthetic];
  const totalContested = aggregated.length + claimActionable.length;

  // S132 Item 3: short-circuit when a non-cancelled dispute already exists.
  // The button becomes a navigation affordance to the existing letter — no
  // re-draft, no API call, no draft overlay. Stays mounted even when
  // totalContested === 0 (e.g., user dismissed all findings post-draft) so
  // the user retains access to their drafted letter.
  if (existingDisputeId) {
    return (
      <div className="mb-4">
        <button
          type="button"
          onClick={() => router.push(`/disputes?dispute=${existingDisputeId}`)}
          className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          View Dispute Letter
        </button>
      </div>
    );
  }

  if (totalContested === 0) return null;

  const distinctLineItemIds = Array.from(new Set(aggregated.map((e) => e.lineItemId)));
  // totalRecoverable removed Session 86 round 6 — button label is action-only
  // (no specific dollar promise). Recovery info stays visible as DATA in the
  // table column + amber finding card, not as a CTA promise.

  // Letter type: dominant type wins; mixed falls back to insurance_appeal.
  const typeCounts = new Map<string, number>();
  for (const e of aggregated) typeCounts.set(e.finding.type, (typeCounts.get(e.finding.type) ?? 0) + 1);
  for (const f of claimActionable) typeCounts.set(f.type, (typeCounts.get(f.type) ?? 0) + 1);
  const dominantType = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const letterTypeHint = (() => {
    if (!dominantType) return "insurance_appeal";
    if (dominantType === "balance_billing") return "balance_billing";
    if (dominantType === "duplicate") return "duplicate_charge";
    if (dominantType === "overcharge") return "overcharge";
    return "insurance_appeal";
  })();

  async function handleClick() {
    if (loading) return;
    setLoading(true);
    setError(null);
    disputeDraftOverlay.start();
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");

      const claimMeta = claim;
      const allFindings = [
        ...aggregated.map((e) => ({
          ...e.finding,
          billedAmount: e.billedAmount,
          benchmarkAmount: undefined,
          description: e.finding.description || e.finding.title,
          lineItems: [e.lineNumber],
        })),
        ...claimActionable.map((f) => ({
          ...f,
          billedAmount: 0,
          benchmarkAmount: undefined,
          description: f.description || f.title,
          lineItems: [] as number[],
        })),
      ];

      const auditReport = {
        id: claimId,
        documentId: (claimMeta.source_document_id as string) || "",
        userId: (claimMeta.user_id as string) || "",
        parsedBill: {
          provider: (claimMeta.metadata as Record<string, unknown>)?.provider || { name: "Unknown" },
          patient: (claimMeta.metadata as Record<string, unknown>)?.patient || { name: "Unknown" },
          serviceDate: (claimMeta.date_of_service as string) || "",
          lineItems: primaryLineItems.map((li) => ({
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
        findings: allFindings,
        summary: {
          totalFindings: allFindings.length,
          totalEstimatedOvercharge: allFindings.reduce((s, f) => s + (f.estimatedOvercharge || 0), 0),
          highSeverityCount: allFindings.filter((f) => f.severity === "high" || f.severity === "critical").length,
          actionableCount: allFindings.filter((f) => f.actionable).length,
        },
        createdAt: new Date().toISOString(),
      };

      const res = await fetch("/api/disputes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          auditReport,
          findingIds: allFindings.map((f) => f.id),
          letterType: letterTypeHint,
          claimId,
          claimLineItemIds: distinctLineItemIds,
          insurancePlanId: (claimMeta.insurance_plan_id as string) || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Dispute generation failed (${res.status})`);
      }
      const result = await res.json();
      onGenerated(result);
      // S132 iter-2: do NOT setLoading(false) on success + do NOT stop the
      // overlay here. router.push to /disputes is triggered by onGenerated;
      // overlay must persist through nav so disputes/page.tsx can stop() once
      // the letter is fetched. Stopping here would briefly expose /claim.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dispute generation failed");
      setLoading(false);
      disputeDraftOverlay.stop();
    }
  }

  // Session 86 round 6 — button shows ACTION only, no specific dollar
  // promise. Showing "recover ~$X" on the CTA risks construing as a credit/
  // recovery guarantee (CROA + state UDAP exposure per Director Checkpoint
  // #5 — user-sends-letter model). Recovery info stays visible as DATA
  // (table column + amber card) but not as a promise on the action button.
  const buttonLabel = totalContested === 1 ? "Dispute charge" : "Dispute these charges";

  // S132 iter-2: overlay moved to (app)/layout.tsx via DisputeDraftOverlayProvider
  // so it persists across /claim → /disputes navigation as a single React mount.
  // S132 iter-8: overlay loader is now cube (audit loader retired).

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {buttonLabel}
      </button>
      {error && (
        <p className="mt-2 text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}

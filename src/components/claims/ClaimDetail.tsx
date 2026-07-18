"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import type { BillState } from "@/lib/claims/derive-bill-state";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { CategoryCorrectionModal } from "@/components/claims/CategoryCorrectionModal";
import { UploadPlanDocModal } from "@/components/claims/UploadPlanDocModal";
import { legacyCategoryReviewHint } from "@/lib/billing/code-categories";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";
import { buildAcaOverrideLine, type AcaOverride } from "@/lib/claims/aca-override-line";
import { LineDrawer } from "@/components/claims/LineDrawer";
import { BundleSuggestion } from "@/components/claims/BundleSuggestion";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useDisputeDraftOverlay } from "@/lib/loading/dispute-draft-overlay";
import { DisputePlanChooser, type DisputePlanChooserPlan } from "@/components/disputes/DisputePlanChooser";
import { CostShareBanner, hasAssumptionRows, type BannerAssumption, type CostShareVerdict, type CostShareOverrideRequest } from "@/components/claims/CostShareBanner";
import { AddPlanDetailsModal } from "@/components/claims/AddPlanDetailsModal";
import type { CostShareAssumption, CostShareOverrides } from "@/lib/claims/recovery-math";

interface CodeIdentityState {
  identityId: string | null;
  communitySlug: string | null;
  promotionState: "proposed" | "corroborated" | "admin_verified" | null;
  confidence: number | null;
  conflictsWithCommunity: boolean;
  userCorrectedAt: string | null;
  userCorrectionLockedAt: string | null;
}

// S135 — ACA-mandate override info from /api/claims/[claimId]. Non-null when
// the line is an ACA-mandated preventive/vaccine code on an ACA-compliant plan
// AND the plan's plan_covered_services row disagrees with the federal $0
// cost-share mandate (either assigns a non-$0 cost-share OR explicitly
// excludes the service). Drives the inline "Plan says X, federal law $0"
// message in the green plan-says box.
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
  // S153 — covered sibling slug for a secondary (category) match (e.g.
  // annual_physical → preventive_care), for the "via Preventive Care" note.
  coverageSecondaryMatchedSlug?: string | null;
  // S154 — secondary-match gate confidence + whether the user still needs to
  // verify it. 'estimate' coverage stays clickable-to-correct AND shows a
  // "Verify coverage" affordance; demoted in disputes until confirmed.
  coverageConfidence?: "confident" | "estimate" | null;
  coverageNeedsConfirmation?: boolean;
  // S135 — plan-vs-ACA override (see AcaOverride above). Drives inline override
  // message in the green plan-says box. Null when no override applies.
  acaOverride?: AcaOverride | null;
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
    // S140 — cite-grade provenance attached by /api/claims/[claimId]. Gates
    // per-line LineDrawer recovery strip (suppressed when isCitablePerLine
    // is false; aggregate bar below shows the one accurate number).
    // H1 — insuranceAdjustedSource added to track writeoff cite-grade too.
    // H5 — insurancePaidSource added so isCitablePerLine requires ALL 4
    // numeric fields per-line cite-grade.
    provenance?: {
      patientPaidSource: "per_line" | "header_prorated";
      patientResponsibilitySource: "per_line" | "header_prorated";
      insuranceAdjustedSource?: "per_line" | "header_prorated";
      insurancePaidSource?: "per_line" | "header_prorated";
      isCitablePerLine: boolean;
    };
  };
  // S140 fix-pass H1 — per-line adjusted billed (= raw billed − resolved
  // writeoff). Drives UI BILLED column + LineDrawer Bill card + OVERCHARGE
  // pill calc. Falls back to raw billed_amount when undefined (legacy).
  adjustedBilled?: number;
  // S140 fix-pass H5 — per-line insurer payment (pro-rated from header
  // when per-line is sparse). Drives LineDrawer Bill card "Insurer paid $X"
  // + desktop/mobile YOU PAID column. Falls back to raw insurance_paid.
  insurancePaidResolved?: number;
  codeIdentity?: CodeIdentityState | null;
  // Cost-Share v2 (S214) — the engine's per-line verdict, attached by the claims
  // API ONLY when recovery_cost_share_v2 is ON. Its PRESENCE switches the dispute
  // synthesis below to verdict-driven (vs the legacy deductible-blind
  // isMysteryGap/hasRecoveryStory). Absent/null → today's behavior.
  costShareVerdict?: "confident" | "correct" | "recovery" | "not_covered" | "insufficient" | null;
  // Cost-Share v2 (W2) — per-line assumptions behind the verdict (§5 banner
  // chips). Same flag-gated presence as costShareVerdict.
  costShareAssumptions?: CostShareAssumption[];
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
  disputes: Array<{ id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number; isStale?: boolean; chargeCount?: number }>;
  relatedClaims: Array<{ id: string; date_of_service: string; status: string; total_billed: number; provider_name: string | null }>;
  // S132 iter-6 Phase 1 — slugs present in user's plan_covered_services for
  // this claim's plan_id. Drives CategoryCorrectionModal filtering + best-
  // guess "Use this" gating. Empty array when no plan uploaded.
  userPlanCoverage?: PlanCoverageEntry[];
  // Cost-Share v2 (W2/D1) — bill-level verdict for the §5 banner; flag-gated
  // (absent when recovery_cost_share_v2 is OFF → today's UI).
  costShareBill?: { verdict: CostShareVerdict };
  // Cost-Share v2 (W3) — the user's resolved overrides (met-status + as-of dates
  // + per-claim network), so the banner renders confirmed "you set this" chips.
  costShareOverrides?: CostShareOverrides;
  recovery?: {
    billed: number;
    alreadyPaid: number;
    stillOutstanding: number;
    shouldOwe: number;
    potentialRecovery: number;
    refundComponent: number;
    forgivenessComponent: number;
    // S140 — citation source for claim-level recovery. Mirrors per-line
    // recovery.provenance.isCitablePerLine but at claim aggregate level.
    provenance?: {
      citationSource: "per_line_sum" | "claim_header";
    };
  };
  // S140 — cite-grade effective totals from /api/claims/[claimId]. Drives
  // billTotals aggregator below (replaces sum-of-per-line-nulls bug).
  effectiveTotals?: {
    patientPaid: number;
    insurancePaid: number;
    insuranceAdjusted: number;
    patientResponsibility: number;
    provenance: {
      patientPaidSource: "per_line_sum" | "claim_header";
      insurancePaidSource: "per_line_sum" | "claim_header";
      insuranceAdjustedSource: "per_line_sum" | "claim_header";
      patientResponsibilitySource: "per_line_sum" | "claim_header";
    };
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

const COVERAGE_BADGE: Record<string, { label: string; className: string }> = {
  covered: { label: "Covered", className: "text-green-700 bg-green-50" },
  // not_covered fires when plan_covered_services explicitly excludes the
  // service. Clicking opens UploadPlanDocModal (upload-only, no re-pick) —
  // re-picking wouldn't help when the underlying plan data confirms exclusion.
  not_covered: { label: "Not in plan", className: "text-gray-500 bg-gray-100" },
  // unknown fires when no plan_covered_services row exists for the line
  // (whether the line has a slug or not). User resolves via
  // CategoryCorrectionModal picker.
  unknown: { label: "Unknown", className: "text-gray-500 bg-gray-100" },
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
  billState: billStateProp,
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
  /**
   * B4.2 — parent /claim page passes the same `BillState` it computed for
   * the list view's BillCard so the bill-detail screen renders the matching
   * FlaggedBody / ReviewBody / CleanBody headline below the line items.
   * Optional for back-compat; when absent, no state-specific headline renders.
   */
  billState?: BillState | null;
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
  // S135 PR-3 — separate modal state for not_covered rows: clicking the
  // "Not in plan" badge or "Your pick" pill opens an upload-only modal,
  // not the category-correction dropdown. Re-picking the same catalog
  // wouldn't help if the user's plan data is missing the service.
  const [uploadPlanModalLineId, setUploadPlanModalLineId] = useState<string | null>(null);
  // Cost-Share v2 (W3 §7b) — line whose manual "Add plan details" form is open.
  const [addPlanDetailsLineId, setAddPlanDetailsLineId] = useState<string | null>(null);
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
  // Surface 3 (clarity redesign) — flagged-bill guided 4-step rail state:
  // the plan-vs-bill diff collapses behind "Show the math"; step 3's
  // "All services look right" / "Something looks wrong" verification pair.
  const [showMath, setShowMath] = useState(false);
  const [svcOk, setSvcOk] = useState(false);
  const [svcIssue, setSvcIssue] = useState(false);

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

  // S135 PR-3 — open upload-only modal for not_covered rows. No catalog
  // load (UploadPlanDocModal doesn't list slugs).
  const openUploadPlanModal = useCallback((lineId: string) => {
    setUploadPlanModalLineId(lineId);
  }, []);

  // S135 PR-3 — route the click to the right modal based on coverage state.
  // not_covered → upload-only modal. Anything else (unknown / covered
  // user-corrected) → existing dropdown picker.
  const openBadgeModal = useCallback(
    (lineId: string, coverageStatus: string | null | undefined) => {
      if (coverageStatus === "not_covered") {
        openUploadPlanModal(lineId);
      } else {
        openCorrectionModal(lineId);
      }
    },
    [openCorrectionModal, openUploadPlanModal],
  );

  const getAuthToken = useCallback(async () => {
    if (!user) return null;
    return user.firebaseUser.getIdToken();
  }, [user]);

  // B4.2 — "View uploaded bill" header icon (bonus per Andrew direction).
  // Fetches a short-lived signed URL for claims.source_document_id from
  // /api/claims/[claimId]/source-document/url and opens it in a new tab.
  const [viewBillLoading, setViewBillLoading] = useState(false);
  const [viewBillError, setViewBillError] = useState<string | null>(null);
  const handleViewBill = useCallback(async () => {
    if (viewBillLoading) return;
    setViewBillLoading(true);
    setViewBillError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(`/api/claims/${claimId}/source-document/url`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error("Source bill no longer available.");
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Could not open the bill (${res.status}).`);
      }
      const body = (await res.json()) as { url: string };
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setViewBillError(err instanceof Error ? err.message : "Could not open the bill.");
    } finally {
      setViewBillLoading(false);
    }
  }, [claimId, getAuthToken, viewBillLoading]);

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

  // Cost-Share v2 (W3) — post ONE assumption correction, then refetch so the
  // engine recomputes live. Uses refetchClaim + onClaimUpdated (NOT
  // handleCorrectionSubmitted — that fires the category-specific re-draft prompt;
  // letter staleness is W4's job via the evidence fingerprint).
  const [csOverridePending, setCsOverridePending] = useState<string | null>(null);
  const [csOverrideError, setCsOverrideError] = useState<string | null>(null);
  const submitCostShareOverride = useCallback(
    async (body: CostShareOverrideRequest, pendingKey: string) => {
      setCsOverridePending(pendingKey);
      setCsOverrideError(null);
      try {
        const token = await getAuthToken();
        if (!token) return;
        const res = await fetch(`/api/claims/${claimId}/cost-share-override`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setCsOverrideError(d.error || `Couldn't save your change (${res.status}).`);
          return;
        }
        await refetchClaim();
        if (onClaimUpdated) await onClaimUpdated();
      } catch {
        setCsOverrideError("Couldn't save your change. Please try again.");
      } finally {
        setCsOverridePending(null);
      }
    },
    [claimId, getAuthToken, refetchClaim, onClaimUpdated],
  );

  // Cost-Share v2 — multi-charge bills start with their line rows collapsed so
  // the bill isn't too busy (single-charge bills stay expanded). Runs once when
  // the claim first loads; user toggles take over after.
  const didInitCollapseRef = useRef(false);
  useEffect(() => {
    if (didInitCollapseRef.current || !data) return;
    didInitCollapseRef.current = true;
    const chargeCount = data.lineItems.filter((li) => (li.billed_amount ?? 0) > 0).length;
    if (chargeCount > 1) {
      setCollapsedRows(new Set(data.lineItems.map((li) => li.id)));
    }
  }, [data]);

  // S154 — confirm an estimate-tier secondary coverage match. Marks the line
  // user-confirmed (Pattern 1 #14 user-scoped) so the "Verify coverage"
  // affordance clears and the dispute pipeline may cite it as confirmed.
  const [confirmingCoverageId, setConfirmingCoverageId] = useState<string | null>(null);
  const handleConfirmCoverage = useCallback(
    async (lineId: string) => {
      setConfirmingCoverageId(lineId);
      try {
        const token = await getAuthToken();
        if (!token) return;
        const res = await fetch(
          `/api/claims/${claimId}/line-items/${lineId}/confirm-coverage`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ confirmed: true }),
          },
        );
        if (res.ok) {
          await refetchClaim();
          if (onClaimUpdated) await onClaimUpdated();
        }
      } catch (err) {
        console.error("[confirm-coverage] failed:", err);
      } finally {
        setConfirmingCoverageId(null);
      }
    },
    [claimId, getAuthToken, refetchClaim, onClaimUpdated],
  );

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

  // B4.2 — bill-level aggregates for FlaggedBody / CleanBody.
  // S140 — read cite-grade values from API's effectiveTotals (per-line
  // sum when available; claim-header fallback when per-line sparse).
  // Replaces sum-of-per-line-nulls bug that was showing $0 insurance paid
  // on Dec 12-style bills where Haiku populated only the header. Display
  // numbers now match dispute letter citations exactly.
  const billTotals = (() => {
    const eff = data.effectiveTotals;
    const insurancePaid = eff?.insurancePaid ?? 0;
    const patientPaid = eff?.patientPaid ?? 0;
    const insuranceAdjusted = eff?.insuranceAdjusted ?? 0;
    const billed = (claim.total_billed as number) || 0;
    const billedAdjusted = Math.max(0, billed - insuranceAdjusted);
    const shouldOwe = data.recovery?.shouldOwe ?? 0;
    const insurerShouldHavePaid = Math.max(0, billedAdjusted - shouldOwe);
    return {
      billed,
      billedAdjusted,
      insurancePaid,
      patientPaid,
      shouldOwe,
      insurerShouldHavePaid,
      refundComponent: data.recovery?.refundComponent ?? 0,
      forgivenessComponent: data.recovery?.forgivenessComponent ?? 0,
      potentialRecovery: data.recovery?.potentialRecovery ?? 0,
    };
  })();
  const billState = billStateProp ?? null;

  // S139 B4.2 multi-line — drives chevron column + LineDrawer rendering in
  // the line-items table AND multi-line branches in FlaggedBody (different
  // pill copy + row labels for "N services" vs single coverage). flaggedLineCount
  // = lines with recovery (refund + forgiveness) > 0; isMultiLine = flagged
  // bill state AND ≥2 flagged lines. Single-flagged-line bills keep the S138
  // single-line treatment (no chevron column; no LineDrawer; existing
  // expansion panel preserved).
  const isFlagged = billState === "overcharge_drafted" || billState === "overcharge_no_draft";
  const flaggedLineCount = primaryLineItems.filter((li) => {
    const refund = li.recovery?.refundComponent ?? 0;
    const forgive = li.recovery?.forgivenessComponent ?? 0;
    return refund + forgive > 0;
  }).length;
  const isMultiLine = isFlagged && flaggedLineCount > 1;
  // S140 fix-pass H2 — totalsBilledSum (raw billed sum) removed; FlaggedBody
  // Row 1 now always uses billTotals.billedAdjusted regardless of multi-line.

  const fmtMoney = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  // Cost-Share v2 (W2) — flatten per-line assumptions with the line context the
  // §5 banner chips + W3 override calls need (lineId + service label/slug). Over
  // primaryLineItems only — zero-charge reporting codes carry no cost-share stake
  // (the engine resolves them `confident`/no-assumptions), so they never chip here.
  const bannerAssumptions: BannerAssumption[] = primaryLineItems.flatMap((li) =>
    (li.costShareAssumptions ?? []).map((a) => ({
      ...a,
      lineId: li.id,
      serviceLabel: humanizeSlug(li.service_slug) || li.description || "this service",
      serviceSlug: li.service_slug,
    })),
  );
  // The line the banner's verdict-specific CTAs act on (matching line, else first).
  const bannerTargetLineId = (() => {
    const v = data.costShareBill?.verdict;
    const match = v ? primaryLineItems.find((li) => li.costShareVerdict === v) : null;
    return (match ?? primaryLineItems[0])?.id ?? null;
  })();
  // S263 — the disputed service's cost-share is EDITABLE only when the USER
  // entered it (planCoverage.source==='manual'); a plan-doc/parsed cost is
  // authoritative → read-only. Drives the persistent "Plan cost · Edit" banner row.
  const bannerEditableCost = (() => {
    const line = bannerTargetLineId
      ? primaryLineItems.find((li) => li.id === bannerTargetLineId)
      : null;
    const pc = line?.planCoverage;
    if (!pc || pc.source !== "manual" || (pc.copay == null && pc.coinsurance == null)) return null;
    return {
      serviceLabel: humanizeSlug(line!.service_slug) || line!.description || "this service",
      copay: pc.copay,
      coinsurancePercent: pc.coinsurance != null ? normalizeCoinsurancePct(pc.coinsurance) : null,
    };
  })();

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

  // B4.2 — surface the "View uploaded bill" icon only when claims.source_document_id
  // links to a real document. Auto-typed claims (no source) hide the icon entirely.
  const hasSourceDocument = Boolean(
    (claim as { source_document_id?: string | null }).source_document_id,
  );

  // ── Surface 3 (clarity redesign) — flagged-bill guided step rail ─────────
  // Step 2 ("Verify our assumptions") exists only when the Cost-Share card has
  // assumption rows to edit; later steps renumber accordingly.
  const railHasAssumptions =
    !!data.costShareBill &&
    hasAssumptionRows(bannerAssumptions, data.costShareOverrides ?? null, bannerEditableCost);
  const railStepServices = railHasAssumptions ? 3 : 2;
  const railStepRecover = railStepServices + 1;

  // Disputes list — step 4 body on flagged bills, bottom "Disputes" section
  // otherwise. Defined once so both placements render identically.
  const disputesListNode =
    data.disputes.length > 0 ? (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Disputes</h3>
          <div className="space-y-2">
            {data.disputes.map((d) => (
              <DisputeRow
                key={d.id}
                dispute={d}
                provider={providerName}
                recovery={billTotals.potentialRecovery}
                hasCostShare={!!data.costShareBill}
              />
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
    ) : null;

  return (
    <div>
      {/* Back button — B4.2 design chrome */}
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 border-none bg-transparent p-0 text-[13px] font-medium text-gray-500 transition-colors hover:text-blue-600"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        {backLabel}
      </button>

      {/* Bill-head — B4.2 redesign per plans/b4.2_bill_detail_redesign.md §4.1 */}
      <div className="mb-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">
          Bill from
        </div>
        <div className="flex items-center gap-2.5">
          <h1 className="m-0 text-[28px] font-bold leading-tight tracking-[-0.02em] text-gray-900">
            {providerName}
          </h1>
          {hasSourceDocument && (
            <button
              type="button"
              onClick={handleViewBill}
              disabled={viewBillLoading}
              className="grid h-9 w-9 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              title="View uploaded bill"
              aria-label="View uploaded bill"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 2v20l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2V2H4z" />
                <path d="M8 7h8" />
                <path d="M8 11h8" />
                <path d="M8 15h5" />
              </svg>
            </button>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-gray-500">
          <span>
            Date of service:{" "}
            <strong className="font-semibold text-gray-900">
              {(claim.date_of_service as string) || "Unknown date"}
            </strong>
          </span>
          <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden />
          <span>
            {data.lineItems.length} line item{data.lineItems.length !== 1 ? "s" : ""}
          </span>
          <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden />
          <span>
            Total billed{" "}
            <strong className="font-semibold text-gray-900">
              ${((claim.total_billed as number) || 0).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </strong>
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-[3px] text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-300">
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3.5}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Verified bill
          </span>
        </div>
      </div>

      {/* Cost-Share v2 — the §5 verdict + assumptions card renders BELOW the line
          table (mockup placement; see after the table outer), replacing the
          legacy CleanBody/ReviewBody when the flag is ON. */}

      {viewBillError && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>{viewBillError}</span>
          <button
            type="button"
            onClick={() => setViewBillError(null)}
            className="text-xs text-red-700 hover:text-red-900"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

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

      {/* S139 — Related-documents sidebar banner removed; BundleSuggestion at
          the bottom of the bill view replaces it with design's tile-list
          treatment per S139 plan A.1 + Q2 (no bundle CTA, peer-bill links). */}

      {/* S74.5 D6 — Case C/D plan-doc nudge banner. Soft prompt for /claim
          per Q-C LOCK; HARD gate for dispute generation lives elsewhere. */}
      {showCaseCDNudge && !data.costShareBill && (
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

      {/* ── Surface 3 (clarity redesign): flagged bills use a numbered guided
          step rail — 1 What you could save (recovery bar first, plan-vs-bill
          diff collapsed behind "Show the math") · 2 Verify our assumptions
          (Cost-Share rows) · 3 Verify the services (the line-items table) ·
          4 Recover the money. Clean/needs-review states keep the classic
          table-first order. */}
      {isFlagged && (
        <div className="mt-6">
          <RailStep
            n={1}
            title="What you could save"
            sub="Candid compared every line of this bill against your plan's policies"
          >
          {billTotals.potentialRecovery >= 1 && (
            <div className="flex flex-col gap-4 rounded-2xl border border-emerald-300 bg-gradient-to-br from-emerald-50 to-teal-50/50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3.5">
                <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-emerald-600 text-white">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">Recoverable from this bill</div>
                  {(billTotals.refundComponent >= 1 || billTotals.forgivenessComponent >= 1) && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-gray-700">
                      {billTotals.refundComponent >= 1 && (
                        <span>
                          <strong className="font-bold tabular-nums text-emerald-700">+${fmtMoney(billTotals.refundComponent)}</strong> refunded to you
                        </span>
                      )}
                      {billTotals.refundComponent >= 1 && billTotals.forgivenessComponent >= 1 && (
                        <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden />
                      )}
                      {billTotals.forgivenessComponent >= 1 && (
                        <span>
                          <strong className="font-bold tabular-nums text-emerald-700">${fmtMoney(billTotals.forgivenessComponent)}</strong> forgiven by provider
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-[26px] font-bold tracking-[-0.02em] tabular-nums text-emerald-700">
                +${fmtMoney(billTotals.potentialRecovery)}
              </div>
            </div>
          )}
            <button
              type="button"
              onClick={() => setShowMath((v) => !v)}
              className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-blue-600 hover:text-blue-700"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={"transition-transform " + (showMath ? "rotate-90" : "")}
                aria-hidden
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
              {showMath ? "Hide the math" : "Show the math — your plan vs. this bill"}
            </button>
            {showMath && (
              <>
          <div className="mt-3.5 grid grid-cols-1 overflow-hidden rounded-[18px] border border-gray-200 bg-white md:grid-cols-[1fr_90px_1fr]">
            {/* Plan side — green gradient */}
            <div className="flex flex-col gap-3 bg-gradient-to-b from-emerald-50 via-emerald-50/40 to-white px-6 py-[22px]">
              <h4 className="m-0 text-[11px] font-bold uppercase tracking-[0.1em] text-emerald-700">
                Your plan says
              </h4>
              <span className="inline-flex items-center gap-[5px] self-start rounded-full bg-emerald-50 px-[9px] py-[3px] text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-300">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {isMultiLine
                  ? `${flaggedLineCount} services — all covered`
                  : "Covered by your plan"}
              </span>
              <div className="mt-0.5 flex items-baseline gap-2 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums text-emerald-800">
                ${fmtMoney(billTotals.shouldOwe)}
                <span className="text-[15px] font-medium text-gray-500 whitespace-nowrap">
                  {isMultiLine ? "your total responsibility" : "your responsibility"}
                </span>
              </div>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Adjusted total billed</span>
                  <strong className="font-semibold tabular-nums text-gray-900">
                    ${fmtMoney(billTotals.billedAdjusted)}
                  </strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Insurer should pay</span>
                  <strong className="font-semibold tabular-nums text-gray-900">${fmtMoney(billTotals.insurerShouldHavePaid)}</strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>You pay</span>
                  <strong className="font-semibold tabular-nums text-gray-900">${fmtMoney(billTotals.shouldOwe)}</strong>
                </div>
                {/* S140 — Refund row moved to RIGHT (Bill) side per Andrew's
                    locked S139 schema. LEFT (Plan) side now ends after
                    "You pay" — purely about what the plan says you owe. */}
              </div>
              {/* Cite-grade source hint per design .hint family. Generic enough
                  to be true without per-finding field_provenance lookup at the
                  bill level — the per-line cite chrome lives inside expansions. */}
              <div className="mt-1 inline-flex items-center gap-[6px] text-[11px] text-gray-500">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Based on your uploaded plan benefits</span>
              </div>
            </div>
            {/* VS chrome (desktop only) — design .diff-mid with vertical separators */}
            <div className="relative hidden border-l border-r border-gray-100 bg-white md:flex md:flex-col md:items-center md:justify-center">
              <div className="absolute left-1/2 top-0 h-[calc(50%-22px)] w-px -translate-x-1/2 bg-gray-200" />
              <div className="z-10 grid h-11 w-11 place-items-center rounded-full border border-gray-200 bg-white text-[11px] font-bold uppercase tracking-[0.06em] text-gray-500">
                vs
              </div>
              <div className="absolute bottom-0 left-1/2 h-[calc(50%-22px)] w-px -translate-x-1/2 bg-gray-200" />
            </div>
            {/* Bill side — red gradient */}
            <div className="flex flex-col gap-3 border-t border-gray-100 bg-gradient-to-b from-red-50 via-red-50/40 to-white px-6 py-[22px] md:border-l md:border-t-0">
              <h4 className="m-0 text-[11px] font-bold uppercase tracking-[0.1em] text-red-700">
                Your bill shows
              </h4>
              <span className="inline-flex items-center gap-[5px] self-start rounded-full bg-red-50 px-[9px] py-[3px] text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.9 4h13.8c1.5 0 2.5-1.7 1.7-2.5L13.7 4c-.8-.8-2-.8-2.7 0L4.1 16.5c-.8.8.2 2.5 1.7 2.5z" />
                </svg>
                You&apos;re paying ${fmtMoney(billTotals.patientPaid)}
              </span>
              {/* S139 big-1 — bill side big number always shows patient OOP
                  (was billedAdjusted; switched per Andrew direction for
                  semantic consistency across single + multi-line). Visual
                  equal on single-line bills where billedAdjusted = patientPaid;
                  divergent only on bills with outstanding balance. */}
              <div className="mt-0.5 flex items-baseline gap-2 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums text-red-800">
                ${fmtMoney(billTotals.patientPaid)}
                <span className="text-[15px] font-medium text-gray-500 whitespace-nowrap">charged to you</span>
              </div>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Adjusted total billed</span>
                  <strong className="font-semibold tabular-nums text-gray-900">
                    ${fmtMoney(billTotals.billedAdjusted)}
                  </strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Insurer paid</span>
                  <strong className="font-semibold tabular-nums text-red-700">${fmtMoney(billTotals.insurancePaid)}</strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>You paid</span>
                  <strong className="font-semibold tabular-nums text-gray-900">${fmtMoney(billTotals.patientPaid)} OOP</strong>
                </div>
                {/* S140 fix-pass H2 — Refund + Forgive: Refund row first,
                    Forgive row second. Both always render (≥$1 gate
                    dropped) so users see both buckets even at $0; clarifies
                    that we tracked both possibilities. */}
                <div className="mt-1 flex justify-between gap-3 border-t border-red-200 pt-[6px] text-xs">
                  <span className="font-semibold text-emerald-700">Refund</span>
                  <strong className="font-bold tabular-nums text-emerald-700">+${fmtMoney(billTotals.refundComponent)}</strong>
                </div>
                <div className="flex justify-between gap-3 text-xs">
                  <span className="font-semibold text-emerald-700">Provider must forgive</span>
                  <strong className="font-bold tabular-nums text-emerald-700">${fmtMoney(billTotals.forgivenessComponent)}</strong>
                </div>
              </div>
              <div className="mt-1 inline-flex items-center gap-[6px] text-[11px] text-gray-500">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>From {providerName} bill · {data.lineItems.length} line item{data.lineItems.length !== 1 ? "s" : ""}</span>
              </div>
            </div>
          </div>
              </>
            )}
          </RailStep>

          {railHasAssumptions && data.costShareBill && (
            <RailStep
              n={2}
              title="Verify our assumptions"
              sub="The savings math relies on these following details. Please verify or correct each line as needed."
            >
              <CostShareBanner
                variant="assumptions"
                verdict={data.costShareBill.verdict}
                assumptions={bannerAssumptions}
                overrides={data.costShareOverrides ?? null}
                recoverable={billTotals.potentialRecovery}
                correctShare={billTotals.shouldOwe}
                charged={billTotals.shouldOwe + billTotals.potentialRecovery}
                fmtMoney={fmtMoney}
                onOverride={submitCostShareOverride}
                pendingKey={csOverridePending}
                errorMsg={csOverrideError}
                onShouldBeCovered={() => bannerTargetLineId && openCorrectionModal(bannerTargetLineId)}
                onAddPlanDetails={() => {
                  const line = bannerTargetLineId
                    ? primaryLineItems.find((li) => li.id === bannerTargetLineId)
                    : null;
                  if (line?.service_slug) setAddPlanDetailsLineId(line.id);
                  else if (bannerTargetLineId) openCorrectionModal(bannerTargetLineId);
                }}
                editableServiceCost={bannerEditableCost}
                onUploadEob={() => router.push("/upload?type=eob")}
                onBack={onBack}
              />
            </RailStep>
          )}

          <RailStep
            n={railStepServices}
            title="Verify the services"
            done={svcOk}
            headerOnly
            sub={
              svcIssue ? (
                <span className="font-semibold text-amber-700">
                  Tell us what&apos;s off — click a service&apos;s category below to correct it.
                </span>
              ) : (
                "Make sure you actually received each service listed."
              )
            }
            right={
              <div className="flex flex-wrap gap-2">
                {flywheelEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setSvcIssue((v) => !v);
                      setSvcOk(false);
                    }}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-[9px] text-[13px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    {svcIssue ? "Never mind" : "Something looks wrong"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSvcOk((v) => !v);
                    setSvcIssue(false);
                  }}
                  className={
                    svcOk
                      ? "inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-[9px] text-[13px] font-semibold text-emerald-700"
                      : "inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700"
                  }
                >
                  {svcOk ? "Confirmed" : "All services look right"}
                  {svcOk && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              </div>
            }
          />
        </div>
      )}
      {/* Step-3 body wrapper — indents the line-items table into the rail on
          flagged bills; a no-op pair of divs otherwise. */}
      <div className={isFlagged ? "relative pb-[30px]" : undefined}>
        {isFlagged && (
          <span className="absolute -top-4 bottom-1 left-[14px] hidden w-[1.5px] bg-gray-200 sm:block" aria-hidden />
        )}
        <div className={isFlagged ? "sm:ml-[43px]" : undefined}>
      {/* Session 86 round 6 — responsive layout strategy:
          • md+ (≥768px) → 7-column table with single-line headers, raw
            "Billed" amount, all numeric columns aligned. Math explained
            in the Plan-says/Bill-shows compare in the expansion panel.
          • mobile (<768px) → vertical card per line item with stacked
            label/value pairs. Horizontal scroll dropped (bad UX); user
            scans down each metric naturally. */}
      <div className="bg-white border border-gray-100 rounded-xl mb-4">
        {/* Desktop table header — hidden at mobile. B4.2: 8-col grid with
            Recovery + Forgiveness split (was single Recovery col); You-owe
            dropped per Open Q A lock; Paid → "You paid"; Plan → "Plan says".
            Grid sized for max-w-3xl container (~728px inner): 8 fixed/flex cols
            + gap-2 (8px × 7 = 56px) + 504px fixed = 560px + ~168px flex. */}
        <div
          className="hidden lg:grid gap-2 items-center px-5 py-3 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.06em] border-b border-gray-100"
          style={{
            gridTemplateColumns: isMultiLine
              ? "minmax(0, 1.5fr) 56px 64px 64px 64px 72px 80px 88px 40px"
              : "minmax(0, 1.5fr) 56px 64px 64px 64px 72px 80px 88px",
          }}
        >
          <div className="min-w-0">Service</div>
          <div className="min-w-0">Code</div>
          <div
            className="text-right"
            title="Amount the provider billed before insurance write-off."
          >
            Billed
          </div>
          <div className="text-right">You paid</div>
          <div
            className="text-right"
            title="What your plan says you should owe — copay, coinsurance, or deductible."
          >
            Plan says
          </div>
          <div
            className="text-right"
            title="Money you're owed back — already paid out-of-pocket above your plan share."
          >
            Recovery
          </div>
          <div
            className="text-right"
            title="Provider must forgive — billed above the plan-allowed amount."
          >
            Forgiveness
          </div>
          <div className="text-center">Coverage</div>
          {/* S139 — chevron column header (multi-line bills only); empty header so
              column width allocates correctly. Chevron button per row provides
              expand affordance for LineDrawer. */}
          {isMultiLine && <div aria-hidden />}
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
          // S154 — estimate-tier secondary matches read "Likely Covered" (an
          // inference pending the user's Verify) vs a confident "Covered".
          const coverageLabel =
            item.coverageNeedsConfirmation && coverageBadge
              ? "Likely Covered"
              : coverageBadge?.label;
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
          // S140 fix-pass H2 — per-line BILLED display now uses adjusted
          // billed everywhere (raw minus resolved writeoff). Reconciles with
          // bill-level "Adjusted total billed" and with coinsurance × adjusted
          // math. Server-computed `adjustedBilled` is authoritative; raw
          // fallback only when API didn't surface it (legacy or empty rows).
          const billedDisplay = item.adjustedBilled ?? billed;
          // S140 fix-pass H5 — resolved insurer payment per line (pro-rated
          // when sparse). Replaces raw item.insurance_paid in display sites.
          const insurancePaidDisplay =
            item.insurancePaidResolved ?? Number(item.insurance_paid ?? 0);
          // S140 — resolved patient paid per line (from H1; surfaces via
          // recovery.patientPaid which carries the pro-rated value through
          // computeRecoveryV2). Falls back to raw for safety.
          const patientPaidDisplay =
            item.recovery?.patientPaid ?? Number(item.patient_paid_amount ?? 0);
          // Session 85 round 5 — "Paid" column = insurance_paid + patient_paid
          // (total cleared on this line by either party). For Bill 1 with
          // insurance_paid=$0 and patient_paid=$292.41, this reads $292.41
          // — matches Andrew's expectation. For Bill 2 99214 with ins=$168.79
          // and OOP=$48.25, reads $217.04 (the allowed amount). The breakdown
          // ("Your insurer actually paid" vs "You paid OOP") lives in the
          // red box for full transparency.
          // "You paid" column = the patient's out-of-pocket ONLY (what YOU paid).
          // Previously insurer_paid + patient_paid ("total settled"), which read
          // wrong under the "You paid" label whenever insurance paid — e.g. a
          // $0-share EOB (insurer paid $126.35, you paid $0) showed "You paid
          // $126.35". Patient-only is correct for every case: a bill you paid
          // yourself is unchanged (insurer was $0), a mixed bill shows your
          // actual OOP. The insurer's payment still surfaces in the expanded
          // line drawer ("Insurer paid $X"). insurancePaidDisplay is retained
          // for that drawer (line ~1916). Display-only; feeds no recovery math.
          const paid = patientPaidDisplay;
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
          // Cost-Share v2 (S214) — when the engine ran (verdict present), the
          // per-line gap panel is VERDICT-DRIVEN like the dispute synthesis:
          // only a 'recovery' line is an actionable gap. A 'correct'/'confident'/
          // 'insufficient'/'not_covered' line is NOT "unexplained" — the engine
          // accounted for it (e.g. cf91a49e's deductible phase) — so suppress the
          // "Unexplained $X charge" + "should have paid" panel. OFF (verdict
          // absent) = today's raw-absence logic, verbatim.
          const gapRelevant =
            item.costShareVerdict != null
              ? item.costShareVerdict === "recovery"
              : hasGap && item.coverageStatus !== "not_covered";

          // S74.5 D6 — category pill state per Subplan §3 Layer C. Only
          // renders when flywheel flag ON. Click opens correction modal
          // without bubbling to the row-expand toggle.
          const showCategoryPill =
            flywheelEnabled &&
            (item.codeIdentity != null ||
              expandCorrectionToAll ||
              item.user_corrected_at != null ||
              // S132 iter-3 / S135 PR-3: always show the category subtitle
              // on unknown rows so the secondary re-categorize affordance
              // is visible alongside the primary badge click target.
              // Not_covered rows also get the pencil so users can navigate
              // to upload via either entry point.
              item.coverageStatus === "unknown" ||
              item.coverageStatus === "not_covered");
          // S153 — derive the review tooltip from slug-PRESENCE, not the
          // identity promotion_state. Pre-launch every identity row is
          // 'proposed' (corroboration threshold is 5 distinct users), so keying
          // off promotion_state showed "couldn't auto-categorize" even on lines
          // that DID get a confident category. A populated service_slug means
          // the line is categorized (the resolver only assigns a slug above its
          // confidence floor); null means genuinely uncategorized.
          const pillState: "user_corrected" | "needs_review" | "auto" =
            item.user_corrected_at
              ? "user_corrected"
              : !item.service_slug
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
                className="lg:hidden block w-full text-left px-5 py-4 border-t border-gray-100 transition-colors hover:bg-gray-50 cursor-pointer"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {item.description || item.service_slug?.replace(/_/g, " ") || "Unknown"}
                    </div>
                    {showCategoryPill && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openBadgeModal(item.id, item.coverageStatus);
                        }}
                        title={
                          item.coverageStatus === "not_covered"
                            ? "Click to upload your plan and update coverage"
                            : pillState === "user_corrected"
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
                  {/* S140 fix-pass H2 — mobile chevron affordance. Card is
                      whole-clickable for expand toggle (line 1320 onClick);
                      chevron icon visually communicates that affordance.
                      Same gate as desktop: isMultiLine + has recoverable
                      money. Rotates on expand state. */}
                  {isMultiLine && (refundComponent + forgivenessComponent) > 0 && (
                    <div className="flex-shrink-0 pt-0.5">
                      <div
                        aria-label={isExpanded ? "Hide breakdown" : "Show breakdown"}
                        className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${isExpanded ? "bg-blue-600 text-white shadow-sm" : "bg-gray-100 text-gray-500"}`}
                      >
                        <svg
                          className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.5}
                          aria-hidden
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                        </svg>
                      </div>
                    </div>
                  )}
                </div>
                <dl className="space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Code</dt>
                    <dd className="font-mono text-gray-700">{item.billing_code || "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Billed</dt>
                    <dd className="tabular-nums text-gray-900">${billedDisplay.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">You paid</dt>
                    <dd className="tabular-nums text-gray-600">${paid.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Plan says</dt>
                    <dd className={`tabular-nums font-semibold ${shouldOwe === 0 ? "text-green-700" : "text-gray-900"}`}>${shouldOwe.toLocaleString()}</dd>
                  </div>
                  {/* B4.2: "You owe" mobile row DROPPED per Open Q A lock. */}
                  {/* B4.2: Recovery + Forgiveness rows render only when value
                      ≥ 1 — keeps mobile card lean. Both rendered when both
                      apply (mixed-pay cases). */}
                  {refundComponent >= 1 && (
                    <div className="flex justify-between gap-3">
                      <dt className="uppercase tracking-wider text-green-700">Recovery</dt>
                      <dd className="tabular-nums font-bold text-green-700">+${refundComponent.toLocaleString()}</dd>
                    </div>
                  )}
                  {forgivenessComponent >= 1 && (
                    <div className="flex justify-between gap-3">
                      <dt className="uppercase tracking-wider text-green-700">Forgiveness</dt>
                      <dd className="tabular-nums font-bold text-green-700">${forgivenessComponent.toLocaleString()}</dd>
                    </div>
                  )}
                  <div className="flex justify-between items-center gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Coverage</dt>
                    <dd className="flex items-center gap-1.5">
                      {coverageBadge ? (
                        flywheelEnabled && (item.coverageStatus === "unknown" || item.coverageStatus === "not_covered" || item.user_corrected_at != null || item.coverageSource === "secondary_match" || item.coverageSource === "aca_preventive") ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openBadgeModal(item.id, item.coverageStatus);
                            }}
                            title={
                              item.coverageStatus === "not_covered"
                                ? "Click to upload your plan and update coverage"
                                : item.user_corrected_at
                                  ? "Click to change your pick"
                                  : "Click to pick the right category"
                            }
                            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className} cursor-pointer ring-1 ring-blue-300 hover:ring-blue-400 hover:bg-blue-50 transition-colors`}
                          >
                            <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            {coverageLabel}
                          </button>
                        ) : (
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${coverageBadge.className}${acaTooltip ? " cursor-help underline decoration-dotted decoration-1 underline-offset-2" : ""}`}
                            title={acaTooltip}
                          >
                            {coverageLabel}
                          </span>
                        )
                      ) : <span className="text-gray-300">—</span>}
                      {pillState === "user_corrected" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openBadgeModal(item.id, item.coverageStatus);
                          }}
                          title={item.coverageStatus === "not_covered" ? "Click to upload your plan and update coverage" : "Click to change your pick"}
                          className="rounded-sm bg-blue-100 px-1 py-px text-[9px] font-semibold text-blue-700 cursor-pointer ring-1 ring-blue-200 hover:bg-blue-200 hover:ring-blue-300 transition-colors"
                        >
                          Your pick
                        </button>
                      )}
                      {item.coverageNeedsConfirmation && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConfirmCoverage(item.id);
                          }}
                          disabled={confirmingCoverageId === item.id}
                          title="We inferred this from a related covered service. Click to confirm it's right."
                          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-px text-[9px] font-semibold text-amber-700 cursor-pointer ring-1 ring-amber-200 hover:bg-amber-100 hover:ring-amber-300 transition-colors disabled:opacity-50"
                        >
                          {confirmingCoverageId === item.id ? "Saving…" : "Verify coverage"}
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
                className={`hidden lg:grid w-full gap-2 items-center px-5 py-3.5 text-left transition-colors border-t border-gray-100 cursor-pointer ${isMultiLine && isExpanded ? "bg-blue-50/40 hover:bg-blue-50/60" : "hover:bg-gray-50"}`}
                style={{
                  gridTemplateColumns: isMultiLine
                    ? "minmax(0, 1.5fr) 56px 64px 64px 64px 72px 80px 88px 40px"
                    : "minmax(0, 1.5fr) 56px 64px 64px 64px 72px 80px 88px",
                }}
              >
                <div className="min-w-0 text-sm text-gray-900">
                  <div id={`line-${item.id}-svc`} className="truncate font-semibold">
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
                        openBadgeModal(item.id, item.coverageStatus);
                      }}
                      title={
                        item.coverageStatus === "not_covered"
                          ? "Click to upload your plan and update coverage"
                          : pillState === "user_corrected"
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
                  <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[12px]">
                    {item.billing_code || "—"}
                  </span>
                </div>
                {/* S140 fix-pass H2 — Billed column shows ADJUSTED billed
                    (raw - resolved writeoff). Reconciles with bill-level
                    "Adjusted total billed" + coinsurance × adjusted math
                    everywhere else. Tooltip retains the raw-vs-adjusted
                    explainer when writeoff is non-zero. */}
                <div
                  className="text-sm font-semibold text-gray-700 text-right tabular-nums whitespace-nowrap"
                  title={
                    billedDisplay !== billed
                      ? `Provider billed $${billed.toLocaleString()}; insurer wrote off $${(billed - billedDisplay).toLocaleString()}, leaving an adjusted balance of $${billedDisplay.toLocaleString()}.`
                      : `$${billed.toLocaleString()} billed.`
                  }
                >
                  ${billedDisplay.toLocaleString()}
                </div>
                <div className="text-sm font-semibold text-gray-700 text-right tabular-nums whitespace-nowrap">
                  ${paid.toLocaleString()}
                </div>
                {/* Plan says — what your plan says you should owe. */}
                <div
                  className={`text-sm font-bold text-right tabular-nums whitespace-nowrap ${shouldOwe === 0 ? "text-emerald-700" : "text-gray-900"}`}
                  title={`Per your plan, you should owe $${shouldOwe.toLocaleString()} for this service.`}
                >
                  ${shouldOwe.toLocaleString()}
                </div>
                {/* B4.2 (Open Q A lock): "You owe" column DROPPED — design
                    leans on "Plan says" to convey what the user should pay; a
                    9th column was crowding the desktop grid. */}
                {/* B4.2: Recovery column — refund component only.
                    refundComponent = max(0, patient_paid − should_owe) — money
                    already paid OOP above plan share, recoverable via insurer
                    refund or provider credit. Source: recovery-math.ts. */}
                <div
                  className="text-right text-sm tabular-nums whitespace-nowrap"
                  title={
                    item.planCoverage == null
                      ? "We need plan coverage info to compute refund recoverable."
                      : refundComponent >= 1
                        ? `Refund recoverable: $${refundComponent.toLocaleString()} — already paid out-of-pocket above your plan share.`
                        : "No refund recoverable — patient hasn't paid above plan share."
                  }
                >
                  {item.planCoverage == null ? (
                    <span className="text-gray-300">—</span>
                  ) : refundComponent >= 1 ? (
                    <span className="font-bold text-emerald-700">+${refundComponent.toLocaleString()}</span>
                  ) : (
                    <span className="text-gray-400">$0.00</span>
                  )}
                </div>
                {/* B4.2: Forgiveness column — forgivenessComponent.
                    = max(0, potentialRecovery − refundComponent) — remaining
                    outstanding above plan share that the provider must write
                    off. Source: recovery-math.ts. */}
                <div
                  className="text-right text-sm tabular-nums whitespace-nowrap"
                  title={
                    item.planCoverage == null
                      ? "We need plan coverage info to compute forgiveness due."
                      : forgivenessComponent >= 1
                        ? `Forgiveness due: $${forgivenessComponent.toLocaleString()} — provider must write off the amount above plan-allowed.`
                        : "No forgiveness due — bill is within plan-allowed."
                  }
                >
                  {item.planCoverage == null ? (
                    <span className="text-gray-300">—</span>
                  ) : forgivenessComponent >= 1 ? (
                    <span className="font-bold text-emerald-700">${forgivenessComponent.toLocaleString()}</span>
                  ) : (
                    <span className="text-gray-400">$0.00</span>
                  )}
                </div>
                {/* Coverage badge — Session 86: static display by default.
                    S135 PR-3: badge becomes clickable when coverageStatus
                    is unknown / not_covered / user-corrected. Routes via
                    openBadgeModal — not_covered opens the upload-plan-doc
                    modal (no dropdown), everything else opens the dropdown
                    picker. UI gated on flywheelEnabled because the backend
                    endpoint requires the same flag (mig 087). */}
                {/* S139 — flex-wrap allows "Your pick" pill to wrap below "Covered"
                    when both present, instead of overflowing 88px column into
                    Forgiveness cell. whitespace-nowrap on each pill prevents
                    in-pill text wrap ("Your\npick"). */}
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {coverageBadge ? (
                    flywheelEnabled && (item.coverageStatus === "unknown" || item.coverageStatus === "not_covered" || item.user_corrected_at != null || item.coverageSource === "secondary_match" || item.coverageSource === "aca_preventive") ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openBadgeModal(item.id, item.coverageStatus);
                        }}
                        title={
                          item.coverageStatus === "not_covered"
                            ? "Click to upload your plan and update coverage"
                            : item.user_corrected_at
                              ? "Click to change your pick"
                              : "Click to pick the right category"
                        }
                        className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap ${coverageBadge.className} cursor-pointer ring-1 ring-blue-300 hover:ring-blue-400 hover:bg-blue-50 transition-colors`}
                      >
                        <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        {coverageLabel}
                      </button>
                    ) : (
                      <span
                        className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap ${coverageBadge.className}${acaTooltip ? " cursor-help underline decoration-dotted decoration-1 underline-offset-2" : ""}`}
                        title={acaTooltip}
                      >
                        {coverageLabel}
                      </span>
                    )
                  ) : null}
                  {pillState === "user_corrected" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openBadgeModal(item.id, item.coverageStatus);
                      }}
                      title={item.coverageStatus === "not_covered" ? "Click to upload your plan and update coverage" : "Click to change your pick"}
                      className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 whitespace-nowrap cursor-pointer ring-1 ring-blue-200 hover:bg-blue-100 hover:ring-blue-300 transition-colors"
                    >
                      Your pick
                    </button>
                  )}
                  {item.coverageNeedsConfirmation && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleConfirmCoverage(item.id);
                      }}
                      disabled={confirmingCoverageId === item.id}
                      title="We inferred this from a related covered service. Click to confirm it's right."
                      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 whitespace-nowrap cursor-pointer ring-1 ring-amber-200 hover:bg-amber-100 hover:ring-amber-300 transition-colors disabled:opacity-50"
                    >
                      {confirmingCoverageId === item.id ? "Saving…" : "Verify coverage"}
                    </button>
                  )}
                </div>
                {/* S139 — chevron column (multi-line bills only). hasFix gate:
                    only render button on rows with recoverable money; empty
                    cell on clean rows so grid aligns. Click toggles existing
                    collapsedRows state (same mechanism as full-row click;
                    stopPropagation prevents double-toggle). */}
                {isMultiLine && (
                  <div className="flex items-center justify-center">
                    {(refundComponent + forgivenessComponent) > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRowCollapsed(item.id);
                        }}
                        aria-label={isExpanded ? "Hide breakdown" : "Show breakdown"}
                        aria-expanded={isExpanded}
                        className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${isExpanded ? "bg-blue-600 text-white shadow-sm" : "bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-700"}`}
                      >
                        <svg
                          className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.5}
                          aria-hidden
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
                {/* Flags column dropped in Session 85 round 3 — finding count
                    info now surfaces via the Refund/Forgive green numbers and
                    the expanded-row state. */}
              </div>

              {/* S139 — LineDrawer for multi-line bills (replaces existing gray
                  expansion panels on multi-line rows with design's polished
                  plan/bill cards + OVERCHARGE pill + recoverable strip).
                  Uses same toggleRowCollapsed state as single-line — only
                  the rendered chrome differs. Gated on hasFix matching the
                  chevron button visibility. */}
              {isMultiLine && isExpanded && (refundComponent + forgivenessComponent) > 0 && (
                <LineDrawer
                  planSaysAmount={shouldOwe}
                  adjustedBilledAmount={billedDisplay}
                  patientPaidAmount={patientPaid}
                  insurancePaidAmount={insurancePaidDisplay}
                  coverageLabel={item.planCoverage ? buildPlanSays(item.planCoverage) : "Coverage unknown"}
                  // S140 — suppress per-line recovery strip when patientPaid is
                  // header-prorated (not cite-grade per-line). Plan + bill cards
                  // above still render with adjusted per-line billed amounts.
                  // The bill-level recovery bar below shows the ONE accurate
                  // aggregate; no double-counting risk.
                  recovery={item.recovery?.provenance?.isCitablePerLine ? refundComponent : 0}
                  forgiveness={item.recovery?.provenance?.isCitablePerLine ? forgivenessComponent : 0}
                  acaOverride={item.acaOverride}
                  ariaLabelledBy={`line-${item.id}-svc`}
                />
              )}

              {/* S135 — gap-explanation panel: header + actionable steps only.
                  Plan-says/bill-shows moved to the expansion panel below so a
                  single source-of-truth pair renders per row (was duplicated
                  pre-S135). Expansion panel's gate now includes gap rows so
                  it always fires alongside this panel.
                  S139 — gated on !isMultiLine; multi-line bills use LineDrawer
                  above instead. */}
              {/* Cost-Share v2 — suppress the legacy "Unexplained $X charge" gap panel when
                  the engine ran (costShareBill present): the §5 banner + financial breakdown +
                  dispute UI carry the explanation, and this panel's "likely a denial" copy
                  contradicts a computed cost-share recovery. OFF → today's behavior. */}
              {!isMultiLine && isExpanded && gapRelevant && findings.length === 0 && !data.costShareBill && (
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
                  a lonely "Hide details" link, which is confusing.
                  S135 — also fire on gap rows with planCoverage so the single
                  plan-says/bill-shows pair (now consolidated here) renders for
                  the gap-explanation case too.
                  S139 — gated on !isMultiLine; multi-line bills use LineDrawer
                  above instead of this expansion panel. */}
              {!isMultiLine && isExpanded && (
                findings.length > 0 ||
                (item.planCoverage != null && (refundComponent >= 1 || forgivenessComponent >= 1)) ||
                (showDismissed && dismissedCount > 0) ||
                (gapRelevant && item.planCoverage != null)
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
                        {/* S135 — inline ACA override when plan terms conflict
                            with the federal $0 mandate. Replaces what was
                            previously a separate D13 amber card; per Andrew's
                            "all money-in info in this one box" direction. */}
                        {item.acaOverride && (
                          <p className="mt-1.5 text-xs text-green-800">
                            {buildAcaOverrideLine(item.acaOverride)}
                          </p>
                        )}
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
        </div>
      </div>{/* /step-3 body wrapper */}

      {/* Step 4 — Recover the money (flagged bills only). Drafted bills show
          the real dispute cards (Open dispute letter); undrafted show the
          recover panel + BulkDisputeButton. */}
      {isFlagged && (
        <RailStep
          n={railStepRecover}
          title="Recover the money"
          sub="Call the billing office to verify the charge or send the appeal — many members do both."
          last
        >
          {data.disputes.length > 0 ? (
            disputesListNode
          ) : (
        <div className="flex flex-col gap-4 rounded-[18px] border border-blue-200 bg-gradient-to-br from-blue-50 to-white px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-[50ch] text-[13px] leading-[1.55] text-gray-600">
            <div className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-blue-900">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Recover ${fmtMoney(billTotals.potentialRecovery)} from this bill
            </div>
            <p className="m-0">
              Candid will write the appeal letter for you using your uploaded plan, the EOB, and Medicare benchmark comparisons. You review and mail it — we never send anything on your behalf.
            </p>
          </div>
          <div className="sm:flex-shrink-0">
            <BulkDisputeButton
              claimId={claimId}
              claim={claim}
              primaryLineItems={primaryLineItems}
              claimLevelFindings={visibleClaimLevelFindings}
              showDismissed={showDismissed}
              getAuthToken={getAuthToken}
              onGenerated={(result) => router.push(disputeUrlForResult(result))}
              existingDisputeId={data.disputes.find((d) => d.status !== "cancelled")?.id ?? null}
            />
          </div>
        </div>
          )}
        </RailStep>
      )}

      {/* Cost-Share v2 (W2+W3) — the §5 verdict + assumptions card. One per bill,
          below the line table (mockup placement). Carries the verdict + Verified
          stamp itself, so it replaces the legacy CleanBody/ReviewBody when the
          flag is ON; OFF → absent → today's UI. */}
      {data.costShareBill && !isFlagged && (
        <CostShareBanner
          verdict={data.costShareBill.verdict}
          assumptions={bannerAssumptions}
          overrides={data.costShareOverrides ?? null}
          recoverable={billTotals.potentialRecovery}
          correctShare={billTotals.shouldOwe}
          charged={billTotals.shouldOwe + billTotals.potentialRecovery}
          fmtMoney={fmtMoney}
          onOverride={submitCostShareOverride}
          pendingKey={csOverridePending}
          errorMsg={csOverrideError}
          onShouldBeCovered={() => bannerTargetLineId && openCorrectionModal(bannerTargetLineId)}
          onAddPlanDetails={() => {
            const line = bannerTargetLineId
              ? primaryLineItems.find((li) => li.id === bannerTargetLineId)
              : null;
            if (line?.service_slug) setAddPlanDetailsLineId(line.id);
            else if (bannerTargetLineId) openCorrectionModal(bannerTargetLineId);
          }}
          editableServiceCost={bannerEditableCost}
          onUploadEob={() => router.push("/upload?type=eob")}
          onBack={onBack}
        />
      )}

      {billState === "needs_review" && !data.costShareBill && (() => {
        // Synthesize a "Specific blockers" list from line-item state so the
        // user sees what specifically needs their input. Mirrors design's
        // bill.reviewReasons[] array (which we don't store at bill level).
        const blockers: string[] = [];
        const unknownLines = primaryLineItems.filter(
          (li) => li.coverageStatus === "unknown" && !li.user_corrected_at,
        );
        const notInPlanLines = primaryLineItems.filter(
          (li) => li.coverageStatus === "not_covered",
        );
        const gapLines = primaryLineItems.filter((li) => {
          const liBilled = li.billed_amount || 0;
          const liInsPaid = Number(li.insurance_paid ?? 0);
          const liOwed = li.patient_owes || 0;
          return liBilled > 0 && liInsPaid === 0 && liOwed === 0;
        });
        if (unknownLines.length > 0) {
          blockers.push(
            `${unknownLines.length} line item${unknownLines.length === 1 ? "" : "s"} need${unknownLines.length === 1 ? "s" : ""} a category — pick the right service in the table above.`,
          );
        }
        if (notInPlanLines.length > 0) {
          blockers.push(
            `${notInPlanLines.length} line item${notInPlanLines.length === 1 ? "" : "s"} ${notInPlanLines.length === 1 ? "isn't" : "aren't"} listed in your uploaded plan — upload the latest plan document or confirm exclusion.`,
          );
        }
        if (gapLines.length > 0 && unknownLines.length === 0) {
          blockers.push(
            `${gapLines.length} line item${gapLines.length === 1 ? "" : "s"} show${gapLines.length === 1 ? "s" : ""} no insurer payment and no patient balance — the EOB may be incomplete.`,
          );
        }
        if (!hasAnyPlanCoverage) {
          blockers.push(
            "We don't have your plan document on file for this bill — upload your SBC or plan summary so Candid can audit coverage.",
          );
        }
        return (
          <div className="mt-[22px] rounded-[18px] border border-orange-200 bg-gradient-to-b from-orange-50 via-orange-50/40 to-white px-6 py-[22px]">
            <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-orange-700">
              Why we couldn&apos;t decide
            </div>
            <h3 className="mb-3.5 mt-2 text-lg font-bold text-gray-900">
              We need more info to tell you if this is an overcharge
            </h3>
            <p className="m-0 text-sm leading-[1.55] text-gray-600">
              Some line items don&apos;t match a clear plan benefit. Resolve them below — pick the right category for each row marked Unknown, or upload your plan if you haven&apos;t yet.
            </p>
            {blockers.length > 0 && (
              <div className="mt-4 rounded-xl border border-orange-200 bg-white p-3.5">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-gray-500">
                  Specific blockers
                </div>
                <ul className="m-0 list-disc space-y-1.5 pl-5">
                  {blockers.map((b, i) => (
                    <li key={i} className="text-[13px] leading-[1.55] text-gray-700">
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })()}

      {billState === "clean" && !data.costShareBill && (
        <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-emerald-300 bg-gradient-to-br from-emerald-50 to-green-50/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-emerald-600 text-white">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-gray-900">This bill looks correct</div>
              <div className="mt-1 text-[13px] text-emerald-700">
                The amount billed matches what your plan says you owe — nothing to dispute.
              </div>
            </div>
          </div>
          <div className="text-[22px] font-bold tracking-[-0.02em] text-emerald-700">Verified</div>
        </div>
      )}

      {/* B4.2 — Bill action footer (non-flagged states; flagged bills
          surface their actions inside step 4 "Recover the money"). */}
      {!isFlagged && (billState === "needs_review" ? (
        <>
          <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-prose text-[13px] text-gray-500">
              Help us answer the questions above. Once we have your plan details, we&apos;ll know if this bill is an overcharge — and draft the appeal in one click.
            </div>
            <div className="sm:flex-shrink-0">
              <button
                type="button"
                onClick={() => {
                  const first = primaryLineItems[0];
                  if (first) openUploadPlanModal(first.id);
                }}
                disabled={primaryLineItems.length === 0}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                </svg>
                Upload my plan
              </button>
            </div>
          </div>
          {/* Bulk dispute still available for needs_review when findings exist —
              user may want to dispute uncertain charges. Suppressed once ANY dispute
              exists on the bill (incl. cancelled) — the Disputes card is the single
              CTA, and this also kills the transient "Draft" flash during a
              billState-recompute refetch. */}
          {data.disputes.length === 0 && (
            <BulkDisputeButton
              claimId={claimId}
              claim={claim}
              primaryLineItems={primaryLineItems}
              claimLevelFindings={visibleClaimLevelFindings}
              showDismissed={showDismissed}
              getAuthToken={getAuthToken}
              onGenerated={(result) => router.push(disputeUrlForResult(result))}
              existingDisputeId={data.disputes.find((d) => d.status !== "cancelled")?.id ?? null}
            />
          )}
        </>
      ) : data.disputes.length === 0 ? (
        // billState is null/clean — back-compat: render BulkDisputeButton standalone.
        // For clean state it self-suppresses when there's nothing to dispute. Also
        // suppressed once ANY dispute exists — the Disputes card below is the single
        // CTA (kills the transient "Draft" flash during a billState-recompute refetch).
        <BulkDisputeButton
          claimId={claimId}
          claim={claim}
          primaryLineItems={primaryLineItems}
          claimLevelFindings={visibleClaimLevelFindings}
          showDismissed={showDismissed}
          getAuthToken={getAuthToken}
          onGenerated={(result) => router.push(disputeUrlForResult(result))}
          existingDisputeId={data.disputes.find((d) => d.status !== "cancelled")?.id ?? null}
        />
      ) : null)}

      {/* S139 — BundleSuggestion: peer bills in the same claim_group_id at the
          bottom of bill-detail. Replaces the legacy "Related documents (N)"
          sidebar banner with design's tile-list. No bundle CTA per Q2 defer;
          tiles link to peer bills via existing /claim?claim=ID route. */}
      {data.relatedClaims.length > 0 && (
        <BundleSuggestion
          peers={data.relatedClaims}
          onSelectBill={(peerId) => router.push(`/claim?claim=${peerId}`)}
        />
      )}

      {/* Quality-reporting codes — collapsed by default */}
      {qualityLineItems.length > 0 && (
        <QualityMeasuresSection items={qualityLineItems} />
      )}

      {/* Disputes on this bill — bottom section for non-flagged states
          (flagged bills surface it inside step 4 "Recover the money"). */}
      {!isFlagged && disputesListNode && <div className="mt-8">{disputesListNode}</div>}

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

      {/* S135 PR-3 — Upload-plan-doc modal for not_covered rows. Mounts
          independently of the catalog so users can navigate to upload even
          before the category catalog finishes loading. */}
      {(() => {
        const uploadLineItem =
          uploadPlanModalLineId != null
            ? primaryLineItems.find((li) => li.id === uploadPlanModalLineId) ?? null
            : null;
        return flywheelEnabled && uploadLineItem ? (
          <UploadPlanDocModal
            open={true}
            description={uploadLineItem.description}
            billingCode={uploadLineItem.billing_code}
            onClose={() => setUploadPlanModalLineId(null)}
          />
        ) : null;
      })()}

      {/* Cost-Share v2 (W3 §7b) — manual "Add plan details" form. Opened from the
          §5 banner for a line that already has a service identity (a null-slug
          line routes to CategoryCorrectionModal first). */}
      {(() => {
        const line =
          addPlanDetailsLineId != null
            ? primaryLineItems.find((li) => li.id === addPlanDetailsLineId) ?? null
            : null;
        return line?.service_slug ? (
          <AddPlanDetailsModal
            open
            claimId={claimId}
            planId={(claim.insurance_plan_id as string | null) ?? null}
            serviceSlug={line.service_slug}
            serviceLabel={humanizeSlug(line.service_slug) || line.description || "this service"}
            getAuthToken={getAuthToken}
            initialCopay={line.planCoverage?.copay ?? null}
            initialCoinsurancePercent={
              line.planCoverage?.coinsurance != null
                ? normalizeCoinsurancePct(line.planCoverage.coinsurance)
                : null
            }
            onClose={() => setAddPlanDetailsLineId(null)}
            onSaved={async () => {
              await refetchClaim();
              if (onClaimUpdated) await onClaimUpdated();
            }}
          />
        ) : null;
      })()}

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

// ── Surface 3 — flagged-bill guided step rail chrome ──────────────────────
// Numbered step section per design bill-detail.jsx StepSection + styles.css
// .bd-step family: 30px blue number circle (green ✓ when done), 1.5px
// connector line, body indented 43px on ≥sm. `headerOnly` renders just the
// header (the step body lives outside — the in-place line-items table);
// `last` drops the connector + bottom padding. Exported for reuse by other
// guided flows (and the dev preview harness).
export function RailStep({
  n,
  title,
  sub,
  done,
  right,
  last,
  headerOnly,
  children,
}: {
  n: number;
  title: string;
  sub?: React.ReactNode;
  done?: boolean;
  right?: React.ReactNode;
  last?: boolean;
  headerOnly?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className={!last && !headerOnly ? "relative pb-[30px]" : "relative"}>
      {!last && !headerOnly && (
        <span
          className="absolute bottom-1 left-[14px] top-[34px] hidden w-[1.5px] bg-gray-200 sm:block"
          aria-hidden
        />
      )}
      <header className="mb-3.5 flex flex-wrap items-start gap-3.5">
        <span
          className={
            "relative z-10 grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-full text-sm font-bold text-white " +
            (done
              ? "bg-emerald-700 shadow-[0_2px_8px_rgba(4,120,87,0.25)]"
              : "bg-blue-600 shadow-[0_2px_8px_rgba(37,99,235,0.25)]")
          }
        >
          {done ? "\u2713" : n}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[16.5px] font-bold tracking-[-0.005em] text-gray-900">{title}</div>
          {sub && <div className="mt-0.5 text-[13px] leading-normal text-gray-500">{sub}</div>}
        </div>
        {right && <div className="w-full sm:w-auto sm:flex-shrink-0 sm:self-center">{right}</div>}
      </header>
      {children != null && <div className="sm:ml-[43px]">{children}</div>}
    </section>
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
  provider,
  recovery,
  hasCostShare,
}: {
  dispute: { id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number; isStale?: boolean; chargeCount?: number };
  provider: string;
  recovery: number;
  hasCostShare: boolean;
}) {
  // Cost-Share v2 (§17.4) — the card surfaces the "May need update" state + the
  // linked-charge count from props (the claim GET now folds `isStale` +
  // `chargeCount` into `data.disputes`), so the pill renders INSTANTLY. This used
  // to fire the heavy /api/disputes/[id] GET on mount (~4.5s) just for these two.
  // The heavy bill / letter / court detail lives on the /disputes letter page
  // ("Open dispute letter"), which also carries Refresh / Keep-as-is.
  const typeLabel = disputeTypeLabel(dispute.dispute_type);
  const statusLabel = DISPUTE_STATUS_LABEL[dispute.status] || dispute.status;
  const statusBadgeClass = DISPUTE_STATUS_BADGE[dispute.status] || "text-gray-700 bg-gray-100";
  const isStale = !!dispute.isStale;
  const chargeCount = dispute.chargeCount ?? null;
  const recovered = dispute.amount_recovered > 0;
  // Headline = the honest cost-share recovery when the engine ran for this bill;
  // else the stored amount_disputed (legacy / flag OFF). Display-only — the
  // stored amount_disputed is reconciled in the recovery-engine unification.
  const headline = hasCostShare ? recovery : dispute.amount_disputed;
  const fmt = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {isStale ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                May need update
              </span>
            ) : (
              <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass}`}>
                {statusLabel}
              </span>
            )}
            <p className="truncate text-base font-bold text-gray-900">{typeLabel}</p>
          </div>
          <p className="mt-1.5 truncate text-sm text-gray-500">
            {provider}
            {chargeCount != null && chargeCount > 0 && ` · ${chargeCount} charge${chargeCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-bold text-gray-900">${fmt(headline)}</p>
          {recovered && (
            <p className="text-xs text-green-600">+${fmt(dispute.amount_recovered)} recovered</p>
          )}
        </div>
      </div>

      {/* Cost-Share v2 (W4) — staleness. The cohesive "may need update" banner
          directs the user to the letter page, where Refresh / Keep-as-is live
          (the card no longer carries the heavy inline detail). */}
      {isStale && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <svg
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <p className="text-sm leading-relaxed text-amber-900">
            Your plan details changed since this was drafted — this charge may now be correct.{" "}
            <span className="font-semibold">Open the letter to refresh or keep it as-is.</span>
          </p>
        </div>
      )}

      <a
        href={`/disputes?dispute=${dispute.id}`}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        Open dispute letter
        <span aria-hidden>→</span>
      </a>
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

// dispute_plan_pinning_v1 (Phase 2) — helpers for the #2 plan chooser.
function resolveClaimYear(claim: Record<string, unknown>): number | null {
  const py = claim.plan_year;
  if (typeof py === "number" && Number.isInteger(py)) return py;
  const dos = claim.date_of_service;
  if (typeof dos === "string") {
    const y = parseInt(dos.slice(0, 4), 10);
    if (Number.isInteger(y)) return y;
  }
  return null;
}

// Default chooser selection: the claim's current pin (already DOS-correct) →
// the plan whose coverage window contains the DOS → the active plan → newest.
function computeDefaultPlanId(
  plans: DisputePlanChooserPlan[],
  claimPinId: string | null | undefined,
  dos: string | null,
): string | null {
  if (claimPinId && plans.some((p) => p.insurancePlanId === claimPinId)) return claimPinId;
  const windowMatch = dos
    ? plans.find(
        (p) =>
          !!(p.coveragePeriodStart &&
            p.coveragePeriodEnd &&
            dos >= p.coveragePeriodStart &&
            dos <= p.coveragePeriodEnd),
      )
    : undefined;
  if (windowMatch) return windowMatch.insurancePlanId;
  const active = plans.find((p) => p.isActive);
  if (active) return active.insurancePlanId;
  return plans[0]?.insurancePlanId ?? null;
}

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

  // dispute_plan_pinning_v1 (Phase 2) — the #2 confirm/override chooser. The
  // flag is read lazily on first draft-click and cached (no read on claim pages
  // where the user never drafts; flag OFF → chooser never opens, draft path is
  // byte-identical to pre-flag).
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserPlans, setChooserPlans] = useState<DisputePlanChooserPlan[]>([]);
  const [chooserDefaultId, setChooserDefaultId] = useState<string | null>(null);
  const pinningFlagRef = useRef<boolean | null>(null);
  const preparingRef = useRef(false);

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
    // Cost-Share v2 (S214) — when the engine ran (verdict present), the dispute
    // synthesis is VERDICT-DRIVEN: only a 'recovery' verdict surfaces a finding,
    // and it uses the engine's refund+forgiveness (the recovery-story branch
    // below), never the deductible-blind gross-billed isMysteryGap amount. Every
    // other verdict (correct/confident/not_covered/insufficient) is suppressed —
    // the engine-fed recovery block already corrects the ~10 display surfaces.
    // OFF (verdict absent) = today's deductible-blind logic, verbatim.
    const onEngine = li.costShareVerdict != null;
    const isMysteryGap = !onEngine && billed > 0 && ins === 0 && owed === 0;
    const hasRecoveryStory = onEngine
      ? li.costShareVerdict === "recovery"
      : li.planCoverage != null && (refund >= 1 || forgiveness >= 1);
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
      <button
        type="button"
        onClick={() => router.push(`/disputes?dispute=${existingDisputeId}`)}
        className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)]"
      >
        Open dispute letter
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </button>
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

  async function submitDispute(pinnedPlanId?: string) {
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
          insurancePlanId: pinnedPlanId,
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

  // dispute_plan_pinning_v1 (Phase 2) — entry point for the draft button. When
  // the flag is ON and the claim's year has >1 of the user's plans, surface the
  // #2 chooser so the user confirms/overrides which plan the dispute is pinned
  // to; otherwise (flag OFF, single-plan year, or any error) draft immediately
  // with the claim's default pin — byte-identical to pre-flag behavior.
  async function handleClick() {
    if (loading || preparingRef.current) return;
    const claimMeta = claim;
    const defaultPinId = (claimMeta.insurance_plan_id as string) || undefined;

    preparingRef.current = true;
    try {
      if (pinningFlagRef.current === null) {
        try {
          const r = await fetch("/api/feature-flags/dispute_plan_pinning_v1");
          const j = (await r.json()) as { enabled?: boolean };
          pinningFlagRef.current = j?.enabled === true;
        } catch {
          pinningFlagRef.current = false;
        }
      }

      if (pinningFlagRef.current) {
        const year = resolveClaimYear(claimMeta);
        if (year != null) {
          const token = await getAuthToken();
          if (token) {
            const params = new URLSearchParams({ year: String(year) });
            if (defaultPinId) params.set("pin", defaultPinId);
            const r = await fetch(`/api/plan/by-year?${params.toString()}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (r.ok) {
              const { plans } = (await r.json()) as { plans: DisputePlanChooserPlan[] };
              if (plans && plans.length > 1) {
                // Ambiguous year → prompt. The draft begins on confirm.
                setChooserPlans(plans);
                setChooserDefaultId(
                  computeDefaultPlanId(
                    plans,
                    defaultPinId,
                    (claimMeta.date_of_service as string) || null,
                  ),
                );
                setChooserOpen(true);
                return;
              }
            }
          }
        }
      }
    } catch {
      // fall through to an immediate draft with the default pin
    } finally {
      preparingRef.current = false;
    }

    void submitDispute(defaultPinId);
  }

  // Session 86 round 6 — button shows ACTION only, no specific dollar
  // promise. Showing "recover ~$X" on the CTA risks construing as a credit/
  // recovery guarantee (CROA + state UDAP exposure per Director Checkpoint
  // #5 — user-sends-letter model). Recovery info stays visible as DATA
  // (table column + amber card) but not as a promise on the action button.
  // S138 — adopts design's FlaggedNoDraftAction label "Draft my dispute letter"
  // (bill-detail.jsx line 536) for all non-drafted states. Singular variant
  // also reads as "Draft my dispute letter" since the user perceives one bill,
  // not one finding.
  const buttonLabel = loading
    ? "Drafting…"
    : "Draft my dispute letter";

  // S132 iter-2: overlay moved to (app)/layout.tsx via DisputeDraftOverlayProvider
  // so it persists across /claim → /disputes navigation as a single React mount.
  // S132 iter-8: overlay loader is now cube (audit loader retired).
  // S138: chrome adopts design .btn.btn-primary.btn-md — inline button + arrow,
  // not full-width. Parent action footer dictates layout via flex.

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
      >
        {buttonLabel}
        {!loading && (
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        )}
      </button>
      {error && (
        <p className="mt-2 text-xs text-red-700">{error}</p>
      )}
      <DisputePlanChooser
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        plans={chooserPlans}
        defaultPlanId={chooserDefaultId}
        serviceDate={(claim.date_of_service as string) || null}
        year={resolveClaimYear(claim)}
        submitting={loading}
        onConfirm={(id) => {
          setChooserOpen(false);
          void submitDispute(id);
        }}
      />
    </>
  );
}

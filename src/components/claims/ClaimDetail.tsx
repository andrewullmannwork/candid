"use client";

import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import type { BillState } from "@/lib/claims/derive-bill-state";
import { Disclaimer } from "@/components/shared/Disclaimer";
import { disputeUrlForResult } from "@/lib/disputes/url";
import { CategoryCorrectionModal } from "@/components/claims/CategoryCorrectionModal";
import { UploadPlanDocModal } from "@/components/claims/UploadPlanDocModal";
import { legacyCategoryReviewHint } from "@/lib/billing/code-categories";
import { normalizeCoinsurancePct } from "@/lib/billing/coinsurance";
import { buildSavingsDerivation } from "@/lib/claims/savings-derivation";
import { buildAcaOverrideLine, type AcaOverride } from "@/lib/claims/aca-override-line";
import { LineDrawer } from "@/components/claims/LineDrawer";
import { BundleSuggestion } from "@/components/claims/BundleSuggestion";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useDisputeDraftOverlay } from "@/lib/loading/dispute-draft-overlay";
import { DisputePlanChooser, type DisputePlanChooserPlan } from "@/components/disputes/DisputePlanChooser";
import { readServicesConfirmedAt } from "@/lib/claims/effective-totals";
import { CostShareBanner, hasAssumptionRows, pendingAssumptionFields, type BannerAssumption, type CostShareVerdict, type CostShareOverrideRequest } from "@/components/claims/CostShareBanner";
import { AddPlanDetailsModal } from "@/components/claims/AddPlanDetailsModal";
import type { CostShareAssumption, CostShareOverrides } from "@/lib/claims/recovery-math";
import { hasPendingAssumption } from "@/lib/claims/recovery-math";
import { useFeatureFlag } from "@/lib/config/use-feature-flag";
import { GuidedPhoneSteps, ShowFullStepButton, derivePhonePackState, samePhonePackState, type GuideStepState, type PhonePackState } from "@/components/claims/GuidedPhoneSteps";
import { CaseRail, CaseResolvedFold, RailStep } from "@/components/claims/CaseRail";
import { CaseFileBlock } from "@/components/claims/CaseFileBlock";
import { OutcomeReportingModal } from "@/components/disputes/OutcomeReportingModal";
import { CollectorModal, type CollectorSubmit } from "@/components/disputes/CollectorModal";
import { ExhaustionAttestModal } from "@/components/disputes/ExhaustionAttestModal";
import {
  railHasExtension,
  composeRail,
  fmtRailDate,
  letterOfferSkipStepId,
  type RailLetterOffer,
} from "@/lib/case/rail-steps";
import {
  readUserTotalsSource,
  type UserTotalsSource,
  type PerLineFieldFact,
} from "@/lib/claims/effective-totals";
import type { AssumptionOptimistic } from "@/components/claims/CostShareBanner";
import {
  SEND_GATE_COPY,
  type ReadinessBlocker,
} from "@/lib/disputes/dispute-readiness";
import {
  EMPTY_PROJECTED_REGULATOR,
  type ProjectedLetterStep,
  type ProjectedRegulatorComplaint,
} from "@/lib/case/timeline-projector";
import { letterRecipientKind } from "@/lib/disputes";
import { isAdverseOutcome } from "@/lib/disputes/outcome-taxonomy";
import { guidedCallLogFromMeta } from "@/lib/guides/pack-registry";
import {
  deriveLetterTracks,
  letterTypeHintFromTypes,
  type LetterTrack,
} from "@/lib/disputes/letter-type";
import {
  markSentPayload,
  undoResultPayload,
  unsendPayload,
} from "@/lib/disputes/outcome-actions";
import { CASE_RAIL, GUIDE_4B, GUIDE_CHROME, PHONE_OUTCOME, type GuideFillContext, type GuideFinding } from "@/lib/guides/pack-registry";

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
    /**
     * S291 — the plan's "does this count toward the deductible?" answer. The
     * server has always sent it (coverage-loader maps `in_deductible_applies`);
     * this type just never declared it, so the Add-plan-details editor couldn't
     * pre-fill and re-opened showing an answered question as blank.
     */
    deductibleApplies?: boolean | null;
    /** S291 — who asserted the cost-share; drives honest attribution copy. */
    costProvenance?: "user" | "card" | "unknown";
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
  // S292 (#4) — per-line "BILLED TO YOU": what the patient was actually asked
  // to pay after the insurer's negotiated adjustment + payment (server-resolved
  // via resolvePerLineBilledToYou; same proportional-split method as YOU PAID).
  // `showBeforeInsurance` gates the "$<gross> before insurance" sub-line —
  // false when the bill has no insurer data (honesty fallback → gross shown).
  // Absent on legacy payloads → column falls back to today's display, no sub-line.
  billedToYou?: { value: number; gross: number; showBeforeInsurance: boolean };
  codeIdentity?: CodeIdentityState | null;
  // Cost-Share v2 (S214) — the engine's per-line verdict, attached by the claims
  // API ONLY when recovery_cost_share_v2 is ON. Its PRESENCE switches the dispute
  // synthesis below to verdict-driven (vs the legacy deductible-blind
  // isMysteryGap/hasRecoveryStory). Absent/null → today's behavior.
  costShareVerdict?: "confident" | "correct" | "recovery" | "not_covered" | "insufficient" | null;
  // Cost-Share v2 (W2) — per-line assumptions behind the verdict (§5 banner
  // chips). Same flag-gated presence as costShareVerdict.
  costShareAssumptions?: CostShareAssumption[];
  /**
   * Cost-Share v2 — "the insurer assigned the patient MORE than the plan says"
   * (positive delta). Same flag-gated presence as costShareVerdict.
   *
   * S305 — it has ridden this payload since the engine landed and NOTHING read
   * it. It is the one signal that can warrant an insurer appeal on a claim with
   * zero audit findings against it, because it comes from plan math rather than
   * from an audit rule — which is exactly why the insurer track cannot be
   * derived from findings alone.
   */
  insurerDiscrepancy?: {
    planDerivedShare: number;
    insurerAssignedShare: number;
    delta: number;
  } | null;
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
  // S299 timeline unification phase 1a — attached by the claim GET ONLY when
  // case_rail_v1 is ON (absent = today's payload, byte-identical). history[]
  // is deliberately omitted until phase 2 renders it.
  caseTimeline?: {
    letters: ProjectedLetterStep[];
    waitingCount: number;
    soonestResponseDue: { date: string; disputeId: string } | null;
    sentLetterMeta: { responseDueDate: string | null; daysRemaining: number | null; amber: boolean } | null;
    /** S303 — the case-level regulator complaint (per-agency filings + the
     *  declination). Never null: an empty record IS "nothing filed yet". */
    regulator: ProjectedRegulatorComplaint;
    /** Per-letter insurer display names (pinned plan), for wait titles. */
    insurerNameByDispute: Record<string, string>;
  };
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
    // S304 — what the LINES say, computed by the resolver and forwarded whole by
    // the GET. `contradictsHeader` is the one condition worth a question: line
    // values that EXIST and disagree with the bill's own summary. A bill that
    // states a total only in its summary block has no per-line values to
    // disagree with, and asking about it produced a choice whose "line items"
    // answer was $0.00.
    perLine?: {
      patientPaid: PerLineFieldFact;
      insurancePaid: PerLineFieldFact;
      insuranceAdjusted: PerLineFieldFact;
      patientResponsibility: PerLineFieldFact;
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
/** S301 (Andrew) — a mailed letter says so, instead of reporting as a draft. */
const DISPUTE_STATUS_SENT_LABEL = "Letter Sent";

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
  anonymousDraftGate,
  onResultsSummary,
}: {
  claimId: string;
  onBack: () => void;
  focusLineItemId?: string | null;
  backLabel?: string;
  /**
   * S316 — the /check anonymous flow's letter gate. When present, every
   * draft-letter CTA click renders this node inline under the button instead
   * of calling /api/disputes/generate (which would 403 the anonymous session
   * — the Tier-3 floor). The authed pages never pass it, so their path is
   * byte-identical. Content and behavior live with the caller.
   */
  anonymousDraftGate?: React.ReactNode;
  /**
   * S316 — fires the SCREEN's own recovery summary (the live-engine numbers
   * this component renders: claim recovery + per-line recoveries) up to the
   * caller whenever the claim payload loads. The /check results email sends
   * exactly this, so the email can never contradict the page (the persisted
   * audit rows it first read are a DIFFERENT finding family than the
   * cost-share engine — his live test caught the contradiction).
   */
  onResultsSummary?: (s: {
    potentialRecovery: number;
    shouldOwe: number;
    lines: { label: string; amount: number | null }[];
  }) => void;
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
  // S309 (Andrew) — the math is OPEN by default; it collapses when the user
  // hides it or interacts with any step AFTER it (phone pack, rail steps) —
  // "I made the call" means they've read the answer and moved on.
  const [showMath, setShowMath] = useState(true);
  // S292 — "Confirmed" is SERVER truth (claims.metadata.servicesConfirmedAt),
  // DERIVED below once `claim` exists, the same persisted-state idiom
  // `assumptionsDone` / `assumptionsEngaged` already use further down this file.
  //
  // It was briefly a lazy `useState` seed reading `claim.metadata`, which could
  // never have worked: the initializer runs on the FIRST render, when the claim
  // fetch hasn't returned and `data` is still null — so it would have read
  // `false` forever, the same looks-saved-but-writes-nothing bug it was meant to
  // fix. (It also referenced `claim` 430 lines before its declaration, which
  // crashed the page outright — a TDZ that `tsc` can't see through an
  // arrow-function capture, so every static gate passed.)
  //
  // This holds only the IN-FLIGHT TARGET of a write, so the button responds
  // instantly and then yields to the server once the write settles — including
  // when it FAILS, where a parallel copy of the truth would go on showing a save
  // that never landed.
  const [svcPendingConfirm, setSvcPendingConfirm] = useState<boolean | null>(null);
  const [svcIssue, setSvcIssue] = useState(false);
  /**
   * S291 — plans that could apply to THIS bill's service year, for the
   * plan-identity assumption row and its re-pin chooser. Fetched once per claim.
   * A separate DisputePlanChooser instance from the draft-time one: same
   * reusable modal, different confirm (re-pin vs draft), no shared state.
   */
  const [planCandidates, setPlanCandidates] = useState<DisputePlanChooserPlan[] | null>(null);
  const [repinOpen, setRepinOpen] = useState(false);
  // S310 (F14a) — the claim-header provider-name editor (pencil beside the
  // title). Writes the claim-scoped provider-contact route — the same single
  // path the letter page uses — then refetches; every surface re-resolves.
  // Saves are OPTIMISTIC (Andrew): the editor closes in the click's render and
  // the page shows the value immediately via the overrides below; a failed
  // write snaps back — override cleared, editor reopened with the error.
  const [providerNameEdit, setProviderNameEdit] = useState<{
    value: string;
    error: boolean;
  } | null>(null);
  const [providerNameOptimistic, setProviderNameOptimistic] = useState<string | null>(null);
  const [insurerNameOptimistic, setInsurerNameOptimistic] = useState<string | null>(null);
  // S293 (#1) — the ACA question block's "Not sure" dismissal, lifted from the
  // banner so the ONE pending set (pendingAssumptionFields → the step badge)
  // sees it: a dismissed block must stop counting, or the badge goes amber over
  // a band with nothing left to answer.
  const [acaDismissed, setAcaDismissed] = useState(false);
  // Guided Steps v1 (S297) — one flag gates the phone subflow AND the done-
  // step rail collapse. OFF (or still loading) = today's page, byte-identical.
  const guidedStepsFlag = useFeatureFlag("guided_steps_v1");
  // S299 phase 1a — the extended rail's UI flag (the event spine is gated
  // separately by case_timeline_v1; see mig 222).
  const caseRailFlag = useFeatureFlag("case_rail_v1");
  // S302 — the line-items-vs-summary question. OFF = the row never renders and
  // nothing writes the answer, so decideField keeps today's header-wins rule.
  const billTotalsSourceFlag = useFeatureFlag("bill_totals_source_v1");
  // S307 — the savings-math derivation pass (priced-answer plan card + the
  // "Where these numbers come from" strip). OFF → today's panel, byte-identical.
  const savingsDerivationFlag = useFeatureFlag("savings_math_derivation_v1");
  /**
   * S302 round 3 (Andrew: "the click takes a while — use optimistic with
   * snapback"). Every other assumption row awaits the claim refetch because the
   * ENGINE re-derives its value server-side, so flipping early would show the
   * pre-answer number for a beat. This row is different: the answer IS the
   * user's click, so the client already knows the outcome and can show it now.
   * `{ value }` wrapper so an optimistic CLEAR (value: null) is distinguishable
   * from "no override". Dropped once the refetch lands; snapped back on failure.
   * The double `bill_totals_adjudicated` event in the S302 E2E was this exact
   * latency — a click with no feedback gets clicked twice.
   */
  const [totalsOverride, setTotalsOverride] = useState<{ value: UserTotalsSource } | null>(null);
  /**
   * S304 — assumption answers this click has made, before the server confirms.
   *
   * Lifted out of CostShareBanner, which used to keep it locally. Three surfaces
   * derived "what have you answered" from two different sources: the banner's
   * rows read its overlay and moved instantly, while the step badge below reads
   * `costShareOverrides` from the server and sat unchanged until the refetch —
   * the lag on "Done". And the banner renders TWICE here, so there were two
   * independent overlays that could disagree with each other as well.
   *
   * Held here, merged ONCE into `effectiveCostShareOverrides` below, and handed
   * to every consumer. Cleared on settle: on success the refetch has landed the
   * truth, on failure clearing IS the snapback — the same discipline
   * `totalsOverride` above uses, for the same reason.
   */
  const [assumptionOptimistic, setAssumptionOptimistic] = useState<AssumptionOptimistic>({});

  /**
   * S304 — THE overrides object every assumption consumer reads: what the server
   * has, plus what this click just answered. One merge, so the step badge, the
   * "has any rows" test, the engaged test and both banner instances can never
   * disagree about whether a question has been answered.
   *
   * `pendingAssumptionFields` stays persisted-truth-only by its own contract —
   * it is handed an already-merged object rather than taught about optimism.
   */
  const effectiveCostShareOverrides = useMemo(() => {
    const base = data?.costShareOverrides ?? null;
    const o = assumptionOptimistic;
    if (!base && Object.keys(o).length === 0) return null;
    return {
      deductibleMet: o.deductibleMet ?? base?.deductibleMet ?? null,
      deductibleMetAsOf: o.deductibleMetAsOf ?? base?.deductibleMetAsOf ?? null,
      oopMet: o.oopMet ?? base?.oopMet ?? null,
      oopMetAsOf: o.oopMetAsOf ?? base?.oopMetAsOf ?? null,
      userNetworkOverride: o.network ?? base?.userNetworkOverride ?? null,
    };
  }, [data?.costShareOverrides, assumptionOptimistic]);

  // S302 — resolved-case fold, expanded on demand (§2.2: no collapse in this
  // product is ever permanent, and every expanded step stays interactive).
  const [caseExpanded, setCaseExpanded] = useState(false);
  // S299 — the rail's inline actions (shared dispute-side modals; see the
  // CaseRail mount + the modal mounts below).
  const [railOutcomeDisputeId, setRailOutcomeDisputeId] = useState<string | null>(null);
  const [railCollectorFromDisputeId, setRailCollectorFromDisputeId] = useState<string | null>(null);
  const [railExhaustionFromDisputeId, setRailExhaustionFromDisputeId] = useState<string | null>(null);
  const [railEscalating, setRailEscalating] = useState(false);
  const [railActionError, setRailActionError] = useState<string | null>(null);
  // "Show full step" client state for the done-collapsed rail steps 1-2
  // (collapsed by default when done; expansion is throwaway, not persisted).
  const [assumpFullOpen, setAssumpFullOpen] = useState(false);
  // S308 — bump → the banner un-collapses (the stub link's second vector).
  const [assumpExpandSignal, setAssumpExpandSignal] = useState(0);
  const [svcFullOpen, setSvcFullOpen] = useState(false);
  // 4a/4b split (S297) — 4a's Show-full-step reopen + the LIVE pack state
  // mirrored up from GuidedPhoneSteps (initial render derives from the
  // persisted meta; the component emits on every persist).
  const [phoneFullOpen, setPhoneFullOpen] = useState(false);
  const [guidedPackLive, setGuidedPackLive] = useState<PhonePackState | null>(null);
  // S309 (Andrew) — the skipped pack's Undo chip bumps this; GuidedPhoneSteps
  // (mounted-but-hidden while collapsed) clears the skip through its OWN
  // persist, keeping its optimistic map + emission + server coherent.
  const [phoneUndoSkipSignal, setPhoneUndoSkipSignal] = useState(0);


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

  /**
   * S291 — candidate plans for THIS bill's service year, backing the
   * plan-identity assumption row and its re-pin chooser.
   *
   * Declared here, above the loading early-return, because hooks must run in
   * the same order every render; it reads `data?.claim` defensively rather than
   * the `claim` binding, which only exists after that return.
   */
  const claimDos = (data?.claim as Record<string, unknown> | undefined)?.date_of_service as
    | string
    | undefined;
  const claimPlanId = (data?.claim as Record<string, unknown> | undefined)?.insurance_plan_id as
    | string
    | null
    | undefined;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const year =
        typeof claimDos === "string" && Number.isInteger(parseInt(claimDos.slice(0, 4), 10))
          ? parseInt(claimDos.slice(0, 4), 10)
          : null;
      if (year == null) return;
      try {
        const token = await getAuthToken();
        if (!token) return;
        const qp = new URLSearchParams({ year: String(year) });
        if (claimPlanId) qp.set("pin", claimPlanId);
        const r = await fetch(`/api/plan/by-year?${qp.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const { plans } = (await r.json()) as { plans: DisputePlanChooserPlan[] };
        if (!cancelled) setPlanCandidates(plans ?? []);
      } catch {
        /* the row simply doesn't render without candidates */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [claimDos, claimPlanId, getAuthToken]);

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

  // S299 — rail inline actions: the dispute page's own requests, reused
  // VERBATIM (undo = /api/disputes/outcome with status "filed" +
  // clearOutcomeDetail, the S266 contract; something-else = the collections
  // escalate). After a mutation the claim refetches so the projection —
  // the rail's one derivation — re-renders the new state.
  const handleRailUndoResult = useCallback(
    async (disputeId: string): Promise<boolean> => {
      try {
        const token = await getAuthToken();
        if (!token) return false;
        const res = await fetch(`/api/disputes/outcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(undoResultPayload(disputeId)),
        });
        if (!res.ok) return false;
        await refetchClaim();
        if (onClaimUpdated) void onClaimUpdated();
        return true;
      } catch {
        return false;
      }
    },
    [getAuthToken, refetchClaim, onClaimUpdated],
  );

  // S301 — the collections "Mail it certified" step IS mark-as-sent, in both
  // directions (Andrew). Routes to the EXISTING outcome route rather than a
  // parallel writer, so the immutable snapshot, the deadline clock, the version
  // stack, and the letter_sent / letter_unsent events all fire exactly once on
  // the path that already owns them.
  //
  // ⚠ Un-sending is a real state change with a sequencing guard: §0.9b allows it
  // only while NO response is logged, so an unsend can never orphan a logged
  // outcome. The route enforces it; a refusal surfaces in the rail's error strip
  // instead of failing silently.
  const handleRailMarkSent = useCallback(
    async (disputeId: string, sent: boolean): Promise<boolean> => {
      try {
        const token = await getAuthToken();
        if (!token) {
          setRailActionError("Couldn't save that — please refresh and try again.");
          return false;
        }
        const res = await fetch(`/api/disputes/outcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          // ONE payload source (outcome-actions). The invented `markSent` /
          // `undoSent` keys this used to send were never route params — the
          // route requires `status` and reads clearSentAt/clearOutcomeDetail —
          // so unsend 400'd every time while the catch below blamed the §0.9b
          // guard.
          body: JSON.stringify(sent ? markSentPayload(disputeId) : unsendPayload(disputeId)),
        });
        if (!res.ok) {
          // S302 — the send gate answers 409 with the FLOOR items that are
          // missing. Saying "please try again" to that would be the S301
          // mistake exactly: an error message pointing away from the cause,
          // on an action that will never succeed by retrying. Name what's
          // missing and where to fix it.
          if (res.status === 409) {
            const body = (await res.json().catch(() => null)) as {
              blockers?: ReadinessBlocker[];
            } | null;
            const missing = (body?.blockers ?? [])
              .map((b) => SEND_GATE_COPY.blocker(b, "both").what.toLowerCase())
              .join(", ");
            setRailActionError(
              missing
                ? `${SEND_GATE_COPY.error} Still missing: ${missing}. Open the letter to add it.`
                : `${SEND_GATE_COPY.error} Open the letter to see what's missing.`,
            );
            return false;
          }
          // S301 — the old message here BLAMED the §0.9b guard, which disguised
          // a malformed request as correct behavior. Unsend now clears the
          // outcome in the same patch, so there is no prerequisite to name.
          setRailActionError(
            sent
              ? "Couldn't mark this as sent — please try again."
              : "Couldn't unsend this — please try again.",
          );
          return false;
        }
        await refetchClaim();
        if (onClaimUpdated) void onClaimUpdated();
        return true;
      } catch {
        setRailActionError("Couldn't save that — please try again.");
        return false;
      }
    },
    [getAuthToken, refetchClaim, onClaimUpdated],
  );

  // S301 — the FDCPA §1692g anchor, through the EXISTING deadline-inputs route
  // (the same endpoint the dispute page's date rows use), so the engine keeps
  // one input path and the rail does not learn about deadlines.
  const handleRailFirstContactDate = useCallback(
    async (disputeId: string, date: string | null): Promise<void> => {
      try {
        const token = await getAuthToken();
        if (!token) return;
        const res = await fetch(`/api/disputes/${disputeId}/deadline-inputs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ collectorFirstContactDate: date }),
        });
        if (!res.ok) {
          setRailActionError("Couldn't save that date — please try again.");
          return;
        }
        await refetchClaim();
      } catch {
        setRailActionError("Couldn't save that date — please try again.");
      }
    },
    [getAuthToken, refetchClaim],
  );

  // ONE escalate path for every rail offer (phase 1b generalizes 1a's
  // collector flow): POST the EXISTING /escalate route, then navigate to the
  // new letter for review (dispute-side parity).
  const railEscalate = useCallback(
    async (
      fromDisputeId: string,
      targetLetterType: "debt_validation" | "external_review" | "final_notice",
      extra: Record<string, unknown> = {},
    ) => {
      if (railEscalating) return;
      setRailEscalating(true);
      setRailActionError(null);
      try {
        const token = await getAuthToken();
        if (!token) throw new Error("not signed in");
        const res = await fetch(`/api/disputes/${fromDisputeId}/escalate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ targetLetterType, ...extra }),
        });
        if (!res.ok) throw new Error("escalate failed");
        const result = await res.json();
        setRailCollectorFromDisputeId(null);
        setRailExhaustionFromDisputeId(null);
        if (result?.disputeId) {
          // Dispute-side parity: the new letter needs review before send.
          router.push(`/disputes?dispute=${result.disputeId}`);
        } else {
          await refetchClaim();
        }
      } catch {
        setRailActionError("We couldn't create that letter. Please try again.");
      } finally {
        setRailEscalating(false);
      }
    },
    [railEscalating, getAuthToken, router, refetchClaim],
  );

  const handleRailCollectorSubmit = useCallback(
    async (input: CollectorSubmit) => {
      if (!railCollectorFromDisputeId) return;
      await railEscalate(railCollectorFromDisputeId, "debt_validation", {
        collector: input.collector,
        collectorFirstContactDate: input.collectorFirstContactDate,
      });
    },
    [railCollectorFromDisputeId, railEscalate],
  );

  // Cost-Share v2 (W3) — post ONE assumption correction, then refetch so the
  // engine recomputes live. Uses refetchClaim + onClaimUpdated (NOT
  // handleCorrectionSubmitted — that fires the category-specific re-draft prompt;
  // letter staleness is W4's job via the evidence fingerprint).
  const [csOverridePending, setCsOverridePending] = useState<string | null>(null);
  const [csOverrideError, setCsOverrideError] = useState<string | null>(null);
  const submitCostShareOverride = useCallback(
    // S302 round 3 — returns whether the write landed, so an OPTIMISTIC caller
    // can snap back. Existing callers ignore it and are unaffected.
    async (body: CostShareOverrideRequest, pendingKey: string): Promise<boolean> => {
      setCsOverridePending(pendingKey);
      setCsOverrideError(null);
      // S309 (Andrew) — Done means FULLY collapsed. The reviewed:true write
      // also rests the step-expand flag, so the step returns to its stub +
      // "Show full step" instead of the phantom third state ("expanded step
      // holding a collapsed card") whose toggle read backwards and cost a
      // double-click. Mirror of the stub link, which pairs its reviewed:false
      // write with setAssumpFullOpen(true). Optimistic on purpose: if the
      // write fails, review stays un-done and the body stays visible
      // regardless of this flag (assumpBodyVisible), so a false reset is inert.
      if (body.field === "assumptions_reviewed" && body.reviewed === true) {
        setAssumpFullOpen(false);
      }
      try {
        const token = await getAuthToken();
        if (!token) return false;
        const res = await fetch(`/api/claims/${claimId}/cost-share-override`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setCsOverrideError(d.error || `Couldn't save your change (${res.status}).`);
          return false;
        }
        // S295 — the answered row's value is re-derived by the ENGINE server-side,
        // so `refetchClaim` stays awaited: unpinning before it lands would show
        // the pre-answer value for a beat. What does NOT need to gate the control
        // is `onClaimUpdated` — that refetches the whole claims LIST purely to
        // refresh the parent BillCard chrome. Awaiting it put a second full GET
        // in the click path of every assumption answer (step 1), on top of
        // /api/claims/[claimId], which is ~24 Supabase queries and can re-run the
        // audit inline. Fire it in the background instead.
        await refetchClaim();
        if (onClaimUpdated) void onClaimUpdated();
        return true;
      } catch {
        setCsOverrideError("Couldn't save your change. Please try again.");
        return false;
      } finally {
        setCsOverridePending(null);
      }
    },
    [claimId, getAuthToken, refetchClaim, onClaimUpdated],
  );

  /**
   * S291 — batch peer of submitCostShareOverride, for the banner's "Done".
   *
   * Writes each confirmed default IN ORDER and refetches the claim exactly
   * ONCE at the end. The single-override path refetches after every write, so
   * firing three of these through it would race three refetches against each
   * other and against the render that reads the result.
   *
   * S293 (#5) — the banner's Done is optimistic now (it collapses before the
   * batch lands), so failure must REJECT: the first error is surfaced via
   * `csOverrideError`, the rest of the batch is abandoned, the claim is still
   * refetched (part of the batch may have landed — the banner re-derives its
   * rows from whatever the server now says), and the thrown error snaps the
   * collapsed section back open so the user can see nothing was saved.
   */
  const confirmAssumptionDefaults = useCallback(
    async (bodies: CostShareOverrideRequest[]) => {
      if (bodies.length === 0) return;
      setCsOverridePending("confirm-defaults");
      setCsOverrideError(null);
      let failMsg: string | null = null;
      try {
        const token = await getAuthToken();
        if (!token) {
          failMsg = "Couldn't save your answers. Please try again.";
        } else {
          for (const body of bodies) {
            const res = await fetch(`/api/claims/${claimId}/cost-share-override`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify(body),
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              failMsg = d.error || `Couldn't save your answers (${res.status}).`;
              break;
            }
          }
        }
        // S295 — same split as submitCostShareOverride: the claim re-resolve is
        // load-bearing (the banner re-derives its rows from it), the list refresh
        // is chrome. Don't make the user wait on the chrome.
        await refetchClaim();
        if (onClaimUpdated) void onClaimUpdated();
      } catch {
        failMsg = failMsg ?? "Couldn't save your answers. Please try again.";
      } finally {
        setCsOverridePending(null);
        // S304 — settle the optimistic overlay. On success the refetch above has
        // already landed the truth, so dropping it is a no-op; on failure
        // dropping it IS the snapback. Both paths clear, for different reasons —
        // the same discipline the totals-source row uses.
        setAssumptionOptimistic({});
      }
      if (failMsg) {
        setCsOverrideError(failMsg);
        throw new Error(failMsg);
      }
    },
    [claimId, getAuthToken, refetchClaim, onClaimUpdated],
  );

  // S316 — surface the rendered recovery summary to the caller (the /check
  // results email mails EXACTLY what this screen shows — one derivation).
  useEffect(() => {
    if (!data || !onResultsSummary) return;
    const lines = (data.lineItems ?? [])
      .filter((li) => (li.recovery?.potentialRecovery ?? 0) >= 1)
      .map((li) => ({
        label: (li.description as string) || "Charge",
        amount: li.recovery?.potentialRecovery ?? null,
      }));
    onResultsSummary({
      potentialRecovery: data.recovery?.potentialRecovery ?? 0,
      shouldOwe: data.recovery?.shouldOwe ?? 0,
      lines,
    });
  }, [data, onResultsSummary]);

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
  // S310 — the optimistic override applies at this ONE derivation, so every
  // consumer on the page (title, offers, footer) shows a just-saved name in
  // the click's render; server truth replaces it on the refetch.
  const providerName =
    providerNameOptimistic ??
    (((claim.metadata as Record<string, unknown>)?.provider as Record<string, unknown>)?.name as string || "Unknown Provider");

  // S292 — services-verification state. `svcConfirmed` is the persisted truth;
  // the in-flight target wins only until the write settles. Derived (not stored)
  // so a reload, a refetch and this render can never disagree. It feeds
  // `assumptionsEngaged` and the rail's done state below, so it must never read
  // complete on a bill whose confirmation isn't actually on the server.
  const svcConfirmed = readServicesConfirmedAt(claim.metadata) != null;
  const svcOk = svcPendingConfirm ?? svcConfirmed;

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
  // S308 — the raw slug is MACHINE vocabulary; when the catalog has no name
  // for it (stale seed slugs, legacy rows), fall back to readable words, never
  // underscores ("physical_therapy" reached the Add-plan-details question).
  const humanizeSlug = (slug: string | null): string =>
    slug ? slugNameMap.get(slug) ?? slug.replace(/_/g, " ") : "";

  // S307 — the savings-math derivation (savings_math_derivation_v1): ONE
  // build feeds the plan card's priced answer, its per-line rows, and the
  // "Where these numbers come from" strip, so they can never disagree. Pure
  // rendering of the engine's own per-line results — no money is computed
  // here. Flag OFF → null → every surface below renders today's markup.
  const savingsDerivation = (() => {
    if (!savingsDerivationFlag.enabled) return null;
    return buildSavingsDerivation({
      lines: primaryLineItems.map((li) => {
        const pct =
          li.planCoverage?.coinsurance != null
            ? normalizeCoinsurancePct(li.planCoverage.coinsurance)
            : null;
        // The deductible facts ride the line's own assumptions (S291 made them
        // always-visible rows): `deductible_applies` assumed subject*/exempt*,
        // `deductible_met` assumed met/not_met, value = the deductible dollars.
        const asm = li.costShareAssumptions ?? [];
        const dedApplies = asm.find((a) => a.field === "deductible_applies");
        const dedMet = asm.find((a) => a.field === "deductible_met");
        return {
          id: li.id,
          label: humanizeSlug(li.service_slug) || li.description || "This service",
          serviceSlug: li.service_slug ?? null,
          billed: li.billed_amount ?? 0,
          adjustedBilled: li.adjustedBilled ?? li.billed_amount ?? null,
          paid: li.recovery?.patientPaid ?? li.patient_paid_amount ?? 0,
          stillBilled: li.recovery?.remainingBalance ?? 0,
          shouldOwe: li.recovery?.shouldOwe ?? 0,
          refund: li.recovery?.refundComponent ?? 0,
          forgiveness: li.recovery?.forgivenessComponent ?? 0,
          // S308 (tracker AU) — ANSWERED service-cost rows now emit (reason
          // user_override); only a PENDING one means the rate is unknown.
          //
          // S314 (Andrew) — an UNCONFIRMED category match is not a known rate
          // either. `coverageNeedsConfirmation` is already on the wire from the
          // claim GET, computed from exactly the state the dispute pipeline uses
          // to withhold a line from the letter ("secondary match, ambiguous
          // cost-share, user has neither confirmed nor rejected"). This panel
          // simply ignored it — so it showed "Annual Physical Exam · no copay ·
          // $0.00" as settled fact for a line the letter would not cite, and
          // promised a recovery the letter could not demand.
          //
          // Reading it costs one clause and makes the panel's EXISTING
          // machinery correct on its own: the row renders the "Confirm your
          // rate →" chip that already exists, and the plan card picks up its
          // own honesty marker (", so far") because not every charged line is
          // priced. Same field, same question, same answer as the letter.
          rateKnown:
            !hasPendingAssumption(li.costShareAssumptions, "service_cost") &&
            li.coverageNeedsConfirmation !== true,
          copay: li.planCoverage?.copay ?? null,
          coinsurance: pct != null ? pct / 100 : null,
          covered: li.planCoverage?.covered ?? null,
          deductibleApplies: dedApplies ? dedApplies.assumed.startsWith("subject") : null,
          deductibleMet: dedMet ? dedMet.assumed === "met" : null,
          deductibleMax: dedApplies?.value ?? dedMet?.value ?? null,
          // planCoverage.source is MACHINE vocabulary ("sbc_parser",
          // "canonical_inherited") — never printable. The strip's "Source: …"
          // suffix stays off until letter-grade citation labels are plumbed
          // here; the helper already accepts sourceLabel when they land.
          sourceLabel: null,
        };
      }),
      prorated: data.recovery?.provenance?.citationSource === "claim_header",
      paidTotal: billTotals.patientPaid,
      balanceTotal: data.recovery?.stillOutstanding ?? 0,
      refundComponent: data.recovery?.refundComponent ?? 0,
      forgivenessComponent: data.recovery?.forgivenessComponent ?? 0,
      // S309 F17 — the bill's actual charge (effective patient responsibility,
      // override-independent) so the derivation can split the refund at the
      // charge line: insurer-claimable vs paid-above-charge (the provider's).
      chargedTotal: data.effectiveTotals?.patientResponsibility,
    });
  })();

  // S309 F17 — the paid-above-charge slice, shared by the provider letter
  // track, its rail-offer reason, and the panel (ONE derivation — the same
  // model field the split renders).
  const overpaidToProvider = savingsDerivation?.bill.paidSplit?.overpaid ?? 0;

  // S310 — the hero banner's party-named sub-spans (insurer slice · provider
  // slice · balance slice), each already null under $1 in the derivation.
  // Null when the flag is off → the legacy two-span markup renders instead.
  const heroSubs = savingsDerivation
    ? [savingsDerivation.refundSub, savingsDerivation.overpaidSub, savingsDerivation.forgivenessSub].filter(
        (s): s is string => s != null,
      )
    : null;

  // Cost-Share v2 (W2) — flatten per-line assumptions with the line context the
  // §5 banner chips + W3 override calls need (lineId + service label/slug). Over
  // primaryLineItems only — zero-charge reporting codes carry no cost-share stake
  // (the engine resolves them `confident`/no-assumptions), so they never chip here.
  /**
   * S302 — the line-items-vs-summary disagreement, assembled from
   * `effectiveTotals.provenance`, which the claim GET has always sent and
   * nothing has ever read. A `claim_header` source MEANS the line items did not
   * sum to the bill's own summary on that field.
   *
   * ONE question, not four rows: a bill is internally consistent on paper, so a
   * mismatch is one parser error of ours, not four independent ones — and the
   * answer applies to every disagreeing total on the bill. We ask on the field
   * with the largest delta (deterministic, and the biggest problem first).
   *
   * Null once answered (`userTotalsSource` set) — the row is the question, and a
   * question that has been answered is not pending.
   */
  const totalsSourceRow = (() => {
    if (!billTotalsSourceFlag.enabled) return null;
    const eff = data.effectiveTotals;
    if (!eff) return null;
    const answered = totalsOverride ? totalsOverride.value : readUserTotalsSource(claim.metadata);
    // S302 round 4 — keyed on the FACT, not on provenance. Provenance was a
    // PROXY for "the two disagree", and it stops saying `claim_header` the
    // moment the user answers (it becomes user_summary / user_line_items). So an
    // optimistic CLEAR produced answered=null AND worst=null, the row returned
    // null, and it VANISHED for the length of a refetch before reappearing amber
    // (Andrew: "it disappears for a few seconds then reappears").
    //
    // S304 — the fact now comes FROM the resolver instead of being re-derived
    // here. This block used to re-sum the raw lines with its own header-column →
    // line-column mapping, a third implementation of a comparison
    // `resolveEffectiveClaimTotals` had already made. It could not tell "the
    // bill states this only in its summary" from "the lines say zero", so it
    // asked users to settle a conflict that did not exist — 14 of 17 DEV claims,
    // none of them a real disagreement. `contradictsHeader` requires the line
    // values to EXIST, which is the whole difference.
    const FIELDS = [
      { fact: eff.perLine?.patientResponsibility, label: "what you owe", header: "total_patient_responsibility" },
      { fact: eff.perLine?.patientPaid, label: "what you've paid", header: "total_patient_paid" },
      { fact: eff.perLine?.insurancePaid, label: "what your insurer paid", header: "total_insurance_paid" },
      { fact: eff.perLine?.insuranceAdjusted, label: "the insurer's adjustments", header: "total_insurance_adjusted" },
    ] as const;
    let worst: { label: string; lineSum: number; header: number; delta: number } | null = null;
    for (const f of FIELDS) {
      if (!f.fact?.contradictsHeader) continue;
      const header = Number((claim as Record<string, unknown>)[f.header] ?? 0);
      const delta = Math.abs(f.fact.sum - header);
      if (worst == null || delta > worst.delta) {
        worst = { label: f.label, lineSum: f.fact.sum, header, delta };
      }
    }
    // Answered → the row STAYS, in its confirmed state, because the copy
    // promises the answer can be changed at any time. (Once answered the
    // provenance is user_*, so `worst` is null — the numbers are carried only
    // for the open question.)
    if (!worst && !answered) return null;
    return {
      answered,
      label: worst?.label ?? "",
      lineItemsTotal: worst ? `$${fmtMoney(worst.lineSum)}` : "",
      summaryTotal: worst ? `$${fmtMoney(worst.header)}` : "",
      onChoose: (use: "summary" | "line_items" | null) => {
        setTotalsOverride({ value: use });
        // BOTH paths clear the override, for different reasons: on success the
        // refetch has already landed the truth, and on failure clearing IS the
        // snap-back (the row reverts to whatever metadata still says).
        void submitCostShareOverride({ field: "totals_source", use }, "totals_source").finally(
          () => setTotalsOverride(null),
        );
      },
    };
  })();

  const bannerAssumptions: BannerAssumption[] = primaryLineItems.flatMap((li) =>
    (li.costShareAssumptions ?? []).map((a) => ({
      ...a,
      lineId: li.id,
      serviceLabel: humanizeSlug(li.service_slug) || li.description || "this service",
      serviceSlug: li.service_slug,
    })),
  );

  /**
   * S291 — which plan this bill is audited against, for the assumptions row.
   *
   * Uses DATE OF SERVICE, not `claims.plan_year`: the two can disagree (a
   * 2025-06 bill carrying plan_year 2026 exists in DEV today), and for "which
   * plan covered you then" the service date is the fact and plan_year is a
   * parsed guess.
   *
   * `null` label = no plan on file for that period — the honest zero-match
   * state. The existing draft-time chooser only opens when MORE than one plan
   * matches, so this case previously produced silence plus a quietly wrong pin.
   */
  const claimServiceYear = (() => {
    const dos = claim.date_of_service;
    if (typeof dos === "string") {
      const y = parseInt(dos.slice(0, 4), 10);
      if (Number.isInteger(y)) return y;
    }
    return resolveClaimYear(claim);
  })();
  const pinnedPlanId = (claim.insurance_plan_id as string | null) ?? null;
  const pinnedPlan = planCandidates?.find((p) => p.insurancePlanId === pinnedPlanId) ?? null;
  // S310 — insurer optimistic override applied at the label derivation too.
  const pinnedInsurerName = insurerNameOptimistic ?? pinnedPlan?.insurerName ?? null;
  const planIdentityLabel = pinnedPlan
    ? [pinnedPlan.planName, pinnedInsurerName].filter(Boolean).join(" — ") || null
    : null;
  // S291 — the pinned plan's own year vs the year the care happened. Both are
  // facts off real documents; disagreeing means the bill is being checked
  // against a plan from the wrong year, which is a prompt, not a data error.
  const planYearMismatch =
    pinnedPlan?.planYear != null &&
    claimServiceYear != null &&
    pinnedPlan.planYear !== claimServiceYear
      ? pinnedPlan.planYear
      : null;

  // S310 (F14a) — the two name-correction writes. Plain consts (no hooks):
  // they close over pinnedPlan above and are handed to the header editor and
  // the banner's pinned-plan row. Both are OPTIMISTIC with snapback (Andrew):
  // the override shows the value in the click's render; the slow part (the
  // refetch that carries server truth) happens behind it; a failed write
  // clears the override and resurfaces the editor with the error.
  const saveProviderName = (name: string): void => {
    setProviderNameOptimistic(name);
    void (async () => {
      try {
        const token = await getAuthToken();
        const res = await fetch(`/api/claims/${claimId}/provider-contact`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(String(res.status));
        await refetchClaim(); // server truth lands first…
        setProviderNameOptimistic(null); // …then the override retires (no flicker)
      } catch {
        setProviderNameOptimistic(null);
        setProviderNameEdit({ value: name, error: true });
      }
    })();
  };
  const saveInsurerName = async (name: string): Promise<boolean> => {
    if (!pinnedPlan?.insurancePlanId) return false;
    setInsurerNameOptimistic(name);
    try {
      const token = await getAuthToken();
      const res = await fetch(`/api/plan/insurer-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planId: pinnedPlan.insurancePlanId, insurerName: name }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await refetchClaim();
      setInsurerNameOptimistic(null);
      return true;
    } catch {
      setInsurerNameOptimistic(null);
      return false;
    }
  };

  // The line the banner's verdict-specific CTAs act on (matching line, else first).
  const bannerTargetLineId = (() => {
    const v = data.costShareBill?.verdict;
    const match = v ? primaryLineItems.find((li) => li.costShareVerdict === v) : null;
    return (match ?? primaryLineItems[0])?.id ?? null;
  })();
  // S308 — every line whose plan cost carries STATED values (source `manual`),
  // generalized from S263's single-target probe: user-provenance rows render
  // answered ("$40 copay · Edit"), card/unknown render as open confirm asks.
  // ONE derivation for N lines; the banner renders these instead of
  // assumption-answered chips (which would duplicate them).
  const statedServiceCosts = primaryLineItems.flatMap((li) => {
    const pc = li.planCoverage;
    if (!pc || pc.source !== "manual" || (pc.copay == null && pc.coinsurance == null)) return [];
    return [{
      lineId: li.id,
      serviceSlug: li.service_slug ?? null,
      serviceLabel: humanizeSlug(li.service_slug) || li.description || "this service",
      copay: pc.copay,
      coinsurancePercent: pc.coinsurance != null ? normalizeCoinsurancePct(pc.coinsurance) : null,
      deductibleApplies: pc.deductibleApplies ?? null,
      costProvenance: (pc.costProvenance ?? "unknown") as "plan_document" | "user" | "card" | "unknown",
    }];
  });

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
  // S305 — the dismissed COUNT died with the banner that showed it. The list
  // itself stays: it feeds the rung's reason, the dispute bundle and the
  // letter-type derivation, all of which read the live findings.

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
  // S291 (Andrew) — CONFIRM-THEN-REVEAL order: verify assumptions → verify
  // services → what you could save → recover. The savings figure is derived
  // FROM the assumptions and the service list, so leading with it asked the
  // user to react to a number before they'd confirmed the inputs behind it.
  // Step 1 ("Verify our assumptions") exists only when the Cost-Share card has
  // assumption rows to edit; every later step renumbers off that.
  const railHasAssumptions =
    !!data.costShareBill &&
    hasAssumptionRows(bannerAssumptions, effectiveCostShareOverrides, statedServiceCosts.length > 0);
  const railStepServices = railHasAssumptions ? 2 : 1;
  const railStepSave = railStepServices + 1;
  const railStepRecover = railStepSave + 1;

  // S291 (Andrew) — step-1 badge state, from PERSISTED overrides so it survives
  // a reload (the banner's own "Done" is local collapse state, not completion).
  // Green check once every assumption is answered; amber — number kept, because
  // it's skipped rather than finished — when answers are still outstanding but
  // the user has already confirmed the services below it.
  // S310 F16 (Andrew's ruling) — estimate-borrowed rates surface in the
  // assumptions card as confirmable rows. Same wire data the line table's
  // Coverage badge renders from (coverageNeedsConfirmation, S154), same
  // confirm write (handleConfirmCoverage), so the card row and the badge
  // read + settle ONE row — flow by construction, no new derivations.
  const estimateRateRows = primaryLineItems
    .filter((li) => li.coverageNeedsConfirmation === true)
    .map((li) => ({
      lineId: li.id,
      serviceLabel:
        humanizeSlug(li.service_slug ?? "") || li.description || "this service",
      siblingLabel: li.coverageSecondaryMatchedSlug
        ? humanizeSlug(li.coverageSecondaryMatchedSlug) || null
        : null,
      rateText:
        li.planCoverage?.copay != null
          ? `$${fmtMoney(li.planCoverage.copay)} copay`
          : li.planCoverage?.coinsurance != null
            ? `${Math.round(normalizeCoinsurancePct(li.planCoverage.coinsurance) ?? 0)}% coinsurance`
            : "a borrowed rate",
      serviceSlug: li.service_slug ?? null,
    }));

  const assumptionsPendingFields = railHasAssumptions
    ? pendingAssumptionFields(
        bannerAssumptions,
        effectiveCostShareOverrides,
        // S292 — the plan-identity row's amber now comes from this ONE set,
        // so the step badge and the row border can never disagree again.
        // S293 (#1) — and the badge input now MIRRORS the row's own render
        // condition: the banner renders the plan row only when `planCandidates`
        // resolved (the by-year fetch landed). Passing `{label}` here
        // unconditionally while the banner got `null` meant a failed/absent
        // fetch counted plan_identity with NO row on screen — invisible amber.
        planCandidates ? { label: planIdentityLabel } : null,
        // S293 (#1) — a field may count only while the row that answers it is
        // on screen (see pendingAssumptionFields). Same sources the banner
        // renders from: the editable-cost row exists only for a manual-source
        // cost; the ACA block hides once dismissed via "Not sure".
        {
          // S308 (Andrew, round 2) — the deductible half is REQUIRED: it
          // counts as pending exactly while an incomplete user-stated row is
          // ON SCREEN with its one-tap Yes/No (per-row precision — the S292
          // amber ⟺ counted invariant, never an invisible blocker).
          deductibleAppliesRowVisible: statedServiceCosts.some(
            (sc) => sc.costProvenance === "user" && sc.deductibleApplies == null && sc.serviceSlug != null,
          ),
          acaRowVisible:
            bannerAssumptions.some((a) => a.field === "aca_preventive") && !acaDismissed,
        },
        // S302 — same object the banner renders from, so the badge and the row
        // can never disagree about whether the question is outstanding.
        totalsSourceRow?.answered == null ? totalsSourceRow : null,
        // S310 F16 — the estimate rows join the ONE pending set (amber ⟺
        // counted; the badge and the card row read the same keys).
        estimateRateRows,
      )
    : new Set<string>();
  const assumptionsPending = assumptionsPendingFields.size;
  const assumptionsDone = railHasAssumptions && assumptionsPending === 0;
  // Amber = "still needs you, and you've already moved past it". Engagement is
  // read from PERSISTED overrides rather than a local flag: because Done now
  // writes the accepted defaults, having any override IS the durable proof the
  // user worked this step — so a bill whose plan cost is still missing stays
  // amber across reloads instead of resetting to a fresh blue "1".
  const assumptionsEngaged =
    svcOk ||
    (effectiveCostShareOverrides?.userNetworkOverride ?? null) != null ||
    (effectiveCostShareOverrides?.deductibleMet ?? null) != null ||
    (effectiveCostShareOverrides?.oopMet ?? null) != null;
  const assumptionsAttention = railHasAssumptions && assumptionsPending > 0 && assumptionsEngaged;

  // S291 (Andrew) — a drafted letter completes BOTH the savings step and the
  // recover step: you've seen what you could get back, and you've acted on it.
  // Same truth the /claim tiles now use, so a bill can't read "letter drafted"
  // there while its rail still shows those steps outstanding. Cancelled drafts
  // don't count — the letter has to actually exist.
  const hasDraftedDispute = data.disputes.some((d) => d.status !== "cancelled");
  // S299 phase 1a — the extended rail (projection attached by the GET only
  // when case_rail_v1 is ON).
  //
  // S302 — there is no PRIMARY letter any more. Once ANY letter exists the rail
  // owns every letter's send step, rendered with one anatomy; 4b (and the
  // flag-OFF "Recover the money" step) shrink to what they uniquely are — the
  // affordance that CREATES the first letter — and stop rendering entirely once
  // one exists. That also retires 4b's done-state bug rather than patching it:
  // it was titled "Send the appeal" but keyed on `hasDraftedDispute`, so it went
  // green when a DRAFT existed and stayed green through an unsend.
  const railTimeline = caseRailFlag.enabled ? (data.caseTimeline ?? null) : null;
  // S305 — `railExtends` moved DOWN, next to the composition, because it now
  // also depends on the offered tracks. One definition, three readers.
  // S302 — the resolved fold (agenda §2.2). Derived from the projection, never
  // stored: "every letter reached a terminal outcome" is already answerable.
  // Distinct from "the user closed the case", which is real server state and
  // its own unit. The whole rail folds — prep steps included — because a
  // finished case should read as one line, not thirteen.
  //
  // ⚠ Gated on `isFlagged` for the same reason the rail itself is (agenda §2.1:
  // v1 gives the extended rail to flagged bills only, clean bills keep today's
  // UI). Without it, a CLEAN bill that happens to carry a resolved letter — an
  // itemized-bill request, say — would fold away its own line-items table,
  // because the collapse wrapper spans the whole rail region.
  // S303 — the rail composition lives below, next to `guidedCtx`, because the
  // badge numbering depends on it. See `railComposed`.
  // Stage-8 offer router (phase 1b): external_review needs the exhaustion
  // attestation (same modal + fail-closed gate as the dispute page);
  // final_notice goes direct with the prior letter's LOCAL send date
  // (sent_at preferred — the dispute page's filed_date proxy predates the
  // date rule); debt_validation reuses the collector capture. Declared after
  // railTimeline (it reads the letters).
  const handleRailStartNextLetter = (disputeId: string, targetLetterType: string) => {
    setRailActionError(null);
    if (targetLetterType === "external_review") {
      setRailExhaustionFromDisputeId(disputeId);
      return;
    }
    if (targetLetterType === "debt_validation") {
      setRailCollectorFromDisputeId(disputeId);
      return;
    }
    if (targetLetterType === "final_notice") {
      // S300 (Item N) — was: one client-derived date (this letter's latest
      // send). The recital is now derived server-side from the case ledger, so
      // the Final Notice recites EVERY genuine prior contact, not just the
      // last one, and the browser can't shape what the letter asserts.
      void railEscalate(disputeId, "final_notice", { certifiedMail: true });
    }
  };

  // ── Guided Steps v1 (S297) ─────────────────────────────────────────────────
  const guidedOn = guidedStepsFlag.enabled;
  // Done rail-step collapse — steps 1-2 ONLY (step 3 "What you could save"
  // stays expanded as the signal of what the steps are for; step 4 is the
  // action hub holding the dispute cards + phone subflow — Andrew S297).
  const assumpBodyVisible = !(guidedOn && assumptionsDone && !assumpFullOpen);
  const svcBodyVisible = !(guidedOn && isFlagged && svcOk && !svcFullOpen);

  // ── Parallel letter tracks (S305) ─────────────────────────────────────────
  //
  // ONE derivation of "what does this bill warrant", read by the guided track,
  // the create step, and the rung offers below. It used to be two calls to the
  // dominant-type hint from two places computing overlapping answers off the
  // same inputs.
  // ONE walk of the bill's findings, for every consumer on this page: the
  // letter-type fallback, the guided track, the rung offers, the create step's
  // own render gate, and the phone scripts' finding list. It used to be three
  // walks applying the same two rules (live, and actionable) to the same lines.
  const disputeEntries = collectDisputeEntries(
    primaryLineItems,
    visibleClaimLevelFindings,
    showDismissed,
  );
  const findingTypes = [
    ...disputeEntries.lineEntries.map((e) => e.finding.type),
    ...disputeEntries.claimActionable.map((f) => f.type),
    ...disputeEntries.gapEntries.map((e) => e.finding.type),
  ];
  // "Is there anything on this bill to contest?" — the same count
  // BulkDisputeButton short-circuits on, now that both read the shared builder.
  // The create step is gated on it too: a "Recover $X" panel wrapping a button
  // that returns null is a promise with no door behind it.
  const hasContestableCharges = findingTypes.length > 0;
  // The cost-share engine's per-line verdict — "the insurer assigned you MORE
  // than the plan says". Plan math, not a finding, which is why a claim can
  // warrant an appeal with zero audit findings against it. Absent when
  // recovery_cost_share_v2 is OFF, so flag-off derives no insurer track.
  const insurerUnderpaid = primaryLineItems.some(
    (li) => (li.insurerDiscrepancy?.delta ?? 0) > 0,
  );
  const letterTracks = deriveLetterTracks({
    findingTypes,
    insurerUnderpaid,
    // S309 F17 — paid above the charge raises the PROVIDER track the same way
    // insurerUnderpaid raises the insurer one (engine math, not a finding).
    providerOverpaid: overpaidToProvider >= 1,
  });
  // Which parties already have a letter. Collector letters count as the
  // provider track (the same fold `guidedTrack` has always applied): a
  // debt-validation letter means that track is already in flight, and offering
  // to start it again would put two doors on one act.
  const partiesWithLetters = new Set<LetterTrack["party"]>(
    data.disputes
      .filter((d) => d.status !== "cancelled")
      .map((d) => (letterRecipientKind(d.dispute_type) === "insurer" ? "insurer" : "provider")),
  );

  // The single letter the create step drafts when no track derives — today's
  // behaviour, unchanged, and the reason returning EMPTY is load-bearing.
  // ONE call: the guided track reads this rather than re-running the heuristic,
  // so the track the phone scripts speak in and the letter the button drafts
  // are the same decision, not two that happen to agree.
  const fallbackLetterType = letterTypeHintFromTypes(findingTypes);

  // Track-awareness (§4.5): drafted → the letter's own recipient is the page's
  // signal; undrafted → the first warranted track, falling back to the
  // dominant-type hint when no party is obligated (the common case — a
  // benchmark overcharge obligates nobody).
  const guidedTrack: "insurer" | "provider" = (() => {
    const active = data.disputes.find((d) => d.status !== "cancelled");
    if (active) {
      return letterRecipientKind(active.dispute_type) === "insurer" ? "insurer" : "provider";
    }
    if (letterTracks.length > 0) return letterTracks[0].party;
    return letterRecipientKind(fallbackLetterType) === "insurer" ? "insurer" : "provider";
  })();

  // Fill context — a projection of values ALREADY rendered on this page
  // (§4.4: consume, never re-derive). null = not on file; scripts degrade to
  // the prep-chip path, never invented values.
  const guidedCtx: GuideFillContext | null = (() => {
    if (!guidedOn || !isFlagged) return null;
    const meta = (claim.metadata as Record<string, unknown>) ?? {};
    const patient = (meta.patient as Record<string, unknown> | undefined) ?? {};
    const provider = (meta.provider as Record<string, unknown> | undefined) ?? {};
    const firstCovered = primaryLineItems.find((li) => li.planCoverage != null) ?? null;
    const dosMonthDay = fmtDateMonthDayUTC((claim.date_of_service as string | null) ?? null);
    const findings: GuideFinding[] = [];
    // The SAME line-level findings the dispute bundle contests (S305) — the
    // phone scripts must never name a charge the letter would not. This walked
    // the lines itself with a byte-identical copy of the live/actionable rules.
    const lineById = new Map(primaryLineItems.map((li) => [li.id, li]));
    for (const e of disputeEntries.lineEntries) {
      findings.push({
        type: e.finding.type,
        lineNumber: e.lineNumber ?? null,
        dateLabel: dosMonthDay,
        serviceNoun: lineById.get(e.lineItemId)?.description?.toLowerCase() ?? null,
        parentLabel: null,
      });
    }
    const rawClaimNumber =
      (claim.external_claim_number as string | null | undefined) ??
      (meta.external_claim_number as string | undefined) ??
      (meta.claim_number as string | undefined);
    return {
      track: guidedTrack,
      serviceLabel: primaryLineItems[0]?.description ?? null,
      dosLong: fmtDateLongUTC((claim.date_of_service as string | null) ?? null),
      providerName: providerName !== "Unknown Provider" ? providerName : null,
      billedAmount: billTotals.billed > 0 ? billTotals.billed : null,
      planVerdictLabel:
        firstCovered != null ? spokenPlanSays(buildPlanSays(firstCovered.planCoverage)) : null,
      insurerPaid: data.effectiveTotals ? billTotals.insurancePaid : null,
      patientPaid: data.effectiveTotals ? billTotals.patientPaid : null,
      accountNumber:
        typeof patient.accountNumber === "string" && patient.accountNumber
          ? patient.accountNumber
          : null,
      claimNumber: typeof rawClaimNumber === "string" && rawClaimNumber ? rawClaimNumber : null,
      // insurance_plans.member_id doesn't ride this payload today — dashed
      // prep chip, honestly absent (§4.4: verify before claiming; it isn't here).
      memberIdOnFile: false,
      planNameOnFile: pinnedPlan != null,
      providerPhone: typeof provider.phone === "string" && provider.phone ? provider.phone : null,
      // No schema field holds a member-services number today — chip path.
      memberServicesPhone: null,
      findings,
      flaggedCount: flaggedLineCount,
      flaggedTotal: billTotals.potentialRecovery >= 1 ? billTotals.potentialRecovery : null,
    };
  })();

  // S303 — ONE composition for the whole rail. ClaimDetail used to compute the
  // fold from `letters` alone while CaseRail separately composed the groups, so
  // the same rail was built TWICE per render from the same inputs — and the
  // fold, never seeing the steps, could collapse a case whose steps were still
  // asking (Andrew: "it was collapsed on reload even though steps 7, 14 and 17
  // are open"). `groups` now goes down to CaseRail, and the summary counts the
  // very steps it is folding.
  //
  // Placed here, after `guidedCtx`, because badge numbering reads it: the rail
  // starts at 5 behind the guided phone step, and at railStepRecover without it.
  const guideStepsMeta =
    ((claim.metadata as Record<string, unknown>)?.guideSteps as
      | Record<string, GuideStepState>
      | undefined) ?? {};

  // S305 — the letters this claim is OWED but has not written: an obligated
  // party with no letter of its own yet.
  //
  // ⚠ Gated on the FLAG, not on `railTimeline != null`. The projection is
  // absent for a claim with no letters — `loadCaseProjection` returns null
  // before the first one, honestly, since there is no case timeline yet — and
  // that is exactly the claim whose offer matters most. Using its presence as a
  // proxy for "the rail is on" would have made this feature dead on every fresh
  // bill while working perfectly on the one test claim that happens to carry a
  // letter. The offer needs nothing from the projection anyway.
  //
  // Also gated on there being something to contest: the draft action is
  // BulkDisputeButton, which returns null with nothing in the bundle, and an
  // offer with no way to accept it is worse than no offer.
  const railOffers: RailLetterOffer[] =
    isFlagged && caseRailFlag.enabled && hasContestableCharges
      ? letterTracks
          .filter((t) => !partiesWithLetters.has(t.party))
          .map((t) => {
            // The finding that obligates THIS party, in its own words. Claim-level
            // only: a per-line finding already renders against its line in the
            // table, and lifting it into the rung would say it twice.
            const reason =
              visibleClaimLevelFindings.find(
                (f) =>
                  !f.dismissed &&
                  f.actionable &&
                  deriveLetterTracks({ findingTypes: [f.type], insurerUnderpaid: false }).some(
                    (x) => x.party === t.party,
                  ),
              ) ?? null;
            // S309 F1-B (Andrew-approved) — an insurer-track offer raised by the
            // cost-share ENGINE has no finding to speak for it; say the engine's
            // own reason from the live totals instead of leaving the card mute.
            // Provider-track engine-raised offers keep null (no approved copy).
            const engineReason =
              !reason && t.party === "insurer" && billTotals.potentialRecovery >= 1
                ? {
                    title: null,
                    detail: `Your plan puts your share around $${fmtMoney(billTotals.shouldOwe)}, but this bill charges you $${fmtMoney(billTotals.shouldOwe + billTotals.potentialRecovery)} — the appeal asks for the $${fmtMoney(billTotals.potentialRecovery)} difference.`,
                  }
                : // S309 F17 — the overpayment-raised provider track speaks the
                  // engine's reason too (the F1-B pattern, live numbers).
                  !reason && t.party === "provider" && overpaidToProvider >= 1
                  ? {
                      title: null,
                      detail: `You paid $${fmtMoney(overpaidToProvider)} more than this bill charged — this letter asks the provider to refund it.`,
                    }
                  : null;
            return {
              party: t.party,
              letterType: t.letterType,
              reason: reason
                ? { title: reason.title, detail: reason.description ?? null }
                : engineReason,
              declinedAt: guideStepsMeta[letterOfferSkipStepId(t.party)]?.skippedAt ?? null,
            };
          })
      : [];

  const railComposed =
    isFlagged && (railTimeline != null || railOffers.length > 0)
      ? composeRail({
          letters: railTimeline?.letters ?? [],
          // The projection's own zero value when the case has not started.
          // Provably inert here: `regulator` is read only inside a letter's
          // steps, and this branch supplies it only when there are none.
          regulator: railTimeline?.regulator ?? EMPTY_PROJECTED_REGULATOR,
          offers: railOffers,
          firstNumber: guidedCtx ? 5 : railStepRecover,
          insurerNameByDispute: railTimeline?.insurerNameByDispute ?? {},
          providerName: providerName === "Unknown Provider" ? null : providerName,
          // Client clock — calendars are the user's timezone (letter-type.ts rule).
          now: new Date(),
        })
      : null;
  const railResolution = railComposed?.resolution ?? null;
  const caseFolded = railResolution != null && !caseExpanded;
  // S305 — did the case END badly? The same predicate the regulator card keys
  // on (S303), so "the case is over and it went against you" means one thing on
  // this page. A case that resolved in the user's favour still gets its Case
  // File; it just isn't the primary thing left to do.
  const caseEndedAdversely =
    railResolution != null &&
    (railTimeline?.letters ?? []).some(
      (l) => l.outcome != null && isAdverseOutcome(l.outcome.detail),
    );
  // The block's meta line. Counts what the case actually holds; the copy omits
  // whatever is zero rather than printing "0 calls".
  const caseFileLetterCount = (railTimeline?.letters ?? []).filter(
    (l) => l.latestSendAt != null,
  ).length;
  const caseFileCallCount = guidedCallLogFromMeta(guideStepsMeta).length;
  const caseFileUpdatedLabel = (() => {
    const stamps = [
      ...(railTimeline?.letters ?? []).flatMap((l) => [l.latestSendAt, l.outcome?.loggedAt]),
      ...(railTimeline?.regulator.filings ?? []).map((f) => f.filedAt),
    ].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (stamps.length === 0) return null;
    return fmtRailDate(stamps.sort().at(-1)!);
  })();
  // S305 — ONE predicate for "the rail owns the letter step", read by 4b's
  // gate, the phone step's 4-vs-4a badge, and the flag-OFF recover gate. A
  // letter the claim is OWED takes that step onto the rail exactly as a letter
  // that exists does; leaving 4b up beside it would put two doors on one act.
  const railExtends = railHasExtension({
    letters: railTimeline?.letters ?? [],
    offers: railOffers,
  });
  // 4a/4b split — pack state for the rail chrome (done pill / resolved chip /
  // skipped) and 4b's activation. Live component state wins once it emits.
  const guidedPack = guidedPackLive ?? derivePhonePackState(guidedTrack, guideStepsMeta);
  const guidedOutcomeDateLabel =
    guidedPack.outcomeAt != null ? fmtStampDateLocal(guidedPack.outcomeAt) : null;

  // Provider-track step-1 CTA — mirrors the legacy RequestItemizedBill flow on
  // /disputes (Case-2 generate: no findings, no persistence), prefilled from
  // this bill's own payload instead of an empty form.
  const requestItemizedLetter = async () => {
    const meta = (claim.metadata as Record<string, unknown>) ?? {};
    const patient = (meta.patient as Record<string, unknown> | undefined) ?? {};
    try {
      const res = await fetch("/api/disputes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientName: typeof patient.name === "string" ? patient.name : "",
          providerName: providerName === "Unknown Provider" ? "" : providerName,
          serviceDate: (claim.date_of_service as string | null) ?? "",
          accountNumber: typeof patient.accountNumber === "string" ? patient.accountNumber : "",
          type: "itemized_request",
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(typeof d?.error === "string" ? d.error : "generate failed");
      window.location.href = disputeUrlForResult(d);
    } catch {
      alert("Failed to generate letter. Please try again.");
    }
  };

  // Disputes list — step 4 body on flagged bills, bottom "Disputes" section
  // otherwise. Defined once so both placements render identically.
  const disputesListNodeFor = (list: ClaimData["disputes"]) =>
    list.length > 0 ? (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Disputes</h3>
          <div className="space-y-2">
            {list.map((d) => (
              <DisputeRow
                key={d.id}
                dispute={d}
                provider={providerName}
                recovery={billTotals.potentialRecovery}
                hasCostShare={!!data.costShareBill}
                sent={
                  railTimeline?.letters.find((l) => l.disputeId === d.id)?.latestSendAt != null
                }
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
  const disputesListNode = disputesListNodeFor(data.disputes);

  // Step-4 recover panel + drafted cards — ONE builder for the flag-OFF step 4
  // AND the guided 4b (S297). muted=true is 4b's inactive treatment (white bg,
  // greyed button) until the phone question concludes "Not yet"/skip — the
  // button STAYS clickable per the locked contract §3.6 (the pack never blocks
  // letter generation); muted=false emits today's classes byte-identically.
  //
  // S302 — the S299 primary-only filter is GONE with the caller that needed it.
  // Both mount sites now render only while `!railExtends`, i.e. only while no
  // letter exists, so the drafted-cards branch is reachable exclusively with the
  // rail OFF — where the full list is the correct, byte-identical behaviour.
  const recoverBranchNode = (muted: boolean) =>
    data.disputes.length > 0 ? (
      disputesListNode
    ) : (
      <div className={`mb-4 flex flex-col gap-4 rounded-[18px] border ${muted ? "border-gray-200 bg-white" : "border-blue-200 bg-gradient-to-br from-blue-50 to-white"} px-6 py-5 sm:-ml-[43px] sm:flex-row sm:items-center sm:justify-between`}>
        <div className="max-w-[50ch] text-[13px] leading-[1.55] text-gray-600">
          <div className={`mb-1.5 flex items-center gap-1.5 text-sm font-bold ${muted ? "text-gray-700" : "text-blue-900"}`}>
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
            letterType={fallbackLetterType}
            getAuthToken={getAuthToken}
            onGenerated={(result) => router.push(disputeUrlForResult(result))}
            existingDisputeId={data.disputes.find((d) => d.status !== "cancelled")?.id ?? null}
            muted={muted}
          anonymousDraftGate={anonymousDraftGate}
            />
        </div>
      </div>
    );

  // S305 — the draft control for a parallel-track offer. The SAME button, told
  // which letter to write; the rail supplies the letter type it composed, so
  // the rung's title and the letter it drafts cannot describe different things.
  // `existingDisputeId` is deliberately null: an offer exists precisely because
  // this track has no letter, and passing the OTHER track's dispute would turn
  // the button into "Open dispute letter" pointing at the wrong one.
  const renderOfferAction = (letterType: string) => (
    <BulkDisputeButton
      claimId={claimId}
      claim={claim}
      primaryLineItems={primaryLineItems}
      claimLevelFindings={visibleClaimLevelFindings}
      showDismissed={showDismissed}
      letterType={letterType}
      getAuthToken={getAuthToken}
      onGenerated={(result) => router.push(disputeUrlForResult(result))}
      existingDisputeId={null}
    anonymousDraftGate={anonymousDraftGate}
      />
  );

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
          {providerNameEdit ? (
            /* S310 (F14a) — inline provider-name editor; Save writes the one
               claim-scoped provider-contact path and refetches. */
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <input
                type="text"
                value={providerNameEdit.value}
                onChange={(e) => setProviderNameEdit((p) => (p ? { ...p, value: e.target.value } : p))}
                aria-label="Provider name"
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-[18px] font-semibold text-gray-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              <button
                type="button"
                disabled={providerNameEdit.value.trim().length === 0}
                onClick={() => {
                  const v = providerNameEdit.value.trim();
                  if (!v) return;
                  // Optimistic: close now; saveProviderName snaps back on failure.
                  setProviderNameEdit(null);
                  saveProviderName(v);
                }}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setProviderNameEdit(null)}
                className="text-[13px] font-medium text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              {providerNameEdit.error ? (
                <span className="w-full text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
              ) : null}
            </span>
          ) : (
            <>
              <h1 className="m-0 text-[28px] font-bold leading-tight tracking-[-0.02em] text-gray-900">
                {providerName}
              </h1>
              {/* S310 (F14a) — the rail-side provider-name edit Andrew asked
                  for; same icon-button chrome as the view-bill control. */}
              <button
                type="button"
                onClick={() =>
                  setProviderNameEdit({
                    value: providerName === "Unknown Provider" ? "" : providerName,
                    error: false,
                  })
                }
                className="grid h-9 w-9 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-600"
                title="Edit provider name"
                aria-label="Edit provider name"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
            </>
          )}
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
          {/* S299 — case-header waiting chip (§0.9a rule 2d: count + soonest
              clock, projector-derived, never stored). */}
          {railTimeline != null && railTimeline.waitingCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-[3px] text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-300">
              {CASE_RAIL.headerChip(
                railTimeline.waitingCount,
                railTimeline.soonestResponseDue
                  ? fmtRailDate(railTimeline.soonestResponseDue.date)
                  : null,
              )}
            </span>
          )}
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

      {/* S305 (Andrew) — the "Claim-level issues" banner is GONE. The finding it
          existed to show is now the REASON on its own rail rung, where the user
          can act on it; carrying it twice on one page was the duplication he
          called out. Skip on the rung replaces Dismiss: "I'm not writing this
          letter" is the answer that matters here, and it stays visible and
          reversible instead of hiding the finding.
          ⚠ A claim-level finding that obligates NO party would now render
          nowhere. Only `unallocated_balance` is emitted claim-level today
          (claim-header-arithmetic.ts) and it obligates the provider, so the
          case is unreachable — but a new claim-level rule must come with a
          rung, or it will be invisible. */}

      {/* S302 — the resolved fold, ABOVE the rail it collapses. */}
      {railResolution && (
        <CaseResolvedFold
          resolution={railResolution}
          expanded={caseExpanded}
          onToggle={() => setCaseExpanded((v) => !v)}
        />
      )}
      {/* `display:contents` when open, so the wrapper is layout-invisible and
          the rail's spacing is byte-identical to before; `hidden` when folded.
          HIDDEN, not unmounted — the same idiom 4a's body uses, so expanding
          restores every step with its state (§2.2: expanded steps stay
          interactive, and nothing here is a one-way collapse). */}
      <div className={caseFolded ? "hidden" : "contents"}>
      {/* ── Surface 3 (clarity redesign): flagged bills use a numbered guided
          step rail. S291 (Andrew) re-ordered it to confirm-then-reveal —
          1 Verify our assumptions (Cost-Share rows) · 2 Verify the services
          (the line-items table) · 3 What you could save (recovery bar, with the
          plan-vs-bill diff collapsed behind "Show the math") · 4 Recover the
          money. The savings number is DERIVED from steps 1-2, so it now lands
          after the user has confirmed the inputs rather than before.
          Clean/needs-review states keep the classic table-first order. */}
      {isFlagged && (
        <div className="mt-6">
          {railHasAssumptions && data.costShareBill && (
            <RailStep
              n={1}
              done={assumptionsDone}
              attention={assumptionsAttention}
              title="Verify our assumptions"
              sub="The savings math relies on these following details. Please verify or correct each line as needed."
              right={
                guidedOn && assumptionsDone ? (
                  <ShowFullStepButton
                    open={assumpFullOpen}
                    onToggle={() => setAssumpFullOpen((v) => !v)}
                  />
                ) : undefined
              }
            >
              {/* S297 — done steps collapse to their header (Show full step). */}
              {/* S308 (Andrew) — the collapsed step still offers the way in:
                  "Update assumptions" expands the step AND un-collapses the
                  card in one gesture (two vectors to the same place). */}
              {!assumpBodyVisible && (
                <div className="rounded-2xl border border-gray-200 bg-white px-5 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      setAssumpFullOpen(true);
                      setAssumpExpandSignal((n) => n + 1);
                      void submitCostShareOverride({ field: "assumptions_reviewed", reviewed: false }, "assumptions_reviewed");
                    }}
                    className="text-[13px] font-medium text-blue-600 hover:text-blue-800"
                  >
                    Update assumptions
                  </button>
                </div>
              )}
              {assumpBodyVisible && (
              <CostShareBanner
                variant="assumptions"
                verdict={data.costShareBill.verdict}
                assumptions={bannerAssumptions}
                overrides={effectiveCostShareOverrides}
                recoverable={billTotals.potentialRecovery}
                correctShare={billTotals.shouldOwe}
                charged={billTotals.shouldOwe + billTotals.potentialRecovery}
                fmtMoney={fmtMoney}
                onOverride={submitCostShareOverride}
                onConfirmDefaults={confirmAssumptionDefaults}
                onOptimistic={(patch) => setAssumptionOptimistic((prev) => ({ ...prev, ...patch }))}
                pendingFields={assumptionsPendingFields}
                estimateRows={estimateRateRows}
                onConfirmEstimate={handleConfirmCoverage}
                confirmingEstimateId={confirmingCoverageId}
                totalsSource={totalsSourceRow}
                planIdentity={
                  planCandidates
                    ? {
                        label: planIdentityLabel,
                        year: claimServiceYear,
                        planYearMismatch,
                        onChange: () => setRepinOpen(true),
                        // S310 (F14a) — insurer-name fix on the pinned-plan row.
                        insurerName: pinnedInsurerName,
                        onSaveInsurerName: saveInsurerName,
                      }
                    : null
                }
                acaDismissed={acaDismissed}
                onAcaDismissedChange={setAcaDismissed}
                flagUnanswered={assumptionsEngaged}
                pendingKey={csOverridePending}
                errorMsg={csOverrideError}
                onShouldBeCovered={() => bannerTargetLineId && openCorrectionModal(bannerTargetLineId)}
                onAddPlanDetails={(target) => {
                  // S290 — honor the clicked chip: its lineId first, then a slug
                  // lookup, then the legacy bannerTargetLineId fallback. Fixes the
                  // answer landing under a DIFFERENT line's service.
                  const line =
                    (target?.lineId ? primaryLineItems.find((li) => li.id === target.lineId) : null) ??
                    (target?.serviceSlug
                      ? primaryLineItems.find((li) => li.service_slug === target.serviceSlug)
                      : null) ??
                    (bannerTargetLineId
                      ? primaryLineItems.find((li) => li.id === bannerTargetLineId)
                      : null);
                  if (line?.service_slug) setAddPlanDetailsLineId(line.id);
                  else if (bannerTargetLineId) openCorrectionModal(bannerTargetLineId);
                }}
                statedServiceCosts={statedServiceCosts}
                // S309 (Andrew's toggle report) — on the GUIDED rail this body
                // only renders when review isn't done OR the user explicitly
                // expanded the step ("Show full step"); mounting the card
                // collapsed made both toggle states render the same
                // "Update assumptions" box (an expandSignal bump can't help — a
                // fresh mount initializes lastExpandSignal to the incoming value
                // and swallows it). Guided ⇒ seed OPEN; the persisted collapse
                // still shows as the collapsed STEP (assumpFullOpen defaults
                // false), so 1.3.13 reload-persistence is untouched. The
                // non-guided site below keeps the metadata seed — there the
                // card's own collapse IS the persistence surface.
                initiallyReviewed={guidedOn ? false : !!(claim.metadata as Record<string, unknown> | null)?.assumptionsReviewedAt}
                expandSignal={assumpExpandSignal}
                onUploadEob={() => router.push("/upload?type=eob")}
                onBack={onBack}
              />
              )}
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
                      const opening = !svcIssue;
                      setSvcIssue(opening);
                      // S292 — flagging a problem must actually UN-confirm on the
                      // server. `svcOk` feeds `assumptionsEngaged` and the rail's
                      // done state, so a local-only false would let a bill the
                      // user just flagged still read complete — and "Confirmed"
                      // would reappear on the next load. It is also the flywheel
                      // signal: a WITHDRAWN confirmation is human-verified
                      // evidence that the extracted service list is wrong, and
                      // it's only evidence if it's written down.
                      if (opening && svcOk) {
                        setSvcPendingConfirm(false);
                        void submitCostShareOverride(
                          { field: "services_confirmed", confirmed: false },
                          "services-confirmed",
                        ).finally(() => setSvcPendingConfirm(null));
                      }
                    }}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-[9px] text-[13px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    {svcIssue ? "Never mind" : "Something looks wrong"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const next = !svcOk;
                    // Instant feedback, then the server decides. On a failed
                    // write `submitCostShareOverride` skips the refetch, so
                    // clearing the target here snaps the button back to the
                    // truth instead of showing a save that never landed.
                    setSvcPendingConfirm(next);
                    setSvcIssue(false);
                    void submitCostShareOverride(
                      { field: "services_confirmed", confirmed: next },
                      "services-confirmed",
                    ).finally(() => setSvcPendingConfirm(null));
                  }}
                  className={
                    svcOk
                      ? "inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-[9px] text-[13px] font-semibold text-emerald-700"
                      : "inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700"
                  }
                >
                  {svcOk ? "Confirmed" : "All services and coverage look right"}
                  {svcOk && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                {/* S297 — done-step collapse control (body = the line-items
                    table below; hidden while collapsed). */}
                {guidedOn && svcOk && (
                  <ShowFullStepButton
                    open={svcFullOpen}
                    onToggle={() => setSvcFullOpen((v) => !v)}
                  />
                )}
              </div>
            }
          />
        </div>
      )}
      {/* S291 — plan-identity re-pin. Separate instance from the draft-time
          chooser (different component, different confirm); the modal is
          self-contained so two usages need no shared state. */}
      <DisputePlanChooser
        open={repinOpen}
        onClose={() => setRepinOpen(false)}
        plans={planCandidates ?? []}
        defaultPlanId={(claim.insurance_plan_id as string | null) ?? null}
        serviceDate={(claim.date_of_service as string) || null}
        year={claimServiceYear}
        eyebrow="Plan we checked against"
        title="Which plan were you on?"
        confirmLabel="Use this plan"
        // S291 (Andrew) — when no plan covers the bill's year there is nothing
        // to pick, so "choose one" is a dead end. The chooser's existing
        // search-or-upload affordance is the way out; it was simply never wired
        // on this path.
        onSearchLibrary={() => {
          setRepinOpen(false);
          router.push("/upload?type=plan");
        }}
        onConfirm={(id) => {
          setRepinOpen(false);
          // Re-pinning changes which coverage the audit reads, so the claim is
          // refetched and the verdict recomputed — same path as any other
          // assumption correction.
          void submitCostShareOverride({ field: "claim_plan", insurancePlanId: id }, "claim-plan");
        }}
      />

      {/* Cost-Share v2 (W2+W3) — the §5 verdict + assumptions card. One per bill.
          S290 (Andrew E2E #6): moved ABOVE the line table, below the bill
          header — the questions gate the math, so they come first. Carries the
          verdict + Verified stamp itself, so it replaces the legacy
          CleanBody/ReviewBody when the flag is ON; OFF → absent → today's UI. */}
      {data.costShareBill && !isFlagged && (
        <CostShareBanner
          verdict={data.costShareBill.verdict}
          assumptions={bannerAssumptions}
          overrides={effectiveCostShareOverrides}
          recoverable={billTotals.potentialRecovery}
          correctShare={billTotals.shouldOwe}
          charged={billTotals.shouldOwe + billTotals.potentialRecovery}
          fmtMoney={fmtMoney}
          onOverride={submitCostShareOverride}
                onConfirmDefaults={confirmAssumptionDefaults}
                onOptimistic={(patch) => setAssumptionOptimistic((prev) => ({ ...prev, ...patch }))}
                pendingFields={assumptionsPendingFields}
                estimateRows={estimateRateRows}
                onConfirmEstimate={handleConfirmCoverage}
                confirmingEstimateId={confirmingCoverageId}
                planIdentity={
                  planCandidates
                    ? {
                        label: planIdentityLabel,
                        year: claimServiceYear,
                        planYearMismatch,
                        onChange: () => setRepinOpen(true),
                        // S310 (F14a) — insurer-name fix on the pinned-plan row.
                        insurerName: pinnedInsurerName,
                        onSaveInsurerName: saveInsurerName,
                      }
                    : null
                }
                acaDismissed={acaDismissed}
                onAcaDismissedChange={setAcaDismissed}
                flagUnanswered={assumptionsEngaged}
          pendingKey={csOverridePending}
          errorMsg={csOverrideError}
          onShouldBeCovered={() => bannerTargetLineId && openCorrectionModal(bannerTargetLineId)}
          onAddPlanDetails={(target) => {
            // S290 — honor the clicked chip: its lineId first, then a slug
            // lookup, then the legacy bannerTargetLineId fallback. Fixes the
            // answer landing under a DIFFERENT line's service.
            const line =
              (target?.lineId ? primaryLineItems.find((li) => li.id === target.lineId) : null) ??
              (target?.serviceSlug
                ? primaryLineItems.find((li) => li.service_slug === target.serviceSlug)
                : null) ??
              (bannerTargetLineId
                ? primaryLineItems.find((li) => li.id === bannerTargetLineId)
                : null);
            if (line?.service_slug) setAddPlanDetailsLineId(line.id);
            else if (bannerTargetLineId) openCorrectionModal(bannerTargetLineId);
          }}
          statedServiceCosts={statedServiceCosts}
          initiallyReviewed={!!(claim.metadata as Record<string, unknown> | null)?.assumptionsReviewedAt}
          onUploadEob={() => router.push("/upload?type=eob")}
          onBack={onBack}
        />
      )}

      {/* Step-3 body wrapper — indents the line-items table into the rail on
          flagged bills; a no-op pair of divs otherwise. */}
      <div className={isFlagged ? "relative pb-[30px]" : undefined}>
        {isFlagged && (
          <span className="absolute -top-4 bottom-1 left-[14px] hidden w-[1.5px] bg-gray-200 sm:block" aria-hidden />
        )}
        {/* S297 — step-2 body: hidden while the done step is collapsed (the
            outer wrapper + connector stay, keeping the rail continuous). */}
        {svcBodyVisible && (
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
            + gap-2 (8px × 7 = 56px) + 504px fixed = 560px + ~168px flex.
            S292 (#4): Billed col 64px → 88px ("Billed to you" header + the
            "$X before insurance" sub-line need the room; Service flex absorbs). */}
        <div
          className="hidden lg:grid gap-2 items-center px-5 py-3 bg-gray-50 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.06em] border-b border-gray-100"
          style={{
            gridTemplateColumns: isMultiLine
              ? "minmax(0, 1.5fr) 56px 88px 64px 64px 72px 80px 112px 40px"
              : "minmax(0, 1.5fr) 56px 88px 64px 64px 72px 80px 112px",
          }}
        >
          <div className="min-w-0">Service</div>
          <div className="min-w-0">Code</div>
          {/* S292 (#4) — "Billed to you": what the patient was actually asked
              to pay after adjudication, not the provider's gross charge. */}
          <div
            className="text-right"
            title="What you were actually asked to pay after your insurer's adjustments and payments."
          >
            Billed to you
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
          // S292 (#4) — `billedDisplay` still feeds LineDrawer + the OVERCHARGE
          // pill calc; the visible column now leads with `billedToYou` below.
          const billedDisplay = item.adjustedBilled ?? billed;
          // S292 (#4) — BILLED TO YOU column value: billed − insurer adjustment
          // − insurer payment (server-resolved, clamped ≥ $0). Legacy payloads
          // without the field fall back to today's display with no sub-line.
          const billedToYou = item.billedToYou ?? {
            value: billedDisplay,
            gross: billed,
            showBeforeInsurance: false,
          };
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
          // S309 F2 — the PLAN-SAYS sub-line, from the SAME derivation the
          // "What you could save" strip renders (one wording source; null when
          // the savings flag is OFF or the line is unpriced/not-covered).
          const planSaysCell =
            savingsDerivation?.rows.find((r) => r.id === item.id)?.planTermCell ?? null;
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
                  {/* S292 (#4) — mobile mirror of the desktop BILLED TO YOU
                      column (same server-resolved value + gross sub-line). */}
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Billed to you</dt>
                    <dd className="text-right">
                      <div className="tabular-nums text-gray-900">${fmtMoney(billedToYou.value)}</div>
                      {billedToYou.showBeforeInsurance && (
                        <div className="text-[10px] leading-tight text-gray-400 tabular-nums">
                          ${fmtMoney(billedToYou.gross)} before insurance
                        </div>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">You paid</dt>
                    <dd className="tabular-nums text-gray-600">${fmtMoney(paid)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 uppercase tracking-wider">Plan says</dt>
                    <dd className="text-right">
                      <div className={`tabular-nums font-semibold ${shouldOwe === 0 ? "text-green-700" : "text-gray-900"}`}>${fmtMoney(shouldOwe)}</div>
                      {planSaysCell && (
                        <div className="mt-0.5 text-[10px] leading-tight text-gray-400">{planSaysCell}</div>
                      )}
                    </dd>
                  </div>
                  {/* B4.2: "You owe" mobile row DROPPED per Open Q A lock. */}
                  {/* B4.2: Recovery + Forgiveness rows render only when value
                      ≥ 1 — keeps mobile card lean. Both rendered when both
                      apply (mixed-pay cases). */}
                  {refundComponent >= 1 && (
                    <div className="flex justify-between gap-3">
                      <dt className="uppercase tracking-wider text-green-700">Recovery</dt>
                      <dd className="tabular-nums font-bold text-green-700">+${fmtMoney(refundComponent)}</dd>
                    </div>
                  )}
                  {forgivenessComponent >= 1 && (
                    <div className="flex justify-between gap-3">
                      <dt className="uppercase tracking-wider text-green-700">Forgiveness</dt>
                      <dd className="tabular-nums font-bold text-green-700">${fmtMoney(forgivenessComponent)}</dd>
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
              {/* Desktop table row — hidden at mobile. S297 (Andrew E2E #3) —
                  items-start, not items-center: the "$X before insurance"
                  sub-line under Billed-to-you was re-centering its cell and
                  floating the dollar above the row's other numbers. First-line
                  alignment keeps every number on one line; the sub-line just
                  grows the row down. */}
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
                className={`hidden lg:grid w-full gap-2 items-start px-5 py-3.5 text-left transition-colors border-t border-gray-100 cursor-pointer ${isMultiLine && isExpanded ? "bg-blue-50/40 hover:bg-blue-50/60" : "hover:bg-gray-50"}`}
                style={{
                  gridTemplateColumns: isMultiLine
                    ? "minmax(0, 1.5fr) 56px 88px 64px 64px 72px 80px 112px 40px"
                    : "minmax(0, 1.5fr) 56px 88px 64px 64px 72px 80px 112px",
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
                {/* S292 (#4) — BILLED TO YOU column: what the patient was
                    actually asked to pay after the insurer's negotiated
                    adjustment + payment (server-resolved; same proportional-
                    split method as YOU PAID, different inputs). Sub-line
                    surfaces the gross charge when insurer data moved the
                    number; bills with no insurer data show the gross alone
                    (honesty fallback — never an invented adjustment). This is
                    a SEPARATE fact from YOU PAID (money actually paid so far)
                    — on a fresh unpaid bill the two legitimately disagree. */}
                <div
                  className="text-right"
                  title={
                    billedToYou.showBeforeInsurance
                      ? `Provider billed $${fmtMoney(billedToYou.gross)}; after your insurer's adjustments and payments, $${fmtMoney(billedToYou.value)} was billed to you.`
                      : `$${fmtMoney(billedToYou.gross)} billed.`
                  }
                >
                  <div className="text-sm font-semibold text-gray-700 tabular-nums whitespace-nowrap">
                    ${fmtMoney(billedToYou.value)}
                  </div>
                  {billedToYou.showBeforeInsurance && (
                    <div className="mt-0.5 text-[10px] leading-tight text-gray-400 tabular-nums">
                      ${fmtMoney(billedToYou.gross)} before insurance
                    </div>
                  )}
                </div>
                <div className="text-sm font-semibold text-gray-700 text-right tabular-nums whitespace-nowrap">
                  ${fmtMoney(paid)}
                </div>
                {/* Plan says — what your plan says you should owe. S309 F2: the
                    sub-line states the rate AND why it isn't applying, from the
                    same derivation as the savings strip. */}
                <div
                  className="text-right"
                  title={`Per your plan, you should owe $${fmtMoney(shouldOwe)} for this service.`}
                >
                  <div className={`text-sm font-bold tabular-nums whitespace-nowrap ${shouldOwe === 0 ? "text-emerald-700" : "text-gray-900"}`}>
                    ${fmtMoney(shouldOwe)}
                  </div>
                  {planSaysCell && (
                    <div className="mt-0.5 text-[10px] leading-tight text-gray-400">
                      {planSaysCell}
                    </div>
                  )}
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
                        ? `Refund recoverable: $${fmtMoney(refundComponent)} — already paid out-of-pocket above your plan share.`
                        : "No refund recoverable — patient hasn't paid above plan share."
                  }
                >
                  {item.planCoverage == null ? (
                    <span className="text-gray-300">—</span>
                  ) : refundComponent >= 1 ? (
                    <span className="font-bold text-emerald-700">+${fmtMoney(refundComponent)}</span>
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
                        ? `Forgiveness due: $${fmtMoney(forgivenessComponent)} — provider must write off the amount above plan-allowed.`
                        : "No forgiveness due — bill is within plan-allowed."
                  }
                >
                  {item.planCoverage == null ? (
                    <span className="text-gray-300">—</span>
                  ) : forgivenessComponent >= 1 ? (
                    <span className="font-bold text-emerald-700">${fmtMoney(forgivenessComponent)}</span>
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
                    when both present, instead of overflowing the column into
                    the Forgiveness cell. whitespace-nowrap on each pill prevents
                    in-pill text wrap ("Your\npick").
                    S304 — flex-wrap alone was not enough and this recurred: it
                    wraps BETWEEN pills, but each pill is nowrap, and S154's
                    "Likely Covered" (~111px with its icon) and "Verify coverage"
                    (~103px) each exceed the old 88px track on their own, so a
                    single pill spilled left over FORGIVENESS. Two fixes, in
                    order of importance: `min-w-0` makes the cell a containment
                    boundary so overflow can NEVER escape into a money column
                    again whatever the label; the track widening to 112px (taken
                    from Service's 1.5fr) is what keeps today's labels on one
                    line. Containment first — sizing alone would just wait for
                    the next longer label. */}
                <div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5">
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
        )}{/* /S297 svcBodyVisible */}
      </div>{/* /step-3 body wrapper */}

      {isFlagged && (
        <RailStep
          n={railStepSave}
          // S297 (Andrew E2E) — any engagement PAST this step (a 4a attest/
          // answer/skip, or a drafted letter) greens it: you've seen the
          // number and moved on. Flag OFF keeps the drafted-only rule.
          done={
            hasDraftedDispute ||
            (guidedCtx != null && (guidedPack.done > 0 || guidedPack.concluded))
          }
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
                {heroSubs ? (
                  /* S310 — party-named subs decomposing the recovery total
                     (Andrew's approved copy); the derivation already nulls any
                     slice under $1, so every rendered span carries real money. */
                  heroSubs.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-gray-700">
                      {heroSubs.map((s, i) => (
                        <Fragment key={s}>
                          {i > 0 && <span className="h-[3px] w-[3px] rounded-full bg-gray-400" aria-hidden />}
                          <span>
                            <strong className="font-bold tabular-nums text-emerald-700">{s}</strong>
                          </span>
                        </Fragment>
                      ))}
                    </div>
                  )
                ) : (
                  (billTotals.refundComponent >= 1 || billTotals.forgivenessComponent >= 1) && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-gray-700">
                      {billTotals.refundComponent >= 1 && (
                        <span>
                          {/* S307 flag-off legacy spans (tense predates the derivation). */}
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
                  )
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
            {savingsDerivation ? (
              /* S307 flag — the plan card leads with the plan's PRICED answer
                 (never a worst-case ceiling headline, never a fabricated $0
                 floor); per-line answers below, unpriced lines bracketed with
                 the Confirm-your-rate ask (the existing AddPlanDetailsModal). */
              <>
                <div className="mt-0.5 flex items-baseline gap-2 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums text-emerald-800">
                  ${fmtMoney(savingsDerivation.pricedShouldOwe)}
                  <span className="text-[15px] font-medium text-gray-500">
                    {savingsDerivation.bigLabel}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-col">
                  {savingsDerivation.rows.map((row) => (
                    <div key={row.id} className="flex flex-col gap-1 border-b border-emerald-100 py-1.5 last:border-b-0">
                      <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 text-xs">
                        <span className="font-semibold text-gray-800">{row.label}</span>
                        <span
                          className={
                            row.unpriced
                              ? "text-[10.5px] font-extrabold uppercase tracking-[0.04em] text-red-600"
                              : "text-[11px] text-gray-500"
                          }
                        >
                          {row.planTerm}
                        </span>
                        <strong
                          className={`whitespace-nowrap text-right tabular-nums ${
                            row.unpriced
                              ? "text-[12px] font-semibold text-gray-800"
                              : "min-w-[72px] text-[13px] font-bold text-emerald-900"
                          }`}
                        >
                          {row.planAmountText}
                        </strong>
                      </div>
                      {row.cta && (
                        <button
                          type="button"
                          onClick={() => setAddPlanDetailsLineId(row.id)}
                          className="self-start rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
                        >
                          Confirm your rate →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {savingsDerivation.planPill && (
                  <div className="mt-1.5 self-start rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-bold text-emerald-700">
                    {savingsDerivation.planPill}
                  </div>
                )}
              </>
            ) : (
              <>
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
              </>
            )}
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
            {savingsDerivation?.bill.recoveryHeadline ? (
              /* S307 v7 — the bill card headlines the recovery; its math below
                 derives exactly this figure and sums on screen. */
              <div className="mt-0.5 flex items-baseline gap-2 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums text-emerald-700">
                +${fmtMoney(billTotals.potentialRecovery)}
                <span className="text-[15px] font-medium text-gray-500 whitespace-nowrap">potential recovery</span>
              </div>
            ) : (
              <div className="mt-0.5 flex items-baseline gap-2 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums text-red-800">
                ${fmtMoney(savingsDerivation ? savingsDerivation.bill.chargedToYou : billTotals.patientPaid)}
                <span className="text-[15px] font-medium text-gray-500 whitespace-nowrap">charged to you</span>
              </div>
            )}
            {savingsDerivation ? (
              /* S307 v7 — deliberate color semantics (Andrew): charged-to-you is
                 the one adversarial number (red); insurer-paid is context, not
                 harm (neutral); zero buckets recede (muted); wins pop (emerald).
                 Splits + equations come from the ONE derivation's bill model. */
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Adjusted total billed</span>
                  <strong className="font-semibold tabular-nums text-gray-900">
                    ${fmtMoney(billTotals.billedAdjusted)}
                  </strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Insurer paid</span>
                  <strong className="font-semibold tabular-nums text-gray-900">${fmtMoney(billTotals.insurancePaid)}</strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>Charged to you</span>
                  <strong className="font-semibold tabular-nums text-red-700">${fmtMoney(savingsDerivation.bill.chargedToYou)}</strong>
                </div>
                <div className="flex justify-between gap-3 text-xs text-gray-600">
                  <span>You paid</span>
                  <strong className={`font-semibold tabular-nums ${billTotals.patientPaid < 1 ? "text-gray-400" : "text-gray-900"}`}>
                    ${fmtMoney(billTotals.patientPaid)} OOP
                  </strong>
                </div>
                {savingsDerivation.bill.paidSplit && (
                  <>
                    <div className="mt-1 border-t border-red-200 pt-[6px] text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-gray-400">
                      {savingsDerivation.bill.paidSplit.divider}
                    </div>
                    <div className="flex flex-col gap-1.5 border-l-2 border-gray-100 pl-2.5">
                      <div className="flex justify-between gap-3 text-xs text-gray-600">
                        <span>Yours to pay under your plan</span>
                        <strong className="font-semibold tabular-nums text-gray-900">${fmtMoney(savingsDerivation.bill.paidSplit.yours)}</strong>
                      </div>
                      <div className="flex justify-between gap-3 text-xs">
                        <span className="font-semibold text-emerald-700">
                          Refund from your insurer
                          <span className="mt-0.5 block max-w-[220px] text-[11px] font-normal leading-snug text-gray-500">
                            Money you already paid that your plan says you didn&apos;t owe.
                          </span>
                        </span>
                        <strong className="font-bold tabular-nums text-emerald-700">+${fmtMoney(savingsDerivation.bill.paidSplit.refund)}</strong>
                      </div>
                      {/* S309 F17 (Andrew-approved copy) — the paid-above-charge
                          slice: the PROVIDER's refund, its own letter track. */}
                      {savingsDerivation.bill.paidSplit.overpaid >= 1 && (
                        <div className="flex justify-between gap-3 text-xs">
                          <span className="font-semibold text-emerald-700">
                            Overpaid to provider
                            <span className="mt-0.5 block max-w-[220px] text-[11px] font-normal leading-snug text-gray-500">
                              Money you paid above what this bill charged — the provider owes it back.
                            </span>
                          </span>
                          <strong className="font-bold tabular-nums text-emerald-700">+${fmtMoney(savingsDerivation.bill.paidSplit.overpaid)}</strong>
                        </div>
                      )}
                    </div>
                    <div className="self-start rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-bold text-emerald-700">
                      {savingsDerivation.bill.paidSplit.equation}
                    </div>
                  </>
                )}
                {savingsDerivation.bill.balanceSplit && (
                  <>
                    <div className="mt-1 border-t border-red-200 pt-[6px] text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-gray-400">
                      {savingsDerivation.bill.balanceSplit.divider}
                    </div>
                    <div className="flex flex-col gap-1.5 border-l-2 border-gray-100 pl-2.5">
                      <div className="flex justify-between gap-3 text-xs text-gray-600">
                        <span>Legitimately owed under your plan</span>
                        <strong className="font-semibold tabular-nums text-gray-900">${fmtMoney(savingsDerivation.bill.balanceSplit.legit)}</strong>
                      </div>
                      <div className="flex justify-between gap-3 text-xs">
                        <span className="font-semibold text-emerald-700">
                          Provider must forgive
                          <span className="mt-0.5 block max-w-[220px] text-[11px] font-normal leading-snug text-gray-500">
                            Money still on your balance that your plan says you don&apos;t owe.
                          </span>
                        </span>
                        <strong className="font-bold tabular-nums text-emerald-700">+${fmtMoney(savingsDerivation.bill.balanceSplit.forgiveness)}</strong>
                      </div>
                    </div>
                    <div className="self-start rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-bold text-emerald-700">
                      {savingsDerivation.bill.balanceSplit.equation}
                    </div>
                  </>
                )}
              </div>
            ) : (
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
            )}
            <div className="mt-1 inline-flex items-center gap-[6px] text-[11px] text-gray-500">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span>From {providerName} bill · {data.lineItems.length} line item{data.lineItems.length !== 1 ? "s" : ""}</span>
            </div>
          </div>
        </div>
        {/* S307 flag — "Where these numbers come from": the per-line derivation
            connecting the two cards to the Refund/Forgive totals. Same
            savingsDerivation build as the plan card — one derivation, two
            renderings, so they can never disagree. */}
        {savingsDerivation && savingsDerivation.rows.length > 0 && (
          <div className="mt-3.5 rounded-[18px] border border-gray-200 bg-gray-50/70 px-5 py-4">
            <h4 className="m-0 text-[11px] font-bold uppercase tracking-[0.09em] text-gray-700">
              Where these numbers come from
            </h4>
            {savingsDerivation.spreadSentence && (
              <p className="mb-1 mt-1.5 text-xs leading-relaxed text-gray-500">{savingsDerivation.spreadSentence}</p>
            )}
            <div className="mt-2.5 flex flex-col gap-2">
              {savingsDerivation.rows.map((row) => (
                <div
                  key={row.id}
                  className={`grid grid-cols-1 items-center gap-2.5 rounded-xl border bg-white px-3.5 py-3 sm:grid-cols-[1.5fr_0.8fr_1fr] ${
                    row.cta ? "border-amber-300 bg-amber-50/40" : "border-gray-200"
                  }`}
                >
                  <div>
                    <div className="text-[13px] font-bold text-gray-900">{row.label}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-gray-500">{row.planDetail}</div>
                    {row.cta && (
                      <button
                        type="button"
                        onClick={() => setAddPlanDetailsLineId(row.id)}
                        className="mt-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
                      >
                        Confirm your rate →
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-gray-600">
                    {row.paidLabel}
                    <span className="block text-[15px] font-bold tabular-nums text-gray-900">${fmtMoney(row.paidAmount)}</span>
                  </div>
                  <div className="sm:text-right">
                    {row.result.kind === "none" ? (
                      <span className="text-xs font-semibold text-gray-400">{row.resultNone}</span>
                    ) : (
                      <>
                        <span className="block text-[11px] font-semibold text-gray-500">{row.resultLabel}</span>
                        <strong className="text-[16px] font-bold tabular-nums text-emerald-700">${fmtMoney(row.result.amount)}</strong>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
            </>
          )}
        </RailStep>
      )}

      {/* Step 4 — Recover the money (flagged bills only). Drafted bills show
          the real dispute cards (Open dispute letter); undrafted show the
          recover panel + BulkDisputeButton.
          S297 (Andrew): with guided_steps_v1 ON the step SPLITS into 4a "Work
          it by phone first" + 4b "Send the appeal / dispute letter" — the
          phone question concludes 4a (auto-collapse; yes carries the resolved
          date, skip goes amber) and 4b's panel activates white/grey → blue on
          "Not yet"/skip. Flag OFF renders today's single step, byte-identical.
          S302 — 4b renders ONLY while no letter exists. Once one does, the rail
          owns its send step, so the a/b split has nothing left to split and the
          phone step is simply step 4. */}
      {isFlagged && guidedCtx && (() => {
        const muted4b = !(
          guidedPack.outcome === "no" ||
          guidedPack.outcome === "skip" ||
          hasDraftedDispute
        );
        const phoneBodyVisible = !guidedPack.concluded || phoneFullOpen;
        return (
          <>
            <RailStep
              n={railExtends ? "4" : "4a"}
              done={guidedPack.concluded && guidedPack.outcome !== "skip"}
              skipped={guidedPack.outcome === "skip"}
              title={GUIDE_CHROME.packATitle}
              sub={GUIDE_CHROME.packAMeta}
              right={
                guidedPack.concluded ? (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    {guidedPack.outcome === "yes" && guidedOutcomeDateLabel != null && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                        {PHONE_OUTCOME.resolvedChipPrefix} · {guidedOutcomeDateLabel}
                      </span>
                    )}
                    {/* Concluded-by-answer now GUARANTEES done === total (the
                        S309 round-2 rule), so the count chip is always the calm
                        emerald one. */}
                    {guidedPack.outcome === "no" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        {GUIDE_CHROME.doneMeta(guidedPack.done, guidedPack.total)}
                      </span>
                    )}
                    {/* S309 (Andrew) — a skipped pack collapses with the
                        skipped chrome; the single way back in is one full-size
                        "Undo Skip" button (ShowFullStepButton's own classes,
                        so the header buttons match). */}
                    {guidedPack.outcome === "skip" && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPhoneUndoSkipSignal((n) => n + 1);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-[9px] text-[13px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        {GUIDE_CHROME.undoSkipLabel}
                      </button>
                    )}
                    <ShowFullStepButton
                      open={phoneFullOpen}
                      onToggle={() => setPhoneFullOpen((v) => !v)}
                    />
                  </div>
                ) : guidedPack.outcome != null && guidedPack.done < guidedPack.total ? (
                  // S309 round 2 (Andrew) — answered but a step still missing:
                  // the pack stays OPEN and the amber chip NAMES the gap (the
                  // S303 fold vocabulary), right beside the lit 4b.
                  <span className="inline-flex items-center gap-1 self-start rounded-full bg-amber-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
                    {GUIDE_CHROME.doneMeta(guidedPack.done, guidedPack.total)} · {CASE_RAIL.foldOpenSteps(guidedPack.total - guidedPack.done)}
                  </span>
                ) : undefined
              }
            >
              {/* Mounted-but-hidden while collapsed — an unmount would reset
                  the component's optimistic state to the (stale) claim meta,
                  making un-checks look like they never landed (Andrew E2E #3). */}
              <div className={phoneBodyVisible ? undefined : "hidden"}>
                <GuidedPhoneSteps
                  claimId={claimId}
                  ctx={guidedCtx}
                  initialSteps={guideStepsMeta}
                  getAuthToken={getAuthToken}
                  onItemizedRequest={requestItemizedLetter}
                  undoSkipSignal={phoneUndoSkipSignal}
                  onStateChange={(s) => {
                    // Collapse ONLY on the not-concluded → concluded TRANSITION;
                    // collapsing on every emit while concluded slammed the panel
                    // shut on any in-panel click (the un-check bug).
                    //
                    // S314 F2 (Andrew) — `setShowMath(false)` used to live BELOW
                    // this guard, unguarded, and was the flicker's larger half:
                    // `showMath` defaults to TRUE, so the FIRST attest collapsed
                    // the whole math block — plan card, bill card, derivation
                    // strip — which sits directly ABOVE the button being
                    // clicked. The button rose ~400px past the cursor mid-click,
                    // leaving the NEXT step's un-attested button under the
                    // pointer: the click landed, but the thing under the cursor
                    // afterwards was un-selected, which reads as "it didn't
                    // take". It also fired on the Undo-Skip path, where the user
                    // never touched the math at all.
                    //
                    // Andrew's S309 intent ("interacting with the phone step
                    // means the math above has been read; collapse it") is
                    // preserved — it now runs on the SAME conclusion transition
                    // the sibling collapse uses, a moment the layout is already
                    // changing on purpose and no click target is in flight.
                    if (s.concluded && !guidedPack.concluded) {
                      setPhoneFullOpen(false);
                      setShowMath(false);
                    }
                    // S314 F2 — `persist` emits TWICE per click (optimistic
                    // paint, then server adopt) and the second is almost always
                    // state-identical. Handing back the SAME object lets React
                    // bail out of the render entirely, instead of re-rendering
                    // this whole (very large) tree for nothing — the flicker's
                    // smaller half. Guarding here rather than at the child's
                    // emit sites covers every emitter, present and future.
                    setGuidedPackLive((prev) => (samePhonePackState(prev, s) ? prev : s));
                  }}
                />
              </div>
            </RailStep>
            {/* 4b — the CREATE step, and only that. Everything it used to carry
                about a letter that already exists (the send receipt, the
                Show-full-step toggle, the bolted-on unsend, the drafted-cards
                list, the done-state) now belongs to that letter's own rail
                step, rendered identically to every other letter's. `done` is
                gone rather than corrected: with no letter, there is nothing to
                be done about.
                S305 — it also stands down when there is nothing on this bill to
                contest. `BulkDisputeButton` already returns null in that case
                by its own rule, so this rendered a "Recover $X from this bill"
                promise with no door behind it; the fix is the button's own rule
                applied one level up, not a new one. */}
            {!railExtends && hasContestableCharges && (
              <RailStep
                n="4b"
                // KEPT, and inert by construction. `railExtends` is false only
                // when the rail flag is OFF or no letter exists — and no letter
                // means `hasDraftedDispute` is false — so this can evaluate true
                // ONLY in the flag-OFF world, where it reproduces today's
                // behaviour byte-for-byte. Deleting it would have been an
                // un-flagged change to production. The bug it caused (green
                // before anything was sent, still green after an unsend) dies
                // structurally with the flip: flag ON, this step is gone the
                // moment a letter exists, and the letter's own send step derives
                // its state from the send record.
                done={hasDraftedDispute}
                title={guidedTrack === "insurer" ? GUIDE_4B.titleInsurer : GUIDE_4B.titleProvider}
                sub={guidedPack.outcome === "yes" ? GUIDE_4B.subResolved : GUIDE_4B.sub}
                last
              >
                {recoverBranchNode(muted4b)}
              </RailStep>
            )}
          </>
        );
      })()}
      {isFlagged && !guidedCtx && !railExtends && hasContestableCharges && (
        <RailStep
          n={railStepRecover}
          done={hasDraftedDispute}
          title="Recover the money"
          sub="Call the billing office to verify the charge or send the appeal — many members do both."
          last
        >
          {/* S290 (Andrew) — recover card spans the full container: sm:-ml-[43px]
              cancels the rail body's indent so it runs from under the step badge
              all the way across (matches the Quality-measures bar width); mb-4
              restores breathing room (the `last` RailStep has no pb). */}
          {recoverBranchNode(false)}
        </RailStep>
      )}
      {/* S299 phase 1a — the extension rail (approved mock Panels A+B):
          per-letter waiting cards + concurrent waits + collapsed receipts,
          rendered from the projector via rail-steps.
          S302 — numbering continues the prep rail with NO gap, because the step
          it replaces has stopped rendering: guided → phone step is 4, rail
          starts at 5; flag-OFF guided → the rail starts AT railStepRecover,
          whose step no longer renders once a letter exists.
          S305 — no longer gated on `railTimeline`: a claim whose only rail
          content is an OFFER has no projection at all (there is no case
          timeline before the first letter), and that is exactly the claim the
          offer exists for. `railComposed` carries everything this renders. */}
      {isFlagged && railExtends && railComposed && (
        <>
          {railActionError && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <span>{railActionError}</span>
              <button
                type="button"
                onClick={() => setRailActionError(null)}
                className="text-xs text-red-700 hover:text-red-900"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}
          <CaseRail
            onStepInteraction={() => setShowMath(false)}
            // S303 — composed ONCE above, alongside the fold that reads it.
            groups={railComposed.groups}
            claimId={claimId}
            getAuthToken={getAuthToken}
            onLogResponse={(id) => setRailOutcomeDisputeId(id)}
            onSomethingElse={(id) => {
              setRailActionError(null);
              setRailCollectorFromDisputeId(id);
            }}
            onUndoResult={handleRailUndoResult}
            onStartNextLetter={handleRailStartNextLetter}
            renderOfferAction={renderOfferAction}
            escalating={railEscalating}
            // S301 — collections step state + the §1692g anchor ride the
            // PROJECTION (ProjectedLetterStep.collectionsSteps /
            // .collectorFirstContactDate), so the rail takes one input and there
            // is no prop here to forget.
            onMarkSent={handleRailMarkSent}
            onSaveFirstContactDate={handleRailFirstContactDate}
            onRefetch={refetchClaim}
          />
        </>
      )}
      </div>{/* /S302 resolved-fold collapse wrapper */}

      {/* S305 — the Case File. OUTSIDE the fold wrapper above, deliberately: it
          is not a rail step, so it must not collapse with them (spec §1 — "it
          survives the fold, unchanged"). Present from the first letter; absent
          before, because there is no case to file. Becomes the primary thing on
          screen once the case has ended in a denial. */}
      {isFlagged && railExtends && railTimeline && (
        <CaseFileBlock
          claimId={claimId}
          getAuthToken={getAuthToken}
          primary={caseFolded && caseEndedAdversely}
          updatedLabel={caseFileUpdatedLabel}
          letters={caseFileLetterCount}
          calls={caseFileCallCount}
          complaints={railTimeline.regulator.filings.length}
        />
      )}
      {/* S299 — the rail's inline-action modals: the dispute page's OWN
          components mounted here (one modal source; zero new UI machinery).
          Open state is settable only from the rail, so flag-OFF renders
          neither. */}
      <OutcomeReportingModal
        open={railOutcomeDisputeId != null}
        disputeId={railOutcomeDisputeId ?? ""}
        defaultAmount={null}
        onCancel={() => setRailOutcomeDisputeId(null)}
        onSubmitted={() => {
          setRailOutcomeDisputeId(null);
          void (async () => {
            await refetchClaim();
            if (onClaimUpdated) void onClaimUpdated();
          })();
        }}
        getIdToken={getAuthToken}
      />
      <CollectorModal
        open={railCollectorFromDisputeId != null}
        submitting={railEscalating}
        onCancel={() => setRailCollectorFromDisputeId(null)}
        onSubmit={handleRailCollectorSubmit}
      />
      <ExhaustionAttestModal
        open={railExhaustionFromDisputeId != null}
        submitting={railEscalating}
        onCancel={() => setRailExhaustionFromDisputeId(null)}
        onSubmit={(input) => {
          if (railExhaustionFromDisputeId) {
            void railEscalate(railExhaustionFromDisputeId, "external_review", {
              appealExhausted: input.appealExhausted,
            });
          }
        }}
      />

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
          {/* S290 (Andrew E2E) — the "upload your plan" nag renders ONLY when
              we genuinely have no plan terms for this bill (no line resolved
              coverage). With a plan on file (uploaded OR search-selected via
              the canonical fallback), the assumptions card above is the ask —
              this banner's premise ("once we have your plan details") is
              false and it reads as if the selection didn't register. */}
          {!primaryLineItems.some((li) => li.planCoverage != null) && (
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
          )}
          {/* Bulk dispute still available for needs_review when findings exist —
              user may want to dispute uncertain charges. Suppressed once ANY dispute
              exists on the bill (incl. cancelled) — the Disputes card is the single
              CTA, and this also kills the transient "Draft" flash during a
              billState-recompute refetch. */}
          {data.disputes.length === 0 && (
            <div className="my-4">
            <BulkDisputeButton
              size="xl"
              claimId={claimId}
              claim={claim}
              primaryLineItems={primaryLineItems}
              claimLevelFindings={visibleClaimLevelFindings}
              showDismissed={showDismissed}
              letterType={fallbackLetterType}
              getAuthToken={getAuthToken}
              onGenerated={(result) => router.push(disputeUrlForResult(result))}
              existingDisputeId={data.disputes.find((d) => d.status !== "cancelled")?.id ?? null}
            anonymousDraftGate={anonymousDraftGate}
              />
            </div>
          )}
        </>
      ) : data.disputes.length === 0 ? (
        // billState is null/clean — back-compat: render BulkDisputeButton standalone.
        // For clean state it self-suppresses when there's nothing to dispute. Also
        // suppressed once ANY dispute exists — the Disputes card below is the single
        // CTA (kills the transient "Draft" flash during a billState-recompute refetch).
        <div className="my-4">
        <BulkDisputeButton
          size="xl"
          claimId={claimId}
          claim={claim}
          primaryLineItems={primaryLineItems}
          claimLevelFindings={visibleClaimLevelFindings}
          showDismissed={showDismissed}
          letterType={fallbackLetterType}
          getAuthToken={getAuthToken}
          onGenerated={(result) => router.push(disputeUrlForResult(result))}
          existingDisputeId={data.disputes.find((d) => d.status !== "cancelled")?.id ?? null}
        anonymousDraftGate={anonymousDraftGate}
          />
        </div>
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
            initialDeductibleApplies={line.planCoverage?.deductibleApplies ?? null}
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

// RailStep moved VERBATIM to @/components/claims/CaseRail (S299) — the
// extension rail owns the chrome now; ClaimDetail imports it back, which
// avoids a ClaimDetail⇄CaseRail module cycle (same idiom as importing
// ShowFullStepButton from GuidedPhoneSteps).

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

// ── Guided Steps v1 (S297) — shared pure helpers ───────────────────────────
// These are the ONE derivation for both BulkDisputeButton's letter-type hint
// and the phone subflow's track ordering — extracted so the two can never
// disagree on the same page (S292 invariant extended to scripts).

/** The gap-line synthesis gate from BulkDisputeButton, verbatim semantics. */
function lineGapFindingKind(li: LineItem): "mystery" | "recovery" | null {
  if (li.coverageStatus === "not_covered") return null;
  const billed = li.billed_amount || 0;
  const ins = li.insurance_paid || 0;
  const owed = li.patient_owes || 0;
  const refund = li.recovery?.refundComponent ?? 0;
  const forgiveness = li.recovery?.forgivenessComponent ?? 0;
  const onEngine = li.costShareVerdict != null;
  const isMysteryGap = !onEngine && billed > 0 && ins === 0 && owed === 0;
  const hasRecoveryStory = onEngine
    ? li.costShareVerdict === "recovery"
    : li.planCoverage != null && (refund >= 1 || forgiveness >= 1);
  return isMysteryGap ? "mystery" : hasRecoveryStory ? "recovery" : null;
}

/** One contested charge in the bulk-dispute bundle, keyed to its line. */
interface DisputeEntry {
  lineItemId: string;
  lineNumber: number;
  finding: AuditFinding;
  billedAmount: number;
}

/**
 * THE bulk-dispute bundle: everything on this bill worth contesting, in three
 * buckets, from one walk (S305).
 *
 *  1. line-level actionable findings, keyed back to their owning line
 *  2. claim-level actionable findings (lineItems=[], e.g. unallocated_balance)
 *  3. gap lines — a synthesized `missing_adjustment` for lines no audit rule
 *     fired on, so the bundle covers them too
 *
 * ⚠ The `not_covered` skip that used to sit in bucket 3 is GONE, not moved:
 * `lineGapFindingKind` already returns null for those lines, so the guard could
 * never fire. Keeping a redundant copy of a rule is how the two versions of it
 * eventually disagree.
 */
function collectDisputeEntries(
  lineItems: LineItem[],
  claimFindings: ClaimLevelFindingMeta[],
  showDismissed: boolean,
): { lineEntries: DisputeEntry[]; claimActionable: ClaimLevelFindingMeta[]; gapEntries: DisputeEntry[] } {
  const lineEntries: DisputeEntry[] = [];
  for (const li of lineItems) {
    const all = (li.metadata?.auditFindings || []) as AuditFinding[];
    const live = showDismissed ? all : all.filter((f) => !f.dismissed);
    for (const f of live) {
      if (!f.actionable) continue;
      lineEntries.push({
        lineItemId: li.id,
        lineNumber: li.line_number,
        finding: f,
        billedAmount: li.billed_amount || 0,
      });
    }
  }

  const claimActionable = claimFindings.filter((f) => !f.dismissed && f.actionable);

  // Gap lines — two shapes:
  //   a. Mystery gap: billed > 0 + $0 insurance + $0 patient. No money moved
  //      despite a charge; the universal "help me dispute" case.
  //   b. Recovery story: the insurer under-paid relative to plan benefits and
  //      the recovery math computed refund/forgiveness ≥ $1. Mirrors the
  //      row-expansion render gate — whenever the row shows the "Your insurer
  //      should have paid X" panel, the bundle must surface the same finding.
  // Lines that already carry a real audit finding are skipped so the same
  // dollar value is never counted twice. The verdict-driven vs deductible-blind
  // decision lives entirely in `lineGapFindingKind` (S297).
  const linesWithRealFindings = new Set(lineEntries.map((e) => e.lineItemId));
  const gapEntries: DisputeEntry[] = [];
  for (const li of lineItems) {
    if (linesWithRealFindings.has(li.id)) continue;
    const gapKind = lineGapFindingKind(li);
    if (gapKind == null) continue;
    const billed = li.billed_amount || 0;
    const ins = li.insurance_paid || 0;
    const serviceLabel = li.description || li.service_slug?.replace(/_/g, " ") || "service";
    let title: string;
    let description: string;
    let estimatedOvercharge: number;
    if (gapKind === "mystery") {
      title = `Unexplained $${billed.toLocaleString()} charge for ${serviceLabel}`;
      description = `Service ${li.coverageStatus === "covered" ? "covered by plan" : "with no coverage data"} but EOB records $0 insurance payment and $0 patient responsibility. Provider billed $${billed.toLocaleString()}. Code: ${li.billing_code || "N/A"}.`;
      estimatedOvercharge = billed;
    } else {
      const recoveryAmount = (li.recovery?.refundComponent ?? 0) + (li.recovery?.forgivenessComponent ?? 0);
      const patientPaid = li.recovery?.patientPaid ?? li.patient_paid_amount ?? 0;
      const shouldOwe = li.recovery?.shouldOwe ?? 0;
      title = `Insurer under-paid $${recoveryAmount.toLocaleString()} for ${serviceLabel}`;
      description = `Service covered by plan. Insurance paid $${ins.toLocaleString()} on a $${billed.toLocaleString()} charge; patient paid $${patientPaid.toLocaleString()} out-of-pocket. Plan-stated patient cost-share: $${shouldOwe.toLocaleString()}. Code: ${li.billing_code || "N/A"}.`;
      estimatedOvercharge = recoveryAmount;
    }
    gapEntries.push({
      lineItemId: li.id,
      lineNumber: li.line_number,
      finding: {
        id: `gap-${li.id}`,
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

  return { lineEntries, claimActionable, gapEntries };
}

/** "Covered · 0% coinsurance" → "covered with 0% coinsurance" — the plan-says
 *  card string adapted for a spoken script (first mid-dot → "with", any
 *  further → "and"). Same source string as the card; a transform, never a
 *  second derivation. */
function spokenPlanSays(label: string): string {
  return label.toLowerCase().replace(" · ", " with ").replace(/ · /g, " and ");
}

/** "2024-04-25" → "April 25, 2024" (UTC — date-only strings must not slip a day). */
function fmtDateLongUTC(d: string | null): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Server ISO timestamp → "Jul 30, 2026" (local; the resolved-by-phone chip). */
function fmtStampDateLocal(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "2024-04-25" → "April 25" (clause dates). */
function fmtDateMonthDayUTC(d: string | null): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
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
  sent,
}: {
  dispute: { id: string; dispute_type: string; status: string; amount_disputed: number; amount_recovered: number; isStale?: boolean; chargeCount?: number };
  provider: string;
  recovery: number;
  hasCostShare: boolean;
  /**
   * S301 — has this letter actually been MAILED, from the projection's
   * `latestSendAt`. The badge below cannot answer that from `status`: mark-as-sent
   * writes `filed`, and DISPUTE_STATUS_LABEL maps BOTH `filed` and
   * `dispute_letter_drafted` to "Dispute Letter Drafted" — so a sent letter
   * reported itself as a draft. `sent_at` is deliberately stripped from the claim
   * payload, so this reads the projection ClaimDetail already holds rather than
   * widening the payload or inventing a second proxy.
   */
  sent: boolean;
}) {
  // Cost-Share v2 (§17.4) — the card surfaces the "May need update" state + the
  // linked-charge count from props (the claim GET now folds `isStale` +
  // `chargeCount` into `data.disputes`), so the pill renders INSTANTLY. This used
  // to fire the heavy /api/disputes/[id] GET on mount (~4.5s) just for these two.
  // The heavy bill / letter / court detail lives on the /disputes letter page
  // ("Open dispute letter"), which also carries Refresh / Keep-as-is.
  const typeLabel = disputeTypeLabel(dispute.dispute_type);
  // Sent is a FACT; the status is a proxy that cannot distinguish drafted from
  // mailed. Null projection (rail flag OFF) → today's label, byte-identical.
  const statusLabel = sent
    ? DISPUTE_STATUS_SENT_LABEL
    : DISPUTE_STATUS_LABEL[dispute.status] || dispute.status;
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
  letterType,
  getAuthToken,
  onGenerated,
  existingDisputeId,
  size = "md",
  muted = false,
  anonymousDraftGate,
}: {
  claimId: string;
  claim: Record<string, unknown>;
  primaryLineItems: LineItem[];
  claimLevelFindings: ClaimLevelFindingMeta[];
  showDismissed: boolean;
  /**
   * The template this button drafts — REQUIRED (S305).
   *
   * It used to derive its own from the dominant finding type, which was fine
   * while a bill produced one letter and nothing else needed the answer. Now
   * the rail offers a rung per obligated party and each one drafts a different
   * letter, so the caller decides and this component writes what it is told.
   * That also collapses the two callers of `letterTypeHintFromTypes` to one.
   */
  letterType: string;
  getAuthToken: () => Promise<string | null>;
  onGenerated: (result: { disputeId?: string | null; deduplicated?: boolean }) => void;
  existingDisputeId?: string | null;
  /** S290 (Andrew E2E #11) — "xl" renders the bottom-of-bill CTA as a
   *  full-width primary action (onboarding Done-button idiom); default "md"
   *  keeps the inline rail/footer chrome untouched. */
  size?: "md" | "xl";
  /** S297 4b — greyed inactive look until the phone question concludes.
   *  STILL CLICKABLE (contract §3.6: the pack never blocks letter generation). */
  muted?: boolean;
  /** S316 — /check anonymous gate: click renders this node instead of
   *  generating (the server would 403 the anonymous session anyway). */
  anonymousDraftGate?: React.ReactNode;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
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

  // S305 — the three buckets come from the SHARED builder, which the letter-type
  // fallback and the rung derivation read too. Two walks of the same data is how
  // "how many issues are there" and "which issues are bundled" drift apart.
  const { lineEntries, claimActionable, gapEntries } = collectDisputeEntries(
    primaryLineItems,
    claimLevelFindings,
    showDismissed,
  );
  const aggregated = [...lineEntries, ...gapEntries];
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
          letterType,
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
    // S316 — anonymous /check: the click opens the account gate inline and
    // never reaches the generate route (whose Tier-3 floor would 403 it).
    if (anonymousDraftGate) {
      setGateOpen((open) => !open);
      return;
    }
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

  // S316 (#4) — while the anonymous gate is open, the gate card is the active
  // surface and the button visually yields to it: the S304 muted idiom
  // (outlined blue, never grey-disabled — it stays clickable to collapse).
  const superseded = !!anonymousDraftGate && gateOpen;

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
        className={
          size === "xl"
            ? superseded
              ? "flex w-full items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-blue-600 bg-white px-6 py-3.5 text-[15px] font-semibold text-blue-700 transition-all hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              : "flex w-full items-center justify-center gap-2 rounded-[14px] bg-blue-600 px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            : muted || superseded
              // S304 (Andrew) — the muted variant was grey fill on grey text,
              // which reads as DISABLED on a button that is fully clickable.
              // De-emphasis should come from weight, not from looking broken:
              // outlined blue on white, the same treatment "Upload another bill"
              // already uses on this page, so it still sits below the filled
              // primary CTA without pretending to be unavailable.
              ? "inline-flex items-center gap-1.5 rounded-xl border border-blue-600 bg-white px-4 py-[9px] text-[13px] font-semibold text-blue-700 transition-all hover:-translate-y-px hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              : "inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        }
      >
        {buttonLabel}
        {!loading && (
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        )}
      </button>
      {anonymousDraftGate && gateOpen && (
        <div className="mt-2.5 w-full min-w-[300px]">{anonymousDraftGate}</div>
      )}
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

/**
 * CaseNeedsPanel — dispute-letters v2 Zone-1 ("What we need from you", map §6).
 *
 * The single consolidated top-of-page widget: one card listing every missing/confirmable
 * input as an icon + label + (why) + control row. Reuses the shared Row/IconChip primitive
 * (same shape as the claim-page CostShareBanner).
 *
 * S265 refinements:
 *  - A completion meter at the top ("6 of 11 added").
 *    ⚠ S302 — the readiness PILL that used to sit here MOVED to the top of the
 *    UnifiedTodo spine (tracker Item AB). The page carried two progress signals
 *    that counted different row sets and could disagree; the one that survives
 *    is the SERVER's floor (`strength.readiness`), which is what actually scores
 *    the letter and prints in the Case File. This panel's four-rung client tier
 *    — including its "Strong" rung — is deleted, not relocated. What remains
 *    here is a quantity meter, not a verdict on sendability.
 *  - Per-row importance: high-impact evidence inputs carry an "Important" chip.
 *  - De-clutter: incomplete rows (important-first) render full at the top; completed rows
 *    sink to an "Added" group below, each still editable.
 *  - Editable-after-verify: the confirmed name + attested-services rows expose an Edit.
 *
 * Reuse-first + delegate: the panel owns only layout and the
 * inline value editors (amount-paid + the two deadline dates). Every other row delegates to
 * an existing handler/modal.
 */
"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Row } from "@/components/shared/InputRow";
import {
  ImportantBadge,
  DoneChip,
  DoneEdit,
  AddButton,
  ValueEdit,
  CancelLink,
  NeedsMeter,
  AddedFold,
} from "@/components/shared/needs-format";
import { PatientIdentityChoices } from "@/components/disputes/PatientIdentityChoices";
import {
  validateUsAddress,
  composeUsAddress,
  type UsAddressErrors,
} from "@/lib/address/validate-us-address";
import {
  ServiceAttestationFlow,
  type AttestationLine,
} from "@/components/disputes/ServiceAttestationFlow";
import { letterNeeds, type LetterNeedKey, type LetterPatientIdentity } from "@/lib/disputes/letter-type";

/** One disputed service's plan-cost state (derived from evidence line planBenefit,
 *  or — S292 (#7) — from the claim page's own cost-share resolution `lineCostShare`). */
export interface PlanCostService {
  serviceSlug: string;
  serviceLabel: string;
  /** false when plan cost is unknown for this service (→ "Add plan details"). */
  known: boolean;
  copay: number | null;
  /** 0–100, already converted from the decimal stored on planBenefit. */
  coinsurancePercent: number | null;
  /** planBenefit.source — 'manual' → the user's own entry (editable); else read-only. */
  source: string | null;
  /**
   * S292 (#7) — provenance split for the review-screen model: true = a human
   * asserted or confirmed this value (manual entry / confirm-coverage mark) →
   * DONE row; false = parser-extracted, never human-reviewed → prefilled under
   * the ONE aggregate "looks right?" confirm. Absent (legacy callers) → known
   * keeps its old DONE behavior.
   */
  humanReviewed?: boolean;
  /** Backing claim_line_items ids (the aggregate confirm fans out per line). */
  lineItemIds?: string[];
  /** The claim the lines belong to (confirm-coverage endpoint scope). */
  claimId?: string | null;
  /** Non-null when the value came from a secondary (category) borrow — the
   *  per-item "Doesn't match" reject stays available for those. */
  secondaryMatchedSlug?: string | null;
  /** S293 (#5) — the service's billed total on this claim, for the one-block
   *  claim-details list. Absent (legacy callers) → the line renders without it. */
  billedAmount?: number | null;
  /**
   * S314 (Andrew) — what ANSWERING this ask is worth, in dollars, when the
   * platform has a category match it isn't confident enough to claim.
   *
   * Sourced from evidence `secondaryCoverageVerify.projectedDiscrepancy`, summed
   * across the service's lines. Null when there is no projection to make.
   *
   * ⚠ Phrase it as what the ANSWER decides, never as what CONFIRMING earns. A
   * user's confirm/reject is the precision oracle behind canonical promotion;
   * copy that pays for one answer buys agreement and then counts it as
   * evidence. The delta is identical either way — confirm and the letter gains
   * it, reject and it does not — so "your answer decides" is both the honest
   * framing and the accurate one.
   */
  projectedDiscrepancy?: number | null;
}

/**
 * S292 (#7) — services the platform resolved but no human has confirmed. These
 * are what the claim-details block asks about; an empty set means every known
 * plan cost has been reviewed.
 */
export function unconfirmedParsedServices(
  planServices: PlanCostService[],
): PlanCostService[] {
  return planServices.filter((s) => s.known && s.humanReviewed === false);
}

/**
 * S314 (Andrew) — everything this panel marks IMPORTANT and still open.
 *
 * THE BUG THIS CLOSES. `isClaimDetailsConfirmed` asked a narrower question than
 * the panel it speaks for: "has the attestation been reviewed, and is every
 * parser-extracted plan cost confirmed?" It never looked at the missing plan
 * cost, the missing denial date, or any other row the panel itself renders with
 * an IMPORTANT badge. So the "Confirm the claim details" step showed a green
 * check while, one click inside, two IMPORTANT items sat empty.
 *
 * That is the S308 amber-honesty shape again — a step declaring itself done on
 * a narrower question than the panel beneath it is asking — and it had a money
 * consequence, not a cosmetic one: an unanswered coverage question keeps its
 * line OUT of the letter, so a PROD letter demanded $87.25 while the bill's own
 * math showed $131.21 recoverable. The green check is why the question was
 * never answered.
 *
 * WHY THIS SHAPE. The function was already the single derivation — the panel
 * (its `detailsDone`) and the page (the UnifiedTodo row's state) both call it.
 * It did not need unifying; it needed to ask enough. Widening the input is a
 * COMPILE ERROR at both call sites by design (the S302 lesson: an optional
 * param lets one site silently keep the old answer).
 *
 * Helpful-only rows (the EOB upload) are deliberately excluded — they never
 * hold the step open, and never turn it amber.
 */
export interface ClaimDetailsNeedsInput {
  planServices: PlanCostService[];
  attestationReviewed: boolean;
  /** Insurer-track letters ask for the denial date; it sets the appeal deadline. */
  insurerTrack: boolean;
  denialNoticeDate: string | null;
  /** The amount-paid ask — null while unanswered. */
  userPatientPaid: number | null;
  /** Collections track only. */
  wantsCollectorDetails: boolean;
  collectorAddressOnFile: boolean;
  accountNumberOnFile: boolean;
  /**
   * Category-coverage confirmations still open and NOT folded into the
   * aggregate confirm row (the panel's own fold rule).
   */
  openCoverageVerifyCount: number;
}

/**
 * S314 — build the completeness input from the panel's own raw props.
 *
 * Exported so the PAGE does not re-derive `insurerTrack` or the collector-track
 * question from `letterType` on its own: those come from `letterNeeds`, and a
 * second copy of that mapping is exactly the drift the widened predicate exists
 * to end. The panel calls this with its props; the page calls it with the same
 * values it passes as props.
 */
export function buildClaimDetailsNeeds(input: {
  letterType: string;
  letterRequirementsOn: boolean;
  planServices: PlanCostService[];
  attestationReviewed: boolean;
  denialNoticeDate: string | null;
  userPatientPaid: number | null;
  collectorAddressOnFile: boolean;
  accountNumberOnFile: boolean;
  coverageVerifyGaps: ReadonlyArray<{ lineItemId: string }>;
  /**
   * True when an aggregate/one-block confirm is already covering the parsed
   * services — a coverage-verify gap on one of those lines is folded into it,
   * not a separate open item (the panel's own fold rule).
   */
  parsedConfirmActive: boolean;
}): ClaimDetailsNeedsInput {
  const needs = letterNeeds(input.letterType);
  const asks = (key: LetterNeedKey): boolean => needs.needs.includes(key);
  const insurerTrack = input.letterRequirementsOn
    ? asks("denial_date")
    : INSURER_TRACK.has(input.letterType);
  const wantsCollectorDetails =
    input.letterRequirementsOn && (asks("collector_address") || asks("account_number"));
  const parsedLineIds = new Set(
    input.parsedConfirmActive
      ? unconfirmedParsedServices(input.planServices).flatMap((s) => s.lineItemIds ?? [])
      : [],
  );
  return {
    planServices: input.planServices,
    attestationReviewed: input.attestationReviewed,
    insurerTrack,
    denialNoticeDate: input.denialNoticeDate,
    userPatientPaid: input.userPatientPaid,
    wantsCollectorDetails,
    collectorAddressOnFile: input.collectorAddressOnFile,
    accountNumberOnFile: input.accountNumberOnFile,
    openCoverageVerifyCount: input.coverageVerifyGaps.filter(
      (g) => !parsedLineIds.has(g.lineItemId),
    ).length,
  };
}

/** Short labels for the open items, in the panel's own words. */
export function openImportantNeeds(input: ClaimDetailsNeedsInput): string[] {
  const open: string[] = [];
  for (const svc of input.planServices) {
    if (!svc.known) open.push(`Plan cost — ${svc.serviceLabel}`);
  }
  if (unconfirmedParsedServices(input.planServices).length > 0) {
    open.push("Plan costs from your documents");
  }
  if (input.openCoverageVerifyCount > 0) open.push("Coverage to verify");
  if (input.userPatientPaid == null) open.push("Amount you paid");
  if (input.insurerTrack && input.denialNoticeDate == null) open.push("Denial date");
  if (
    input.wantsCollectorDetails &&
    !(input.collectorAddressOnFile && input.accountNumberOnFile)
  ) {
    open.push("Collection agency details");
  }
  return open;
}

/**
 * S295 — the claim-details block's confirmation predicate, exported so the
 * UnifiedTodo row's done-state and the block's own rendering read the SAME
 * derivation rather than two that can drift (the S292 one-derivation
 * invariant).
 *
 * S314 — now true only when the attestation has been reviewed AND nothing the
 * panel calls important is still open. See openImportantNeeds.
 */
export function isClaimDetailsConfirmed(input: ClaimDetailsNeedsInput): boolean {
  return input.attestationReviewed && openImportantNeeds(input).length === 0;
}

export interface CaseNeedsPanelProps {
  /** Surface 4 (clarity redesign) — true when rendered INSIDE the UnifiedTodo
   *  "Confirm the claim details" expansion: drops the outer card chrome
   *  (border/shadow/padding) so panel + expansion read as ONE card. */
  embedded?: boolean;
  letterType: string;
  planServices: PlanCostService[];
  nameMismatch: boolean;
  nameResolved: boolean;
  billName: string | null;
  profileName: string | null;
  /** S307 (tracker AT round 2) — the stored answer, pre-selecting the widget. */
  patientIdentity?: LetterPatientIdentity | null;
  attestationReviewed: boolean;
  /**
   * S292 (#7) — where the attestation-reviewed state came from: "dispute" (the
   * user answered the attestation flow here) or "claim_page" (adopted from the
   * claim page's "All services look right" confirmation — rendered as done with
   * that provenance, never re-asked). Absent/null when not reviewed.
   */
  attestationSource?: "dispute" | "claim_page" | null;
  hasInsurer: boolean;
  providerAddressOnFile: boolean;
  insurerAddressOnFile: boolean;
  eobPresent: boolean;
  userPatientPaid: number | null;
  /**
   * S292 (#9) — the bill's parsed amount-paid (effectiveTotals.patientPaid).
   * When the user hasn't confirmed an override yet, the row prefills this value
   * for a one-click confirm (never re-typed). Null/0 → the ask renders as before.
   */
  billPatientPaid?: number | null;
  denialNoticeDate: string | null;
  /**
   * S292 (#10) — parsed EOB issue date (claims.metadata.eob_date). Prefills the
   * denial-date input on the insurer track: one-click confirm + editable, with
   * parsed provenance. Null → the question renders as before.
   */
  denialDatePrefill?: { date: string; source: string } | null;
  collectorFirstContactDate: string | null;
  planLabel: string | null;
  showInsuranceRow: boolean;
  canChangePlan: boolean;
  // S302 — `readiness` REMOVED. The panel no longer renders a sendability
  // verdict, so it no longer needs the floor: the one signal lives at the top of
  // the spine, where UnifiedTodo reads the same `strength.readiness` the page
  // already holds. One prop, one consumer, one answer.
  /** service_coverage_verify gates — moved from EvidenceGaps into Zone-1 (S265). */
  coverageVerifyGaps: Array<{
    claimId: string;
    lineItemId: string;
    matchedServiceName: string;
    description: string;
  }>;
  onCoverageVerify: (claimId: string, lineItemId: string, decision: "match" | "no_match") => Promise<void>;
  /** Re-run audit — moved from EvidenceGaps. Gated OFF for now (the endpoint is broken, S265). */
  rerunAuditEnabled: boolean;
  auditFindingsMissing: boolean;
  onAuditRerun: () => Promise<void>;
  onAddPlanDetails: (svc: PlanCostService) => void;
  /**
   * S292 (#7) — the ONE aggregate "looks right?" confirm over every
   * parser-extracted plan cost (the single human glance that keeps the letter's
   * citations defensible). The page fans out the per-line confirm-coverage
   * writes + runs ONE reconcile refetch. Absent → the aggregate row still
   * renders but items fall back to individual Add/Edit only.
   */
  onConfirmParsedCosts?: (services: PlanCostService[]) => Promise<void>;
  /** S292 (#7) — per-item "Doesn't match" for a secondary-borrowed value. */
  onRejectParsedCost?: (svc: PlanCostService) => Promise<void>;
  /**
   * S293 (#5) — the ONE claim-details block (replaces the per-item confirmation
   * rows: per-service plan-cost rows + the aggregate parsed-costs row + the
   * attest-services row). All four props present → the block renders; any
   * absent (legacy callers / flag-off page path) → the per-item rows render
   * exactly as before (fail-closed to the shipped behavior).
   */
  claimFacts?: {
    patientName: string | null;
    providerName: string | null;
    serviceDate: string | null;
    /**
     * S310 (F14a) — present only when THIS letter prints the insurer (the page
     * gates by recipient kind), so the fact — and its fix row — appears exactly
     * when the name is in the letter. Undefined → no insurer fact.
     */
    insurerName?: string | null;
    /**
     * S310 (sender block) — the user's mailing address (profiles row), printed
     * above every letter's dateline when complete. Null → the letter renders
     * no sender block and the wrong-mode row offers Add.
     */
    userAddress?: {
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      zip: string;
    } | null;
  } | null;
  /** every billed line — the attestation picker's candidates (same shape the
   *  ServiceAttestationFlow always consumed). */
  attestationLines?: AttestationLine[];
  attestedLineItemIds?: string[];
  /** account holder's name (attestation default) + persisted adopted name. */
  accountName?: string;
  attestingAsName?: string | null;
  /** the attest-service submit (page's handleAttestServices). */
  onAttest?: (payload: {
    attestedLineItemIds: string[];
    serviceAttestationReviewed: boolean;
    attestingAsName?: string;
  }) => void | Promise<void>;
  /**
   * S294 — replaces the one-click `onConfirmName`. That button resolved the
   * identity mismatch with NO choice: on a dependent's bill it suppressed the
   * rail's three-choice question and later renders fell back to the ACCOUNT
   * name — an outbound letter naming the wrong patient (observed live, bug 2
   * of Andrew's prod E2E). Same contract as UnifiedTodo.onResolvePatient; both
   * surfaces render the shared PatientIdentityChoices form.
   */
  onResolvePatient: (choice: "me" | "dependent" | "wrong", correctedName?: string) => void;
  onEditLetter: () => void;
  onReviewAttestation: () => void;
  /**
   * S310 (F14a) — name corrections from the claim-details block's
   * "Something's wrong" mode. Provider name renders whenever the handler is
   * present (every letter prints the provider); the insurer row additionally
   * requires claimFacts.insurerName (page-gated to insurer-recipient letters).
   * Both write their single upstream source (claims.metadata.provider /
   * the plan row), so every surface + the live draft follow on the reconcile.
   */
  onFixProviderName?: (name: string) => Promise<unknown>;
  onFixInsurerName?: (name: string) => Promise<unknown>;
  /**
   * S310 (sender block) — saves the user's mailing address through the page's
   * existing /api/profile write; letters rebuild with the sender block.
   */
  onFixUserAddress?: (addr: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    zip: string;
  }) => Promise<unknown>;
  /**
   * S310 — "These look right" also vouches the printed names (flywheel
   * corroboration stamps; fire-and-forget on the page side).
   */
  onVouchNames?: () => void | Promise<unknown>;
  onAddProviderAddress: () => void;
  onAddInsurerAddress: () => void;
  onUploadEob: () => void;
  onSaveAmountPaid: (amount: number | null) => Promise<void>;
  onChangePlan: () => void;
  onSaveDeadlineDate: (
    field: "denialNoticeDate" | "collectorFirstContactDate",
    value: string | null,
  ) => Promise<void>;
  /**
   * S301 `letter_requirements_v1`. OFF keeps the legacy row set exactly (every
   * letter asked for a provider address + EOB; INSURER_TRACK below drove the
   * denial row). ON drives the track-varying rows from `letterNeeds`.
   */
  letterRequirementsOn?: boolean;
  /** S301 — from `planContext.collectorContact` (claims.metadata.collector). */
  collectorAddressOnFile?: boolean;
  accountNumberOnFile?: boolean;
  /** Opens the collector-details editor (the parameterized CollectorModal). */
  onAddCollectorDetails?: () => void;
}

type EditorKey = "amount" | "denial" | "collector";
type Importance = "important" | "helpful";

/**
 * ⚠ LEGACY — the pre-S301 "insurer letter" set, and a THIRD definition of it.
 * It includes `final_notice`, which `RECIPIENT_BY_LETTER_TYPE` calls a PROVIDER
 * letter and the deadline engine's own INSURER_TRACK excludes. Only reachable
 * with `letter_requirements_v1` OFF; `letterNeeds` is the single source when ON.
 */
const INSURER_TRACK = new Set(["insurance_appeal", "final_notice", "external_review"]);
const todayIso = (): string => new Date().toISOString().slice(0, 10);
const money = (n: number): string => `$${n.toFixed(2)}`;
function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── icons (inline, matching the codebase's stroke-SVG style) ──────────────────
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const ShieldIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /></svg>);
const UserIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>);
const CheckListIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>);
const MapPinIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>);
const ReceiptIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M6 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1z" /><path d="M9 8h6M9 12h6" /></svg>);
const CashIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></svg>);
const CardIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></svg>);
const CalendarIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4M16 3v4M4 11h16" /></svg>);
const PencilIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="text-blue-600" aria-hidden><path d="M12 20h9M4 20l1-4 10-10a2.1 2.1 0 013 3L8 19l-4 1z" /></svg>);
const ShieldCheckIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>);
const AuditIcon = (<svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>);

// ── readiness ──────────────────────────────────────────────────────────────
// S302 — the client's four-rung `computeTier` + TIER_META are DELETED. There
// were two readiness ladders: this one (floorMet + a weighted count of the
// panel's own rows → not_ready / ready / STRONG / airtight) and the server's
// (`strength.readiness`: the MVDL floor + open optional gaps → attention /
// ready_to_send / airtight). They counted different row sets, so they could and
// did disagree — and only the server's scores the letter and prints in the
// Case File. The one signal now lives at the TOP of the spine (tracker Item AB,
// Andrew: "I don't see the readiness score anywhere except under the dispute
// letter card, which is not really where you look"), rendered by UnifiedTodo
// from the same `readiness` prop this panel receives.
//
// What this panel keeps is a QUANTITY meter — "6 of 11 added" — which says more
// precisely what the lost "Strong" rung was gesturing at.

// ── small controls ────────────────────────────────────────────────────────────

/** Coverage-verify gate control — "Matches" / "Doesn't match" (from ServiceVerificationGateCard). */
function CoverageVerifyControl({ onDecide }: { onDecide: (d: "match" | "no_match") => Promise<void> }) {
  const [status, setStatus] = useState<"idle" | "match" | "no_match" | "error">("idle");
  const busy = status === "match" || status === "no_match";
  const decide = async (d: "match" | "no_match") => {
    if (busy) return;
    setStatus(d);
    try { await onDecide(d); setStatus("idle"); } catch { setStatus("error"); }
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => decide("match")}
        disabled={busy}
        className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
      >
        {status === "match" ? "Saving…" : "Matches"}
      </button>
      <button
        type="button"
        onClick={() => decide("no_match")}
        disabled={busy}
        className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
      >
        {status === "no_match" ? "Saving…" : "Doesn't match"}
      </button>
    </div>
  );
}

/**
 * S292 (#7/#9/#10) — "prefilled, one-click confirm" control: the platform already
 * knows the value (parser-extracted); the user glances + confirms, never re-types.
 * Reuses the claim page's approved "Looks right" verb (G5 / "All services look
 * right"). Edit stays available for corrections.
 */
function PrefilledConfirm({
  value,
  onConfirm,
  onEdit,
}: {
  value: string;
  onConfirm: () => Promise<void>;
  onEdit?: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const confirm = async () => {
    if (status === "saving") return;
    setStatus("saving");
    try {
      await onConfirm();
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2.5">
      <span className="whitespace-nowrap text-sm font-medium text-gray-900">{value}</span>
      <button
        type="button"
        disabled={status === "saving"}
        onClick={() => { void confirm(); }}
        className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
      >
        {status === "saving" ? "Saving…" : "Looks right"}
      </button>
      {onEdit ? (
        <button type="button" onClick={onEdit} className="whitespace-nowrap text-[13px] font-medium text-blue-600 hover:text-blue-700">
          Edit
        </button>
      ) : null}
      {status === "error" ? (
        <span className="w-full text-right text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
      ) : null}
    </span>
  );
}

/** Full-width editor panel shared by the value rows — wraps on mobile. */
function EditorShell({ prompt, children }: { prompt: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <p className="mb-3 text-[13px] font-medium text-gray-800">{prompt}</p>
      {children}
    </div>
  );
}

function AmountEditor({ initial, onSaved }: { initial: number | null; onSaved: (a: number | null) => Promise<void> }) {
  const [value, setValue] = useState(initial != null ? String(initial) : "");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const save = async () => {
    const t = value.trim();
    let amount: number | null;
    if (t === "") amount = null;
    else {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) { setStatus("error"); return; }
      amount = Math.round(n * 100) / 100;
    }
    setStatus("saving");
    try { await onSaved(amount); } catch { setStatus("error"); }
  };
  return (
    <EditorShell prompt="How much have you paid on this bill?">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-500">$</span>
          <input
            inputMode="decimal"
            value={value}
            onChange={(e) => { setValue(e.target.value); if (status === "error") setStatus("idle"); }}
            placeholder="0.00"
            aria-label="Amount you paid"
            className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <button
          type="button"
          disabled={status === "saving"}
          onClick={save}
          className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      {status === "error" ? (
        <p className="mt-2 text-[12px] text-red-600">Enter a dollar amount, or leave it blank to clear.</p>
      ) : (
        <p className="mt-2 text-[12px] text-gray-400">Leave blank if you haven&apos;t paid anything yet.</p>
      )}
    </EditorShell>
  );
}

function DateEditor({ initial, prompt, onSaved }: { initial: string | null; prompt: string; onSaved: (v: string | null) => Promise<void> }) {
  const [value, setValue] = useState(initial ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const save = async () => {
    setStatus("saving");
    try { await onSaved(value === "" ? null : value); } catch { setStatus("error"); }
  };
  return (
    <EditorShell prompt={prompt}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <input
          type="date"
          // S309 F15 — the floor pairs with the route's MIN_ANCHOR_DATE: a
          // typed 3-digit year ("0203") is past-dated and slipped both the
          // format regex and the future-date guard.
          min="2000-01-01"
          max={todayIso()}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
        <button
          type="button"
          disabled={status === "saving" || value === ""}
          onClick={save}
          className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      {status === "error" ? <p className="mt-2 text-[12px] text-red-600">Couldn&apos;t save — try again.</p> : null}
    </EditorShell>
  );
}

/** Header: title + a thin completion meter. The readiness PILL moved to the
 *  top of the spine (S302 / Item AB) — a second one here is the competing
 *  signal that item exists to remove. Bar colour is now constant: this is a
 *  count of optional strengtheners added, not a verdict on sendability. */
function ReadinessHeader({ completed, total }: { completed: number; total: number }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {PencilIcon}
        <h3 className="text-[15px] font-semibold text-gray-900">What we need from you</h3>
      </div>
      <p className="mt-1.5 text-[13px] text-gray-500">
        Add what you can — each item makes your letter stronger, and we&apos;ll use it right away.
      </p>
      <NeedsMeter completed={completed} total={total} suffix=" — each one makes the letter stronger" />
    </div>
  );
}

interface RowDesc {
  key: string;
  done: boolean;
  importance: Importance;
  /** editor keys can force an otherwise-"done" row back into the open group while editing. */
  editorKey?: EditorKey;
  node: ReactNode;
}

export function CaseNeedsPanel(props: CaseNeedsPanelProps) {
  const {
    embedded, letterType, planServices, nameMismatch, nameResolved, billName, profileName, patientIdentity,
    attestationReviewed, attestationSource, hasInsurer, providerAddressOnFile, insurerAddressOnFile,
    eobPresent, userPatientPaid, billPatientPaid, denialNoticeDate, denialDatePrefill,
    collectorFirstContactDate,
    planLabel, showInsuranceRow, canChangePlan,
    coverageVerifyGaps, onCoverageVerify, rerunAuditEnabled, auditFindingsMissing, onAuditRerun,
    onAddPlanDetails, onConfirmParsedCosts, onRejectParsedCost, onResolvePatient, onEditLetter,
    onReviewAttestation,
    claimFacts, attestationLines, attestedLineItemIds, accountName, attestingAsName, onAttest,
    onFixProviderName, onFixInsurerName, onFixUserAddress, onVouchNames,
    onAddProviderAddress, onAddInsurerAddress, onUploadEob, onSaveAmountPaid,
    onChangePlan, onSaveDeadlineDate,
    letterRequirementsOn = false,
    collectorAddressOnFile = false, accountNumberOnFile = false, onAddCollectorDetails,
  } = props;

  const [openEditor, setOpenEditor] = useState<EditorKey | null>(null);
  // S311 (Andrew, §A round-2) — editing an ANSWERED row moves it out of the
  // Added fold to the open list above; without following it, the row looks
  // like it vanished from under the click. Follow the re-homed editor with a
  // smooth centered scroll (the S293 #11 treatment), scoped to THIS panel
  // instance so two mounted panels can never scroll each other.
  const sectionRef = useRef<HTMLElement | null>(null);
  const prevEditorRef = useRef<EditorKey | null>(null);
  useEffect(() => {
    if (openEditor && prevEditorRef.current !== openEditor) {
      // One macrotask after the commit (not requestAnimationFrame — rAF never
      // fires in background tabs): the fold row vanishing and the editor
      // appearing reflow in the same commit, and the browser's scroll
      // anchoring counter-adjusts the viewport right after any scroll made
      // during it. Waiting one tick lets layout + anchoring settle, then the
      // instant jump lands and nothing fights it (the section also opts out
      // of anchoring below).
      const key = openEditor;
      const t = setTimeout(() => {
        sectionRef.current
          ?.querySelector(`[data-needs-editor-row="${key}"]`)
          ?.scrollIntoView({ behavior: "auto", block: "center" });
      }, 60);
      return () => clearTimeout(t);
    }
    prevEditorRef.current = openEditor;
  }, [openEditor]);
  const [showAdded, setShowAdded] = useState(false);
  const [confirmAllStatus, setConfirmAllStatus] = useState<"idle" | "saving" | "error">("idle");
  // S293 (#5) — the one-block's "Something's wrong" expansion (per-item edits +
  // the didn't-receive attestation flow).
  const [detailsWrongMode, setDetailsWrongMode] = useState(false);
  // S310 (F14a) — the open name editor in wrong-mode (provider / insurer),
  // mirroring the per-service Edit rows: value + Edit → input + Save/Cancel.
  // Save is OPTIMISTIC (Andrew): the editor closes in the click's render (the
  // page's optimistic override shows the value at once); a rejected save
  // reopens it with the attempted value + error — the snapback.
  const [nameEdit, setNameEdit] = useState<{
    field: "provider" | "insurer";
    value: string;
    error: boolean;
  } | null>(null);
  // S310 (sender block) — the wrong-mode mailing-address editor (5 fields,
  // the SHARED US-address validation the provider/insurer forms use). Local
  // validation keeps the form open; a valid save closes optimistically and
  // snaps back open on failure, same as the name rows.
  const [addrEdit, setAddrEdit] = useState<{
    line1: string;
    line2: string;
    city: string;
    state: string;
    zip: string;
    errors: UsAddressErrors;
    error: boolean;
  } | null>(null);
  // S294 — the shared three-choice patient-identity form, expanded below its row.
  const [nameChoicesOpen, setNameChoicesOpen] = useState(false);
  const close = () => setOpenEditor(null);

  // ── What THIS letter asks for (S301) ──────────────────────────────────────
  //
  // Flag ON: the row set comes from `letterNeeds`, the same resolver the gap
  // emitter and the readiness floor use — so the panel can no longer ask for
  // something the letter doesn't print, or stay silent about something it does.
  //
  // What that fixes here: this panel pushed "Provider address" and "EOB detail"
  // UNCONDITIONALLY, so a collections letter asked for the clinic's billing
  // address (and its Add button opened the PROVIDER modal — banked defect #2)
  // while never offering the collector's address at all. Its own INSURER_TRACK
  // was a THIRD definition of "insurer letter" — it included `final_notice`,
  // which the recipient map calls a provider letter and the deadline engine
  // excludes — so the denial-date row rendered on two letter types where nothing
  // consumes it.
  //
  // Flag OFF: the legacy sets below, byte-identical.
  const needs = letterNeeds(letterType);
  const asks = (key: LetterNeedKey): boolean => needs.needs.includes(key);
  const insurerTrack = letterRequirementsOn ? asks("denial_date") : INSURER_TRACK.has(letterType);
  const collectorTrack = letterRequirementsOn
    ? asks("collector_first_contact_date")
    : letterType === "debt_validation";
  const wantsProviderAddress = letterRequirementsOn ? asks("provider_address") : true;
  const wantsInsurerAddress = letterRequirementsOn ? asks("insurer_appeals_address") : hasInsurer;
  const wantsEob = letterRequirementsOn ? asks("eob_detail") : true;
  const wantsCollectorAddress = letterRequirementsOn && asks("collector_address");
  const wantsAccountNumber = letterRequirementsOn && asks("account_number");
  const nameDone = !nameMismatch || nameResolved;

  // ── row descriptors (each carries done-ness + importance so we can order + group) ──
  const descs: RowDesc[] = [];

  // S292 (#7) — review-screen split. A service the platform already knows lands in
  // one of two buckets: human-reviewed (manual entry / confirmed) → DONE row;
  // parser-extracted only → prefilled under the ONE aggregate confirm below.
  // `humanReviewed === undefined` (legacy caller shape) keeps the old known→DONE
  // behavior. Genuinely unknown services keep the "Add plan cost" ask.
  const parsedSvcs = unconfirmedParsedServices(planServices);
  // S293 (#5) — the ONE claim-details block replaces the per-item confirmation
  // surfaces (known-cost rows, the aggregate confirm row, the attest row) when
  // the page supplies its inputs. Unknown-cost "Add plan cost" rows stay
  // separate — they are data ASKS, not confirmations.
  const detailsBlockActive =
    claimFacts != null && attestationLines != null && onAttest != null;
  // Without the aggregate handler the parsed bucket would have no row at all —
  // fall back to the per-service DONE row (editable) rather than dropping them.
  const aggregateActive =
    !detailsBlockActive && parsedSvcs.length > 0 && onConfirmParsedCosts != null;

  // S314 — line ids the aggregate/one-block confirm already covers, so a
  // coverage-verify gap on one of them is not a SEPARATE open item (the panel's
  // own fold rule, hoisted here so the completeness count and the row loop
  // below share it rather than each applying their own version).
  const parsedLineIds = new Set(
    aggregateActive || detailsBlockActive ? parsedSvcs.flatMap((s) => s.lineItemIds ?? []) : [],
  );

  // S314 — the ONE completeness input, built by the SAME exported builder the
  // page uses, and read by this panel's own `detailsDone` below as well as by
  // the UnifiedTodo row's green check. The fixture pins that the panel's
  // rendered important-and-open rows match what this list says is open.
  const claimDetailsNeeds = buildClaimDetailsNeeds({
    letterType,
    letterRequirementsOn,
    planServices,
    attestationReviewed,
    denialNoticeDate,
    userPatientPaid,
    collectorAddressOnFile,
    accountNumberOnFile,
    coverageVerifyGaps,
    parsedConfirmActive: aggregateActive || detailsBlockActive,
  });

  // Plan details — one row per disputed, slug'd service (done + unknown buckets).
  for (const svc of planServices) {
    if (detailsBlockActive && svc.known) continue; // → the one claim-details block
    if (aggregateActive && svc.known && svc.humanReviewed === false) continue; // → aggregate confirm row
    descs.push({
      key: `svc-${svc.serviceSlug}`,
      done: svc.known,
      importance: "important",
      node: svc.known ? (
        <Row
          icon={ShieldIcon}
          label={`Plan cost — ${svc.serviceLabel}`}
          control={
            // S266 (item 5) — every known plan-cost row is editable. Editing writes a
            // user-scoped cost-share override (Pattern 1 #14); the canonical/parsed value
            // is untouched. (Was read-only "On file" for parsed sources — Andrew's S263
            // rule, reversed here so a user can fix a wrong value.)
            <ValueEdit
              value={svc.copay != null ? `${money(svc.copay)} copay` : `${svc.coinsurancePercent}% coinsurance`}
              onEdit={() => onAddPlanDetails(svc)}
            />
          }
        />
      ) : (
        <Row
          icon={ShieldIcon}
          label={`Add plan cost — ${svc.serviceLabel}`}
          badge={ImportantBadge}
          control={<AddButton label="Add" onClick={() => onAddPlanDetails(svc)} />}
        >
          {/* S314 (Andrew, approved copy) — when the platform HAS a category
              match it isn't confident enough to claim, say what the open
              question is worth. The line is correctly withheld from the letter
              meanwhile; what was missing is any way for the user to know that
              cost them $X. Graceful drop to the generic line when there is no
              projection — the same rule the letter header follows. */}
          {svc.projectedDiscrepancy != null && svc.projectedDiscrepancy > 0 ? (
            <>
              Your plan may cover this as preventive care, at no cost to you — but we&apos;re
              not certain. Your answer decides whether your letter asks for{" "}
              {money(svc.projectedDiscrepancy)} more.
            </>
          ) : (
            <>
              Your plan&apos;s cost-share for this service — lets the letter quote your exact
              benefit.
            </>
          )}
        </Row>
      ),
    });
  }

  // S292 (#7) — the ONE aggregate "looks right?" confirm over every parser-extracted
  // plan cost. Everything known arrives prefilled; one glance + one click covers the
  // whole set (counsel rail: that recorded human glance keeps the letter's citations
  // defensible). Per-item Edit corrects a value (manual override); "Doesn't match"
  // rejects a secondary borrow. Renders only when parser-only values exist.
  if (aggregateActive && onConfirmParsedCosts) {
    descs.push({
      key: "parsed-costs",
      done: false,
      importance: "important",
      node: (
        <Row
          icon={ShieldIcon}
          label="Plan costs from your documents"
          badge={ImportantBadge}
          control={
            <span className="inline-flex flex-col items-end gap-1">
              <button
                type="button"
                disabled={confirmAllStatus === "saving"}
                onClick={() => {
                  void (async () => {
                    if (confirmAllStatus === "saving") return;
                    setConfirmAllStatus("saving");
                    try {
                      await onConfirmParsedCosts(parsedSvcs);
                      setConfirmAllStatus("idle");
                    } catch {
                      setConfirmAllStatus("error");
                    }
                  })();
                }}
                className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {confirmAllStatus === "saving" ? "Saving…" : "Looks right"}
              </button>
              {confirmAllStatus === "error" ? (
                <span className="text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
              ) : null}
            </span>
          }
          below={
            <ul className="space-y-1.5">
              {parsedSvcs.map((svc) => (
                <li key={svc.serviceSlug} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[13px]">
                  <span className="min-w-0 text-gray-700">
                    {svc.serviceLabel}
                    {" — "}
                    <span className="font-medium text-gray-900">
                      {svc.copay != null ? `${money(svc.copay)} copay` : `${svc.coinsurancePercent}% coinsurance`}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => onAddPlanDetails(svc)}
                      className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
                    >
                      Edit
                    </button>
                    {svc.secondaryMatchedSlug && onRejectParsedCost ? (
                      <button
                        type="button"
                        onClick={() => { void onRejectParsedCost(svc); }}
                        className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700"
                      >
                        Doesn&apos;t match
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          }
        >
          {/* TODO(copy-proposal S292): sentence pending Andrew's approval — composed from
              existing panel vocabulary; fails closed to a factual description. */}
          From your plan documents — the letter will cite them once you confirm.
        </Row>
      ),
    });
  }

  // S293 (#5) — the ONE claim-details block: every detail we parsed (patient,
  // provider, date, services + billed + plan cost) presented together with a
  // single "These look right" / "Something's wrong" choice. Wrong → inline
  // per-item edits (plan-cost Edit, secondary-borrow "Doesn't match", and the
  // didn't-receive-this-service attestation flow — moved here from the removed
  // "Why this should be covered" sidebar; its scroll anchor comes along).
  // "These look right" fans out the SAME writes the two rows it replaces made:
  // the per-line confirm-coverage marks + the services-performed attestation.
  if (detailsBlockActive && claimFacts && attestationLines && onAttest) {
    const detailsDone = isClaimDetailsConfirmed(claimDetailsNeeds);
    const factsLine = [
      claimFacts.patientName ? `Patient: ${claimFacts.patientName}` : null,
      claimFacts.providerName ? `Provider: ${claimFacts.providerName}` : null,
      // S310 — present only when this letter prints the insurer (page-gated).
      claimFacts.insurerName ? `Insurer: ${claimFacts.insurerName}` : null,
      claimFacts.serviceDate ? `Service date: ${prettyDate(claimFacts.serviceDate)}` : null,
      // S310 (sender block) — the address the letters print above the dateline.
      claimFacts.userAddress
        ? `Your address: ${composeUsAddress({
            addressLine1: claimFacts.userAddress.line1,
            addressLine2: claimFacts.userAddress.line2 ?? "",
            city: claimFacts.userAddress.city,
            state: claimFacts.userAddress.state,
            postalCode: claimFacts.userAddress.zip,
          })}`
        : null,
    ].filter(Boolean).join(" · ");
    // S310 (F14a, Andrew's ruling) — the names the letter prints are part of
    // confirming the claim details: "These look right" vouches them, and
    // "Something's wrong" offers the fix. Row style mirrors the per-service
    // edit rows; the save awaits the parent's write + reconcile, so the value
    // shown is always server truth.
    const nameFixRow = (
      field: "provider" | "insurer",
      label: string,
      value: string | null,
      onFix: (name: string) => Promise<unknown>,
    ) => {
      const editing = nameEdit?.field === field;
      return (
        <li key={field} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
          <span className="min-w-0 text-gray-700">
            {label}
            {value ? (
              <>
                {" · "}
                <span className="font-medium text-gray-900">{value}</span>
              </>
            ) : null}
          </span>
          {editing && nameEdit ? (
            <span className="flex w-full flex-wrap items-center gap-2">
              <input
                type="text"
                value={nameEdit.value}
                onChange={(e) => setNameEdit((p) => (p ? { ...p, value: e.target.value } : p))}
                aria-label={label}
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              <button
                type="button"
                disabled={nameEdit.value.trim().length === 0}
                onClick={() => {
                  const v = nameEdit.value.trim();
                  if (!v) return;
                  // Optimistic: close now; snap back open on rejection.
                  setNameEdit(null);
                  void Promise.resolve(onFix(v)).catch(() => {
                    setNameEdit({ field, value: v, error: true });
                  });
                }}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setNameEdit(null)}
                className="text-[13px] font-medium text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              {nameEdit.error ? (
                <span className="w-full text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
              ) : null}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setNameEdit({ field, value: value ?? "", error: false })}
              className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
            >
              Edit
            </button>
          )}
        </li>
      );
    };
    // S310 (sender block) — validate locally (shared US-address rules); a valid
    // save closes optimistically and snaps back open on rejection.
    const saveAddr = () => {
      if (!addrEdit || !onFixUserAddress) return;
      const fields = {
        addressLine1: addrEdit.line1.trim(),
        addressLine2: addrEdit.line2.trim() || undefined,
        city: addrEdit.city.trim(),
        state: addrEdit.state.trim().toUpperCase(),
        postalCode: addrEdit.zip.trim(),
      };
      const errs = validateUsAddress(fields);
      if (Object.keys(errs).length > 0) {
        setAddrEdit((p) => (p ? { ...p, errors: errs } : p));
        return;
      }
      const addr = {
        line1: fields.addressLine1,
        line2: addrEdit.line2.trim() || null,
        city: fields.city,
        state: fields.state,
        zip: fields.postalCode,
      };
      setAddrEdit(null);
      void Promise.resolve(onFixUserAddress(addr)).catch(() => {
        setAddrEdit({
          line1: addr.line1,
          line2: addr.line2 ?? "",
          city: addr.city,
          state: addr.state,
          zip: addr.zip,
          errors: {},
          error: true,
        });
      });
    };
    const addrRow = () => {
      const a = claimFacts.userAddress ?? null;
      const inputCls =
        "rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100";
      const errCls =
        "rounded-lg border border-red-400 px-2.5 py-1.5 text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-100";
      return (
        <li key="user-address" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
          <span className="min-w-0 text-gray-700">
            Your mailing address
            {a ? (
              <>
                {" · "}
                <span className="font-medium text-gray-900">
                  {composeUsAddress({
                    addressLine1: a.line1,
                    addressLine2: a.line2 ?? "",
                    city: a.city,
                    state: a.state,
                    postalCode: a.zip,
                  })}
                </span>
              </>
            ) : null}
          </span>
          {addrEdit ? (
            <span className="flex w-full flex-col gap-2">
              <input
                type="text"
                value={addrEdit.line1}
                onChange={(e) => setAddrEdit((p) => (p ? { ...p, line1: e.target.value } : p))}
                aria-label="Street address"
                placeholder="Street address"
                autoFocus
                className={`w-full ${addrEdit.errors.addressLine1 ? errCls : inputCls}`}
              />
              <input
                type="text"
                value={addrEdit.line2}
                onChange={(e) => setAddrEdit((p) => (p ? { ...p, line2: e.target.value } : p))}
                aria-label="Suite / unit"
                placeholder="Suite / unit (optional)"
                className={`w-full ${inputCls}`}
              />
              <span className="flex w-full gap-2">
                <input
                  type="text"
                  value={addrEdit.city}
                  onChange={(e) => setAddrEdit((p) => (p ? { ...p, city: e.target.value } : p))}
                  aria-label="City"
                  placeholder="City"
                  className={`min-w-0 flex-1 ${addrEdit.errors.city ? errCls : inputCls}`}
                />
                <input
                  type="text"
                  value={addrEdit.state}
                  onChange={(e) => setAddrEdit((p) => (p ? { ...p, state: e.target.value } : p))}
                  aria-label="State"
                  placeholder="ST"
                  maxLength={2}
                  className={`w-14 ${addrEdit.errors.state ? errCls : inputCls}`}
                />
                <input
                  type="text"
                  value={addrEdit.zip}
                  onChange={(e) => setAddrEdit((p) => (p ? { ...p, zip: e.target.value } : p))}
                  aria-label="ZIP code"
                  placeholder="ZIP"
                  className={`w-24 ${addrEdit.errors.postalCode ? errCls : inputCls}`}
                />
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveAddr}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setAddrEdit(null)}
                  className="text-[13px] font-medium text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
                {addrEdit.error ? (
                  <span className="text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
                ) : null}
              </span>
            </span>
          ) : (
            <button
              type="button"
              onClick={() =>
                setAddrEdit({
                  line1: a?.line1 ?? "",
                  line2: a?.line2 ?? "",
                  city: a?.city ?? "",
                  state: a?.state ?? "",
                  zip: a?.zip ?? "",
                  errors: {},
                  error: false,
                })
              }
              className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
            >
              {a ? "Edit" : "Add"}
            </button>
          )}
        </li>
      );
    };
    const svcValue = (svc: PlanCostService): string =>
      svc.copay != null ? `${money(svc.copay)} copay` : `${svc.coinsurancePercent}% coinsurance`;
    const confirmDetails = () => {
      void (async () => {
        if (confirmAllStatus === "saving") return;
        setConfirmAllStatus("saving");
        try {
          const ops: Array<Promise<unknown> | void> = [];
          if (parsedSvcs.length > 0 && onConfirmParsedCosts) ops.push(onConfirmParsedCosts(parsedSvcs));
          if (!attestationReviewed) {
            ops.push(
              onAttest({
                attestedLineItemIds: attestedLineItemIds ?? [],
                serviceAttestationReviewed: true,
              }),
            );
          }
          // S310 — "These look right" also vouches the printed names.
          if (onVouchNames) ops.push(onVouchNames());
          await Promise.all(ops);
          setConfirmAllStatus("idle");
          setDetailsWrongMode(false);
          setNameEdit(null);
        } catch {
          setConfirmAllStatus("error");
        }
      })();
    };
    descs.push({
      key: "claim-details",
      done: detailsDone && !detailsWrongMode,
      importance: "important",
      node: (
        <Row
          icon={CheckListIcon}
          label="Claim details"
          badge={detailsDone ? undefined : ImportantBadge}
          control={
            detailsDone && !detailsWrongMode ? (
              <DoneEdit label="Confirmed" onEdit={() => setDetailsWrongMode(true)} />
            ) : (
              <span className="inline-flex flex-col items-end gap-1">
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    disabled={confirmAllStatus === "saving"}
                    onClick={confirmDetails}
                    className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                  >
                    {confirmAllStatus === "saving" ? "Saving…" : "These look right"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailsWrongMode((v) => !v)}
                    className="whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Something&apos;s wrong
                  </button>
                </span>
                {confirmAllStatus === "error" ? (
                  <span className="text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
                ) : null}
              </span>
            )
          }
          below={
            <div className="space-y-2.5">
              {factsLine ? <p className="text-[13px] text-gray-700">{factsLine}</p> : null}
              {/* S310 — wrong-mode name fixes (provider always; insurer only
                  when the letter prints it — claimFacts.insurerName gated by
                  the page to insurer-recipient letters). */}
              {detailsWrongMode &&
              (onFixProviderName ||
                (onFixInsurerName && claimFacts.insurerName !== undefined) ||
                onFixUserAddress) ? (
                <ul className="space-y-1.5 border-l-2 border-gray-100 pl-2.5">
                  {onFixProviderName
                    ? nameFixRow("provider", "Provider name", claimFacts.providerName, onFixProviderName)
                    : null}
                  {onFixInsurerName && claimFacts.insurerName !== undefined
                    ? nameFixRow("insurer", "Insurer name", claimFacts.insurerName ?? null, onFixInsurerName)
                    : null}
                  {/* S310 (sender block) — the mailing address the letters
                      print; Add state when the profile has none. */}
                  {onFixUserAddress ? addrRow() : null}
                </ul>
              ) : null}
              <ul className="space-y-1.5">
                {planServices.map((svc) => (
                  <li
                    key={svc.serviceSlug}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[13px]"
                  >
                    <span className="min-w-0 text-gray-700">
                      {svc.serviceLabel}
                      {svc.billedAmount != null && svc.billedAmount > 0 ? (
                        <span className="text-gray-500"> — billed {money(svc.billedAmount)}</span>
                      ) : null}
                      {svc.known ? (
                        <>
                          {" · "}
                          <span className="font-medium text-gray-900">{svcValue(svc)}</span>
                        </>
                      ) : null}
                    </span>
                    {detailsWrongMode ? (
                      <span className="inline-flex items-center gap-2.5">
                        <button
                          type="button"
                          onClick={() => onAddPlanDetails(svc)}
                          className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
                        >
                          Edit
                        </button>
                        {svc.secondaryMatchedSlug && onRejectParsedCost ? (
                          <button
                            type="button"
                            onClick={() => { void onRejectParsedCost(svc); }}
                            className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700"
                          >
                            Doesn&apos;t match
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {detailsWrongMode ? (
                // The didn't-receive-this-service path — the attestation flow's
                // own picker handles per-item selection + the locked affirmation.
                // Anchor id preserved for the "Confirm the services" jump.
                <div id="dispute-service-attestation" className="pt-1">
                  <ServiceAttestationFlow
                    lines={attestationLines}
                    attested={attestedLineItemIds ?? []}
                    reviewed={attestationReviewed}
                    accountName={accountName ?? ""}
                    attestingAsName={attestingAsName}
                    onSubmit={onAttest}
                  />
                </div>
              ) : attestationReviewed && attestationSource === "claim_page" ? (
                /* TODO(copy-proposal S292): provenance line pending approval. */
                <p className="text-[12px] text-gray-500">You confirmed these on the previous page.</p>
              ) : null}
            </div>
          }
        >
          {detailsDone && !detailsWrongMode
            ? undefined
            : /* TODO(copy — Andrew approval): NEW sentence for the one-block
                 confirm (S293 #5); factual fallback wording. */
              "Everything below comes from your documents — confirm it together, or flag what's off."}
        </Row>
      ),
    });
  }

  // Coverage-verify gates (moved from EvidenceGaps into Zone-1, S265) — open when present.
  // S292 (#7) — a gap whose line is already covered by the aggregate confirm above is
  // folded into it (same per-line confirm, one glance) instead of double-asking.
  // Folds ONLY when the aggregate row actually renders (else the gap stays standalone).
  // S293 (#5) — the one-block confirm covers the same line ids, so it folds too.
  for (const g of coverageVerifyGaps) {
    if (parsedLineIds.has(g.lineItemId)) continue;
    descs.push({
      key: `coverage-verify-${g.claimId}-${g.lineItemId}`,
      done: false,
      importance: "important",
      node: (
        <Row
          icon={ShieldCheckIcon}
          label={`Confirm coverage — ${g.matchedServiceName}`}
          badge={ImportantBadge}
          control={<CoverageVerifyControl onDecide={(d) => onCoverageVerify(g.claimId, g.lineItemId, d)} />}
        >
          {g.description}
        </Row>
      ),
    });
  }

  // Re-run audit (moved from EvidenceGaps) — gated OFF for now (endpoint broken, S265; flip
  // rerunAuditEnabled to re-enable). Shown only when the audit_findings_missing gap is present.
  if (rerunAuditEnabled && auditFindingsMissing) {
    descs.push({
      key: "rerun-audit",
      done: false,
      importance: "important",
      node: (
        <Row
          icon={AuditIcon}
          label="Re-run the audit"
          badge={ImportantBadge}
          control={<AddButton label="Re-run" onClick={() => { void onAuditRerun(); }} />}
        >
          Re-run our audit against this bill to flag coverage mismatches, duplicate charges, and balance-billing — findings strengthen your letter.
        </Row>
      ),
    });
  }

  // Verify patient name (editable once verified — families can re-point to a different patient).
  descs.push({
    key: "name",
    done: nameDone,
    importance: "helpful",
    node: nameMismatch && !nameResolved ? (
      <Row
        icon={UserIcon}
        label="Verify the patient name"
        control={
          <div className="flex items-center gap-2">
            {/* S294 — opens the SAME three-choice form the rail uses (shared
                PatientIdentityChoices), replacing the one-click "This is me"
                that resolved with no choice and no dependent path. */}
            <AddButton label="Resolve name" onClick={() => setNameChoicesOpen((o) => !o)} />
            <button type="button" onClick={onEditLetter} className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700">Edit</button>
          </div>
        }
        below={
          nameChoicesOpen && billName && profileName ? (
            <div className="mt-2">
              <PatientIdentityChoices
                initialIdentity={patientIdentity}
                billName={billName}
                profileName={profileName}
                onResolve={(choice, correctedName) => {
                  onResolvePatient(choice, correctedName);
                  setNameChoicesOpen(false);
                }}
                onCancel={() => setNameChoicesOpen(false)}
              />
            </div>
          ) : undefined
        }
      >
        {billName && profileName
          ? `The bill lists "${billName}" — we're using "${profileName}". Confirm it's you, or edit for a family member.`
          : "Make sure the bill's patient is you (or a family member you're disputing for)."}
      </Row>
    ) : (
      /* S302 round 3 (Andrew: "when I go to edit patient name, it won't let me
         click edit"). This Edit called `onEditLetter` — it opened the LETTER
         BODY editor, not the patient question, and on a sent letter that is
         immutable so it did nothing at all. It now reopens the SAME
         three-choice form the unresolved row uses, which became possible only
         once the mismatch stopped being nulled on confirmation (the names have
         to survive for the question to be re-askable). */
      <Row
        icon={UserIcon}
        label="Patient name"
        control={<DoneEdit label="Verified" onEdit={() => setNameChoicesOpen((o) => !o)} />}
        below={
          nameChoicesOpen && billName && profileName ? (
            <div className="mt-2">
              <PatientIdentityChoices
                initialIdentity={patientIdentity}
                billName={billName}
                profileName={profileName}
                onResolve={(choice, correctedName) => {
                  onResolvePatient(choice, correctedName);
                  setNameChoicesOpen(false);
                }}
                onCancel={() => setNameChoicesOpen(false)}
              />
            </div>
          ) : undefined
        }
      />
    ),
  });

  // Attest services performed (editable once attested — un-attest a service in the evidence list).
  // S292 (#7) — the claim page's "All services look right" confirmation
  // (claims.metadata.servicesConfirmedAt) is adopted server-side: the row arrives
  // DONE with claim-page provenance, never re-asked. Edit still opens the flow
  // (flagging a service as not-performed remains an explicit act here).
  // S293 (#5) — superseded by the one claim-details block when it renders (the
  // block owns both the confirm and the didn't-receive path).
  if (!detailsBlockActive) descs.push({
    key: "attest",
    done: attestationReviewed,
    importance: "helpful",
    node: attestationReviewed ? (
      <Row
        icon={CheckListIcon}
        label="Services performed"
        control={
          <DoneEdit
            label={attestationSource === "claim_page" ? "Confirmed" : "Attested"}
            onEdit={onReviewAttestation}
          />
        }
      >
        {attestationSource === "claim_page"
          ? /* TODO(copy-proposal S292): provenance line pending approval. */
            "You confirmed these on the previous page."
          : undefined}
      </Row>
    ) : (
      <Row
        icon={CheckListIcon}
        label="Confirm the services"
        control={<AddButton label="Review" onClick={onReviewAttestation} />}
      >
        Confirm each billed service was actually performed — flag any that weren&apos;t.
      </Row>
    ),
  });

  // Provider address — only when THIS letter mails to the provider (S301).
  if (wantsProviderAddress) descs.push({
    key: "provider-addr",
    done: providerAddressOnFile,
    importance: "helpful",
    node: providerAddressOnFile ? (
      <Row icon={MapPinIcon} label="Provider address" control={<DoneEdit label="On file" onEdit={onAddProviderAddress} />} />
    ) : (
      <Row
        icon={MapPinIcon}
        label="Provider address"
        control={<AddButton label="Add" onClick={onAddProviderAddress} />}
      >
        The biller&apos;s mailing address — where a provider-directed letter is sent.
      </Row>
    ),
  });

  // Insurer appeals address — only when THIS letter mails to the insurer (S301);
  // legacy gate was merely "the claim has an insurer", which is true of provider
  // and collector letters too.
  if (wantsInsurerAddress && hasInsurer) {
    descs.push({
      key: "insurer-addr",
      done: insurerAddressOnFile,
      importance: "helpful",
      node: insurerAddressOnFile ? (
        <Row icon={MapPinIcon} label="Insurer appeals address" control={<DoneEdit label="On file" onEdit={onAddInsurerAddress} />} />
      ) : (
        <Row
          icon={MapPinIcon}
          label="Insurer appeals address"
          control={<AddButton label="Add" onClick={onAddInsurerAddress} />}
        >
          Your plan&apos;s appeals-department address — where the appeal is mailed.
        </Row>
      ),
    });
  }

  // ── Collections track (S301) — the two rows that never existed ────────────
  //
  // The collector's ADDRESS is what the debt-validation letter's recipient block
  // actually prints, and the account number is what every FDCPA dispute is keyed
  // on. Neither was offered anywhere: the collector was captured once inside
  // CollectorModal at escalation (name required, everything else optional) and
  // could never be edited afterwards.
  //
  // Both are CLAIM-scoped (`claims.metadata.collector`) exactly as the provider
  // contact is, so they cascade — the user types the agency once for the bill and
  // every later letter on it reads the same values.
  // ONE row for the collection agency (Andrew, S301 E2E). It was two — address
  // and account number — that opened the SAME modal, next to a contact-date row
  // that used a different inline editor: three rows, one action, two interaction
  // models. One row, one action, one modal.
  //
  // Done means BOTH required fields are on file: the address is what the letter
  // prints, the account number is what the dispute is keyed on. Either missing
  // and the row still needs the user, so a half-filled agency can never read as
  // complete.
  if (wantsCollectorAddress || wantsAccountNumber) {
    const agencyDone = collectorAddressOnFile && accountNumberOnFile;
    descs.push({
      key: "collector-details",
      done: agencyDone,
      importance: "important",
      node: agencyDone ? (
        <Row
          icon={MapPinIcon}
          label="Collection agency details"
          control={<DoneEdit label="On file" onEdit={() => onAddCollectorDetails?.()} />}
        />
      ) : (
        <Row
          icon={MapPinIcon}
          label="Collection agency details"
          badge={ImportantBadge}
          control={
            <AddButton
              label={collectorAddressOnFile || accountNumberOnFile ? "Finish" : "Add"}
              onClick={() => onAddCollectorDetails?.()}
            />
          }
        >
          Their mailing address and the account number for this debt — both are printed on the
          notice they sent you, and your letter needs both.
        </Row>
      ),
    });
  }

  // EOB line detail — a SUPPLEMENT to the bill. The bill already gives us the billed amounts
  // and (with plan details) the cost-share for the core math; the EOB only adds the insurer
  // paid/allowed side that powers the optional balance-billing clause. So it's Helpful, not
  // Important — never nag for it as if the letter can't be built without it.
  // S301: suppressed on the collections track — a debt-validation letter never
  // argues from the insurer's paid/allowed side.
  if (wantsEob) descs.push({
    key: "eob",
    done: eobPresent,
    importance: "helpful",
    node: eobPresent ? (
      <Row icon={ReceiptIcon} label="EOB detail" control={<DoneChip label="On file" />} />
    ) : (
      <Row
        icon={ReceiptIcon}
        label="EOB detail"
        control={<AddButton label="Upload" onClick={onUploadEob} />}
      >
        We already use your bill for the core math, but your insurer&apos;s EOB adds the paid/allowed side — important for balance-billing.
      </Row>
    ),
  });

  // Amount paid (expand-to-edit; unlocks a refund request).
  // S292 (#9) — the bill's parsed amount-paid (effectiveTotals / the S291
  // userPatientPaid override chain) prefills the row: one-click confirm writes it
  // as the override; the user never re-types a number the platform already read.
  const amountPrefill =
    userPatientPaid == null && billPatientPaid != null && billPatientPaid > 0
      ? Math.round(billPatientPaid * 100) / 100
      : null;
  descs.push({
    key: "amount",
    done: userPatientPaid != null,
    importance: "important",
    editorKey: "amount",
    node: (
      <Row
        icon={CashIcon}
        label="Amount you paid"
        badge={userPatientPaid == null && amountPrefill == null && openEditor !== "amount" ? ImportantBadge : undefined}
        control={
          openEditor === "amount" ? (
            <CancelLink onClick={close} />
          ) : userPatientPaid != null ? (
            <ValueEdit value={money(userPatientPaid)} onEdit={() => setOpenEditor("amount")} />
          ) : amountPrefill != null ? (
            <PrefilledConfirm
              value={money(amountPrefill)}
              onConfirm={() => onSaveAmountPaid(amountPrefill)}
              onEdit={() => setOpenEditor("amount")}
            />
          ) : (
            <AddButton label="Add" onClick={() => setOpenEditor("amount")} />
          )
        }
        below={
          openEditor === "amount" ? (
            <AmountEditor
              initial={userPatientPaid ?? amountPrefill}
              onSaved={async (a) => { await onSaveAmountPaid(a); close(); }}
            />
          ) : undefined
        }
      >
        {openEditor !== "amount" && userPatientPaid == null
          ? amountPrefill != null
            ? /* TODO(copy-proposal S292): provenance line pending approval. */
              "This total is from your bill. Confirm the amount or edit if incorrect."
            : "How much you've paid so far. If you overpaid, we add a refund request."
          : undefined}
      </Row>
    ),
  });

  // Denial-notice date (insurer track) — sets the appeal deadline.
  // S292 (#10) — when the EOB parser already read the notice date
  // (claims.metadata.eob_date), it prefills here: one-click confirm persists it;
  // Edit opens the date input seeded with it (parsed provenance, always editable).
  // No parsed date → the question renders exactly as before.
  const denialPrefillDate =
    denialNoticeDate == null && denialDatePrefill != null ? denialDatePrefill.date : null;
  if (insurerTrack) {
    descs.push({
      key: "denial",
      done: denialNoticeDate != null,
      importance: "important",
      editorKey: "denial",
      node: (
        <Row
          icon={CalendarIcon}
          label="Denial date"
          badge={denialNoticeDate == null && denialPrefillDate == null && openEditor !== "denial" ? ImportantBadge : undefined}
          control={
            openEditor === "denial" ? (
              <CancelLink onClick={close} />
            ) : denialNoticeDate != null ? (
              <ValueEdit value={prettyDate(denialNoticeDate)} onEdit={() => setOpenEditor("denial")} />
            ) : denialPrefillDate != null ? (
              <PrefilledConfirm
                value={prettyDate(denialPrefillDate)}
                onConfirm={() => onSaveDeadlineDate("denialNoticeDate", denialPrefillDate)}
                onEdit={() => setOpenEditor("denial")}
              />
            ) : (
              <AddButton label="Add" onClick={() => setOpenEditor("denial")} />
            )
          }
          below={
            openEditor === "denial" ? (
              <DateEditor
                initial={denialNoticeDate ?? denialPrefillDate}
                prompt="When did you receive the denial? Use the date printed on the insurer's denial letter."
                onSaved={async (v) => { await onSaveDeadlineDate("denialNoticeDate", v); close(); }}
              />
            ) : undefined
          }
        >
          {openEditor !== "denial" && denialNoticeDate == null
            ? denialPrefillDate != null
              ? /* S295 — approved. The prefill's only source is a parsed EOB
                   (claims.metadata.eob_date); a bill never carries this date,
                   so "from your bill" pointed at the wrong document. */
                "Date from your Explanation of Benefits. Confirm the date you received it, or edit if incorrect."
              : "The date printed on your insurer's denial letter — this sets your appeal deadline."
            : undefined}
        </Row>
      ),
    });
  }

  // Collector first-contact date (collections track) — 30-day validation window.
  if (collectorTrack) {
    descs.push({
      key: "collector",
      done: collectorFirstContactDate != null,
      importance: "important",
      editorKey: "collector",
      node: (
        <Row
          icon={CalendarIcon}
          label="Collector contact date"
          badge={collectorFirstContactDate == null && openEditor !== "collector" ? ImportantBadge : undefined}
          control={
            openEditor === "collector" ? (
              <CancelLink onClick={close} />
            ) : collectorFirstContactDate != null ? (
              <ValueEdit value={prettyDate(collectorFirstContactDate)} onEdit={() => setOpenEditor("collector")} />
            ) : (
              <AddButton label="Add" onClick={() => setOpenEditor("collector")} />
            )
          }
          below={
            openEditor === "collector" ? (
              <DateEditor
                initial={collectorFirstContactDate}
                prompt="When did the collector first contact you? Use the date of their first letter or call."
                onSaved={async (v) => { await onSaveDeadlineDate("collectorFirstContactDate", v); close(); }}
              />
            ) : undefined
          }
        >
          {collectorFirstContactDate == null && openEditor !== "collector"
            ? "The date the collector first contacted you — starts the 30-day validation window."
            : undefined}
        </Row>
      ),
    });
  }

  // ── counter + tier + grouping ──
  const completed = descs.filter((d) => d.done).length;
  const total = descs.length;

  // A value row whose editor is open renders full at the top even though it's "done".
  const isEditing = (d: RowDesc) => d.editorKey != null && openEditor === d.editorKey;
  const openDescs = descs
    .filter((d) => !d.done || isEditing(d))
    .sort((a, b) => (a.importance === b.importance ? 0 : a.importance === "important" ? -1 : 1));
  const doneDescs = descs.filter((d) => d.done && !isEditing(d));

  return (
    <section
      ref={sectionRef}
      // overflow-anchor:none — the browser's scroll anchoring counter-scrolls
      // when the Added fold loses a row mid-commit, negating the follow-the-
      // editor jump above; the panel opts out so the jump sticks.
      style={{ overflowAnchor: "none" }}
      className={
        embedded
          ? "bg-transparent"
          : "rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:p-6"
      }
    >
      <ReadinessHeader completed={completed} total={total} />

      <div className="mt-3">
        {/* S308 (Andrew) — the plan/insurance row is the ONE persistent row,
            pinned at the top: excluded from the counter, never folding, so
            nothing sits below Added but the footer actions. */}
        {/* Insurance for this claim — an action (excluded from the counter + readiness),
            shown only when a plan is bound (a missing-year claim is owned by VerifStrip). */}
        {showInsuranceRow ? (
          <Row
            icon={CardIcon}
            label="Insurance for this claim"
            control={
              // S266 (#1) — always show the CURRENT plan; add the Change action beside it
              // when re-pinning is enabled (was hiding the plan name behind the button).
              <div className="flex max-w-full flex-col items-end gap-1.5">
                {/* Container-safe cap (was 42vw — wider than the embedded
                    expansion, overlapping the label column). */}
                <span
                  className="max-w-[200px] truncate text-right text-[13px] text-gray-500 sm:max-w-[260px]"
                  title={planLabel ?? undefined}
                >
                  {planLabel ?? "—"}
                </span>
                {canChangePlan ? <AddButton label="Change" onClick={onChangePlan} /> : null}
              </div>
            }
          >
            {canChangePlan ? "Use a different plan for these dates." : undefined}
          </Row>
        ) : null}

        {openDescs.map((d) => (
          <div key={d.key} data-needs-editor-row={d.editorKey ?? undefined}>
            {d.node}
          </div>
        ))}

        <AddedFold count={doneDescs.length} open={showAdded} onToggle={() => setShowAdded((v) => !v)}>
          {doneDescs.map((d) => <Fragment key={d.key}>{d.node}</Fragment>)}
        </AddedFold>

      </div>
    </section>
  );
}

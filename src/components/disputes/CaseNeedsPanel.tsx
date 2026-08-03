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

import { Fragment, useState, type ReactNode } from "react";
import { Row } from "@/components/shared/InputRow";
import { PatientIdentityChoices } from "@/components/disputes/PatientIdentityChoices";
import {
  ServiceAttestationFlow,
  type AttestationLine,
} from "@/components/disputes/ServiceAttestationFlow";
import { letterNeeds, type LetterNeedKey } from "@/lib/disputes/letter-type";

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
 * S295 — the claim-details block's confirmation predicate, exported so the
 * UnifiedTodo row's done-state and the block's own rendering read the SAME
 * derivation rather than two that can drift (the S292 one-derivation
 * invariant). True once the services attestation has been reviewed AND no
 * parser-extracted plan cost is still awaiting a human confirmation.
 */
export function isClaimDetailsConfirmed(
  planServices: PlanCostService[],
  attestationReviewed: boolean,
): boolean {
  return attestationReviewed && unconfirmedParsedServices(planServices).length === 0;
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

const ImportantBadge = (
  <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
    Important
  </span>
);

// ── small controls ────────────────────────────────────────────────────────────
function DoneChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-medium text-emerald-600">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
      {label}
    </span>
  );
}
/** "<label> · Edit" — a resolved row that stays editable (addresses, name, attestation). */
function DoneEdit({ label, onEdit }: { label: string; onEdit: () => void }) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap">
      <span className="inline-flex items-center gap-1 text-[13px] font-medium text-emerald-600">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
        {label}
      </span>
      <button type="button" onClick={onEdit} className="text-[13px] font-medium text-blue-600 hover:text-blue-700">Edit</button>
    </span>
  );
}
function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-50"
    >
      {label}
    </button>
  );
}
function ValueEdit({ value, onEdit }: { value: string; onEdit: () => void }) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap">
      <span className="text-sm font-medium text-gray-900">{value}</span>
      <button type="button" onClick={onEdit} className="text-[13px] font-medium text-blue-600 hover:text-blue-700">Edit</button>
    </span>
  );
}
function CancelLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700">Cancel</button>
  );
}

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
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div>
      <div className="flex items-center gap-2">
        {PencilIcon}
        <h3 className="text-[15px] font-semibold text-gray-900">What we need from you</h3>
      </div>
      <p className="mt-1.5 text-[13px] text-gray-500">
        Add what you can — each item makes your letter stronger, and we&apos;ll use it right away.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-blue-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="whitespace-nowrap text-[12px] font-medium text-gray-500">
          {completed} of {total} added — each one makes the letter stronger
        </span>
      </div>
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
    embedded, letterType, planServices, nameMismatch, nameResolved, billName, profileName,
    attestationReviewed, attestationSource, hasInsurer, providerAddressOnFile, insurerAddressOnFile,
    eobPresent, userPatientPaid, billPatientPaid, denialNoticeDate, denialDatePrefill,
    collectorFirstContactDate,
    planLabel, showInsuranceRow, canChangePlan,
    coverageVerifyGaps, onCoverageVerify, rerunAuditEnabled, auditFindingsMissing, onAuditRerun,
    onAddPlanDetails, onConfirmParsedCosts, onRejectParsedCost, onResolvePatient, onEditLetter,
    onReviewAttestation,
    claimFacts, attestationLines, attestedLineItemIds, accountName, attestingAsName, onAttest,
    onAddProviderAddress, onAddInsurerAddress, onUploadEob, onSaveAmountPaid,
    onChangePlan, onSaveDeadlineDate,
    letterRequirementsOn = false,
    collectorAddressOnFile = false, accountNumberOnFile = false, onAddCollectorDetails,
  } = props;

  const [openEditor, setOpenEditor] = useState<EditorKey | null>(null);
  const [showAdded, setShowAdded] = useState(false);
  const [confirmAllStatus, setConfirmAllStatus] = useState<"idle" | "saving" | "error">("idle");
  // S293 (#5) — the one-block's "Something's wrong" expansion (per-item edits +
  // the didn't-receive attestation flow).
  const [detailsWrongMode, setDetailsWrongMode] = useState(false);
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
          Your plan&apos;s cost-share for this service — lets the letter quote your exact benefit.
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
    const detailsDone = isClaimDetailsConfirmed(planServices, attestationReviewed);
    const factsLine = [
      claimFacts.patientName ? `Patient: ${claimFacts.patientName}` : null,
      claimFacts.providerName ? `Provider: ${claimFacts.providerName}` : null,
      claimFacts.serviceDate ? `Service date: ${prettyDate(claimFacts.serviceDate)}` : null,
    ].filter(Boolean).join(" · ");
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
          await Promise.all(ops);
          setConfirmAllStatus("idle");
          setDetailsWrongMode(false);
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
  const parsedLineIds = new Set(
    aggregateActive || detailsBlockActive
      ? parsedSvcs.flatMap((s) => s.lineItemIds ?? [])
      : [],
  );
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
      <Row icon={UserIcon} label="Patient name" control={<DoneEdit label="Verified" onEdit={onEditLetter} />} />
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
      className={
        embedded
          ? "bg-transparent"
          : "rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:p-6"
      }
    >
      <ReadinessHeader completed={completed} total={total} />

      <div className="mt-3">
        {openDescs.map((d) => (
          <Fragment key={d.key}>{d.node}</Fragment>
        ))}

        {doneDescs.length > 0 ? (
          <div className="border-t border-gray-100">
            <button
              type="button"
              onClick={() => setShowAdded((v) => !v)}
              aria-expanded={showAdded}
              className="flex w-full items-center justify-between rounded-lg py-2.5 text-left transition-colors hover:bg-gray-50"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Added ({doneDescs.length})
              </span>
              <span className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-600">
                {showAdded ? "Hide" : "Show"}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  {...stroke}
                  className={`transition-transform ${showAdded ? "rotate-180" : ""}`}
                  aria-hidden
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>
            {showAdded ? doneDescs.map((d) => <Fragment key={d.key}>{d.node}</Fragment>) : null}
          </div>
        ) : null}

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
      </div>
    </section>
  );
}

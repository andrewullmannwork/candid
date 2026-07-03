/**
 * CaseNeedsPanel — dispute-letters v2 Zone-1 ("What we need from you", map §6).
 *
 * The single consolidated top-of-page widget listing every missing/confirmable input,
 * each row = icon + label + why-it-matters + a control. Reuses the shared Row/IconChip
 * primitive (same shape as the claim-page CostShareBanner). Reuse-first + delegate:
 * the panel owns only layout, the "N of M complete" counter, and the three INLINE inputs
 * (amount-paid + the two deadline dates, optimistic). Every other row delegates to an
 * existing handler/modal via a callback — no reimplementation of attestation, address,
 * plan-search, or the AddPlanDetailsModal flows.
 *
 * Render-when-applicable: rows appear based on the dispute's track (letterType), claim
 * linkage, and evidence — a done row still shows (with a check) so the user sees progress.
 */
"use client";

import { useState } from "react";
import { Row } from "@/components/shared/InputRow";

/** One disputed service's plan-cost state (derived from evidence line planBenefit). */
export interface PlanCostService {
  serviceSlug: string;
  serviceLabel: string;
  /** null when plan cost is unknown for this service (→ "Add plan details"). */
  known: boolean;
  copay: number | null;
  /** 0–100, already converted from the decimal stored on planBenefit. */
  coinsurancePercent: number | null;
  /** planBenefit.source — 'manual' → the user's own entry (editable); else read-only. */
  source: string | null;
}

export interface CaseNeedsPanelProps {
  claimId: string | null;
  letterType: string;
  planServices: PlanCostService[];
  nameMismatch: boolean;
  nameResolved: boolean;
  attestationReviewed: boolean;
  addressGap: boolean;
  addressOnFile: boolean;
  eobPresent: boolean;
  userPatientPaid: number | null;
  denialNoticeDate: string | null;
  collectorFirstContactDate: string | null;
  planLabel: string | null;
  canChangePlan: boolean;
  onAddPlanDetails: (svc: PlanCostService) => void;
  onConfirmName: () => void;
  onEditLetter: () => void;
  onReviewAttestation: () => void;
  onAddAddress: () => void;
  onUploadEob: () => void;
  onSaveAmountPaid: (amount: number | null) => Promise<void>;
  onChangePlan: () => void;
  onSaveDeadlineDate: (
    field: "denialNoticeDate" | "collectorFirstContactDate",
    value: string | null,
  ) => Promise<void>;
}

const INSURER_TRACK = new Set(["insurance_appeal", "final_notice", "external_review"]);
const todayIso = (): string => new Date().toISOString().slice(0, 10);
const money = (n: number): string => `$${n.toFixed(2)}`;

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

function DoneChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-700">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
      {label}
    </span>
  );
}

function ActionButton({ onClick, children, tone = "primary" }: { onClick: () => void; children: React.ReactNode; tone?: "primary" | "muted" }) {
  const cls =
    tone === "primary"
      ? "rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 hover:bg-blue-50"
      : "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50";
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** Inline optimistic amount-paid editor. Empty → clears the override (null). */
function AmountPaidControl({ current, onSave }: { current: number | null; onSave: (a: number | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current != null ? String(current) : "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async () => {
    const trimmed = value.trim();
    let amount: number | null;
    if (trimmed === "") amount = null;
    else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) { setStatus("error"); return; }
      amount = Math.round(n * 100) / 100;
    }
    setStatus("saving");
    try {
      await onSave(amount);
      setStatus("saved");
      setEditing(false);
      setTimeout(() => setStatus("idle"), 1600);
    } catch {
      setStatus("error");
    }
  };

  if (current != null && !editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{money(current)}</span>
        <ActionButton tone="muted" onClick={() => { setValue(String(current)); setEditing(true); }}>Edit</ActionButton>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[13px] text-gray-500">$</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => { setValue(e.target.value); if (status === "error") setStatus("idle"); }}
        placeholder="0.00"
        aria-label="Amount you paid"
        className="w-20 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-blue-400 focus:outline-none"
      />
      <button
        type="button"
        disabled={status === "saving"}
        onClick={save}
        className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "error" ? "Try again" : "Save"}
      </button>
    </div>
  );
}

/** Inline optimistic date editor (past-or-today), used for both deadline anchors. */
function DateControl({ current, onSave }: { current: string | null; onSave: (v: string | null) => Promise<void> }) {
  const [value, setValue] = useState(current ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async (next: string) => {
    setStatus("saving");
    try {
      await onSave(next === "" ? null : next);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1600);
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="date"
        max={todayIso()}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-blue-400 focus:outline-none"
      />
      <button
        type="button"
        disabled={status === "saving" || value === (current ?? "")}
        onClick={() => save(value)}
        className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
      >
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "error" ? "Try again" : "Save"}
      </button>
    </div>
  );
}

export function CaseNeedsPanel(props: CaseNeedsPanelProps) {
  const {
    letterType, planServices, nameMismatch, nameResolved, attestationReviewed,
    addressGap, addressOnFile, eobPresent, userPatientPaid, denialNoticeDate,
    collectorFirstContactDate, planLabel, canChangePlan,
    onAddPlanDetails, onConfirmName, onEditLetter, onReviewAttestation, onAddAddress,
    onUploadEob, onSaveAmountPaid, onChangePlan, onSaveDeadlineDate,
  } = props;

  const insurerTrack = INSURER_TRACK.has(letterType);
  const collectorTrack = letterType === "debt_validation";

  // Counter over "need" rows (the change-insurance action is excluded).
  const needs: boolean[] = [
    ...planServices.map((s) => s.known),
    !nameMismatch || nameResolved,
    attestationReviewed,
    addressOnFile,
    eobPresent,
    userPatientPaid != null,
    ...(insurerTrack ? [denialNoticeDate != null] : []),
    ...(collectorTrack ? [collectorFirstContactDate != null] : []),
  ];
  const completed = needs.filter(Boolean).length;
  const total = needs.length;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="text-blue-600" aria-hidden><path d="M12 20h9M4 20l1-4 10-10a2.1 2.1 0 013 3L8 19l-4 1z" /></svg>
          <h3 className="text-[15px] font-semibold text-gray-900">What we need from you</h3>
        </div>
        <span className="text-[13px] text-gray-500">{completed} of {total} complete</span>
      </div>
      <p className="mt-1 text-[13px] text-gray-600">
        Each item makes your letter stronger — add what you can and we&apos;ll use it right away.
      </p>

      <div className="mt-2">
        {/* Plan details — one row per disputed, slug'd service. */}
        {planServices.map((svc) =>
          svc.known ? (
            <Row
              key={`svc-${svc.serviceSlug}`}
              icon={ShieldIcon}
              label={`Plan cost for ${svc.serviceLabel}`}
              control={
                svc.source === "manual" ? (
                  <ActionButton tone="muted" onClick={() => onAddPlanDetails(svc)}>Edit</ActionButton>
                ) : (
                  <DoneChip label="On file" />
                )
              }
            >
              {svc.source === "manual"
                ? `You entered ${svc.copay != null ? `${money(svc.copay)} copay` : `${svc.coinsurancePercent}% coinsurance`}. Edit if that's not right.`
                : undefined}
            </Row>
          ) : (
            <Row
              key={`svc-${svc.serviceSlug}`}
              icon={ShieldIcon}
              label={`Add plan details for ${svc.serviceLabel}`}
              control={<ActionButton onClick={() => onAddPlanDetails(svc)}>Add ↗</ActionButton>}
            >
              Unlocks your exact cost-share + a plan-language quote in the letter.
            </Row>
          ),
        )}

        {/* Verify patient name. */}
        {nameMismatch && !nameResolved ? (
          <Row
            icon={UserIcon}
            label="Verify the patient name"
            control={
              <div className="flex items-center gap-2">
                <ActionButton onClick={onConfirmName}>This is me</ActionButton>
                <ActionButton tone="muted" onClick={onEditLetter}>Edit</ActionButton>
              </div>
            }
          >
            Confirm the bill&apos;s patient matches the person appealing.
          </Row>
        ) : (
          <Row icon={UserIcon} label="Patient name verified" control={<DoneChip label="Done" />} />
        )}

        {/* Attest services performed (delegates to the evidence attestation). */}
        {attestationReviewed ? (
          <Row icon={CheckListIcon} label="Services confirmed as performed" control={<DoneChip label="Attested" />} />
        ) : (
          <Row
            icon={CheckListIcon}
            label="Confirm the services were performed"
            control={<ActionButton onClick={onReviewAttestation}>Review</ActionButton>}
          >
            Flag anything you didn&apos;t actually receive so we don&apos;t dispute it wrongly.
          </Row>
        )}

        {/* Recipient address. */}
        {addressOnFile && !addressGap ? (
          <Row icon={MapPinIcon} label="Recipient address on file" control={<DoneChip label="Done" />} />
        ) : (
          <Row
            icon={MapPinIcon}
            label="Add the recipient's address"
            control={<ActionButton onClick={onAddAddress}>Add ↗</ActionButton>}
          >
            So the letter reaches the right department.
          </Row>
        )}

        {/* EOB line detail. */}
        {eobPresent ? (
          <Row icon={ReceiptIcon} label="EOB line detail on file" control={<DoneChip label="Done" />} />
        ) : (
          <Row
            icon={ReceiptIcon}
            label="Add EOB line detail"
            control={<ActionButton onClick={onUploadEob}>Upload EOB</ActionButton>}
          >
            Shows the exact billed vs. allowed vs. paid math in the letter.
          </Row>
        )}

        {/* Amount paid (inline, unlocks a refund request). */}
        <Row icon={CashIcon} label="Confirm the amount you paid" control={<AmountPaidControl current={userPatientPaid} onSave={onSaveAmountPaid} />}>
          {userPatientPaid == null ? "If you overpaid, we add a refund request." : undefined}
        </Row>

        {/* Denial-notice date (insurer track) — anchors the 180-day appeal window. */}
        {insurerTrack && (
          <Row
            icon={CalendarIcon}
            label="Date you received the denial"
            control={<DateControl current={denialNoticeDate} onSave={(v) => onSaveDeadlineDate("denialNoticeDate", v)} />}
          >
            {denialNoticeDate == null ? "Starts your 180-day appeal clock so we never file too late." : undefined}
          </Row>
        )}

        {/* Collector first-contact date (collections track) — 30-day validation window. */}
        {collectorTrack && (
          <Row
            icon={CalendarIcon}
            label="Date the collector first contacted you"
            control={<DateControl current={collectorFirstContactDate} onSave={(v) => onSaveDeadlineDate("collectorFirstContactDate", v)} />}
          >
            {collectorFirstContactDate == null ? "Starts the 30-day debt-validation window." : undefined}
          </Row>
        )}

        {/* Change insurance — an action, not a "need" (excluded from the counter). */}
        <Row
          icon={CardIcon}
          label="Insurance for this claim"
          control={
            canChangePlan ? (
              <ActionButton tone="muted" onClick={onChangePlan}>Change</ActionButton>
            ) : (
              <span className="text-[13px] text-gray-500">{planLabel ?? "—"}</span>
            )
          }
        >
          {canChangePlan ? "Use a different plan for this claim's dates." : undefined}
        </Row>
      </div>
    </section>
  );
}

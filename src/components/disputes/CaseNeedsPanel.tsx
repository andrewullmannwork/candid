/**
 * CaseNeedsPanel — dispute-letters v2 Zone-1 ("What we need from you", map §6).
 *
 * The single consolidated top-of-page widget: one card listing every missing/confirmable
 * input as an icon + label + (why) + control row, with an "N of M" completion pill. Reuses
 * the shared Row/IconChip primitive (same shape as the claim-page CostShareBanner).
 *
 * Reuse-first + delegate: the panel owns only layout, the counter, and the inline value
 * editors (amount-paid + the two deadline dates). Every other row delegates to an existing
 * handler/modal. The value rows use the claim-page "expand to edit" pattern — a compact
 * Add/Edit affordance that reveals a full-width editor BELOW the row (never a cramped
 * right-column input), so it reads clean and wraps on mobile.
 */
"use client";

import { useState } from "react";
import { Row } from "@/components/shared/InputRow";

/** One disputed service's plan-cost state (derived from evidence line planBenefit). */
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
}

export interface CaseNeedsPanelProps {
  letterType: string;
  planServices: PlanCostService[];
  nameMismatch: boolean;
  nameResolved: boolean;
  attestationReviewed: boolean;
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

type EditorKey = "amount" | "denial" | "collector";

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

// ── small controls ────────────────────────────────────────────────────────────
function DoneChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-medium text-emerald-600">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
      {label}
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

/** Full-width editor panel shared by the value rows — wraps on mobile. */
function EditorShell({ prompt, children }: { prompt: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5">
      <p className="mb-2.5 text-[13px] font-medium text-gray-800">{prompt}</p>
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
      <div className="flex flex-wrap items-center gap-2">
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
      <div className="flex flex-wrap items-center gap-2">
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

export function CaseNeedsPanel(props: CaseNeedsPanelProps) {
  const {
    letterType, planServices, nameMismatch, nameResolved, attestationReviewed,
    addressOnFile, eobPresent, userPatientPaid, denialNoticeDate,
    collectorFirstContactDate, planLabel, canChangePlan,
    onAddPlanDetails, onConfirmName, onEditLetter, onReviewAttestation, onAddAddress,
    onUploadEob, onSaveAmountPaid, onChangePlan, onSaveDeadlineDate,
  } = props;

  const [openEditor, setOpenEditor] = useState<EditorKey | null>(null);
  const close = () => setOpenEditor(null);

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
  const allDone = completed === total && total > 0;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} className="text-blue-600" aria-hidden><path d="M12 20h9M4 20l1-4 10-10a2.1 2.1 0 013 3L8 19l-4 1z" /></svg>
          <h3 className="text-[15px] font-semibold text-gray-900">What we need from you</h3>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${
            allDone ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"
          }`}
        >
          {completed} of {total}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-gray-500">
        Add what you can — each item makes your letter stronger, and we&apos;ll use it right away.
      </p>

      <div className="mt-1.5">
        {/* Plan details — one row per disputed, slug'd service. */}
        {planServices.map((svc) =>
          svc.known ? (
            <Row
              key={`svc-${svc.serviceSlug}`}
              icon={ShieldIcon}
              label={`Plan cost — ${svc.serviceLabel}`}
              control={
                svc.source === "manual" ? (
                  <ValueEdit
                    value={svc.copay != null ? `${money(svc.copay)} copay` : `${svc.coinsurancePercent}% coinsurance`}
                    onEdit={() => onAddPlanDetails(svc)}
                  />
                ) : (
                  <DoneChip label="On file" />
                )
              }
            />
          ) : (
            <Row
              key={`svc-${svc.serviceSlug}`}
              icon={ShieldIcon}
              label={`Add plan cost — ${svc.serviceLabel}`}
              control={<AddButton label="Add" onClick={() => onAddPlanDetails(svc)} />}
            >
              Adds your plan&apos;s cost-share to the letter.
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
                <AddButton label="This is me" onClick={onConfirmName} />
                <button type="button" onClick={onEditLetter} className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700">Edit</button>
              </div>
            }
          >
            Make sure the bill&apos;s patient is you.
          </Row>
        ) : (
          <Row icon={UserIcon} label="Patient name" control={<DoneChip label="Verified" />} />
        )}

        {/* Attest services performed (delegates to the evidence attestation). */}
        {attestationReviewed ? (
          <Row icon={CheckListIcon} label="Services performed" control={<DoneChip label="Attested" />} />
        ) : (
          <Row
            icon={CheckListIcon}
            label="Confirm the services"
            control={<AddButton label="Review" onClick={onReviewAttestation} />}
          >
            Tell us if a service wasn&apos;t actually done.
          </Row>
        )}

        {/* Recipient address. */}
        {addressOnFile ? (
          <Row icon={MapPinIcon} label="Recipient address" control={<DoneChip label="On file" />} />
        ) : (
          <Row
            icon={MapPinIcon}
            label="Recipient address"
            control={<AddButton label="Add" onClick={onAddAddress} />}
          >
            So the letter reaches the right office.
          </Row>
        )}

        {/* EOB line detail. */}
        {eobPresent ? (
          <Row icon={ReceiptIcon} label="EOB detail" control={<DoneChip label="On file" />} />
        ) : (
          <Row
            icon={ReceiptIcon}
            label="EOB detail"
            control={<AddButton label="Upload" onClick={onUploadEob} />}
          >
            Adds the billed-vs-paid breakdown.
          </Row>
        )}

        {/* Amount paid (expand-to-edit; unlocks a refund request). */}
        <Row
          icon={CashIcon}
          label="Amount you paid"
          control={
            openEditor === "amount" ? (
              <CancelLink onClick={close} />
            ) : userPatientPaid != null ? (
              <ValueEdit value={money(userPatientPaid)} onEdit={() => setOpenEditor("amount")} />
            ) : (
              <AddButton label="Add" onClick={() => setOpenEditor("amount")} />
            )
          }
          below={
            openEditor === "amount" ? (
              <AmountEditor
                initial={userPatientPaid}
                onSaved={async (a) => { await onSaveAmountPaid(a); close(); }}
              />
            ) : undefined
          }
        >
          {userPatientPaid == null && openEditor !== "amount" ? "If you overpaid, we'll ask for a refund." : undefined}
        </Row>

        {/* Denial-notice date (insurer track) — sets the appeal deadline. */}
        {insurerTrack && (
          <Row
            icon={CalendarIcon}
            label="Denial date"
            control={
              openEditor === "denial" ? (
                <CancelLink onClick={close} />
              ) : denialNoticeDate != null ? (
                <ValueEdit value={prettyDate(denialNoticeDate)} onEdit={() => setOpenEditor("denial")} />
              ) : (
                <AddButton label="Add" onClick={() => setOpenEditor("denial")} />
              )
            }
            below={
              openEditor === "denial" ? (
                <DateEditor
                  initial={denialNoticeDate}
                  prompt="When did you receive the denial?"
                  onSaved={async (v) => { await onSaveDeadlineDate("denialNoticeDate", v); close(); }}
                />
              ) : undefined
            }
          >
            {denialNoticeDate == null && openEditor !== "denial" ? "Sets your appeal deadline." : undefined}
          </Row>
        )}

        {/* Collector first-contact date (collections track) — 30-day validation window. */}
        {collectorTrack && (
          <Row
            icon={CalendarIcon}
            label="Collector contact date"
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
                  prompt="When did the collector first contact you?"
                  onSaved={async (v) => { await onSaveDeadlineDate("collectorFirstContactDate", v); close(); }}
                />
              ) : undefined
            }
          >
            {collectorFirstContactDate == null && openEditor !== "collector" ? "Sets the 30-day validation window." : undefined}
          </Row>
        )}

        {/* Change insurance — an action, not a "need" (excluded from the counter). */}
        <Row
          icon={CardIcon}
          label="Insurance for this claim"
          control={
            canChangePlan ? (
              <AddButton label="Change" onClick={onChangePlan} />
            ) : (
              <span className="max-w-[45vw] truncate text-[13px] text-gray-500">{planLabel ?? "—"}</span>
            )
          }
        >
          {canChangePlan ? "Use a different plan for these dates." : undefined}
        </Row>
      </div>
    </section>
  );
}

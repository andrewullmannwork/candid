/**
 * CaseNeedsPanel — dispute-letters v2 Zone-1 ("What we need from you", map §6).
 *
 * The single consolidated top-of-page widget: one card listing every missing/confirmable
 * input as an icon + label + (why) + control row. Reuses the shared Row/IconChip primitive
 * (same shape as the claim-page CostShareBanner).
 *
 * S265 refinements:
 *  - Unified readiness indicator at the top (one pill + meter) — replaces the separate
 *    ReadinessRail. Spans the required floor ("Not ready" until a recipient address /
 *    backed line exists → from the backend `strength.readiness`) and the soft strengtheners
 *    ("Ready to send" → "Strong" → "Airtight" as plan cost / EOB / amount / denial land).
 *  - Per-row importance: high-impact evidence inputs carry an "Important" chip.
 *  - De-clutter: incomplete rows (important-first) render full at the top; completed rows
 *    sink to an "Added" group below, each still editable.
 *  - Editable-after-verify: the confirmed name + attested-services rows expose an Edit.
 *
 * Reuse-first + delegate: the panel owns only layout, the readiness computation, and the
 * inline value editors (amount-paid + the two deadline dates). Every other row delegates to
 * an existing handler/modal.
 */
"use client";

import { Fragment, useState, type ReactNode } from "react";
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
  billName: string | null;
  profileName: string | null;
  attestationReviewed: boolean;
  hasInsurer: boolean;
  providerAddressOnFile: boolean;
  insurerAddressOnFile: boolean;
  eobPresent: boolean;
  userPatientPaid: number | null;
  denialNoticeDate: string | null;
  collectorFirstContactDate: string | null;
  planLabel: string | null;
  showInsuranceRow: boolean;
  canChangePlan: boolean;
  /**
   * The backend-computed readiness floor (`strength.readiness`) — drives the bottom rung
   * of the unified indicator (can the letter be credibly sent at all). Null when the
   * strength payload is absent → the panel falls back to a name+address heuristic.
   */
  readiness: {
    state: "attention" | "ready_to_send" | "airtight";
    requiredMet: number;
    requiredTotal: number;
  } | null;
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
  onConfirmName: () => void;
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
}

type EditorKey = "amount" | "denial" | "collector";
type Importance = "important" | "helpful";

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

// ── unified readiness ladder ──────────────────────────────────────────────────
type Tier = "not_ready" | "ready" | "strong" | "airtight";
const TIER_META: Record<Tier, { label: string; pill: string; bar: string }> = {
  not_ready: { label: "Not ready to send", pill: "border-amber-200 bg-amber-50 text-amber-800", bar: "bg-amber-400" },
  ready: { label: "Ready to send", pill: "border-blue-200 bg-blue-50 text-blue-700", bar: "bg-blue-500" },
  strong: { label: "Strong", pill: "border-indigo-200 bg-indigo-50 text-indigo-700", bar: "bg-indigo-500" },
  airtight: { label: "Airtight", pill: "border-emerald-200 bg-emerald-50 text-emerald-700", bar: "bg-emerald-500" },
};

/**
 * The four-rung tier. `floorMet` = the required-to-send floor is satisfied (a recipient
 * address + a backed line, per the backend readiness state). Above the floor the soft
 * strengtheners (weighted: Important ×2, Helpful ×1) push Ready → Strong → Airtight.
 */
export function computeTier(
  floorMet: boolean,
  items: Array<{ done: boolean; importance: Importance }>,
): Tier {
  if (!floorMet) return "not_ready";
  const w = (imp: Importance) => (imp === "important" ? 2 : 1);
  const totalW = items.reduce((s, i) => s + w(i.importance), 0);
  const doneW = items.reduce((s, i) => s + (i.done ? w(i.importance) : 0), 0);
  const frac = totalW === 0 ? 1 : doneW / totalW;
  if (frac >= 1) return "airtight";
  if (frac >= 0.5) return "strong";
  return "ready";
}

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

/** Header: title + the unified readiness pill + a thin completion meter. */
function ReadinessHeader({ tier, completed, total }: { tier: Tier; completed: number; total: number }) {
  const meta = TIER_META[tier];
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {PencilIcon}
          <h3 className="text-[15px] font-semibold text-gray-900">What we need from you</h3>
        </div>
        <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${meta.pill}`}>
          {meta.label}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] text-gray-500">
        Add what you can — each item makes your letter stronger, and we&apos;ll use it right away.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full transition-all ${meta.bar}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="whitespace-nowrap text-[12px] font-medium text-gray-500">{completed} of {total} added</span>
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
    letterType, planServices, nameMismatch, nameResolved, billName, profileName,
    attestationReviewed, hasInsurer, providerAddressOnFile, insurerAddressOnFile,
    eobPresent, userPatientPaid, denialNoticeDate, collectorFirstContactDate,
    planLabel, showInsuranceRow, canChangePlan, readiness,
    coverageVerifyGaps, onCoverageVerify, rerunAuditEnabled, auditFindingsMissing, onAuditRerun,
    onAddPlanDetails, onConfirmName, onEditLetter, onReviewAttestation,
    onAddProviderAddress, onAddInsurerAddress, onUploadEob, onSaveAmountPaid,
    onChangePlan, onSaveDeadlineDate,
  } = props;

  const [openEditor, setOpenEditor] = useState<EditorKey | null>(null);
  const [showAdded, setShowAdded] = useState(false);
  const close = () => setOpenEditor(null);

  const insurerTrack = INSURER_TRACK.has(letterType);
  const collectorTrack = letterType === "debt_validation";
  const nameDone = !nameMismatch || nameResolved;

  // ── row descriptors (each carries done-ness + importance so we can order + group) ──
  const descs: RowDesc[] = [];

  // Plan details — one row per disputed, slug'd service.
  for (const svc of planServices) {
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

  // Coverage-verify gates (moved from EvidenceGaps into Zone-1, S265) — open when present.
  for (const g of coverageVerifyGaps) {
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
            <AddButton label="This is me" onClick={onConfirmName} />
            <button type="button" onClick={onEditLetter} className="whitespace-nowrap text-[13px] font-medium text-gray-500 hover:text-gray-700">Edit</button>
          </div>
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
  descs.push({
    key: "attest",
    done: attestationReviewed,
    importance: "helpful",
    node: attestationReviewed ? (
      <Row icon={CheckListIcon} label="Services performed" control={<DoneEdit label="Attested" onEdit={onReviewAttestation} />} />
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

  // Provider address — always relevant (there's always a biller).
  descs.push({
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

  // Insurer appeals address — only when the claim has an insurer.
  if (hasInsurer) {
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

  // EOB line detail — a SUPPLEMENT to the bill. The bill already gives us the billed amounts
  // and (with plan details) the cost-share for the core math; the EOB only adds the insurer
  // paid/allowed side that powers the optional balance-billing clause. So it's Helpful, not
  // Important — never nag for it as if the letter can't be built without it.
  descs.push({
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
  descs.push({
    key: "amount",
    done: userPatientPaid != null,
    importance: "important",
    editorKey: "amount",
    node: (
      <Row
        icon={CashIcon}
        label="Amount you paid"
        badge={userPatientPaid == null && openEditor !== "amount" ? ImportantBadge : undefined}
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
        {userPatientPaid == null && openEditor !== "amount"
          ? "How much you've paid so far. If you overpaid, we add a refund request."
          : undefined}
      </Row>
    ),
  });

  // Denial-notice date (insurer track) — sets the appeal deadline.
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
          badge={denialNoticeDate == null && openEditor !== "denial" ? ImportantBadge : undefined}
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
                prompt="When did you receive the denial? Use the date printed on the insurer's denial letter."
                onSaved={async (v) => { await onSaveDeadlineDate("denialNoticeDate", v); close(); }}
              />
            ) : undefined
          }
        >
          {denialNoticeDate == null && openEditor !== "denial"
            ? "The date printed on your insurer's denial letter — this sets your appeal deadline."
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
  const floorMet = readiness
    ? readiness.state !== "attention"
    : nameDone && (providerAddressOnFile || (hasInsurer && insurerAddressOnFile));
  const tier = computeTier(floorMet, descs.map((d) => ({ done: d.done, importance: d.importance })));

  // A value row whose editor is open renders full at the top even though it's "done".
  const isEditing = (d: RowDesc) => d.editorKey != null && openEditor === d.editorKey;
  const openDescs = descs
    .filter((d) => !d.done || isEditing(d))
    .sort((a, b) => (a.importance === b.importance ? 0 : a.importance === "important" ? -1 : 1));
  const doneDescs = descs.filter((d) => d.done && !isEditing(d));

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:p-6">
      <ReadinessHeader tier={tier} completed={completed} total={total} />

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
              <div className="flex flex-col items-end gap-1.5">
                <span className="max-w-[42vw] truncate text-right text-[13px] text-gray-500">{planLabel ?? "—"}</span>
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

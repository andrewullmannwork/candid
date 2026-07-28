/**
 * CostShareBanner — Cost-Share v2 (W2 + W3), the §5 "one card per bill" surface.
 *
 * One unified card, universal across verdicts: only the header (icon color +
 * headline + body) changes per verdict (V0–V4); the "WHAT WE ASSUMED" editor is
 * shared. The user corrects each assumption inline — the bidirectional network /
 * deductible / OOP toggles + the plain-English ACA question. Toggles flip
 * OPTIMISTICALLY (instant); the override POST + refetch run in the background and
 * reconcile the card to server truth (or revert on error). Copy is LOCKED in
 * plans/cost_share_v2_plan_2026-06-23.md §5 + §14 (ACA).
 *
 * This card carries the verdict + Verified stamp itself, so it replaces the
 * legacy CleanBody/ReviewBody and sits BELOW the line-items table.
 *
 * Flag-gated upstream: parent only renders this when `data.costShareBill` is
 * present (recovery_cost_share_v2 ON). OFF → absent → today's UI.
 */
"use client";

import { useState, type ReactNode } from "react";
import type { CostShareAssumption, CostShareOverrides } from "@/lib/claims/recovery-math";
import { Row, IconChip } from "@/components/shared/InputRow";

export type CostShareVerdict =
  | "confident"
  | "correct"
  | "recovery"
  | "not_covered"
  | "insufficient";

export interface BannerAssumption extends CostShareAssumption {
  lineId: string;
  serviceLabel: string;
  serviceSlug: string | null;
}

export type CostShareOverrideRequest =
  | { field: "network"; value: "in_network" | "out_of_network" }
  | { field: "deductible_met"; met: boolean; asOf: string | null }
  | { field: "oop_met"; met: boolean; asOf: string | null }
  | { field: "aca"; status: "confirmed" | "non_aca" };

interface CostShareBannerProps {
  verdict: CostShareVerdict;
  assumptions: BannerAssumption[];
  overrides: CostShareOverrides | null;
  recoverable: number;
  correctShare: number;
  charged: number;
  fmtMoney: (n: number) => string;
  onOverride: (body: CostShareOverrideRequest, pendingKey: string) => void;
  /** reserved — the toggle is optimistic so no per-chip spinner is shown. */
  pendingKey: string | null;
  errorMsg: string | null;
  onShouldBeCovered: () => void;
  /** S290 — carries WHICH chip was clicked so the modal preselects that
   *  service (the old zero-arg form always targeted bannerTargetLineId,
   *  which mis-saved the answer under a different line's service). */
  onAddPlanDetails: (target?: { lineId?: string | null; serviceSlug?: string | null }) => void;
  /** S263 — the user's OWN entered cost-share for the disputed service
   *  (plan_covered_services.source='manual'). Present → a persistent "Plan cost ·
   *  $X · Edit" row so they can correct their own mistake. Null when unknown (the
   *  Add-details gap) or plan-doc-parsed (authoritative → read-only). */
  editableServiceCost?: { serviceLabel: string; copay: number | null; coinsurancePercent: number | null; lineId?: string | null } | null;
  onUploadEob: () => void;
  onBack: () => void;
  /** Surface 3 (clarity redesign) — "assumptions" renders ONLY the editable
   *  "What we assumed" rows (no verdict header, no clean-state outro): the
   *  flagged-bill step rail carries the verdict in step 1, so step 2 embeds
   *  just this card. Default "full" is the standalone verdict card. */
  variant?: "full" | "assumptions";
}

/**
 * True when the banner has ANY assumption content to edit — open rows,
 * already-resolved overrides (re-editable via "Update assumptions"), or the
 * user's own editable service cost. The flagged step rail uses this to decide
 * whether the "Verify our assumptions" step exists at all.
 */
export function hasAssumptionRows(
  assumptions: CostShareAssumption[],
  overrides: CostShareOverrides | null,
  editableServiceCost?: { serviceLabel: string } | null,
): boolean {
  const has = (field: string) => assumptions.some((a) => a.field === field);
  return (
    has("network") ||
    has("deductible_met") ||
    has("oop_met") ||
    has("aca_preventive") ||
    has("service_cost") ||
    overrides?.userNetworkOverride != null ||
    overrides?.deductibleMet != null ||
    overrides?.oopMet != null ||
    !!editableServiceCost
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "this bill's date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "this bill's date";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const NUMBER_WORD: Record<number, string> = { 2: "two", 3: "three", 4: "four", 5: "five" };

// ── presentational helpers (Row + IconChip now shared: @/components/shared/InputRow) ──

const GlobeIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
  </svg>
);
const DollarIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
  </svg>
);
const DocIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" />
  </svg>
);

interface Seg {
  label: string; // shown when this side is the active (current) one
  prompt: string; // shown when this side is the inactive switch-to option (carries the ?)
  active: boolean;
  onSelect: () => void; // fired when the inactive side is clicked
}

/** Stable two-segment switch: positions never move; the highlight + the "?" toggle. */
function Toggle({ left, right }: { left: Seg; right: Seg }) {
  return (
    <div className="inline-flex flex-none items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5 text-[13px]">
      <Segment seg={left} />
      <Segment seg={right} />
    </div>
  );
}
function Segment({ seg }: { seg: Seg }) {
  if (seg.active) {
    return <span className="rounded-md bg-white px-3 py-1.5 font-medium text-emerald-700 shadow-sm">{seg.label}</span>;
  }
  return (
    <button type="button" onClick={seg.onSelect} className="rounded-md px-3 py-1.5 font-medium text-blue-600 hover:text-blue-800">
      {seg.prompt}
    </button>
  );
}

// ── main ────────────────────────────────────────────────────────────────────

interface Optimistic {
  network?: "in_network" | "out_of_network";
  deductibleMet?: boolean;
  deductibleMetAsOf?: string | null;
  oopMet?: boolean;
  oopMetAsOf?: string | null;
}

export function CostShareBanner({
  verdict,
  assumptions,
  overrides,
  recoverable,
  correctShare,
  charged,
  fmtMoney,
  onOverride,
  errorMsg,
  onShouldBeCovered,
  onAddPlanDetails,
  editableServiceCost,
  onUploadEob,
  onBack,
  variant = "full",
}: CostShareBannerProps) {
  const assumptionsOnly = variant === "assumptions";
  const [acaDismissed, setAcaDismissed] = useState(false);
  const [editAll, setEditAll] = useState(false); // "Update assumptions" re-opens resolved rows for re-edit
  const [dismissed, setDismissed] = useState(false); // "Done" collapses the section (accept as-is)
  const [optimistic, setOptimistic] = useState<Optimistic>({});

  // Reconcile during render (not in an effect — that trips set-state-in-effect):
  // if a save errors, drop the optimistic overlay so the toggle snaps back to
  // server truth. On success the overlay just matches the refreshed props
  // (display = optimistic ?? props), so no explicit clear is needed.
  const [seenError, setSeenError] = useState<string | null>(errorMsg);
  if (errorMsg !== seenError) {
    setSeenError(errorMsg);
    if (errorMsg) setOptimistic({});
  }

  const money = (n: number) => `$${fmtMoney(n)}`;

  const networkA = assumptions.find((a) => a.field === "network");
  const deductibleA = assumptions.find((a) => a.field === "deductible_met");
  const oopA = assumptions.find((a) => a.field === "oop_met");
  const acaA = assumptions.find((a) => a.field === "aca_preventive");
  const serviceCostChips = (() => {
    const seen = new Set<string>();
    const out: BannerAssumption[] = [];
    for (const a of assumptions) {
      if (a.field !== "service_cost") continue;
      const key = a.serviceSlug ?? a.serviceLabel;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  })();

  // Display values: optimistic overlay wins until the refetch reconciles it.
  const oonDisplay = optimistic.network !== undefined ? optimistic.network === "out_of_network" : overrides?.userNetworkOverride === "out_of_network";
  const dedMetDisplay = optimistic.deductibleMet ?? overrides?.deductibleMet === true;
  const dedAsOfDisplay = optimistic.deductibleMetAsOf ?? overrides?.deductibleMetAsOf ?? null;
  const oopMetDisplay = optimistic.oopMet ?? overrides?.oopMet === true;
  const oopAsOfDisplay = optimistic.oopMetAsOf ?? overrides?.oopMetAsOf ?? null;
  const networkLabel = oonDisplay ? "out-of-network" : "in-network";

  const selectNetwork = (value: "in_network" | "out_of_network") => {
    setOptimistic((o) => ({ ...o, network: value }));
    onOverride({ field: "network", value }, "network");
  };
  const selectDeductible = (met: boolean, asOf: string | null) => {
    setOptimistic((o) => ({ ...o, deductibleMet: met, deductibleMetAsOf: asOf }));
    onOverride({ field: "deductible_met", met, asOf }, "deductible");
  };
  const selectOop = (met: boolean, asOf: string | null) => {
    setOptimistic((o) => ({ ...o, oopMet: met, oopMetAsOf: asOf }));
    onOverride({ field: "oop_met", met, asOf }, "oop");
  };
  const answerAca = (status: "confirmed" | "non_aca") => {
    setAcaDismissed(true); // hide instantly; refetch removes the assumption
    onOverride({ field: "aca", status }, "aca");
  };

  // An assumption is "resolved" once the user picks it (override present —
  // optimistic or persisted). Resolved rows DISAPPEAR from the list; the
  // "Update assumptions" control re-opens them all (saved values) to re-select.
  const netResolved = optimistic.network !== undefined || overrides?.userNetworkOverride != null;
  const dedResolved = optimistic.deductibleMet !== undefined || overrides?.deductibleMet != null;
  const oopResolved = optimistic.oopMet !== undefined || overrides?.oopMet != null;
  const networkExists = !!networkA || netResolved;
  const deductibleExists = !!deductibleA || dedResolved;
  const oopExists = !!oopA || oopResolved;

  const showNetwork = networkExists && (!netResolved || editAll);
  const showDeductible = deductibleExists && (!dedResolved || editAll);
  const showOop = oopExists && (!oopResolved || editAll);
  const showAca = !!acaA && !acaDismissed;
  const hasServiceCostGap = serviceCostChips.length > 0;
  // S263 — the user's own manual cost-share is EDITABLE (correct a mistake); a
  // plan-doc/parsed cost is authoritative and read-only (gated in the parent).
  const hasEditableCost = !!editableServiceCost;

  // pending = assumptions still awaiting a first pick (drives the headline copy).
  const pendingCount =
    ((networkExists && !netResolved) ? 1 : 0) +
    ((deductibleExists && !dedResolved) ? 1 : 0) +
    ((oopExists && !oopResolved) ? 1 : 0) +
    serviceCostChips.length +
    (showAca ? 1 : 0);
  const rawSectionHasRows = showNetwork || showDeductible || showOop || hasServiceCostGap || showAca || hasEditableCost;
  // Section is OPEN unless the user dismissed it via "Done"; when closed but
  // assumptions exist, "Update assumptions" brings it back.
  const sectionOpen = !dismissed && rawSectionHasRows;
  const anyAssumptions = networkExists || deductibleExists || oopExists || hasServiceCostGap || !!acaA || hasEditableCost;
  const showUpdateLink = !sectionOpen && anyAssumptions;
  const effectivePending = sectionOpen ? pendingCount : 0;
  const isClean = verdict === "correct" || verdict === "confident";

  let headline = "";
  let body: ReactNode = "";
  if (isClean) {
    headline = "This bill checks out";
    if (effectivePending === 0) {
      body = "What you were charged lines up with what your plan says you owe.";
    } else if (effectivePending === 1) {
      body = (
        <>What you were charged lines up with what your plan says you owe — <span className="font-medium text-gray-900">as long as the detail below is right.</span></>
      );
    } else {
      const word = NUMBER_WORD[effectivePending] ?? String(effectivePending);
      body = (
        <>What you were charged lines up with what your plan says you owe — <span className="font-medium text-gray-900">as long as the {word} details below are right.</span></>
      );
    }
  } else if (verdict === "recovery") {
    headline = `You may be able to recover ${money(recoverable)}`;
    body = `Your plan puts your share around ${money(correctShare)}, but this bill charges you ${money(charged)}.${sectionOpen ? " Here's what we based that on:" : ""}`;
  } else if (verdict === "not_covered") {
    headline = "This charge is expected";
    body = "Your plan doesn't cover this service, so this cost is yours — nothing to dispute. If you believe it should be covered, tell us and we'll take another look.";
  } else {
    headline = "We can't fully check this one yet";
    body = "We're missing your plan's cost for this service, and we won't flag a dispute we can't back up. Add it and we'll run the numbers.";
  }

  const headChip: Record<CostShareVerdict, ReactNode> = {
    correct: <CheckGlyph />, confident: <CheckGlyph />,
    recovery: <span className="text-lg font-semibold">$</span>,
    not_covered: <InfoGlyph />, insufficient: <span className="text-base font-semibold">?</span>,
  };
  const headChipBg: Record<CostShareVerdict, string> = {
    correct: "bg-emerald-600 text-white", confident: "bg-emerald-600 text-white",
    recovery: "bg-amber-500 text-white", not_covered: "bg-gray-400 text-white", insufficient: "bg-blue-500 text-white",
  };

  return (
    <>
      <div
        className={
          assumptionsOnly
            ? "overflow-hidden rounded-[18px] border border-gray-200 bg-white"
            : "mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white"
        }
      >
        {!assumptionsOnly && (
          <div className="flex items-start justify-between gap-3 px-5 py-4">
            <div className="flex items-start gap-3.5">
              <div className={`grid h-[42px] w-[42px] flex-none place-items-center rounded-xl ${headChipBg[verdict]}`}>{headChip[verdict]}</div>
              <div>
                <div className="text-[17px] font-semibold tracking-[-0.01em] text-gray-900">{headline}</div>
                <div className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-gray-600">{body}</div>
              </div>
            </div>
            {isClean && (
              <div className="flex flex-none items-center gap-1 rounded-full border border-emerald-300 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
                <CheckGlyph small /> Verified
              </div>
            )}
          </div>
        )}

        {sectionOpen && (
          <div
            className={
              assumptionsOnly
                ? // First row's border-t would read as a stray card edge right
                  // under the container's own border — suppress it.
                  "px-5 pb-4 pt-1.5 [&>div:first-child]:border-t-0"
                : "px-5 pb-4"
            }
          >
            {!assumptionsOnly && (
              <div className="border-t border-gray-100 pt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">What we assumed</div>
            )}

            {showNetwork && (
              <Row
                icon={GlobeIcon}
                label="Network"
                control={
                  <Toggle
                    left={{ label: "In-network", prompt: "In-network?", active: !oonDisplay, onSelect: () => selectNetwork("in_network") }}
                    right={{ label: "Out-of-network", prompt: "Out-of-network?", active: oonDisplay, onSelect: () => selectNetwork("out_of_network") }}
                  />
                }
              >
                {oonDisplay ? "You set this visit to out-of-network." : "This visit was billed by an in-network provider."}
              </Row>
            )}

            {showDeductible && (
              <MetRow kind="deductible" isMet={dedMetDisplay} metAsOf={dedAsOfDisplay} amount={deductibleA?.value ?? null} networkLabel={networkLabel} money={money} onSubmit={selectDeductible} />
            )}

            {showOop && (
              <MetRow kind="oop" isMet={oopMetDisplay} metAsOf={oopAsOfDisplay} amount={oopA?.value ?? null} networkLabel={networkLabel} money={money} onSubmit={selectOop} />
            )}

            {serviceCostChips.map((chip, i) => (
              <Row
                key={`service_cost-${chip.lineId}-${i}`}
                icon={DocIcon}
                label="Plan cost"
                control={
                  <button type="button" onClick={() => onAddPlanDetails({ lineId: chip.lineId, serviceSlug: chip.serviceSlug })} className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 hover:bg-blue-50">Add details</button>
                }
              >
                We don&apos;t have your plan&apos;s cost for {chip.serviceLabel} yet, so this is a conservative estimate.
              </Row>
            ))}

            {editableServiceCost && (
              <Row
                icon={DocIcon}
                label="Plan cost"
                control={
                  <button type="button" onClick={() => onAddPlanDetails({ lineId: editableServiceCost.lineId ?? null })} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50">Edit</button>
                }
              >
                You told us your plan&apos;s cost for {editableServiceCost.serviceLabel} is{" "}
                {editableServiceCost.copay != null
                  ? `$${editableServiceCost.copay} copay`
                  : `${editableServiceCost.coinsurancePercent}% coinsurance`}. Edit if that&apos;s not right.
              </Row>
            )}

            {showAca && (
              <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-[13px] text-blue-900">
                <p className="leading-relaxed">
                  Most health plans must cover preventive care — annual checkups, vaccines, screenings — for free. That
                  applies to employer and marketplace plans, but not short-term or health-sharing plans. Which kind is this?
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => answerAca("confirmed")} className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 font-semibold text-blue-700 hover:bg-blue-100">Employer or marketplace</button>
                  <button type="button" onClick={() => answerAca("non_aca")} className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 font-semibold text-blue-700 hover:bg-blue-100">Short-term / health-sharing</button>
                  <button type="button" onClick={() => setAcaDismissed(true)} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-600 hover:bg-gray-100">Not sure</button>
                </div>
              </div>
            )}

            <p className="mt-3 text-[12px] leading-relaxed text-gray-400">
              Fix anything that&apos;s off and we&apos;ll re-check this bill. Your network corrections also help us flag this provider for other members.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => { setDismissed(true); setEditAll(false); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-gray-800 active:scale-[0.98]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
                Done
              </button>
            </div>
          </div>
        )}

        {showUpdateLink && (
          <div className="border-t border-gray-100 px-5 py-3">
            <button type="button" onClick={() => { setDismissed(false); setEditAll(true); }} className="text-[13px] font-medium text-blue-600 hover:text-blue-800">
              Update assumptions
            </button>
          </div>
        )}

        {errorMsg && <p className="px-5 pb-3 text-[13px] text-red-600">{errorMsg}</p>}

        {(verdict === "not_covered" || verdict === "insufficient" || hasServiceCostGap) && (
          <div className="flex flex-wrap gap-2 border-t border-gray-100 px-5 py-3.5">
            {verdict === "not_covered" && (
              <button type="button" onClick={onShouldBeCovered} className="rounded-lg border border-gray-300 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-gray-700 hover:bg-gray-100">I think this should be covered</button>
            )}
            {(verdict === "insufficient" || hasServiceCostGap) && (
              <>
                {/* Footer catch-all (no specific chip) → first unresolved
                    service-cost chip's target, else the legacy fallback. */}
                <button type="button" onClick={() => onAddPlanDetails(serviceCostChips[0] ? { lineId: serviceCostChips[0].lineId, serviceSlug: serviceCostChips[0].serviceSlug } : undefined)} className="rounded-lg border border-blue-300 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-blue-700 hover:bg-blue-50">Add plan details</button>
                <button type="button" onClick={onUploadEob} className="rounded-lg border border-blue-300 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-blue-700 hover:bg-blue-50">Upload EOB</button>
              </>
            )}
          </div>
        )}
      </div>

      {isClean && !assumptionsOnly && (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-[60ch] text-[13px] leading-relaxed text-gray-500">
            Nothing to do here. We&apos;ll keep watching this bill in case the EOB updates or new plan info changes the picture.
          </p>
          <button type="button" onClick={onBack} className="inline-flex flex-none items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-4 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50">
            Back to bills
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M12 5l7 7-7 7" /></svg>
          </button>
        </div>
      )}
    </>
  );
}

function MetRow({
  kind, isMet, metAsOf, amount, networkLabel, money, onSubmit,
}: {
  kind: "deductible" | "oop";
  isMet: boolean;
  metAsOf: string | null;
  amount: number | null;
  networkLabel: string;
  money: (n: number) => string;
  onSubmit: (met: boolean, asOf: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [dateValue, setDateValue] = useState("");
  const rightActive = isMet || editing;

  const verb = kind === "deductible" ? "met" : "hit";
  const label = kind === "deductible" ? "Deductible" : "Out-of-pocket max";
  const nounBase = kind === "deductible" ? "deductible" : "out-of-pocket max";
  const amt = amount != null ? `${money(amount)} ` : "";
  const noun = kind === "deductible" ? `${amt}${networkLabel} deductible` : `${amt}out-of-pocket max`;

  const control = (
    <Toggle
      left={{
        label: kind === "deductible" ? "Not met" : "Not hit",
        prompt: kind === "deductible" ? "Not met?" : "Not hit?",
        active: !rightActive,
        onSelect: () => { if (editing) setEditing(false); else onSubmit(false, null); },
      }}
      right={{
        label: isMet ? (kind === "deductible" ? "Met" : "Hit") : (kind === "deductible" ? "Met it?" : "Hit it?"),
        prompt: kind === "deductible" ? "Met it?" : "Hit it?",
        active: rightActive,
        onSelect: () => setEditing(true),
      }}
    />
  );

  return (
    <div className="border-t border-gray-100 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <IconChip>{DollarIcon}</IconChip>
          <div className="pt-0.5">
            <div className="text-sm font-medium text-gray-900">{label}</div>
            <div className="mt-0.5 text-[13px] leading-snug text-gray-600">
              {isMet
                ? `You've ${verb} your ${networkLabel} ${nounBase} as of ${fmtDate(metAsOf)}.`
                : `You haven't ${verb} your ${noun} yet, so this applies to it.`}
            </div>
          </div>
        </div>
        <div className="pt-1">{control}</div>
      </div>
      {!isMet && editing && (
        <div className="ml-12 mt-2.5 rounded-xl border border-gray-200 bg-gray-50 p-3.5 text-[13px]">
          <p className="mb-2 font-medium text-gray-900">When did you {verb} your {amt || nounBase}?</p>
          <div className="flex items-center gap-2">
            <input type="date" value={dateValue} max={todayIso()} onChange={(e) => setDateValue(e.target.value)} className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px]" aria-label={`Date ${kind} was ${verb}`} />
            <button type="button" disabled={!dateValue} onClick={() => { setEditing(false); onSubmit(true, dateValue); }} className="rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">Save</button>
          </div>
          <p className="mt-2 text-[12px] text-gray-400">An approximate date is fine — we&apos;ll re-check bills dated on or after it.</p>
        </div>
      )}
    </div>
  );
}

function CheckGlyph({ small }: { small?: boolean }) {
  const s = small ? 12 : 22;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}
function InfoGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" />
    </svg>
  );
}

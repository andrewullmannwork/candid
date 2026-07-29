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
import { ANSWERED_REASONS } from "@/lib/claims/recovery-math";
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
  | { field: "aca"; status: "confirmed" | "non_aca" }
  /** S291 — "I checked the service list" (guided rail step 2), persisted to claims.metadata. */
  | { field: "services_confirmed"; confirmed: boolean }
  /** S291 — re-pin the bill to another plan the user owns. */
  | { field: "claim_plan"; insurancePlanId: string };

interface CostShareBannerProps {
  verdict: CostShareVerdict;
  assumptions: BannerAssumption[];
  overrides: CostShareOverrides | null;
  recoverable: number;
  correctShare: number;
  charged: number;
  fmtMoney: (n: number) => string;
  onOverride: (body: CostShareOverrideRequest, pendingKey: string) => void;
  /**
   * S291 (Andrew) — "Done" LOCKS IN the values shown on screen.
   *
   * Every row here is displayed with a default already selected ("Not hit"),
   * so a user who reads it, agrees, and clicks Done has genuinely answered —
   * but until now that answer was never written: Done only set a local
   * `dismissed` flag. The assumption stayed unresolved, the guided-rail badge
   * stayed amber, and the engine kept treating a confirmed fact as a guess.
   *
   * Batched deliberately: the single-override path refetches the whole claim
   * after each write, so firing three in parallel races three refetches. The
   * parent writes them in order and refetches ONCE.
   *
   * Only rows with a real default are sent. `service_cost` and
   * `aca_preventive` are never auto-confirmed — there is nothing to agree
   * with, so they keep the step unfinished until answered explicitly.
   */
  onConfirmDefaults?: (bodies: CostShareOverrideRequest[]) => Promise<void>;
  /**
   * S291 (Andrew) — rows still missing real input, from
   * `pendingAssumptionFields`. Passed in rather than recomputed so the amber
   * borders here and the amber step badge on the rail read the SAME set.
   */
  pendingFields?: Set<string>;
  /**
   * S291 (Andrew) — WHICH plan this bill is being checked against, surfaced as
   * a first-class assumption. Bills pin to the plan in force when the care
   * happened and do NOT follow later plan changes (by design — a 2025 bill must
   * not be judged by a 2026 plan). Nothing said so, which made a correctly
   * pinned bill look broken. `label` null = we have no plan for that period, the
   * honest zero-match state: we ask rather than silently borrowing a plan.
   */
  planIdentity?: {
    label: string | null;
    year: number | null;
    /**
     * S291 (Andrew) — the pinned plan's OWN year, when it differs from the
     * bill's care year. Both are real facts from real documents (care date off
     * the bill, plan year off the plan), so a disagreement isn't noise — it
     * means we have no plan for the year this care happened and are checking
     * the bill against the wrong one.
     */
    planYearMismatch: number | null;
    onChange: () => void;
  } | null;
  /**
   * The user has tried to finish this step (any override persisted, or the
   * services below confirmed). Only then do unanswered rows turn amber —
   * flagging them before the user has attempted anything would be nagging, not
   * signalling.
   */
  flagUnanswered?: boolean;
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
  editableServiceCost?: {
    serviceLabel: string;
    copay: number | null;
    coinsurancePercent: number | null;
    lineId?: string | null;
    /**
     * S291 (Andrew) — who actually asserted this cost. The row used to say
     * "You told us…" unconditionally, which is a LIE for a value a card scan
     * invented and attributed to the user. "unknown" = written before
     * provenance stamping; we genuinely don't know, so we claim neither.
     */
    costProvenance?: "user" | "card" | "unknown";
  } | null;
  onUploadEob: () => void;
  onBack: () => void;
  /** Surface 3 (clarity redesign) — "assumptions" renders ONLY the editable
   *  "What we assumed" rows (no verdict header, no clean-state outro): the
   *  flagged-bill step rail carries the verdict in step 1, so step 2 embeds
   *  just this card. Default "full" is the standalone verdict card. */
  variant?: "full" | "assumptions";
  /**
   * S293 (#1) — the ACA block's dismissed state, LIFTED to the parent when
   * provided so the ONE pending set (pendingAssumptionFields, which the step
   * badge reads) can see it: "Not sure" used to hide the block via banner-local
   * state while the badge kept counting the field — an amber badge above a band
   * with nothing left to answer. Controlled when both props present; falls back
   * to internal state for legacy callers.
   */
  acaDismissed?: boolean;
  onAcaDismissedChange?: (dismissed: boolean) => void;
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

/**
 * How many assumptions still await the user's first answer — PERSISTED truth
 * only (no optimistic overlay, no local `dismissed` flag), so it survives a
 * reload and can drive surfaces outside this component.
 *
 * S291 (Andrew): returns the SET of unanswered fields, not a count, because two
 * surfaces read it and they must never disagree — the guided-rail step badge
 * (green check when the set is empty, amber when it isn't) and the per-row
 * amber borders that point at which rows are still missing input. One source,
 * so a row can't be flagged while the badge says finished, or vice versa.
 *
 * Deliberately NOT a hardcoded list of "required" fields: membership is derived
 * from what the engine actually emitted, so a new assumption type inherits both
 * the badge and the border behaviour with no change here.
 *
 * Persisted truth only — no optimistic overlay, no local `dismissed` flag — so
 * it survives a reload.
 */
export function pendingAssumptionFields(
  assumptions: BannerAssumption[],
  overrides: CostShareOverrides | null,
  /**
   * S292 — the plan-identity row's state, so its amber comes from THIS set like
   * every other row's. It used to be flagged by its own independent condition
   * (`label == null || planYearMismatch != null`) ANDed with `flagUnanswered`,
   * which is `assumptionsEngaged` — durably true forever once any override is
   * saved. So the row went amber and could never clear, while the step badge
   * independently went green: the badge and the border reading two different
   * sources, the exact split S291 set out to end.
   */
  planIdentity?: { label: string | null } | null,
  /**
   * S293 (#1) — the S292 rule, finished: amber ⟺ counted, and a field may
   * count ONLY while the row that answers it is actually on screen. Two fields
   * could previously count with no visible ask — `deductible_applies` (its
   * owning row renders only for a manual-source cost, but the engine emits the
   * assumption for parsed/canonical costs too) and `aca_preventive` (the "Not
   * sure" button hid the block while the field kept counting). Both produced
   * an amber badge above a band with nothing to answer — the observed
   * "Done → amber though every visible row is Done-confirmable". Callers pass
   * the real row visibility; absent (legacy/standalone callers, fixtures) the
   * defaults preserve the S291 always-counted behavior.
   */
  visibility?: {
    /** the editable plan-cost row (the row that OWNS deductible_applies) renders. */
    deductibleAppliesRowVisible?: boolean;
    /** the ACA question block renders (exists and not "Not sure"-dismissed). */
    acaRowVisible?: boolean;
  },
): Set<string> {
  const has = (field: string) => assumptions.some((a) => a.field === field);
  const pending = new Set<string>();

  // Toggle-backed rows: a default is on screen, so these are pending only until
  // an override is saved — and "Done" saves them.
  // A row whose reason is "accumulator" is already ANSWERED — by our own tally
  // of the user's bills — so it renders (transparency) without counting as
  // outstanding. It stays overridable: the tally only knows uploaded bills, so
  // it's a floor, not the truth. S291.
  const answeredByData = (field: string) =>
    assumptions.some((a) => a.field === field && ANSWERED_REASONS.has(a.reason));
  const unanswered = (field: string) => has(field) && !answeredByData(field);

  if (unanswered("network") && overrides?.userNetworkOverride == null) pending.add("network");
  if (unanswered("deductible_met") && overrides?.deductibleMet == null) pending.add("deductible_met");
  if (unanswered("oop_met") && overrides?.oopMet == null) pending.add("oop_met");

  // Input-backed rows: no default exists to accept, so "Done" can never clear
  // them. They stay pending until the user supplies a real value.
  //
  // `deductible_applies` is the one that produced the false green (S291): the
  // engine emits it as a correctable assumption whenever the plan row doesn't
  // state whether the deductible applies (recovery-math.ts:704), and it's
  // answered through the Add-plan-details modal — NOT a toggle. It was missing
  // from the count entirely, so a bill with a known $30 copay but an unknown
  // deductible-applies read as fully answered. Its presence in `assumptions`
  // IS its pending state: once the plan row carries a non-null value the engine
  // stops emitting it.
  if (has("deductible_applies") && (visibility?.deductibleAppliesRowVisible ?? true)) {
    pending.add("deductible_applies");
  }
  if (has("aca_preventive") && (visibility?.acaRowVisible ?? true)) {
    pending.add("aca_preventive");
  }

  // Plan identity is OUTSTANDING only when there is no plan on file for the
  // bill's year — then we genuinely cannot check it and need the user to pick
  // or upload one. A WRONG-YEAR plan is not counted here: we did check the bill,
  // the caveat is stated in the row's own sub-line, and it already carries its
  // own step in "What you need to do" (S291). Counting it here too would hold
  // this step open forever on a bill the engine considers fully answered —
  // which is what produced a green badge sitting above an amber row.
  if (planIdentity && planIdentity.label == null) pending.add("plan_identity");
  for (const a of assumptions) {
    if (a.field === "service_cost") pending.add(`service_cost:${a.serviceSlug ?? a.serviceLabel}`);
  }
  return pending;
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
  onConfirmDefaults,
  pendingFields,
  planIdentity,
  flagUnanswered = false,
  errorMsg,
  onShouldBeCovered,
  onAddPlanDetails,
  editableServiceCost,
  onUploadEob,
  onBack,
  variant = "full",
  acaDismissed: acaDismissedProp,
  onAcaDismissedChange,
}: CostShareBannerProps) {
  const assumptionsOnly = variant === "assumptions";
  // S293 (#1) — controlled when the parent supplies the pair (so the badge's
  // pending set sees the dismissal); internal otherwise.
  const [acaDismissedLocal, setAcaDismissedLocal] = useState(false);
  const acaDismissed = acaDismissedProp ?? acaDismissedLocal;
  const setAcaDismissed = (v: boolean) => {
    onAcaDismissedChange?.(v);
    setAcaDismissedLocal(v);
  };
  const [dismissed, setDismissed] = useState(false); // "Done" collapses the section (accept as-is)
  const [confirming, setConfirming] = useState(false); // Done is now a WRITE — guard the double-click
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
  /**
   * S294 — the plan's OWN statement about deductible treatment (mig 219 /
   * `reason: "plan_document"`). An ANSWERED row: it informs, it never joins the
   * pending set, and it never blocks Done.
   *
   * Rendered only for the two `_free` cases, because those are the ones whose
   * meaning is genuinely non-obvious — a "$0" that is only $0 after a $7,250
   * deductible reads identically to a "$0" that is free outright, and that
   * ambiguity is the whole S294 defect. When the plan charges a real
   * copay/coinsurance the deductible row's own prose already says "you haven't
   * met your $X deductible yet, so this applies to it", and a second sentence
   * saying the same thing would be noise.
   */
  const planDeductibleTerm = (() => {
    const a = assumptions.find(
      (x) => x.field === "deductible_applies" && x.reason === "plan_document",
    );
    if (!a) return null;
    if (a.assumed === "subject_free" && a.value != null) {
      return `Your plan covers this at no charge — but only after your ${money(a.value)} deductible is met.`;
    }
    if (a.assumed === "exempt_free") {
      return "Your plan covers this at no charge, and the deductible doesn't apply.";
    }
    return null;
  })();
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
  /**
   * "Done" = the user has read these rows and accepts what they say. Collapse
   * in the SAME click; persist every displayed-but-unanswered default as a
   * real override in the background (S293 #5 — it used to await the batched
   * POSTs + a full claim refetch before any visible response, a multi-second
   * dead click).
   *
   * Sends the value currently on screen (optimistic overlay first, saved value
   * second, engine default last), so what gets written is exactly what the
   * user was looking at. Skips rows already answered — re-confirming them
   * would be a redundant write.
   *
   * `service_cost` / `aca_preventive` are excluded by construction: they have
   * no default to accept, so they stay pending and keep the rail step amber.
   * The pending-target idiom (ClaimDetail's svcPendingConfirm): `dismissed`
   * holds only the in-flight collapse; everything else stays derived from
   * server truth. A FAILED batch rejects — the section snaps back open (the
   * user must see nothing was saved) and `errorMsg` says why.
   */
  /**
   * Does this row still need input? Each row declares which pending field(s)
   * it OWNS — the control the user would actually use to answer them — so the
   * flag follows the data rather than a hardcoded "plan cost is the important
   * one" rule. `deductible_applies` has no row of its own; it's answered
   * through the plan-cost editor, so that row owns it.
   */
  const flagRow = (...fields: string[]) =>
    flagUnanswered && fields.some((f) => pendingFields?.has(f) ?? false);

  // S293 (#1) — what would STILL pend after Done writes its three toggle
  // fields. Done can only answer network / deductible_met / oop_met; anything
  // else in the ONE pending set (plan cost to add, plan to pick, ACA question)
  // survives it. Collapsing the section anyway hid exactly the rows the amber
  // badge was counting — badge said "still needs you", band showed nothing.
  // Rule (S292, Andrew): amber ⟺ counted, badge and band must agree — so Done
  // collapses ONLY when nothing else pends; otherwise the section stays open
  // with the remaining rows flagged.
  const DONE_WRITABLE = new Set(["network", "deductible_met", "oop_met"]);
  const pendingAfterDone = pendingFields
    ? Array.from(pendingFields).filter(
        (f) => !DONE_WRITABLE.has(f) && !(f === "aca_preventive" && acaDismissed),
      ).length
    : 0;

  const confirmAndDismiss = () => {
    const bodies: CostShareOverrideRequest[] = [];
    if (networkExists && !netResolved) {
      bodies.push({ field: "network", value: oonDisplay ? "out_of_network" : "in_network" });
    }
    if (deductibleExists && !dedResolved) {
      bodies.push({ field: "deductible_met", met: dedMetDisplay, asOf: dedAsOfDisplay });
    }
    if (oopExists && !oopResolved) {
      bodies.push({ field: "oop_met", met: oopMetDisplay, asOf: oopAsOfDisplay });
    }
    const collapseAfter = pendingAfterDone === 0;
    if (bodies.length > 0 && onConfirmDefaults) {
      setConfirming(true);
      // Mirror the writes locally so the rows don't flicker back to unanswered
      // between the save and the refetch.
      setOptimistic((o) => ({
        ...o,
        network: networkExists && !netResolved ? (oonDisplay ? "out_of_network" : "in_network") : o.network,
        deductibleMet: deductibleExists && !dedResolved ? dedMetDisplay : o.deductibleMet,
        oopMet: oopExists && !oopResolved ? oopMetDisplay : o.oopMet,
      }));
      // Collapse NOW (when nothing else pends) — the click's own render is the
      // response. The batch and its ONE refetch reconcile in the background;
      // rejection = snap back open + drop nothing else (errorMsg arrives via
      // props and the existing render-time reconcile clears the optimistic
      // overlay). When other rows still pend, stay OPEN so the flagged rows
      // remain visible under the amber badge.
      if (collapseAfter) setDismissed(true);
      onConfirmDefaults(bodies)
        .catch(() => setDismissed(false))
        .finally(() => setConfirming(false));
      return;
    }
    if (collapseAfter) setDismissed(true);
  };

  const answerAca = (status: "confirmed" | "non_aca") => {
    setAcaDismissed(true); // hide instantly; refetch removes the assumption
    onOverride({ field: "aca", status }, "aca");
  };

  // An assumption is "resolved" once the user picks it (override present —
  // optimistic or persisted).
  //
  // S291 (Andrew) — resolved rows used to DISAPPEAR, which is why the "Update
  // assumptions" control existed at all. Reversed deliberately: hiding an
  // answered assumption means the user can't see what we assumed, where the
  // number came from, or change their mind — and after "Done" started
  // persisting the displayed defaults, whole rows (deductible, OOP max) began
  // vanishing the moment they were confirmed. Transparency over tidiness: a
  // resolved row stays visible, states its source, and stays editable.
  const netResolved = optimistic.network !== undefined || overrides?.userNetworkOverride != null;
  const dedResolved = optimistic.deductibleMet !== undefined || overrides?.deductibleMet != null;
  const oopResolved = optimistic.oopMet !== undefined || overrides?.oopMet != null;
  const networkExists = !!networkA || netResolved;
  const deductibleExists = !!deductibleA || dedResolved;
  const oopExists = !!oopA || oopResolved;

  // Always shown when the assumption exists at all — resolved or not.
  const showNetwork = networkExists;
  const showDeductible = deductibleExists;
  const showOop = oopExists;
  const showAca = !!acaA && !acaDismissed;
  const hasServiceCostGap = serviceCostChips.length > 0;
  // S263 — the user's own manual cost-share is EDITABLE (correct a mistake); a
  // plan-doc/parsed cost is authoritative and read-only (gated in the parent).
  const hasEditableCost = !!editableServiceCost;

  // pending = assumptions still awaiting a first pick (drives the headline copy).
  // S293 (#1) — derived from the ONE pending set the badge reads
  // (pendingAssumptionFields, passed in as `pendingFields`) instead of a
  // second local tally that could disagree with it. The set is persisted-truth
  // only, so overlay the in-flight optimistic answers on top (a toggle click
  // must drop the count in its own render, not after the refetch). Legacy
  // callers without the prop keep the local tally.
  const pendingCount = pendingFields
    ? Array.from(pendingFields).filter((f) => {
        if (f === "network") return !netResolved;
        if (f === "deductible_met") return !dedResolved;
        if (f === "oop_met") return !oopResolved;
        if (f === "aca_preventive") return !acaDismissed;
        return true;
      }).length
    : ((networkExists && !netResolved) ? 1 : 0) +
      ((deductibleExists && !dedResolved) ? 1 : 0) +
      ((oopExists && !oopResolved) ? 1 : 0) +
      serviceCostChips.length +
      (showAca ? 1 : 0);
  const rawSectionHasRows = !!planIdentity || showNetwork || showDeductible || showOop || hasServiceCostGap || showAca || hasEditableCost;
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
    // S291 (Andrew): the "?" reads AMBER, not blue — "we can't fully check this"
    // is an open question needing the user, not a neutral informational note.
    // Deliberately amber-500/white to match `recovery`'s weight: both are "this
    // needs you". The glyph still separates them ($ = money found, ? = unknown).
    recovery: "bg-amber-500 text-white", not_covered: "bg-gray-400 text-white", insufficient: "bg-amber-500 text-white",
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
                  "px-5 pb-4 pt-1.5 [&>div:first-child]:border-t-0 [&>div[data-flagged]+div]:border-t-0"
                : // S293 (#1) — the full variant needs the same suppression: a
                  // row following a flagged (amber-bleed) row must not draw its
                  // top border across the tint.
                  "px-5 pb-4 [&>div[data-flagged]+div]:border-t-0"
            }
          >
            {!assumptionsOnly && (
              <div className="border-t border-gray-100 pt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">What we assumed</div>
            )}

            {planIdentity && (
              <Row
                flagged={flagRow("plan_identity")}
                icon={DocIcon}
                label="Plan we checked against"
                control={
                  <button
                    type="button"
                    onClick={planIdentity.onChange}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Change
                  </button>
                }
              >
                {planIdentity.label == null
                  ? `We don't have a plan on file for${planIdentity.year ? ` ${planIdentity.year}` : " when this care happened"}. Pick the plan you were on so we can check this bill properly.`
                  : planIdentity.planYearMismatch != null
                    ? `This bill is from ${planIdentity.year}, but we checked it against your ${planIdentity.planYearMismatch} plan. Coverage changes year to year — add your ${planIdentity.year} plan for an accurate check.`
                    : `We checked this bill against ${planIdentity.label}. Change it if you were on a different plan${planIdentity.year ? ` in ${planIdentity.year}` : ""}.`}
              </Row>
            )}

            {showNetwork && (
              <Row
                // S292 — network is counted by `pendingAssumptionFields` but had
                // no `flagged` prop, so it was the mirror image of the plan row:
                // the badge counted it while the border stayed silent. Every row
                // the badge counts now shows amber, and only those do.
                flagged={flagRow("network")}
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

            {/* S294 — the plan's own term, stated BEFORE the question it makes
                relevant. Reading order is the point: the user learns the $0 is
                conditional, then answers the one thing that resolves it. Not a
                Row with a control — there is nothing here to change, only
                something to know. */}
            {planDeductibleTerm && (
              <Row icon={DocIcon} label="Plan cost" control={null}>
                {planDeductibleTerm}
              </Row>
            )}

            {showDeductible && (
              <MetRow flagged={flagRow("deductible_met")} source={deductibleA?.reason === "user_override" || dedResolved ? "user" : deductibleA?.reason === "accumulator" ? "accumulator" : null} kind="deductible" isMet={dedMetDisplay} metAsOf={dedAsOfDisplay} amount={deductibleA?.value ?? null} networkLabel={networkLabel} money={money} onSubmit={selectDeductible} />
            )}

            {showOop && (
              <MetRow flagged={flagRow("oop_met")} source={oopA?.reason === "user_override" || oopResolved ? "user" : oopA?.reason === "accumulator" ? "accumulator" : null} kind="oop" isMet={oopMetDisplay} metAsOf={oopAsOfDisplay} amount={oopA?.value ?? null} networkLabel={networkLabel} money={money} onSubmit={selectOop} />
            )}

            {serviceCostChips.map((chip, i) => (
              <Row
                key={`service_cost-${chip.lineId}-${i}`}
                flagged={flagRow(`service_cost:${chip.serviceSlug ?? chip.serviceLabel}`)}
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
                flagged={flagRow("deductible_applies")}
                icon={DocIcon}
                label="Plan cost"
                control={
                  <button type="button" onClick={() => onAddPlanDetails({ lineId: editableServiceCost.lineId ?? null })} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50">Edit</button>
                }
              >
                {(() => {
                  const amount =
                    editableServiceCost.copay != null
                      ? `$${editableServiceCost.copay} copay`
                      : `${editableServiceCost.coinsurancePercent}% coinsurance`;
                  const who = editableServiceCost.costProvenance ?? "unknown";
                  if (who === "user") {
                    return `You told us your plan's cost for ${editableServiceCost.serviceLabel} is ${amount}. Edit if that's not right.`;
                  }
                  if (who === "card") {
                    return `From your insurance card, we have ${amount} for ${editableServiceCost.serviceLabel}. Cards rarely have this information — confirm or correct it.`;
                  }
                  return `We have ${amount} as your plan's cost for ${editableServiceCost.serviceLabel}. Confirm it's right.`;
                })()}
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
                onClick={confirmAndDismiss}
                disabled={confirming}
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
            <button type="button" onClick={() => setDismissed(false)} className="text-[13px] font-medium text-blue-600 hover:text-blue-800">
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
  kind, isMet, metAsOf, amount, networkLabel, money, onSubmit, flagged = false, source = null,
}: {
  kind: "deductible" | "oop";
  isMet: boolean;
  metAsOf: string | null;
  amount: number | null;
  networkLabel: string;
  money: (n: number) => string;
  onSubmit: (met: boolean, asOf: string | null) => void;
  /** S291 — still unanswered after the user tried to finish. */
  flagged?: boolean;
  /**
   * S291 — where this answer came from. "accumulator" = our own running tally
   * of the user's uploaded bills; "user" = they told us. Rendered as a small
   * attribution line so a confirmed row still shows its basis and stays
   * arguable — our tally only sees bills we've been given, so it is a floor.
   */
  source?: "accumulator" | "user" | null;
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
    <div
      // S293 (#1) — flagged renders the SAME full-bleed amber tint as the
      // shared Row primitive (InputRow.tsx), replacing this row's private
      // bordered-box treatment. The deductible/OOP rows were the only flagged
      // rows drawing a border instead of the approved bleed — a genuinely
      // pending MetRow now looks like every other pending row, and the
      // `data-flagged` attr keeps the parent's border-suppression selector
      // working for the row beneath it.
      data-flagged={flagged || undefined}
      className={
        flagged
          ? "-mx-5 bg-amber-50 px-5 py-3.5 first:-mt-1.5 last:-mb-4"
          : "border-t border-gray-100 py-3.5"
      }
    >
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
            {source ? (
              <div className="mt-1 text-[12px] text-gray-500">
                {source === "accumulator"
                  ? "Based on the bills you've uploaded — change it if you've had others."
                  : "You told us this."}
              </div>
            ) : (
              /* S294 — with no accumulator and no answer, the toggle above is
                 showing a DEFAULT, not a fact. Say so. The row already
                 attributes an accumulator- or user-sourced answer; staying
                 silent in the one case where we are guessing was the gap, and
                 it is the same silence that let a displayed default read as a
                 confirmed value elsewhere (S291). Conservative direction: "not
                 yet" makes the patient owe MORE, so it can never invent a
                 refund — but it must still be legible as an assumption. */
              !isMet && (
                <div className="mt-1 text-[12px] text-gray-500">
                  We&apos;re assuming not yet. Change it if you have.
                </div>
              )
            )}
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

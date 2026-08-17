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

import { Fragment, useState, type ReactNode } from "react";
import { ANSWERED_REASONS } from "@/lib/claims/recovery-math";
import type { CostShareAssumption, CostShareOverrides } from "@/lib/claims/recovery-math";
import { Row, IconChip } from "@/components/shared/InputRow";
import { DoneEdit, ValueEdit, AddButton, CancelLink, NeedsMeter, AddedFold } from "@/components/shared/needs-format";

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

// S302 — the client's parallel copy of this union is DELETED. It had already
// drifted from the server's (missing `service_cost` and `patient_paid`), so two
// real corrections were unrepresentable on the surface that sends them. One
// type, re-exported here so existing importers of this module keep working.
import type { CostShareOverrideRequest } from "@/lib/claims/cost-share-override";
export type { CostShareOverrideRequest };

interface CostShareBannerProps {
  verdict: CostShareVerdict;
  assumptions: BannerAssumption[];
  overrides: CostShareOverrides | null;
  recoverable: number;
  correctShare: number;
  charged: number;
  fmtMoney: (n: number) => string;
  onOverride: (body: CostShareOverrideRequest, pendingKey: string) => void | Promise<boolean>;
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
   * S304 — report an answer the user just made, before the server confirms it.
   * A PATCH: only the fields this interaction answered. The caller merges it
   * into `overrides` and hands the merged object back down, so this component
   * and the guided-rail step badge read the same value in the same render.
   * Defaults to a no-op for callers that don't track it.
   */
  onOptimistic?: (patch: AssumptionOptimistic) => void;
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
  /**
   * S302 — the line-items-vs-summary disagreement. Claim-level, so it arrives
   * as its own prop rather than through `assumptions[]` (the plan_identity
   * pattern); null when the totals agree, the user has already answered, or
   * `bill_totals_source_v1` is OFF.
   */
  totalsSource?: {
    /**
     * The user's standing answer, or null while the question is still open.
     * The row does NOT disappear once answered — the copy promises "you can
     * change it any time", and a row that vanishes makes that untrue.
     */
    answered: "summary" | "line_items" | null;
    /** "what you owe" / "what you've paid" — the field with the largest delta. */
    label: string;
    lineItemsTotal: string;
    summaryTotal: string;
    /** null clears the answer, reopening the question. */
    onChoose: (use: "summary" | "line_items" | null) => void;
  } | null;
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
    /**
     * S310 (F14a) — the pinned plan's insurer name + its correction write
     * (ClaimDetail's saveInsurerName → /api/plan/insurer-name → refetch).
     * Present → the row's description offers "Fix insurer name" with an
     * inline editor. Resolves to true when the save landed.
     */
    insurerName?: string | null;
    onSaveInsurerName?: (name: string) => Promise<boolean>;
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
  /** S308 — every line whose plan cost carries STATED values (source `manual`):
   *  user-provenance rows render answered ("$40 copay · Edit"), card/unknown
   *  render as open confirm asks. Replaces the single-target editableServiceCost
   *  probe (S263) — one derivation, N lines. */
  statedServiceCosts?: Array<{
    lineId: string;
    serviceSlug: string | null;
    serviceLabel: string;
    copay: number | null;
    coinsurancePercent: number | null;
    deductibleApplies: boolean | null;
    costProvenance: "plan_document" | "user" | "card" | "unknown";
  }> | null;
  /**
   * S310 F16 (Andrew's ruling) — lines whose rate is an ESTIMATE borrowed from
   * a category sibling (S153/S154, `coverageNeedsConfirmation`). Each renders
   * a confirmable row: "Looks right" fires the SAME S154 confirm-coverage
   * write the line table's Coverage badge uses, "Edit" opens the existing
   * rate modal — one row, two surfaces, flow by construction.
   */
  estimateRows?: Array<{
    lineId: string;
    serviceLabel: string;
    siblingLabel: string | null;
    rateText: string;
    serviceSlug: string | null;
  }> | null;
  /** S310 F16 — the S154 confirm (ClaimDetail's handleConfirmCoverage). */
  onConfirmEstimate?: (lineId: string) => void | Promise<void>;
  /** S310 F16 — the in-flight confirm's line id (ClaimDetail's pending state). */
  confirmingEstimateId?: string | null;
  /** S308 — the persisted reviewed/collapsed state (claims.metadata.assumptionsReviewedAt). */
  initiallyReviewed?: boolean;
  /** S308 — bumps when the collapsed rail step's "Update assumptions" link is
   *  clicked: the card un-collapses in the same gesture that expands the step. */
  expandSignal?: number;
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
  hasStatedCosts?: boolean,
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
    !!hasStatedCosts
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
/**
 * S294 — HOW each assumption field gets answered. ONE declaration, because the
 * "press Done, still says needs review" defect recurred THREE times and every
 * recurrence was the same shape: two or more hand-maintained lists disagreeing
 * about whether a field was answerable.
 *
 * The badge may count a field ONLY when the user has something on screen to act
 * on. Each field declares which:
 *
 *   "done"  — a toggle with a real default is on screen. Done accepts it, so it
 *             pends only until an override is saved. `DONE_WRITABLE_FIELDS` is
 *             DERIVED from this, so the Done writer and the pending set cannot
 *             drift apart (they were separate literals before).
 *   "input" — no default exists to accept; a real value must be supplied
 *             through a control (Add-details modal, plan chooser, ACA block).
 *             Pends only while that control is actually rendered.
 *
 * Any field answered via ANSWERED_REASONS is exempt regardless of kind — see
 * `clearAnswered` below. Adding a field to CostShareAssumption without adding it
 * here fails `s294-canonical-coverage-fixture` (exhaustiveness §7e).
 */
export const ASSUMPTION_ANSWERABILITY = {
  network: "done",
  deductible_met: "done",
  oop_met: "done",
  deductible_applies: "input",
  aca_preventive: "input",
  service_cost: "input",
  plan_identity: "input",
  // S302 — answered by picking one of two already-parsed numbers, so it is an
  // "input" row like plan_identity: "Done" cannot answer it on the user's behalf.
  totals_source: "input",
  // Emitted for transparency only — never gates the step. `denial` states what
  // the insurer said; `plan_provenance` names WHY a verdict was degraded and is
  // resolved by uploading a plan document, not by answering a row.
  denial: "info",
  plan_provenance: "info",
} as const satisfies Record<string, "done" | "input" | "info">;

/** Derived, never hand-listed — the fields "Done" can actually write. */
export const DONE_WRITABLE_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(ASSUMPTION_ANSWERABILITY)
    .filter(([, kind]) => kind === "done")
    .map(([field]) => field),
);

export function pendingAssumptionFields(
  assumptions: BannerAssumption[],
  overrides: CostShareOverrides | null,
  // (trailing optional params below; S310 F16 adds `estimateRows` at the end)
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
  /**
   * S302 — an unanswered line-items-vs-summary disagreement. Truthy only while
   * the question is live (the caller passes null once answered), so it enters
   * the pending set through the SAME path every other row does, rather than a
   * second independent amber condition — the S292 lesson on this exact component.
   * APPENDED, never inserted: a new positional arg in the middle silently
   * re-maps every existing caller's arguments.
   */
  totalsSource?: unknown,
  /**
   * S310 F16 — estimate-borrowed rates awaiting the S154 confirm. One key per
   * visible row (the caller passes only needing-confirmation lines, so the
   * amber ⟺ counted ⟺ on-screen invariant holds by construction). APPENDED,
   * same rule as totalsSource.
   */
  estimateRows?: Array<{ lineId: string }> | null,
): Set<string> {
  const has = (field: string) => assumptions.some((a) => a.field === field);
  const pending = new Set<string>();

  // Toggle-backed rows: a default is on screen, so these are pending only until
  // an override is saved — and "Done" saves them.
  // A row whose reason is "accumulator" is already ANSWERED — by our own tally
  // of the user's bills — so it renders (transparency) without counting as
  // outstanding. It stays overridable: the tally only knows uploaded bills, so
  // it's a floor, not the truth. S291.
  //
  // S312 (F2-S312.2, Andrew) — a field is answered only when EVERY instance is
  // answered (and at least one exists). The old any-instance `some()` was fine
  // for the claim-scoped singletons (network/deductible_met/oop_met — one
  // instance per claim) but WRONG for the per-line fields: since S294 every
  // plan-stated line emits an answered `deductible_applies` instance, so a
  // neighbor's answer silenced a line's genuinely open question — the badge
  // went green over a visible ask (live case: acupuncture/office-visit
  // plan-stated, the allergy line's "I'm not sure" left honestly null). Same
  // clearUnactionable path silenced a service's open rate behind another
  // service's answered one. Andrew's rule, stated plainly: amber whenever
  // something that affects the math is missing. This is the badge-side twin of
  // S308's hasPendingAssumption ("is any instance still unanswered?") — the
  // pending-set convention applied per instance, here as the post-pass clear.
  // The zero-instance guard keeps keys with no engine assumption (plan_identity,
  // totals_source, estimate:<lineId>) exactly as before: never data-answered.
  const answeredByData = (field: string) => {
    const instances = assumptions.filter((a) => a.field === field);
    return instances.length > 0 && instances.every((a) => ANSWERED_REASONS.has(a.reason));
  };
  const unanswered = (field: string) => has(field) && !answeredByData(field);

  if (unanswered("network") && overrides?.userNetworkOverride == null) pending.add("network");
  if (unanswered("deductible_met") && overrides?.deductibleMet == null) pending.add("deductible_met");
  if (unanswered("oop_met") && overrides?.oopMet == null) pending.add("oop_met");

  // ── THE INVARIANT (S294, Andrew — third recurrence) ─────────────────────
  // ANSWERED_REASONS is authoritative for EVERY field, without exception.
  //
  // It was applied only to the three toggle-backed rows above, while the
  // input-backed rows below tested mere PRESENCE. So a field that was already
  // answered — by our accumulator, by the user, or (S294) by the plan document
  // itself — still counted as outstanding if it happened to be input-backed.
  // Done cannot write those fields, so the badge stayed amber permanently with
  // nothing on screen left to answer. That is the "press Done, still says needs
  // review" defect, and it survived three fixes because each one reasoned about
  // a specific ROW rather than the rule underneath.
  //
  // Andrew's rule, stated plainly: if every row either shows a default the user
  // can accept or already holds a value, Done means answered. A field may hold
  // this step open ONLY when there is genuinely nothing on screen to accept.
  //
  // Enforced as a post-pass so it cannot be forgotten when a field is added:
  // whatever the branches below decide, an answered field is never pending.
  //
  // The second half of the same guarantee: a field declared "info" in
  // ASSUMPTION_ANSWERABILITY has no control at all, so it can never be pending
  // however it got added. Together these two post-passes mean the badge counts
  // only fields the user can actually act on — by construction, not by three
  // lists agreeing.
  const clearUnactionable = (set: Set<string>) => {
    for (const f of Array.from(set)) {
      // service_cost keys are namespaced (`service_cost:<slug>`); strip to the field.
      const field = f.startsWith("service_cost:") ? "service_cost" : f;
      const kind = (ASSUMPTION_ANSWERABILITY as Record<string, string>)[field];
      if (answeredByData(field) || kind === "info") set.delete(f);
    }
    return set;
  };

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
  // S302 — an unanswered totals disagreement is PENDING: it changes which
  // numbers every downstream citation reads, so the step is not done until the
  // user has adjudicated it.
  if (totalsSource) pending.add("totals_source");
  for (const a of assumptions) {
    // S308 (tracker AU) — an ANSWERED rate (reason ∈ ANSWERED_REASONS) is
    // visible history with an Edit affordance, never an open question.
    if (a.field === "service_cost" && !ANSWERED_REASONS.has(a.reason)) {
      pending.add(`service_cost:${a.serviceSlug ?? a.serviceLabel}`);
    }
  }
  // S310 F16 — one key per estimate row on screen.
  for (const er of estimateRows ?? []) pending.add(`estimate:${er.lineId}`);
  return clearUnactionable(pending);
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

/**
 * S304 — the answers a click has made but the server has not yet confirmed.
 *
 * OWNED BY ClaimDetail, not by this component. It used to be local `useState`
 * here, which meant three surfaces derived "what have you answered" from two
 * different places: this banner's rows read the overlay and moved instantly,
 * while the guided-rail step badge read `costShareOverrides` straight from the
 * server and sat unchanged until the refetch landed — the lag Andrew saw on
 * "Done". Worse, this component renders TWICE on the page (the rail step's
 * `variant="assumptions"` instance and the standalone one), so there were two
 * independent overlays that could disagree with each other as well as with the
 * badge.
 *
 * Lifting it means the caller merges these answers into `overrides` ONCE and
 * hands the same object to every consumer, so the badge and the rows are
 * reading the identical value and cannot drift. The same defect class —
 * "press Done, still says needs review" — has been patched three times in this
 * file; two sources of truth was the shape behind all three.
 */
export interface AssumptionOptimistic {
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
  onOptimistic = () => {},
  pendingFields,
  planIdentity,
  totalsSource = null,
  flagUnanswered = false,
  errorMsg,
  onShouldBeCovered,
  onAddPlanDetails,
  statedServiceCosts,
  estimateRows,
  onConfirmEstimate,
  confirmingEstimateId,
  initiallyReviewed,
  expandSignal,
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
  // S310 (F14a) — the pinned-plan row's inline insurer-name editor. Save is
  // OPTIMISTIC (Andrew): the editor closes in the click's render (ClaimDetail
  // shows the value instantly via its optimistic override); a failed write
  // reopens it with the attempted value + error — the snapback.
  const [insurerNameEdit, setInsurerNameEdit] = useState<{
    value: string;
    error: boolean;
  } | null>(null);
  const acaDismissed = acaDismissedProp ?? acaDismissedLocal;
  const setAcaDismissed = (v: boolean) => {
    onAcaDismissedChange?.(v);
    setAcaDismissedLocal(v);
  };
  // "Done" collapses the section (accept as-is). S308 — seeded from the
  // persisted flag so the collapse survives reloads; Done/re-open post it.
  const [dismissed, setDismissed] = useState(!!initiallyReviewed);
  // S308 — the rail stub's "Update assumptions" opens the card too. State
  // adjusted DURING render (the React-sanctioned derive-from-props pattern) —
  // an effect here would be a cascading-render lint error.
  const [lastExpandSignal, setLastExpandSignal] = useState(expandSignal ?? 0);
  // S308 — the inline Yes/No paints immediately; the entry clears when the
  // post resolves (success ⇒ the submit's awaited refetch already delivered
  // server truth; failure ⇒ snap back). Keyed by lineId.
  const [dedOptimistic, setDedOptimistic] = useState<Record<string, boolean>>({});
  if (expandSignal != null && expandSignal !== lastExpandSignal) {
    setLastExpandSignal(expandSignal);
    setDismissed(false);
  }
  // S308 (Andrew) — mirror the letter needs-panel's "Added" fold: answered rows
  // sink below a collapse so the card leads with what still needs input.
  const [showAdded, setShowAdded] = useState(false);
  // S308 — which answered inline row (network/totals) is temporarily re-opened
  // for editing; mirrors the letter panel's openEditor pattern.
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // Done is now a WRITE — guard the double-click
  // S304 — `overrides` ARRIVES already merged with the caller's pending
  // answers, so every display below reads it directly. The snapback that used
  // to live here (drop the overlay when a save errors) now lives with the state
  // in ClaimDetail, which is where both the failure and the state are known.

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
    const rows = assumptions.filter(
      (x) => x.field === "deductible_applies" && x.reason === "plan_document",
    );
    if (rows.length === 0) return null;
    const a = rows[0];
    // S294 (Andrew) — name the actual services rather than "this". Read off the
    // bill's OWN lines, so it stays correct for any bill: one service is named,
    // two are joined, three or more collapse to "these services" rather than
    // running an unbounded list through the sentence.
    const names = Array.from(
      new Set(rows.map((r) => r.serviceLabel).filter((n): n is string => !!n && n.trim().length > 0)),
    );
    const subject =
      names.length === 1 ? names[0]
      : names.length === 2 ? `${names[0]} and ${names[1]}`
      : names.length > 2 ? "these services"
      : "this";
    if (a.assumed === "subject_free" && a.value != null) {
      return `Your plan covers ${subject} at no charge — but only after your ${money(a.value)} deductible is met.`;
    }
    if (a.assumed === "exempt_free") {
      return `Your plan covers ${subject} at no charge, and the deductible doesn't apply.`;
    }
    return null;
  })();

  /**
   * S294 (Andrew) — where these terms came from, stated plainly and WITHOUT
   * blocking anything. Candid's catalog extraction of a plan's SBC is the same
   * filing the member would upload, so it no longer degrades the verdict; the
   * member is simply told, and pointed at the upload that would make it current.
   */
  const planCostSourceNote = assumptions.some(
    (x) => x.field === "deductible_applies" && x.reason === "plan_document",
  ) && !(statedServiceCosts && statedServiceCosts.length > 0)
    ? "From Candid's plan database — upload your plan document for the most up-to-date results."
    : null;
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
  // S308 (tracker AU) — the card renders PENDING asks from assumptions; every
  // STATED value (answered or needing confirmation) renders from
  // `statedServiceCosts` (planCoverage-derived, one derivation for N lines —
  // the S263 single-target probe generalized). Assumption-answered rows are
  // deliberately NOT rendered from assumptions here or they would duplicate
  // the stated rows; the emission still drives every non-card consumer.
  const pendingServiceCostChips = serviceCostChips.filter((c) => !ANSWERED_REASONS.has(c.reason));

  // Display values. S304 — one source: `overrides` already carries any
  // answer this click made, merged by the caller.
  const oonDisplay = overrides?.userNetworkOverride === "out_of_network";
  const dedMetDisplay = overrides?.deductibleMet === true;
  const dedAsOfDisplay = overrides?.deductibleMetAsOf ?? null;
  const oopMetDisplay = overrides?.oopMet === true;
  const oopAsOfDisplay = overrides?.oopMetAsOf ?? null;
  const networkLabel = oonDisplay ? "out-of-network" : "in-network";

  const selectNetwork = (value: "in_network" | "out_of_network") => {
    onOptimistic({ network: value });
    onOverride({ field: "network", value }, "network");
  };
  const selectDeductible = (met: boolean, asOf: string | null) => {
    onOptimistic({ deductibleMet: met, deductibleMetAsOf: asOf });
    onOverride({ field: "deductible_met", met, asOf }, "deductible");
  };
  const selectOop = (met: boolean, asOf: string | null) => {
    onOptimistic({ oopMet: met, oopMetAsOf: asOf });
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
  // S294 — DERIVED from ASSUMPTION_ANSWERABILITY, not a second literal. The
  // Done writer and the pending set drifting apart is what produced the
  // recurring "Done does nothing" defect.
  const DONE_WRITABLE = DONE_WRITABLE_FIELDS;
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
      // Mirror the writes upward so the rows don't flicker back to unanswered
      // between the save and the refetch — and so the step badge above moves in
      // the SAME render, which is the lag this lift removes. A PATCH: only the
      // fields this click actually answers, merged by the caller.
      onOptimistic({
        ...(networkExists && !netResolved
          ? { network: (oonDisplay ? "out_of_network" : "in_network") as "in_network" | "out_of_network" }
          : {}),
        ...(deductibleExists && !dedResolved ? { deductibleMet: dedMetDisplay } : {}),
        ...(oopExists && !oopResolved ? { oopMet: oopMetDisplay } : {}),
      });
      // Collapse NOW (when nothing else pends) — the click's own render is the
      // response. The batch and its ONE refetch reconcile in the background;
      // rejection = snap back open + drop nothing else (the caller clears the
      // overlay on a failed write, which snaps the rows back too). When other
      // rows still pend, stay OPEN so the flagged rows
      // remain visible under the amber badge.
      if (collapseAfter) {
        setDismissed(true);
        onOverride({ field: "assumptions_reviewed", reviewed: true }, "assumptions_reviewed");
      }
      onConfirmDefaults(bodies)
        .catch(() => setDismissed(false))
        .finally(() => setConfirming(false));
      return;
    }
    if (collapseAfter) {
      setDismissed(true);
      onOverride({ field: "assumptions_reviewed", reviewed: true }, "assumptions_reviewed");
    }
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
  const netResolved = overrides?.userNetworkOverride != null;
  const dedResolved = overrides?.deductibleMet != null;
  const oopResolved = overrides?.oopMet != null;
  const networkExists = !!networkA || netResolved;
  const deductibleExists = !!deductibleA || dedResolved;
  const oopExists = !!oopA || oopResolved;
  // S308 — the Added-fold partition. A row sinks when it carries an ANSWER
  // (user/accumulator) and owns no pending field; asks and warnings stay up.
  const rowPending = (...fields: string[]) => fields.some((f) => pendingFields?.has(f) ?? false);
  const dedSource: "user" | "accumulator" | null =
    deductibleA?.reason === "user_override" || dedResolved ? "user" : deductibleA?.reason === "accumulator" ? "accumulator" : null;
  const oopSource: "user" | "accumulator" | null =
    oopA?.reason === "user_override" || oopResolved ? "user" : oopA?.reason === "accumulator" ? "accumulator" : null;
  const networkAnswered = networkExists && netResolved && !rowPending("network");
  const dedAnswered = dedSource != null && !rowPending("deductible_met");
  const oopAnswered = oopSource != null && !rowPending("oop_met");
  const totalsAnswered = !!totalsSource?.answered;

  // Always shown when the assumption exists at all — resolved or not.
  const showNetwork = networkExists;
  const showDeductible = deductibleExists;
  const showOop = oopExists;
  const showAca = !!acaA && !acaDismissed;
  const hasServiceCostGap = pendingServiceCostChips.length > 0;
  const statedCosts = statedServiceCosts ?? [];

  // pending = assumptions still awaiting a first pick (drives the headline copy).
  // S293 (#1) — derived from the ONE pending set the badge reads
  // (pendingAssumptionFields, passed in as `pendingFields`) instead of a
  // second local tally that could disagree with it. `pendingFields` is
  // persisted-truth only BY DESIGN (see pendingAssumptionFields) — S304 keeps
  // that contract intact and instead has the caller compute it from an
  // already-merged overrides object, so a toggle click drops the count in its
  // own render without this function ever learning about optimism. Legacy
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
      pendingServiceCostChips.length +
      (showAca ? 1 : 0);
  const estimates = estimateRows ?? [];
  const rawSectionHasRows = !!totalsSource || !!planIdentity || showNetwork || showDeductible || showOop || hasServiceCostGap || statedCosts.length > 0 || estimates.length > 0 || showAca;
  // Section is OPEN unless the user dismissed it via "Done"; when closed but
  // assumptions exist, "Update assumptions" brings it back.
  const sectionOpen = !dismissed && rawSectionHasRows;
  const anyAssumptions = networkExists || deductibleExists || oopExists || hasServiceCostGap || !!acaA || statedCosts.length > 0 || estimates.length > 0;
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
    // S294 (Andrew) — say the ACTUAL reason. The single line below was shown for
    // every `insufficient` verdict, so a bill whose plan cost we were DISPLAYING
    // one row further down still claimed we were missing it — and pointed at
    // "Add plan details", which writes a `manual` value the same gate distrusts.
    // The instruction could not resolve the state it was describing.
    const cardSourced = assumptions.some(
      (a) => a.field === "plan_provenance" && a.assumed === "unverified_plan",
    );
    body = cardSourced
      ? "These costs came from your insurance card which lacks the specifics needed to determine coverage. Upload your plan document and we'll re-check."
      : "We're missing your plan's cost for this service, and we won't flag a dispute we can't back up. Add it and we'll run the numbers.";
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

  // S308 (Andrew) — the rows as open/done DESCRIPTORS, mirroring the letter
  // panel's RowDesc pattern: open asks render at the top, answered rows sink
  // under the shared AddedFold with calm ✓/value + Edit controls. Wiring
  // (onOverride, optimistic overlay, pendingFields, Done) is untouched — this
  // is the presentation layer only.
  const descs: Array<{ key: string; done: boolean; node: ReactNode }> = [];

  if (totalsSource) {
    descs.push({
      key: "totals",
      done: totalsAnswered,
      node: (
              <Row
                flagged={flagRow("totals_source")}
                icon={DocIcon}
                label={
                  totalsSource.answered
                    ? "Which numbers we're using"
                    : "These numbers don't match"
                }
                control={
                  totalsSource.answered ? (
                    <button
                      type="button"
                      onClick={() => totalsSource.onChoose(null)}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Change
                    </button>
                  ) : (
                    <span className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => totalsSource.onChoose("summary")}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Use the summary
                      </button>
                      <button
                        type="button"
                        onClick={() => totalsSource.onChoose("line_items")}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Use the line items
                      </button>
                    </span>
                  )
                }
              >
                {totalsSource.answered
                  ? `You told us the bill's ${totalsSource.answered === "summary" ? "summary" : "line items"} is right, so we're using it for this bill's totals.`
                  : `Adding up the line items on this bill gives ${totalsSource.lineItemsTotal} for ${totalsSource.label}, but the bill's own summary says ${totalsSource.summaryTotal}. Which is right? We'll use the same answer for the other totals on this bill, and you can change it any time.`}
              </Row>
      ),
    });
  }

  // S308 (Andrew) — the plan row is the ONE persistent row: pinned above the
  // open asks, excluded from the meter, never folding into Added.
  const planDone = !!planIdentity && planIdentity.label != null && planIdentity.planYearMismatch == null;
  const planIdentityNode = planIdentity ? (
              <Row
                flagged={flagRow("plan_identity")}
                icon={DocIcon}
                label="Plan we checked against"
                control={
                  planDone ? (
                    <DoneEdit label={planIdentity.label!} onEdit={planIdentity.onChange} />
                  ) : (
                    <button
                      type="button"
                      onClick={planIdentity.onChange}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Change
                    </button>
                  )
                }
              >
                {planIdentity.label == null
                  ? `We don't have a plan on file for${planIdentity.year ? ` ${planIdentity.year}` : " when this care happened"}. Pick the plan you were on so we can check this bill properly.`
                  : planIdentity.planYearMismatch != null
                    ? `This bill is from ${planIdentity.year}, but we checked it against your ${planIdentity.planYearMismatch} plan. Coverage changes year to year — add your ${planIdentity.year} plan for an accurate check.`
                    : (
                      <>
                        {`We checked this bill against ${planIdentity.label}. Change it if you were on a different plan${planIdentity.year ? ` in ${planIdentity.year}` : ""}.`}
                        {/* S310 (F14a) — fix the insurer's NAME (a spelling/
                            identity correction on the plan row) as distinct
                            from Change (a different plan). */}
                        {planIdentity.insurerName && planIdentity.onSaveInsurerName ? (
                          insurerNameEdit ? (
                            <span className="mt-1.5 flex flex-wrap items-center gap-2">
                              <input
                                type="text"
                                value={insurerNameEdit.value}
                                onChange={(e) => setInsurerNameEdit((p) => (p ? { ...p, value: e.target.value } : p))}
                                aria-label="Insurer name"
                                autoFocus
                                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                              />
                              <button
                                type="button"
                                disabled={insurerNameEdit.value.trim().length === 0}
                                onClick={() => {
                                  const v = insurerNameEdit.value.trim();
                                  if (!v) return;
                                  // Optimistic: close now; snap back open on failure.
                                  setInsurerNameEdit(null);
                                  void planIdentity.onSaveInsurerName!(v).then((ok) => {
                                    if (!ok) setInsurerNameEdit({ value: v, error: true });
                                  });
                                }}
                                className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setInsurerNameEdit(null)}
                                className="text-[13px] font-medium text-gray-500 hover:text-gray-700"
                              >
                                Cancel
                              </button>
                              {insurerNameEdit.error ? (
                                <span className="w-full text-[12px] text-red-600">Couldn&apos;t save — try again.</span>
                              ) : null}
                            </span>
                          ) : (
                            <>
                              {" "}
                              <button
                                type="button"
                                onClick={() =>
                                  setInsurerNameEdit({
                                    value: planIdentity.insurerName ?? "",
                                    error: false,
                                  })
                                }
                                className="font-medium text-blue-600 hover:text-blue-700"
                              >
                                Fix insurer name
                              </button>
                            </>
                          )
                        ) : null}
                      </>
                    )}
              </Row>
  ) : null;

  if (showNetwork) {
    const editingNetwork = editingRow === "network";
    descs.push({
      key: "network",
      done: networkAnswered && !editingNetwork,
      node: (
              <Row
                flagged={flagRow("network")}
                icon={GlobeIcon}
                label="Network"
                control={
                  networkAnswered && !editingNetwork ? (
                    <DoneEdit label={oonDisplay ? "Out-of-network" : "In-network"} onEdit={() => setEditingRow("network")} />
                  ) : (
                    <span className="inline-flex flex-none items-center gap-2">
                      <Toggle
                        left={{ label: "In-network", prompt: "In-network?", active: !oonDisplay, onSelect: () => { setEditingRow(null); selectNetwork("in_network"); } }}
                        right={{ label: "Out-of-network", prompt: "Out-of-network?", active: oonDisplay, onSelect: () => { setEditingRow(null); selectNetwork("out_of_network"); } }}
                      />
                      {editingNetwork && <CancelLink onClick={() => setEditingRow(null)} />}
                    </span>
                  )
                }
              >
                {oonDisplay ? "You set this visit to out-of-network." : "This visit was billed by an in-network provider."}
              </Row>
      ),
    });
  }

  if (showDeductible) {
    descs.push({
      key: "deductible",
      done: dedAnswered,
      node: (
              <MetRow flagged={flagRow("deductible_met")} source={dedSource} mode={dedAnswered ? "done" : "open"} planTerm={planDeductibleTerm ?? null} planTermNote={planCostSourceNote} kind="deductible" isMet={dedMetDisplay} metAsOf={dedAsOfDisplay} amount={deductibleA?.value ?? null} networkLabel={networkLabel} money={money} onSubmit={selectDeductible} />
      ),
    });
  }

  if (showOop) {
    descs.push({
      key: "oop",
      done: oopAnswered,
      node: (
              <MetRow flagged={flagRow("oop_met")} source={oopSource} mode={oopAnswered ? "done" : "open"} kind="oop" isMet={oopMetDisplay} metAsOf={oopAsOfDisplay} amount={oopA?.value ?? null} networkLabel={networkLabel} money={money} onSubmit={selectOop} />
      ),
    });
  }

  for (const chip of pendingServiceCostChips) {
    descs.push({
      key: `service-pending-${chip.lineId}`,
      done: false,
      node: (
              <Row
                flagged={flagRow(`service_cost:${chip.serviceSlug ?? chip.serviceLabel}`)}
                icon={DocIcon}
                label="Plan cost"
                control={
                  <AddButton label="Add details" onClick={() => onAddPlanDetails({ lineId: chip.lineId, serviceSlug: chip.serviceSlug })} />
                }
              >
                We don&apos;t have your plan&apos;s cost for {chip.serviceLabel} yet, so this is a conservative estimate.
              </Row>
      ),
    });
  }

  for (const sc of statedCosts) {
    const amount =
      sc.copay != null
        ? `$${sc.copay} copay`
        : sc.coinsurancePercent != null
          ? `${sc.coinsurancePercent}% coinsurance`
          : "";
    const openEdit = () => onAddPlanDetails({ lineId: sc.lineId, serviceSlug: sc.serviceSlug });
    if (sc.costProvenance === "user") {
      // S308 (Andrew, round 2) — the deductible half is REQUIRED for done:
      // it changes the math (exempt = owe the copay; subject = owe the full
      // allowed until the deductible is met), so a stated rate with the
      // question open stays an amber ask that SAYS what's missing and answers
      // in one tap (the parser-pinned partial write, merging into the user's
      // own row — safe by this row's render condition). Complete → white →
      // Added.
      const dedOpen = (sc.deductibleApplies ?? dedOptimistic[sc.lineId] ?? null) == null;
      if (dedOpen && sc.serviceSlug) {
        const slug = sc.serviceSlug;
        const answerDed = (val: boolean) => {
          setDedOptimistic((prev) => ({ ...prev, [sc.lineId]: val }));
          const r = onOverride(
            { field: "service_cost", serviceSlug: slug, copay: null, coinsurance: null, deductibleApplies: val },
            "deductible_applies",
          );
          void Promise.resolve(r).then(() => {
            setDedOptimistic((prev) => {
              const next = { ...prev };
              delete next[sc.lineId];
              return next;
            });
          });
        };
        descs.push({
          key: `service-stated-${sc.lineId}`,
          done: false,
          node: (
              <Row
                flagged={flagRow("deductible_applies")}
                icon={DocIcon}
                label="Plan cost"
                control={
                  <span className="inline-flex flex-none items-center gap-2">
                    <Toggle
                      left={{ label: "Yes", prompt: "Yes", active: false, onSelect: () => answerDed(true) }}
                      right={{ label: "No", prompt: "No", active: false, onSelect: () => answerDed(false) }}
                    />
                    <button type="button" onClick={openEdit} className="text-[13px] font-medium text-blue-600 hover:text-blue-700">Edit</button>
                  </span>
                }
              >
                {`You told us your plan's cost for ${sc.serviceLabel} is ${amount} — but not whether it counts toward your deductible, and that changes the math.`}
              </Row>
          ),
        });
      } else {
        descs.push({
          key: `service-stated-${sc.lineId}`,
          done: true,
          node: (
              <Row
                flagged={false}
                icon={DocIcon}
                label="Plan cost"
                control={<ValueEdit value={amount} onEdit={openEdit} />}
              >
                {`You told us your plan's cost for ${sc.serviceLabel} is ${amount}.`}
              </Row>
          ),
        });
      }
    } else {
      descs.push({
        key: `service-stated-${sc.lineId}`,
        done: false,
        node: (
              <Row
                flagged={false}
                icon={DocIcon}
                label="Plan cost"
                control={<AddButton label="Confirm" onClick={openEdit} />}
              >
                {sc.costProvenance === "card"
                  ? `From your insurance card, we have ${amount} for ${sc.serviceLabel}. Cards rarely have this information — confirm or correct it.`
                  : `We have ${amount} as your plan's cost for ${sc.serviceLabel}. Confirm it's right.`}
              </Row>
        ),
      });
    }
  }

  // S310 F16 (Andrew's ruling) — estimate-borrowed rates are confirmable here
  // too. Same wire row the line table's Coverage badge renders from, same S154
  // confirm write; confirming either surface settles both on the refetch.
  for (const er of estimates) {
    const confirming = confirmingEstimateId === er.lineId;
    descs.push({
      key: `estimate:${er.lineId}`,
      done: false,
      node: (
              <Row
                flagged={flagRow(`estimate:${er.lineId}`)}
                icon={DocIcon}
                label={`Estimated rate — ${er.serviceLabel}`}
                control={
                  <span className="inline-flex flex-none items-center gap-2">
                    <button
                      type="button"
                      disabled={confirming || !onConfirmEstimate}
                      onClick={() => void onConfirmEstimate?.(er.lineId)}
                      className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
                    >
                      {confirming ? "Saving…" : "Looks right"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onAddPlanDetails({ lineId: er.lineId, serviceSlug: er.serviceSlug })}
                      className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
                    >
                      Edit
                    </button>
                  </span>
                }
              >
                {er.siblingLabel
                  ? `Your plan doesn't list ${er.serviceLabel.toLowerCase()} directly, so we're using its ${er.siblingLabel} rate: ${er.rateText}. Confirm it or set the real rate.`
                  : `We're using an estimated rate for ${er.serviceLabel.toLowerCase()}: ${er.rateText}. Confirm it or set the real rate.`}
              </Row>
      ),
    });
  }

  if (showAca) {
    descs.push({
      key: "aca",
      done: false,
      node: (
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
      ),
    });
  }

  const openDescs = descs.filter((d) => !d.done);
  const doneDescs = descs.filter((d) => d.done);

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
                  // top border across the tint. S308 — likewise the row that
                  // follows the meter (the seam read as a stray line).
                  "px-5 pb-4 [&>div[data-flagged]+div]:border-t-0 [&>div[data-meter]+div]:border-t-0"
            }
          >
            {!assumptionsOnly && (
              <div className="border-t border-gray-100 pt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">What we assumed</div>
            )}

            {descs.length > 0 && (
              <NeedsMeter completed={doneDescs.length} total={descs.length} />
            )}

            {planIdentityNode}

            {openDescs.map((d) => (
              <Fragment key={d.key}>{d.node}</Fragment>
            ))}

            <AddedFold count={doneDescs.length} open={showAdded} onToggle={() => setShowAdded((v) => !v)}>
              {doneDescs.map((d) => (
                <Fragment key={d.key}>{d.node}</Fragment>
              ))}
            </AddedFold>

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
                Confirm
              </button>
            </div>
          </div>
        )}

        {showUpdateLink && (
          <div className="border-t border-gray-100 px-5 py-3">
            <button
              type="button"
              onClick={() => {
                setDismissed(false);
                onOverride({ field: "assumptions_reviewed", reviewed: false }, "assumptions_reviewed");
              }}
              className="text-[13px] font-medium text-blue-600 hover:text-blue-800"
            >
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
  mode = "open", planTerm = null, planTermNote = null,
}: {
  kind: "deductible" | "oop";
  isMet: boolean;
  metAsOf: string | null;
  amount: number | null;
  networkLabel: string;
  money: (n: number) => string;
  onSubmit: (met: boolean, asOf: string | null) => void;
  /** S308 — "done" renders the calm ✓-status + Edit (the letter-panel format);
   *  Edit re-opens the toggle in place. Default "open" = today's toggle row. */
  mode?: "open" | "done";
  /** S294 reading-order — the plan's own term, stated before the question it
   *  makes relevant (was its own row; merged here per the S308 format rework). */
  planTerm?: string | null;
  planTermNote?: string | null;
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
  // S308 — a "done" row stays calm until its Edit is clicked, then shows the
  // toggle again (self-contained; parent state not needed).
  const [reopened, setReopened] = useState(false);
  const rightActive = isMet || editing;

  const verb = kind === "deductible" ? "met" : "hit";
  const label = kind === "deductible" ? "Deductible" : "Out-of-pocket max";
  const nounBase = kind === "deductible" ? "deductible" : "out-of-pocket max";
  const amt = amount != null ? `${money(amount)} ` : "";
  const noun = kind === "deductible" ? `${amt}${networkLabel} deductible` : `${amt}out-of-pocket max`;

  const doneLabel = kind === "deductible" ? (isMet ? "Met" : "Not met") : (isMet ? "Hit" : "Not hit");
  const control = mode === "done" && !reopened ? (
    <DoneEdit label={doneLabel} onEdit={() => setReopened(true)} />
  ) : (
    <Toggle
      left={{
        label: kind === "deductible" ? "Not met" : "Not hit",
        prompt: kind === "deductible" ? "Not met?" : "Not hit?",
        active: !rightActive,
        // S308 — answering closes a reopened done-row back to its calm ✓ state.
        onSelect: () => { setReopened(false); if (editing) setEditing(false); else onSubmit(false, null); },
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
            {planTerm && (
              // S294 reading-order — the plan's own term, stated BEFORE the
              // question it makes relevant (merged from its former own row).
              <div className="mt-0.5 text-[13px] leading-snug text-gray-600">{planTerm}</div>
            )}
            <div className="mt-0.5 text-[13px] leading-snug text-gray-600">
              {isMet
                ? `You've ${verb} your ${networkLabel} ${nounBase} as of ${fmtDate(metAsOf)}.`
                : `You haven't ${verb} your ${noun} yet, so this applies to it.`}
            </div>
            {planTermNote && (
              <div className="mt-1 text-[12px] text-gray-500">{planTermNote}</div>
            )}
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

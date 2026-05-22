"use client";

/**
 * VerifStrip — S111 D3.
 *
 * Single morphing component that replaces SamePlanConfirmBanner +
 * "Strengthen this letter" blue CTA panel + click-Search-modal from
 * disputes/page.tsx. 4-state morph per Subplan §3d derivation cheat-sheet:
 *
 *   question        → user hasn't answered "same insurer in {billYear}?" yet
 *   checking        → optimistic state after Yes click (modal opens beneath)
 *   bound-verified  → canonical bound via PlanSearchModal (boundCanonicalPlan)
 *   bound-proxy     → user answered Yes but skipped bind (current plan as proxy)
 *   fallback        → user answered No / Not sure; offer Find / Upload / Keep
 *
 * Optimistic local state per D3 — Yes/No/Not sure clicks update local state
 * IMMEDIATELY (perceived 0-latency) while the POST fires in the background.
 * Parent's refetch reconciles props; useEffect syncs derived → local on
 * prop changes. Single component morph eliminates the inter-component
 * re-render race that caused B7 in the S110 smoke.
 *
 * Approved copy verbatim from Subplan §3c.
 */

import { useState, useEffect, useCallback } from "react";

interface ResolvedPlan {
  id: string;
  planName: string | null;
  planYear: number | null;
  insurerName: string | null;
  planType: string | null;
  canonicalPlanId: string | null;
}

interface BoundCanonicalPlan {
  id: string;
  planName: string | null;
  planYear: number | null;
  insurerName: string | null;
  planType: string | null;
  canonicalPlanId: string;
  badgeLevel: "verified" | "community" | "estimated";
}

type StripState =
  | "question"
  | "checking"
  | "confirm-archive"
  | "upload-or-proxy"
  | "fallback"
  | "bound-verified"
  | "bound-proxy";

/**
 * S111 smoke #2 — archive-shape suggestion exposed by the API as
 * `planContext.archiveCanonicalPlan`. Drives the confirm-archive strip view
 * when present alongside `userConfirmedSamePlan="yes"`.
 */
interface ArchiveSuggestion {
  id: string;
  planName: string | null;
  planYear: number | null;
  insurerName: string | null;
}

export interface VerifStripProps {
  disputeId: string;
  /** Bill year derived from claim.plan_year or date_of_service in resolver. */
  billYear: number;
  /** Insurer name shown in question + checking states. Pulled from
   *  planContext.insurer.name when known; falls back to fallbackPlan.insurerName. */
  insurerName: string | null;
  /** User's current plan — drives the bound-proxy state's plan name + year. */
  fallbackPlan: ResolvedPlan | null;
  /** Persisted same-plan-confirm answer. Drives initial state derivation. */
  userConfirmedSamePlan: "yes" | "no" | "not_sure" | null;
  /** S111 smoke #2 — true when user has explicitly chosen to cite current
   *  plan as proxy (clicked "Use current plan as evidence (weaker)"). Set
   *  via confirm-same-plan POST with acceptedProxy=true. When false, the
   *  Yes path renders confirm-archive (if archive exists) or upload-or-proxy
   *  (if no archive); when true, the strip is bound-proxy. */
  userAcceptedProxy: boolean;
  /** S111 smoke #5 — wrong-year banner dismissal flag. When true, the strip
   *  collapses the wrong-year banner to a small clickable badge. Reset to
   *  false on every new bind so the banner re-evaluates against the new
   *  bound canonical's year. */
  wrongYearBannerDismissed: boolean;
  /** S110 Chunk C — auto-discovered Pattern 2 year-shift canonical. When
   *  set, indicates Candid's library has a likely match for the bill-year
   *  plan. Drives the confirm-archive prompt. */
  archiveCanonicalPlan: ArchiveSuggestion | null;
  /** Server-resolved bound canonical (id + name + insurer + badge). */
  boundCanonicalPlan: BoundCanonicalPlan | null;
  /** Firebase bearer token getter — parent owns auth context. */
  getAuthToken: () => Promise<string | null>;
  /** Called after a successful confirm-same-plan POST; parent re-fetches the
   *  dispute so the letter regenerates with the new framing. */
  onConfirmed: (answer: "yes" | "no" | "not_sure") => Promise<void>;
  /** Opens PlanSearchModal in auto mode (yes-with-archive: confirm the match). */
  onOpenSearchModalAuto: () => void;
  /** Opens PlanSearchModal in search mode (Find in library / Change / Pick different). */
  onOpenSearchModalSearch: () => void;
  /** Opens PlanSearchModal in upload mode (Upload my {billYear} plan). */
  onOpenUploadModal: () => void;
  /** S111 smoke #5 — POSTs dismiss-wrong-year-banner + refetches parent. */
  onDismissWrongYearBanner: () => Promise<void>;
}

function deriveState(props: VerifStripProps): StripState {
  // Parent gates rendering when planContext.plan exists; we don't see that
  // case here.
  //
  // Priority (first match wins):
  //   1. boundCanonicalPlan set → bound-verified (canonical bound)
  //   2. userConfirmedSamePlan='yes' + userAcceptedProxy=true → bound-proxy
  //      (user explicitly chose proxy after seeing the post-yes options)
  //   3. userConfirmedSamePlan='yes' + archiveCanonicalPlan set → confirm-archive
  //      (Branch A — auto-discovered Pattern 2 year-shift match; prompt user
  //      to confirm or reject it)
  //   4. userConfirmedSamePlan='yes' + no archive → upload-or-proxy
  //      (Branch B — no library match; prompt upload or explicit proxy)
  //   5. userConfirmedSamePlan='no' or 'not_sure' → fallback (Find / Upload / Proxy)
  //   6. (null) → question (initial prompt)
  if (props.boundCanonicalPlan) return "bound-verified";
  if (props.userConfirmedSamePlan === "yes") {
    if (props.userAcceptedProxy) return "bound-proxy";
    if (props.archiveCanonicalPlan) return "confirm-archive";
    return "upload-or-proxy";
  }
  if (
    props.userConfirmedSamePlan === "no" ||
    props.userConfirmedSamePlan === "not_sure"
  ) {
    return "fallback";
  }
  return "question";
}

/**
 * Monotonic state "level" — used to prevent backward sync when a transient
 * refetch returns stale or stripped data. Initial bug (S111 smoke #1):
 * pressing No optimistically transitioned to fallback, but a refetch race
 * could surface `userConfirmedSamePlan: null` momentarily (e.g., GET handler
 * re-reads dispute before POST commit visible to its connection pool),
 * which then forced derivedState back to "question" + useEffect downgraded
 * localState. By syncing only on upgrade we preserve user intent across
 * any such transient prop regressions.
 */
function stateLevel(s: StripState): number {
  switch (s) {
    case "question":
      return 0;
    case "checking":
      return 1;
    case "confirm-archive":
      return 2;
    case "upload-or-proxy":
      return 2;
    case "fallback":
      return 2;
    case "bound-proxy":
      return 3;
    case "bound-verified":
      return 4;
  }
}

export function VerifStrip(props: VerifStripProps) {
  const derivedState = deriveState(props);
  const [localState, setLocalState] = useState<StripState>(derivedState);
  const [submitting, setSubmitting] = useState<"yes" | "no" | "not_sure" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // D3 — sync local to derived on PROP changes (not every render). Monotonic:
  // only upgrade to a more-advanced state, never downgrade. Prevents the S111
  // smoke #1 regression where a transient refetch with stale metadata could
  // bounce the strip from optimistic "fallback" back to "question".
  useEffect(() => {
    setLocalState((prev) =>
      stateLevel(derivedState) >= stateLevel(prev) ? derivedState : prev,
    );
  }, [derivedState]);

  const handleConfirm = useCallback(
    async (
      answer: "yes" | "no" | "not_sure",
      options?: { acceptedProxy?: boolean },
    ) => {
      if (submitting) return;
      setSubmitting(answer);
      setError(null);
      const acceptedProxy = options?.acceptedProxy === true;
      // Optimistic local state per Yes/No/Not sure + acceptedProxy intent.
      //   Yes + acceptedProxy → bound-proxy (user explicitly chose proxy
      //                                from confirm-archive / upload-or-proxy
      //                                / fallback strips)
      //   Yes + !acceptedProxy → checking (transient; once props refresh,
      //                                derivedState picks confirm-archive
      //                                or upload-or-proxy based on archive
      //                                availability — no auto-open of modal)
      //   No / Not sure  → fallback (inline CTAs)
      if (answer === "yes") {
        setLocalState(acceptedProxy ? "bound-proxy" : "checking");
      } else {
        setLocalState("fallback");
      }
      try {
        const token = await props.getAuthToken();
        if (!token) throw new Error("Sign-in expired. Please reload and try again.");
        const res = await fetch(
          `/api/disputes/${props.disputeId}/confirm-same-plan`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              answer,
              ...(acceptedProxy ? { acceptedProxy: true } : {}),
            }),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `confirm failed (${res.status})`);
        }
        await props.onConfirmed(answer);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save your answer");
        // Revert optimistic update on error so the user can retry. Only
        // downgrade when level allows (consistent with the monotonic
        // useEffect sync above).
        setLocalState((prev) =>
          stateLevel(derivedState) >= stateLevel(prev) ? derivedState : prev,
        );
      } finally {
        setSubmitting(null);
      }
    },
    [submitting, props, derivedState],
  );

  const insurerClause = props.insurerName ?? "your insurer";

  if (localState === "bound-verified" && props.boundCanonicalPlan) {
    return (
      <BoundVerifiedStrip
        bound={props.boundCanonicalPlan}
        billYear={props.billYear}
        archiveCanonicalPlan={props.archiveCanonicalPlan}
        wrongYearBannerDismissed={props.wrongYearBannerDismissed}
        onChange={props.onOpenSearchModalSearch}
        onConfirmBillYearPlan={props.onOpenSearchModalAuto}
        onUploadBillYearPlan={props.onOpenUploadModal}
        onDismissWrongYearBanner={props.onDismissWrongYearBanner}
      />
    );
  }

  if (localState === "bound-proxy") {
    return (
      <BoundProxyStrip
        billYear={props.billYear}
        fallbackPlan={props.fallbackPlan}
        insurerName={props.insurerName}
        archiveCanonicalPlan={props.archiveCanonicalPlan}
        wrongYearBannerDismissed={props.wrongYearBannerDismissed}
        onChange={props.onOpenSearchModalSearch}
        onConfirmBillYearPlan={props.onOpenSearchModalAuto}
        onUploadBillYearPlan={props.onOpenUploadModal}
        onDismissWrongYearBanner={props.onDismissWrongYearBanner}
      />
    );
  }

  if (localState === "confirm-archive" && props.archiveCanonicalPlan) {
    return (
      <ConfirmArchiveStrip
        archive={props.archiveCanonicalPlan}
        billYear={props.billYear}
        onUseThisPlan={props.onOpenSearchModalAuto}
        onPickDifferent={props.onOpenSearchModalSearch}
        onUseCurrentPlan={() =>
          handleConfirm("yes", { acceptedProxy: true })
        }
        submittingProxy={submitting === "yes"}
        error={error}
      />
    );
  }

  if (localState === "upload-or-proxy") {
    return (
      <UploadOrProxyStrip
        billYear={props.billYear}
        onUpload={props.onOpenUploadModal}
        onUseCurrentPlan={() =>
          handleConfirm("yes", { acceptedProxy: true })
        }
        submittingProxy={submitting === "yes"}
        error={error}
      />
    );
  }

  if (localState === "fallback") {
    return (
      <FallbackStrip
        billYear={props.billYear}
        onFindLibrary={props.onOpenSearchModalSearch}
        onUpload={props.onOpenUploadModal}
        onUseCurrentPlan={() =>
          handleConfirm("yes", { acceptedProxy: true })
        }
        submittingYes={submitting === "yes"}
        error={error}
      />
    );
  }

  // question + checking share the shell (same copy, different leading icon
  // + suppressed buttons during checking).
  return (
    <QuestionOrCheckingStrip
      state={localState as "question" | "checking"}
      billYear={props.billYear}
      insurerClause={insurerClause}
      submitting={submitting}
      onYes={() => handleConfirm("yes")}
      onNo={() => handleConfirm("no")}
      onNotSure={() => handleConfirm("not_sure")}
      error={error}
    />
  );
}

// ─── State variants ─────────────────────────────────────────────────────────

function QuestionOrCheckingStrip(props: {
  state: "question" | "checking";
  billYear: number;
  insurerClause: string;
  submitting: "yes" | "no" | "not_sure" | null;
  onYes: () => void;
  onNo: () => void;
  onNotSure: () => void;
  error: string | null;
}) {
  const isChecking = props.state === "checking";
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-blue-700">
          {isChecking ? <SpinnerIcon /> : <QuestionIcon />}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-blue-900">
              {isChecking
                ? `Checking Candid's library for your ${props.billYear} ${props.insurerClause} plan…`
                : `Were you on the same ${props.insurerClause} plan in ${props.billYear}?`}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-blue-800/90">
              We don&apos;t have your {props.billYear} plan on file.{" "}
              <strong>If you had the same insurer in {props.billYear}</strong>,
              we&apos;ll look for it in our community library so this letter can
              cite the actual {props.billYear} cost-sharing terms — materially
              stronger than a statutory-only framing. If you switched insurers,
              we&apos;ll search for the right one or accept an upload.
            </p>
          </div>
          {!isChecking && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={props.onYes}
                disabled={props.submitting != null}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {props.submitting === "yes"
                  ? "Saving…"
                  : `Yes, same ${props.insurerClause} in ${props.billYear}`}
              </button>
              <button
                type="button"
                onClick={props.onNo}
                disabled={props.submitting != null}
                className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {props.submitting === "no" ? "Saving…" : "No, different insurer"}
              </button>
              <button
                type="button"
                onClick={props.onNotSure}
                disabled={props.submitting != null}
                className="rounded-lg border border-blue-200 bg-transparent px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {props.submitting === "not_sure" ? "Saving…" : "Not sure"}
              </button>
            </div>
          )}
          {props.error && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {props.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmArchiveStrip(props: {
  archive: ArchiveSuggestion;
  billYear: number;
  onUseThisPlan: () => void;
  onPickDifferent: () => void;
  onUseCurrentPlan: () => void;
  submittingProxy: boolean;
  error: string | null;
}) {
  const insurer = props.archive.insurerName ?? "your insurer";
  const planName = props.archive.planName ?? "your plan";
  const year = props.archive.planYear ?? props.billYear;
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-blue-700">
          <SparklesIcon />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-blue-900">
              Is this your {props.billYear} plan?
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-blue-800/90">
              Candid&apos;s community library has a likely match. Confirm and
              your letter will cite this plan&apos;s actual cost-sharing terms.
            </p>
          </div>
          <div className="rounded-lg border border-blue-100 bg-white px-3 py-2.5">
            <p className="text-sm font-semibold text-slate-900">
              {planName}
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              {insurer} · {year}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={props.onUseThisPlan}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              Use this plan
            </button>
            <button
              type="button"
              onClick={props.onPickDifferent}
              className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
            >
              Pick a different plan
            </button>
            <button
              type="button"
              onClick={props.onUseCurrentPlan}
              disabled={props.submittingProxy}
              className="rounded-lg border border-transparent bg-transparent px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.submittingProxy
                ? "Saving…"
                : "Use current plan as evidence (weaker)"}
            </button>
          </div>
          {props.error && (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {props.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UploadOrProxyStrip(props: {
  billYear: number;
  onUpload: () => void;
  onUseCurrentPlan: () => void;
  submittingProxy: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-blue-700">
          <UploadIcon />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-blue-900">
              We don&apos;t have your {props.billYear} plan in Candid&apos;s library
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-blue-800/90">
              Upload your {props.billYear} SBC or plan booklet to cite the
              actual cost-sharing terms — or fall back to citing your current
              plan as a proxy.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={props.onUpload}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              <UploadIcon /> Upload my {props.billYear} plan
            </button>
            <button
              type="button"
              onClick={props.onUseCurrentPlan}
              disabled={props.submittingProxy}
              className="rounded-lg border border-transparent bg-transparent px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.submittingProxy
                ? "Saving…"
                : "Use current plan as evidence (weaker)"}
            </button>
          </div>
          {props.error && (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {props.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BoundVerifiedStrip(props: {
  bound: BoundCanonicalPlan;
  billYear: number;
  archiveCanonicalPlan: ArchiveSuggestion | null;
  wrongYearBannerDismissed: boolean;
  onChange: () => void;
  onConfirmBillYearPlan: () => void;
  onUploadBillYearPlan: () => void;
  onDismissWrongYearBanner: () => Promise<void>;
}) {
  const insurer = props.bound.insurerName ?? "Insurer";
  const planName = props.bound.planName ?? "Plan";
  const boundYear = props.bound.planYear;
  // S111 smoke #5 — honest year disclosure. When the bound canonical's year
  // doesn't match the bill year, render a wrong-year treatment (banner +
  // badge) and use copy that admits the proxy nature instead of falsely
  // claiming "Citing your {billYear} plan terms".
  const wrongYear = boundYear != null && boundYear !== props.billYear;

  return (
    <div className="space-y-2">
      {wrongYear && !props.wrongYearBannerDismissed && (
        <WrongYearBanner
          billYear={props.billYear}
          hasArchive={!!props.archiveCanonicalPlan}
          onConfirmBillYearPlan={props.onConfirmBillYearPlan}
          onUploadBillYearPlan={props.onUploadBillYearPlan}
          onDismiss={props.onDismissWrongYearBanner}
        />
      )}
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-emerald-700">
            <ShieldCheckIcon />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h3 className="text-sm font-semibold text-emerald-900">
              {wrongYear
                ? `Citing ${boundYear} plan terms as proxy for ${props.billYear}`
                : `Citing your ${props.billYear} plan terms`}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-slate-900">
                {insurer} · {planName}
              </span>
              <VerificationPill level={props.bound.badgeLevel} />
              <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                <DocIcon /> {boundYear ?? props.billYear} SBC
              </span>
              {wrongYear && props.wrongYearBannerDismissed && (
                <WrongYearBadge
                  billYear={props.billYear}
                  onClick={props.onChange}
                />
              )}
            </div>
            <p className="text-xs leading-relaxed text-emerald-900/90">
              {wrongYear
                ? `Your letter cites the ${boundYear} plan's actual cost-sharing terms as a proxy and requires the insurer to prove any year-over-year differences. Stronger than statutory-only, weaker than a bound ${props.billYear} plan.`
                : "Your letter cites this plan's actual cost-sharing terms. This is materially stronger than a statutory-only framing."}
            </p>
          </div>
          <button
            type="button"
            onClick={props.onChange}
            className="shrink-0 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
          >
            Change
          </button>
        </div>
      </div>
    </div>
  );
}

function BoundProxyStrip(props: {
  billYear: number;
  fallbackPlan: ResolvedPlan | null;
  insurerName: string | null;
  archiveCanonicalPlan: ArchiveSuggestion | null;
  wrongYearBannerDismissed: boolean;
  onChange: () => void;
  onConfirmBillYearPlan: () => void;
  onUploadBillYearPlan: () => void;
  onDismissWrongYearBanner: () => Promise<void>;
}) {
  const insurer =
    props.insurerName ?? props.fallbackPlan?.insurerName ?? "Insurer";
  const planName = props.fallbackPlan?.planName ?? "your current plan";
  const currentYear = props.fallbackPlan?.planYear;
  // S111 smoke #5 — proxy state is always wrong-year by construction (the
  // user has no exact-year plan; we cite the fallback plan whose year
  // differs from the bill year). Banner + badge fire when not dismissed.
  const wrongYear = currentYear != null && currentYear !== props.billYear;

  return (
    <div className="space-y-2">
      {wrongYear && !props.wrongYearBannerDismissed && (
        <WrongYearBanner
          billYear={props.billYear}
          hasArchive={!!props.archiveCanonicalPlan}
          onConfirmBillYearPlan={props.onConfirmBillYearPlan}
          onUploadBillYearPlan={props.onUploadBillYearPlan}
          onDismiss={props.onDismissWrongYearBanner}
        />
      )}
      <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-blue-700">
            <BriefcaseIcon />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h3 className="text-sm font-semibold text-blue-900">
              {currentYear != null
                ? `Citing your current ${currentYear} plan as evidence`
                : `Citing your current plan as evidence`}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-slate-900">
                {insurer} · {planName}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                {currentYear != null ? `Proxy · ${currentYear}` : "Proxy"}
              </span>
              {wrongYear && props.wrongYearBannerDismissed && (
                <WrongYearBadge
                  billYear={props.billYear}
                  onClick={props.onChange}
                />
              )}
            </div>
            <p className="text-xs leading-relaxed text-blue-900/90">
              Your letter cites your current plan&apos;s cost-sharing as a proxy and
              requires the insurer to prove any year-over-year differences.
              Stronger than statutory-only, weaker than a bound {props.billYear}{" "}
              plan.
            </p>
          </div>
          <button
            type="button"
            onClick={props.onChange}
            className="shrink-0 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
          >
            Change
          </button>
        </div>
      </div>
    </div>
  );
}

function WrongYearBanner(props: {
  billYear: number;
  hasArchive: boolean;
  onConfirmBillYearPlan: () => void;
  onUploadBillYearPlan: () => void;
  onDismiss: () => Promise<void>;
}) {
  const [dismissing, setDismissing] = useState(false);
  const handleDismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      await props.onDismiss();
    } finally {
      setDismissing(false);
    }
  };
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-amber-700">
          <WarnIcon />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-relaxed text-amber-900">
            <strong>This dispute is from {props.billYear}.</strong>{" "}
            {props.hasArchive
              ? `We may have your ${props.billYear} plan in Candid's library — confirm to cite the actual ${props.billYear} terms.`
              : `Upload your ${props.billYear} plan for stronger evidence.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {props.hasArchive ? (
              <button
                type="button"
                onClick={props.onConfirmBillYearPlan}
                className="rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700"
              >
                Confirm {props.billYear} plan
              </button>
            ) : (
              <button
                type="button"
                onClick={props.onUploadBillYearPlan}
                className="rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700"
              >
                Upload {props.billYear} plan
              </button>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              disabled={dismissing}
              className="rounded-lg border border-transparent bg-transparent px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dismissing ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WrongYearBadge(props: { billYear: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200 hover:bg-amber-100"
      title={`Click to bind a ${props.billYear} plan`}
    >
      <WarnIconXs /> Wrong year · click to change
    </button>
  );
}

function WarnIconXs() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function FallbackStrip(props: {
  billYear: number;
  onFindLibrary: () => void;
  onUpload: () => void;
  /** S111 smoke #3 — replaces the prior "Keep statutory framing" dismiss
   *  button. Now transitions the strip to bound-proxy state by re-POSTing
   *  the same-plan confirmation with answer="yes", so the letter cites the
   *  user's current plan as a proxy (weaker than a bound bill-year canonical
   *  but stronger than a statutory-only framing). */
  onUseCurrentPlan: () => void;
  submittingYes: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-amber-700">
          <WarnIcon />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-amber-900">
              Strengthen this letter with your {props.billYear} plan terms
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-amber-800/90">
              Right now your letter falls back to a statutory-only framing —
              accurate, but weaker. Adding the actual {props.billYear} plan
              terms lets the letter cite real cost-sharing numbers instead of{" "}
              <span className="font-mono text-[11px]">§503-1(g)</span>{" "}
              reverse-burden language.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={props.onFindLibrary}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              <SearchIcon /> Find in Candid&apos;s library
            </button>
            <button
              type="button"
              onClick={props.onUpload}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
            >
              <UploadIcon /> Upload my {props.billYear} plan
            </button>
            <button
              type="button"
              onClick={props.onUseCurrentPlan}
              disabled={props.submittingYes}
              className="rounded-lg border border-transparent bg-transparent px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.submittingYes
                ? "Saving…"
                : "Use current plan as evidence (weaker)"}
            </button>
          </div>
          {props.error && (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {props.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VerificationPill({
  level,
}: {
  level: BoundCanonicalPlan["badgeLevel"];
}) {
  if (level === "verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        Verified
      </span>
    );
  }
  if (level === "community") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-300">
        Community
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 ring-1 ring-inset ring-slate-300">
      Estimated
    </span>
  );
}

// ─── Icons (inline SVG; matches Lucide-style stroke aesthetic) ──────────────

function QuestionIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
      aria-hidden
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function BriefcaseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z" />
      <path
        d="M19 14l.75 2.5L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.5L19 14z"
        opacity="0.7"
      />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

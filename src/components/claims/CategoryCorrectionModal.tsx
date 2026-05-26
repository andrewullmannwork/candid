/**
 * CategoryCorrectionModal — S74.5 D6
 *
 * Opens when user clicks the category pill on a /claim line item. Lets them
 * search service_catalog slugs and submit a correction via D5 endpoint.
 *
 * Disclaimer copy locked by G1: "Your update is in effect for your Candid
 * account. We'll mark it verified once our community or admins confirm
 * the change."
 *
 * Out of scope (deferred to S74.5b): "Suggest a new category" path,
 * bill-wide "Looks right?" affordance, community-vs-user conflict modal,
 * Case C/D plan-doc nudge.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// S74.5c §3.6 — correction reason picker REMOVED in Session 85 per N-1a
// for a cleaner inline UX. The endpoint still accepts an optional `reason`
// field (see correct-category/route.ts) for future restoration. Telemetry
// signal preserved at the dismiss-finding endpoint (D15) which DOES capture
// reasons today.

interface CatalogSlug {
  slug: string;
  name: string;
  category: string;
}

// S132 iter-6 Phase 1: user's plan coverage per slug. Drives catalog
// filtering, inline coverage badges per row, and best-guess gating.
interface PlanCoverageEntry {
  slug: string;
  covered: boolean | null;
  copay: number | null;
  coinsurance: number | null;
}

interface Props {
  open: boolean;
  claimId: string;
  lineItemId: string;
  billingCode: string | null;
  description: string | null;
  currentSlug: string | null;
  catalog: CatalogSlug[];
  /**
   * Slugs the user's plan actually lists (from plan_covered_services).
   * Empty array = no plan uploaded / plan has zero parsed services.
   * When non-empty: catalog filters to these slugs + best-guess "Use this"
   * disables if currentSlug isn't here.
   */
  userPlanCoverage?: PlanCoverageEntry[];
  onClose: () => void;
  onSubmitted?: (newSlug: string) => void | Promise<void>;
  getAuthToken: () => Promise<string | null>;
}

function formatCoverageBadge(c: PlanCoverageEntry): string {
  if (c.covered === false) return "Not covered";
  const parts: string[] = [];
  if (c.copay != null) parts.push(`$${c.copay} copay`);
  if (c.coinsurance != null) parts.push(`${Math.round((c.coinsurance ?? 0) * 100)}% coinsurance`);
  if (parts.length === 0) return "Covered · $0";
  return `Covered · ${parts.join(" · ")}`;
}

export function CategoryCorrectionModal({
  open,
  claimId,
  lineItemId,
  billingCode,
  description,
  currentSlug,
  catalog,
  userPlanCoverage = [],
  onClose,
  onSubmitted,
  getAuthToken,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(currentSlug);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedSlug(currentSlug);
      setError(null);
      setSubmitting(false);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [open, currentSlug]);

  // S132 iter-6 Phase 1: coverage map for O(1) lookups + filter scope.
  const planCoverageBySlug = useMemo(() => {
    const m = new Map<string, PlanCoverageEntry>();
    for (const c of userPlanCoverage) m.set(c.slug, c);
    return m;
  }, [userPlanCoverage]);

  // Empty-plan fallback: no plan_covered_services rows → fall back to full
  // catalog browse (existing pre-iter-6 behavior). Banner at top tells the
  // user picks won't auto-resolve coverage.
  const hasPlanCoverage = planCoverageBySlug.size > 0;

  // Best-guess gating: if currentSlug isn't in the user's plan, the "Use
  // this" auto-confirm button disables — user is steered toward picking a
  // similar covered service below.
  const currentSlugInPlan = currentSlug ? planCoverageBySlug.has(currentSlug) : false;

  // Catalog scope: when plan coverage data exists, restrict to those slugs
  // (sorted covered-first); otherwise full catalog as fallback.
  const scopedCatalog = useMemo(() => {
    if (!hasPlanCoverage) return catalog;
    const inPlan = catalog.filter((c) => planCoverageBySlug.has(c.slug));
    inPlan.sort((a, b) => {
      const ca = planCoverageBySlug.get(a.slug);
      const cb = planCoverageBySlug.get(b.slug);
      const aCovered = ca?.covered !== false ? 0 : 1;
      const bCovered = cb?.covered !== false ? 0 : 1;
      if (aCovered !== bCovered) return aCovered - bCovered;
      return a.name.localeCompare(b.name);
    });
    return inPlan;
  }, [catalog, planCoverageBySlug, hasPlanCoverage]);

  const filtered = useMemo(() => {
    if (!query.trim()) return scopedCatalog.slice(0, 20);
    const q = query.toLowerCase();
    return scopedCatalog
      .filter(
        (c) =>
          c.slug.includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [query, scopedCatalog]);

  if (!open) return null;

  // S132 iter-4: hoisted from handleSubmit so the "Use this" auto-confirm
  // path on the best-guess card can short-circuit the form-submit flow.
  // Catalog-pick path still routes through handleSubmit (which delegates).
  const actuallySubmit = async (slug: string) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch(
        `/api/claims/${claimId}/line-items/${lineItemId}/correct-category`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ slug }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          retryAfterSeconds?: number;
        };
        if (res.status === 429 && errBody.retryAfterSeconds) {
          throw new Error(`Please wait ${errBody.retryAfterSeconds}s before correcting again.`);
        }
        throw new Error(errBody.error || `Submit failed (${res.status})`);
      }
      await onSubmitted?.(slug);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug) {
      setError("Pick a category from the list.");
      return;
    }
    void actuallySubmit(selectedSlug);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-correction-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 id="category-correction-title" className="text-lg font-semibold text-gray-900">
            Update category
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
          <div className="font-medium text-gray-900">{description || "Line item"}</div>
          {billingCode && (
            <div className="text-gray-600">Code: {billingCode}</div>
          )}
        </div>

        {/* S132 iter-6: best-guess card — "Use this" gated on whether the
            current slug is in user's plan. In-plan → autoconfirm on click.
            Out-of-plan → button disabled + helper text steers user to pick
            a similar covered service from the filtered catalog below. */}
        {currentSlug && (() => {
          const best = catalog.find((c) => c.slug === currentSlug);
          const useDisabled = submitting || (hasPlanCoverage && !currentSlugInPlan);
          const bestCoverage = planCoverageBySlug.get(currentSlug);
          return (
            <div className="mb-5">
              <div className="mb-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-blue-600">
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707M12 6a6 6 0 016 6c0 2.31-1.305 4.314-3.214 5.31a2 2 0 00-.786 1.611V19a2 2 0 11-4 0v-.079c0-.659-.317-1.273-.786-1.611A6 6 0 0112 6z" />
                </svg>
                Our best guess
              </div>
              <button
                type="button"
                onClick={() => actuallySubmit(currentSlug)}
                disabled={useDisabled}
                className="group flex w-full items-center justify-between gap-3 rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50/60 to-white px-4 py-3 text-left shadow-sm transition-all hover:-translate-y-px hover:border-blue-400 hover:from-blue-50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:border-blue-200 disabled:hover:from-blue-50/60 disabled:hover:shadow-sm"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900">
                    {best?.name ?? currentSlug}
                  </div>
                  <div className="font-mono text-xs text-gray-500">
                    {currentSlug}
                  </div>
                  {bestCoverage && (
                    <div className={`mt-1 text-xs font-medium ${bestCoverage.covered === false ? "text-red-700" : "text-green-700"}`}>
                      {formatCoverageBadge(bestCoverage)}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-blue-600 transition-colors group-hover:text-blue-700">
                  {submitting ? (
                    "Saving…"
                  ) : (
                    <>
                      <span>Use this</span>
                      <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </>
                  )}
                </div>
              </button>
              <p className="mt-2 text-xs text-gray-500">
                {hasPlanCoverage && !currentSlugInPlan
                  ? "Your plan doesn't list this. Pick a similar covered service."
                  : "Not right? Search for a different category below."}
              </p>
            </div>
          );
        })()}

        <form onSubmit={handleSubmit}>
          {!hasPlanCoverage && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              No plan uploaded for this claim — picks won&apos;t auto-resolve coverage. Showing the full service catalog.
            </div>
          )}
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {hasPlanCoverage ? "Covered services in your plan" : "Browse all categories"}
          </label>
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. preventive_care, pcp_visit"
            className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />

          <div className="mb-4 max-h-64 overflow-y-auto rounded border border-gray-200">
            {filtered.length === 0 ? (
              <div className="p-3 text-sm text-gray-500">No matches.</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {filtered.map((c) => {
                  const isSelected = c.slug === selectedSlug;
                  const coverage = planCoverageBySlug.get(c.slug);
                  return (
                    <li key={c.slug}>
                      <button
                        type="button"
                        onClick={() => setSelectedSlug(c.slug)}
                        className={`flex w-full items-start justify-between gap-2 p-3 text-left text-sm transition-colors ${
                          isSelected
                            ? "bg-blue-100 ring-2 ring-inset ring-blue-500"
                            : "hover:bg-blue-50"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900">{c.name}</div>
                          <div className="font-mono text-xs text-gray-500">{c.slug}</div>
                          {coverage && (
                            <div className={`mt-0.5 text-xs font-medium ${coverage.covered === false ? "text-red-700" : "text-green-700"}`}>
                              {formatCoverageBadge(coverage)}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {isSelected && (
                            <svg className="h-4 w-4 text-blue-600" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                            {c.category}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* N-1a (Session 85) — correction-reason picker dropped for
              cleaner inline UX. Telemetry signal preserved at endpoint
              level via the dismiss flow (D15) for now; reason capture
              will return in Phase 2 if cross-user pattern analysis needs
              it. */}

          <div className="mb-4 rounded border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900">
            Your update is in effect for your Candid account. We&apos;ll mark it verified once
            our community or admins confirm the change.
          </div>

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
              disabled={submitting || !selectedSlug}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting
                ? "Saving..."
                : selectedSlug === currentSlug
                  ? "Confirm category"
                  : "Update category"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

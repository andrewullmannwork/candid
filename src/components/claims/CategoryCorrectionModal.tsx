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

import { cn } from "@/lib/utils/cn";

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
  // S153 — server-ranked, synonym-aware search results (null = not searched /
  // request in flight; the client substring filter is the in-flight fallback).
  const [serverResults, setServerResults] = useState<CatalogSlug[] | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedSlug(currentSlug);
      setError(null);
      setSubmitting(false);
      setServerResults(null);
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [open, currentSlug]);

  // S153 — debounced server search. Ranks the FULL catalog (synonym-aware; not
  // restricted to the user's plan) and, on a no-result instant pass, retries
  // with semantic=true (one budget-gated Haiku resolve that learns the synonym
  // for next time). The client substring filter (below) covers the in-flight
  // window + any failure.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setServerResults(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const token = await getAuthToken();
        if (!token || cancelled) return;
        const run = async (semantic: boolean) => {
          const res = await fetch("/api/service-catalog/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ query: q, semantic }),
          });
          if (!res.ok) return null;
          const json = (await res.json()) as {
            items?: Array<{ slug: string; name: string; category: string }>;
          };
          return json.items ?? [];
        };
        let items = await run(false);
        if (items && items.length === 0) items = await run(true);
        if (!cancelled && items) {
          setServerResults(
            items.map((i) => ({ slug: i.slug, name: i.name, category: i.category })),
          );
        }
      } catch {
        // Network/parse failure → leave serverResults as-is; client filter covers it.
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open, getAuthToken]);

  // B4.2 — lock body scroll while modal open (design polish).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // B4.2 — escape key closes (design polish).
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);

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
    // S153 — prefer server-ranked, synonym-aware results (full catalog, NOT
    // restricted to the plan, so the correct slug is never hidden). Fall back to
    // the client substring filter while the request is in flight / on failure.
    if (serverResults) return serverResults.slice(0, 20);
    const q = query.toLowerCase();
    return scopedCatalog
      .filter(
        (c) =>
          c.slug.includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [query, scopedCatalog, serverResults]);

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
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/55 p-0 backdrop-blur-sm animate-in fade-in duration-200 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-correction-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-cm-pop flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-[20px] bg-white shadow-[0_32px_64px_-16px_rgba(15,23,42,0.32),0_16px_32px_-8px_rgba(15,23,42,0.12)] sm:max-h-[calc(100vh-3rem)] sm:rounded-[20px]">
        {/* Header — fixed */}
        <header className="flex items-center justify-between border-b border-gray-100 px-6 pb-[18px] pt-[22px]">
          <h2 id="category-correction-title" className="m-0 text-[22px] font-bold leading-tight tracking-[-0.015em] text-gray-900">
            Update category
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <form
          id="category-correction-form"
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* Body — scrollable */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-[22px]">
            {/* Service info card */}
            <div className="mb-5 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3.5">
              <div className="text-[15px] font-bold tracking-[-0.005em] text-gray-900">
                {description || "Line item"}
              </div>
              {billingCode && (
                <div className="mt-[3px] font-mono text-[13px] text-gray-500">
                  Code: {billingCode}
                </div>
              )}
            </div>

            {/* Best-guess card — Open Q C lock: visually separated above search list */}
            {currentSlug && (() => {
              const best = catalog.find((c) => c.slug === currentSlug);
              const useDisabled = submitting || (hasPlanCoverage && !currentSlugInPlan);
              const isSelected = selectedSlug === currentSlug;
              const bestCoverage = planCoverageBySlug.get(currentSlug);
              return (
                <>
                  <div className="mb-[10px] inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-blue-600">
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l2.4 5.7L20 10l-5.6 2.3L12 18l-2.4-5.7L4 10l5.6-2.3L12 2zM19 17l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9.9-2z" />
                    </svg>
                    Our best guess
                  </div>
                  <button
                    type="button"
                    onClick={() => actuallySubmit(currentSlug)}
                    disabled={useDisabled}
                    className={cn(
                      "group flex w-full items-center justify-between gap-4 rounded-2xl border-[1.5px] px-[18px] py-4 text-left transition-all",
                      "bg-gradient-to-b from-[#f6faff] to-blue-50",
                      isSelected
                        ? "border-blue-600 shadow-[0_0_0_3px_rgba(37,99,235,0.14)]"
                        : "border-blue-200 hover:border-blue-600 hover:shadow-[0_0_0_3px_rgba(37,99,235,0.10)]",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      "disabled:hover:border-blue-200 disabled:hover:shadow-none",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-bold leading-[1.2] tracking-[-0.01em] text-gray-900">
                        {best?.name ?? currentSlug}
                      </div>
                      <div className="mt-1 font-mono text-[12.5px] text-gray-500">
                        {currentSlug}
                      </div>
                      {bestCoverage && (
                        <div
                          className={cn(
                            "mt-1.5 text-[13px] font-semibold",
                            bestCoverage.covered === false ? "text-red-700" : "text-green-700",
                          )}
                        >
                          {formatCoverageBadge(bestCoverage)}
                        </div>
                      )}
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[14px] font-semibold text-blue-700">
                      {submitting ? (
                        "Saving…"
                      ) : (
                        <>
                          <span>{isSelected ? "Selected" : "Use this"}</span>
                          <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </>
                      )}
                    </span>
                  </button>
                  <p className="mb-[14px] mt-[18px] text-[13px] text-gray-500">
                    {hasPlanCoverage && !currentSlugInPlan
                      ? "Your plan doesn't list this. Pick a similar covered service."
                      : "Not right? Search for a different category below."}
                  </p>
                </>
              );
            })()}

            {!hasPlanCoverage && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs text-amber-800">
                No plan uploaded for this claim — picks won&apos;t auto-resolve coverage. Showing the full service catalog.
              </div>
            )}

            <label
              htmlFor="cm-search"
              className="mb-2 block text-[13px] font-semibold text-gray-900"
            >
              {hasPlanCoverage ? "Covered services in your plan" : "Browse all categories"}
            </label>
            <input
              id="cm-search"
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. preventive_care, pcp_visit"
              className="h-11 w-full rounded-[10px] border border-gray-200 bg-white px-[14px] text-sm text-gray-900 outline-none transition-all placeholder:font-mono placeholder:text-[13px] placeholder:text-gray-400 focus:border-blue-600 focus:shadow-[0_0_0_3px_rgba(37,99,235,0.14)]"
            />

            <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {filtered.length === 0 ? (
                <div className="p-6 text-center text-[13px] text-gray-400">
                  No matching categories. Try a different search.
                </div>
              ) : (
                <ul className="m-0 flex flex-col p-0">
                  {filtered.map((c, idx) => {
                    const isSelected = c.slug === selectedSlug;
                    const coverage = planCoverageBySlug.get(c.slug);
                    return (
                      <li
                        key={c.slug}
                        className={cn(idx > 0 && "border-t border-gray-100")}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedSlug(c.slug)}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 px-4 py-[14px] text-left transition-colors",
                            isSelected
                              ? "bg-blue-50 shadow-[inset_3px_0_0_#2563eb]"
                              : "bg-white hover:bg-gray-50",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-[14.5px] font-semibold tracking-[-0.005em] text-gray-900">
                              {c.name}
                            </div>
                            <div className="mt-0.5 font-mono text-xs text-gray-500">
                              {c.slug}
                            </div>
                            {coverage && (
                              <div
                                className={cn(
                                  "mt-1 text-[12.5px] font-medium",
                                  coverage.covered === false ? "text-red-700" : "text-green-700",
                                )}
                              >
                                {formatCoverageBadge(coverage)}
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 whitespace-nowrap rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold lowercase text-gray-700">
                            {c.category}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="mt-[18px] flex gap-2.5 rounded-xl border border-blue-100 bg-blue-50 px-3.5 py-3 text-[12.5px] leading-[1.5] text-blue-700">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0"
                aria-hidden
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              <span>
                Your update is in effect for your Candid account. We&apos;ll mark it verified once
                our community or admins confirm the change.
              </span>
            </div>

            {error && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>

          {/* Footer — fixed */}
          <footer className="flex justify-end gap-2.5 border-t border-gray-100 bg-white px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-gray-200 bg-white px-4 py-[9px] text-[13px] font-semibold text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selectedSlug}
              className="rounded-xl bg-blue-600 px-4 py-[9px] text-[13px] font-semibold text-white shadow-[0_0_20px_hsla(217,91%,60%,0.15)] transition-all hover:-translate-y-px hover:bg-blue-700 hover:shadow-[0_0_24px_hsla(217,91%,60%,0.25)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
            >
              {submitting
                ? "Saving..."
                : selectedSlug === currentSlug
                  ? "Confirm category"
                  : "Update category"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

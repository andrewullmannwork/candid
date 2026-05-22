"use client";

/**
 * SearchCanonicalPlanModal — S110 Chunk D.
 *
 * Opens when the user clicked "No, different insurer" on SamePlanConfirmBanner
 * (or any future "Find my <billYear> plan in Candid's library" entry point)
 * and needs to bind a community-corroborated canonical as their bill-year
 * plan so the dispute letter can cite it.
 *
 * Inputs:
 *   - billYear   — pre-filled year filter (the bill's plan_year)
 *   - userState  — pre-filled state filter (from profiles.state) when known
 *
 * Search calls POST /api/plan/search with { query, planYear, insurerHint,
 * state }. Results render with verification-tier badge (Verified / Community
 * / Estimated per Pattern 1 #16) PLUS clear disambiguators per row (insurer
 * + plan name + state + year + metal + plan_type) so the user can pick the
 * correct row without auto-disambiguation (false positive on bind = Pattern
 * 1 #2 violation; asymmetric risk handled by explicit display).
 *
 * Select-to-bind calls POST /api/disputes/[disputeId]/bind-canonical with
 * the selected canonical id. On success, parent re-fetches the dispute so
 * the letter regenerates with Case C-archive framing.
 *
 * Functional-baseline styling per Andrew's S110 direction — Claude Design
 * polish handled in the platform-wide design integration arc (post-S110).
 */

import { useState, useEffect, useCallback } from "react";

type BadgeLevel = "verified" | "community" | "estimated";

interface SearchResult {
  id: string;
  canonicalPlanId: string;
  hiosId: string | null;
  name: string;
  type: string | null;
  state: string | null;
  metalLevel: string | null;
  year: number | null;
  insurerName: string;
  badgeLevel: BadgeLevel;
}

export interface SearchCanonicalPlanModalProps {
  open: boolean;
  disputeId: string;
  billYear: number;
  userState: string | null;
  getAuthToken: () => Promise<string | null>;
  onBound: () => void;
  onClose: () => void;
}

export function SearchCanonicalPlanModal({
  open,
  disputeId,
  billYear,
  userState,
  getAuthToken,
  onBound,
  onClose,
}: SearchCanonicalPlanModalProps) {
  const [insurerQuery, setInsurerQuery] = useState("");
  const [planQuery, setPlanQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<string>(userState ?? "");
  const [yearFilter, setYearFilter] = useState<number>(billYear);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [binding, setBinding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Reset when modal closes so re-opening starts fresh.
  useEffect(() => {
    if (!open) {
      setInsurerQuery("");
      setPlanQuery("");
      setStateFilter(userState ?? "");
      setYearFilter(billYear);
      setResults([]);
      setHasSearched(false);
      setError(null);
      setBinding(null);
    }
  }, [open, userState, billYear]);

  const handleSearch = useCallback(async () => {
    setError(null);
    if (planQuery.trim().length < 2) {
      setError("Type at least 2 characters of the plan name.");
      return;
    }
    setSearching(true);
    setHasSearched(true);
    try {
      const token = await getAuthToken();
      if (!token) throw new Error("Sign-in expired. Please reload and try again.");
      const res = await fetch("/api/plan/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: planQuery.trim(),
          planYear: yearFilter,
          insurerHint: insurerQuery.trim() || undefined,
          state: stateFilter.trim() || undefined,
          canonicalOnly: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Search failed (${res.status})`);
      }
      const data = (await res.json()) as { plans?: SearchResult[] };
      setResults(data.plans ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [planQuery, yearFilter, insurerQuery, stateFilter, getAuthToken]);

  const handleBind = useCallback(
    async (canonicalPlanId: string) => {
      if (binding) return;
      setBinding(canonicalPlanId);
      setError(null);
      try {
        const token = await getAuthToken();
        if (!token) throw new Error("Sign-in expired. Please reload and try again.");
        const res = await fetch(`/api/disputes/${disputeId}/bind-canonical`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ canonicalPlanId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Bind failed (${res.status})`);
        }
        onBound();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to bind plan");
      } finally {
        setBinding(null);
      }
    },
    [binding, getAuthToken, disputeId, onBound, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Find your {billYear} plan in Candid&apos;s library
            </h2>
            <p className="mt-0.5 text-xs text-gray-600">
              Bind a community-corroborated canonical so this letter cites
              the actual {billYear} plan terms.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 border-b px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Insurer (optional)</span>
              <input
                type="text"
                value={insurerQuery}
                onChange={(e) => setInsurerQuery(e.target.value)}
                placeholder="e.g. Anthem, Blue Cross"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Plan name *</span>
              <input
                type="text"
                value={planQuery}
                onChange={(e) => setPlanQuery(e.target.value)}
                placeholder="e.g. Silver 70 PPO"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">State</span>
              <input
                type="text"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="e.g. CA"
                maxLength={2}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm uppercase focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Plan year</span>
              <input
                type="number"
                value={yearFilter}
                onChange={(e) => setYearFilter(parseInt(e.target.value, 10) || billYear)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={handleSearch}
            disabled={searching}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {searching ? "Searching…" : "Search Candid's library"}
          </button>
          {error && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {error}
            </div>
          )}
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-5 py-4">
          {!hasSearched && (
            <p className="text-xs text-gray-500">
              Enter a plan name and click Search. Filters narrow results;
              leave blank to see broader matches.
            </p>
          )}
          {hasSearched && !searching && results.length === 0 && (
            <div className="space-y-2 text-sm text-gray-700">
              <p className="font-medium">
                No matching plans in Candid&apos;s library for these criteria.
              </p>
              <p className="text-xs text-gray-600">
                Your {billYear} plan may not be in the library yet. You can
                upload it directly — the letter will then cite your own plan
                document.
              </p>
              <a
                href="/upload"
                className="inline-block rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Upload my {billYear} plan
              </a>
            </div>
          )}
          {results.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {results.map((r) => (
                <li key={r.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-gray-900">
                          {r.name}
                        </p>
                        <VerificationBadge level={r.badgeLevel} />
                      </div>
                      <p className="mt-0.5 text-xs text-gray-600">
                        {r.insurerName || "Insurer unknown"}
                        {r.year != null && ` · ${r.year}`}
                        {r.state && ` · ${r.state}`}
                        {r.metalLevel && ` · ${capitalize(r.metalLevel)}`}
                        {r.type && ` · ${r.type}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleBind(r.canonicalPlanId)}
                      disabled={binding != null}
                      className="shrink-0 rounded-md border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {binding === r.canonicalPlanId ? "Binding…" : "Use this plan"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function VerificationBadge({ level }: { level: BadgeLevel }) {
  const styles =
    level === "verified"
      ? "bg-emerald-100 text-emerald-800"
      : level === "community"
      ? "bg-blue-100 text-blue-800"
      : "bg-gray-100 text-gray-700";
  const label = level === "verified" ? "Verified" : level === "community" ? "Community" : "Estimated";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles}`}>
      {label}
    </span>
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

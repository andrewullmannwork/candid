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

interface CatalogSlug {
  slug: string;
  name: string;
  category: string;
}

interface Props {
  open: boolean;
  claimId: string;
  lineItemId: string;
  billingCode: string | null;
  description: string | null;
  currentSlug: string | null;
  catalog: CatalogSlug[];
  onClose: () => void;
  onSubmitted?: (newSlug: string) => void | Promise<void>;
  getAuthToken: () => Promise<string | null>;
}

export function CategoryCorrectionModal({
  open,
  claimId,
  lineItemId,
  billingCode,
  description,
  currentSlug,
  catalog,
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

  const filtered = useMemo(() => {
    if (!query.trim()) return catalog.slice(0, 20);
    const q = query.toLowerCase();
    return catalog
      .filter(
        (c) =>
          c.slug.includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [query, catalog]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlug) {
      setError("Pick a category from the list.");
      return;
    }
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
          body: JSON.stringify({ slug: selectedSlug }),
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
      await onSubmitted?.(selectedSlug);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
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
          {currentSlug && (
            <div className="mt-1 text-gray-600">
              Current: <span className="font-mono">{currentSlug}</span>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Search categories
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
                  return (
                    <li key={c.slug}>
                      <button
                        type="button"
                        onClick={() => setSelectedSlug(c.slug)}
                        className={`flex w-full items-start justify-between p-3 text-left text-sm hover:bg-blue-50 ${
                          isSelected ? "bg-blue-100" : ""
                        }`}
                      >
                        <div>
                          <div className="font-medium text-gray-900">{c.name}</div>
                          <div className="font-mono text-xs text-gray-500">{c.slug}</div>
                        </div>
                        <span className="ml-2 rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                          {c.category}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

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
              disabled={submitting || !selectedSlug || selectedSlug === currentSlug}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Saving..." : "Update category"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

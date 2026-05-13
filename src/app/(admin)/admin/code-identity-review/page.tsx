"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

/**
 * /admin/code-identity-review — S74.5 D8 (Session 83).
 *
 * Pattern 1 #16 admin attestation surface for the categorization flywheel.
 * Lists billing_code_identity rows so an admin can:
 *   - Review proposed signatures + raw description corpus
 *   - Pick or correct a service_slug for unmapped proposals
 *   - Click Approve → calls apply_mapping_promotion(..., 'admin_verified', ...)
 *     bypassing the ≥3 EMAIL+PHONE-verified threshold per Pattern 1 #16
 *     cold-start lever
 *
 * Display tabs:
 *   - Proposed (default) — needs admin attention
 *   - Corroborated — promoted via Pattern 1 #3
 *   - Admin Verified — promoted via this surface
 */

interface IdentityRow {
  id: string;
  billing_code: string;
  billing_code_type: string;
  description_signature: string;
  description_examples: string[] | null;
  service_slug: string | null;
  promotion_state: "proposed" | "corroborated" | "admin_verified";
  confidence: number;
  distinct_user_count: number;
  proposed_by_user_id: string | null;
  corroborator_sources: unknown[] | null;
  first_seen_at: string;
  last_corroborated_at: string;
  last_promotion_event_at: string | null;
  created_at: string;
}

interface CatalogSlug {
  slug: string;
  name: string;
  category: string;
}

type Tab = "proposed" | "corroborated" | "admin_verified";

export default function CodeIdentityReviewPage() {
  const { user } = useAuth();
  const { query } = useAdminQuery();
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogSlug[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("proposed");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSlugForId, setEditingSlugForId] = useState<string | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await query({
          table: "billing_code_identity",
          filters: [{ column: "promotion_state", op: "eq", value: tab }],
          order: { column: "last_corroborated_at", ascending: false },
          limit: 200,
        });
        setRows((data as IdentityRow[]) ?? []);
        if (catalog.length === 0) {
          // Lazy-fetch catalog once.
          const res = await fetch("/api/service-catalog");
          if (res.ok) {
            const json = (await res.json()) as { items?: CatalogSlug[] };
            setCatalog(json.items ?? []);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setLoading(false);
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, tab]);

  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) => {
      if (r.billing_code.toLowerCase().includes(q)) return true;
      if (r.billing_code_type.toLowerCase().includes(q)) return true;
      if (r.description_signature.toLowerCase().includes(q)) return true;
      if (r.service_slug?.toLowerCase().includes(q)) return true;
      if (
        (r.description_examples ?? []).some((ex) =>
          ex.toLowerCase().includes(q),
        )
      )
        return true;
      return false;
    });
  }, [rows, searchQuery]);

  async function refreshRows() {
    if (!user) return;
    try {
      const data = await query({
        table: "billing_code_identity",
        filters: [{ column: "promotion_state", op: "eq", value: tab }],
        order: { column: "last_corroborated_at", ascending: false },
        limit: 200,
      });
      setRows((data as IdentityRow[]) ?? []);
    } catch (err) {
      console.error("Refresh failed:", err);
    }
  }

  async function handlePromote(row: IdentityRow, slugOverride?: string) {
    if (!user) return;
    setActioningId(row.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/code-identity/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          identityId: row.id,
          slug: slugOverride ?? row.service_slug ?? "",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      const result = await res.json();
      setSuccessMessage(
        `Promoted ${row.billing_code} (${row.billing_code_type}) → ${result.promotedSlug}`,
      );
      setEditingSlugForId(null);
      await refreshRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Promote failed");
    } finally {
      setActioningId(null);
    }
  }

  const tabCounts = useMemo(() => {
    // Counts are tab-local since we only load one tab at a time. The label
    // shows the loaded count to avoid an extra round-trip for the cross-tab
    // totals; refreshes when the tab changes.
    return { [tab]: rows.length };
  }, [tab, rows.length]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Code Identity Review
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Pattern 1 #16 admin attestation queue for the S74.5 categorization
          flywheel. Promote here to bypass the ≥3 EMAIL+PHONE-verified
          corroboration threshold during cold-start.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {successMessage}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-1">
          {(
            [
              ["proposed", "Proposed"],
              ["corroborated", "Corroborated"],
              ["admin_verified", "Admin Verified"],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {label}
              {tab === key && (
                <span className="ml-1.5 text-gray-400">
                  ({tabCounts[key] ?? 0})
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by code, signature, slug, raw description…"
          className="w-72 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          Loading…
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          No rows match.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Signature</th>
                <th className="px-4 py-3">Service slug</th>
                <th className="px-4 py-3 text-right">Users</th>
                <th className="px-4 py-3 text-right">Confidence</th>
                <th className="px-4 py-3">Last touch</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRows.map((row) => {
                const examples = row.description_examples ?? [];
                const isEditing = editingSlugForId === row.id;
                const canPromote = (slugDraft || row.service_slug) != null;
                const isActioning = actioningId === row.id;
                return (
                  <tr key={row.id} className="align-top hover:bg-gray-50/60">
                    <td className="px-4 py-3 font-mono text-xs">
                      <div className="font-semibold text-gray-900">
                        {row.billing_code}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {row.billing_code_type}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      <div className="font-mono text-[11px]">
                        {row.description_signature}
                      </div>
                      {examples.length > 0 && (
                        <div className="mt-1 space-y-0.5 text-[10px] text-gray-500">
                          {examples.slice(0, 3).map((ex, i) => (
                            <div key={i} className="truncate" title={ex}>
                              · {ex}
                            </div>
                          ))}
                          {examples.length > 3 && (
                            <div className="text-gray-400">
                              + {examples.length - 3} more
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {isEditing ? (
                        <SlugAutocomplete
                          value={slugDraft}
                          onChange={setSlugDraft}
                          catalog={catalog}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSlugForId(row.id);
                            setSlugDraft(row.service_slug ?? "");
                          }}
                          className="font-mono text-blue-600 hover:text-blue-700"
                          title="Click to edit"
                        >
                          {row.service_slug ?? (
                            <span className="text-amber-700">
                              (none — set before promoting)
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {row.distinct_user_count}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {Number(row.confidence).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatRelative(row.last_corroborated_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {tab === "proposed" && (
                        <div className="flex justify-end gap-2">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSlugForId(null);
                                  setSlugDraft("");
                                }}
                                disabled={isActioning}
                                className="rounded px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePromote(row, slugDraft)}
                                disabled={isActioning || !slugDraft}
                                className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                              >
                                {isActioning ? "Promoting…" : "Save + Promote"}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handlePromote(row)}
                              disabled={!canPromote || isActioning}
                              className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                              title={
                                row.service_slug
                                  ? "Promote to admin_verified"
                                  : "Set a service slug first"
                              }
                            >
                              {isActioning ? "Promoting…" : "Promote"}
                            </button>
                          )}
                        </div>
                      )}
                      {tab !== "proposed" && (
                        <span className="text-[10px] text-gray-400">
                          {row.promotion_state.replace(/_/g, " ")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SlugAutocomplete({
  value,
  onChange,
  catalog,
}: {
  value: string;
  onChange: (v: string) => void;
  catalog: CatalogSlug[];
}) {
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    if (!value.trim()) return catalog.slice(0, 8);
    const q = value.toLowerCase();
    return catalog
      .filter(
        (c) =>
          c.slug.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [value, catalog]);

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Pick or type a slug"
        className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-48 w-72 overflow-y-auto rounded border border-gray-200 bg-white shadow-lg">
          {filtered.map((c) => (
            <li key={c.slug}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(c.slug);
                  setOpen(false);
                }}
                className="flex w-full items-start justify-between px-2 py-1.5 text-left text-xs hover:bg-blue-50"
              >
                <span>
                  <span className="block font-medium text-gray-900">
                    {c.name}
                  </span>
                  <span className="block font-mono text-[10px] text-gray-500">
                    {c.slug}
                  </span>
                </span>
                <span className="ml-2 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                  {c.category}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const delta = Math.max(0, now - then);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

/**
 * /admin/code-identity-seeds — S74.6 §H.2 A2 (Session 89).
 *
 * Lists `billing_code_identity` rows whose corroborator_sources contain an
 * `admin_seed` entry (loaded via the §G bootstrap CLI). Admin can:
 *   - Demote a seed row back to `proposed` when downstream evidence
 *     contradicts (calls /api/admin/code-identity/demote).
 *   - Promote a corroborated seed to admin_verified via the existing
 *     /api/admin/code-identity/promote (locks it as admin-attested).
 *
 * Per Subplan §G governance: admin = 1 vote, not authority. A seed in
 * proposed state needs 4 more user votes to corroborate; a contradicting
 * user-vote cohort wins over the seed slug.
 */

interface IdentityRow {
  id: string;
  billing_code: string;
  billing_code_type: string;
  description_signature: string;
  service_slug: string | null;
  promotion_state: string;
  distinct_user_count: number;
  corroborator_sources: Array<{
    source?: string;
    source_label?: string;
    basis?: string;
    recorded_at?: string;
  }> | null;
  last_promotion_event_at: string | null;
  created_at: string;
}

function findSeedEntry(row: IdentityRow): {
  source_label?: string;
  basis?: string;
  recorded_at?: string;
} | null {
  if (!Array.isArray(row.corroborator_sources)) return null;
  return (
    row.corroborator_sources.find(
      (s) => s.source === "admin_seed" || s.source === "admin_seed_pre_launch",
    ) ?? null
  );
}

export default function CodeIdentitySeedsPage() {
  const { user } = useAuth();
  const { query } = useAdminQuery();
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  async function load() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      // Server-side JSONB filter via the existing /api/admin/query is more
      // surgical than client-side filtering, but the helper doesn't expose a
      // JSONB op. Pull recent rows and filter client-side — small N (<1000
      // expected before MVP, per §G ~50 seeds).
      const data = await query({
        table: "billing_code_identity",
        order: { column: "created_at", ascending: false },
        limit: 1000,
      });
      const all = (data as IdentityRow[]) ?? [];
      const seeded = all.filter((r) => findSeedEntry(r) != null);
      setRows(seeded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter(
      (r) =>
        r.billing_code.toLowerCase().includes(q) ||
        r.billing_code_type.toLowerCase().includes(q) ||
        r.description_signature.toLowerCase().includes(q) ||
        r.service_slug?.toLowerCase().includes(q) ||
        findSeedEntry(r)?.source_label?.toLowerCase().includes(q),
    );
  }, [rows, searchQuery]);

  async function handleDemote(row: IdentityRow) {
    if (!user) return;
    const reason = window.prompt(
      "Demote reason (optional — used in audit log):",
      "",
    );
    if (reason === null) return;
    setActioningId(row.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/code-identity/demote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ identityId: row.id, reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Demote failed (${res.status})`);
      }
      const result = await res.json();
      setSuccessMessage(
        `Demoted ${row.billing_code}/${row.billing_code_type} from ${result.fromState} → proposed`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demote failed");
    } finally {
      setActioningId(null);
    }
  }

  async function handleAdminVerify(row: IdentityRow) {
    if (!user) return;
    if (!row.service_slug) {
      setError("Cannot admin-verify a row with no service_slug");
      return;
    }
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
        body: JSON.stringify({ identityId: row.id, slug: row.service_slug }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      setSuccessMessage(
        `Locked ${row.billing_code}/${row.billing_code_type} as admin_verified`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Promote failed");
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Admin Seeds — Code Identity
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          S74.6 §H.2 A2 — billing_code_identity rows seeded via the
          admin-bootstrap CLI. Demote when downstream evidence contradicts.
          Lock as admin_verified when a corroborated row should resist future
          drift.
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
        <div className="text-xs text-gray-500">{filteredRows.length} seed rows</div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by code, signature, slug, source…"
          className="w-72 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
      </div>

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          Loading…
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          No admin-seeded rows match.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Seed source</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3 text-right">Users</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRows.map((row) => {
                const seed = findSeedEntry(row);
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
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">
                      {row.service_slug ?? (
                        <span className="text-amber-700">(unset)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      <div>{seed?.source_label ?? "—"}</div>
                      {seed?.basis && (
                        <div className="text-[10px] text-gray-500">
                          {seed.basis}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-700">
                        {row.promotion_state.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {row.distinct_user_count}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        {row.promotion_state === "corroborated" && (
                          <button
                            type="button"
                            onClick={() => handleAdminVerify(row)}
                            disabled={isActioning}
                            className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            Lock as admin_verified
                          </button>
                        )}
                        {(row.promotion_state === "corroborated" ||
                          row.promotion_state === "admin_verified") && (
                          <button
                            type="button"
                            onClick={() => handleDemote(row)}
                            disabled={isActioning}
                            className="rounded border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            Demote
                          </button>
                        )}
                      </div>
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

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * /admin/recoding-outcomes — S74.6 §H.3 A3 (Session 89).
 *
 * Lists dispute_outcomes rows where the insurer reprocessed under a different
 * code (recoded_as_code IS NOT NULL), grouped by recoded code pair. Admin
 * can mark a pattern as "do not surface" → flips do_not_surface_in_letters=TRUE
 * on every matching billing_code_identity row → peer-code-engine excludes
 * the pattern from future dispute letters.
 */

interface RecodingGroup {
  recodedAsCode: string;
  recodedAsCodeType: string;
  winCount: number;
  totalRecovered: number;
  distinctUsers: number;
  distinctClaims: number;
  latestAt: string;
  doNotSurface: boolean;
}

export default function RecodingOutcomesPage() {
  const { user } = useAuth();
  const [groups, setGroups] = useState<RecodingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningKey, setActioningKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function load() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/recoding-outcomes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Load failed (${res.status})`);
      }
      const { groups: g } = (await res.json()) as { groups: RecodingGroup[] };
      setGroups(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleToggle(group: RecodingGroup) {
    if (!user) return;
    const key = `${group.recodedAsCode}||${group.recodedAsCodeType}`;
    setActioningKey(key);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/recoding-outcomes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recodedAsCode: group.recodedAsCode,
          recodedAsCodeType: group.recodedAsCodeType,
          doNotSurface: !group.doNotSurface,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Toggle failed (${res.status})`);
      }
      const result = await res.json();
      setSuccessMessage(
        `${result.doNotSurface ? "Suppressed" : "Re-enabled"} ${group.recodedAsCode}/${group.recodedAsCodeType} (${result.updatedRowCount} identity rows updated)`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Toggle failed");
    } finally {
      setActioningKey(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Recoding Outcomes</h1>
        <p className="mt-1 text-sm text-gray-600">
          S74.6 §H.3 A3 — disputes where the insurer reprocessed under a
          different code. Suppress a pattern to remove it from dispute-letter
          alternative-code recommendations.
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

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          Loading…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          No recoding outcomes yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Recoded as</th>
                <th className="px-4 py-3 text-right">Wins</th>
                <th className="px-4 py-3 text-right">Total recovered</th>
                <th className="px-4 py-3 text-right">Users</th>
                <th className="px-4 py-3 text-right">Claims</th>
                <th className="px-4 py-3">Latest</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {groups.map((g) => {
                const key = `${g.recodedAsCode}||${g.recodedAsCodeType}`;
                const isActioning = actioningKey === key;
                return (
                  <tr key={key} className="align-top hover:bg-gray-50/60">
                    <td className="px-4 py-3 font-mono text-xs">
                      <div className="font-semibold text-gray-900">
                        {g.recodedAsCode}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {g.recodedAsCodeType}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {g.winCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      ${g.totalRecovered.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {g.distinctUsers}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {g.distinctClaims}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(g.latestAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleToggle(g)}
                        disabled={isActioning}
                        className={`rounded px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                          g.doNotSurface
                            ? "bg-green-600 text-white hover:bg-green-700"
                            : "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                        }`}
                      >
                        {g.doNotSurface ? "Re-enable" : "Suppress"}
                      </button>
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

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * /admin/cost-cap — S74.6 §H.4 A4 (Session 89).
 *
 * Lists users currently paused on the $10/user/day Haiku spend cap (the §F.1
 * cap-trigger flow). Admin can:
 *   - Unfreeze: clears paused_at + pause_reason. Optionally resets the day's
 *     accumulated total to 0 so the user can keep working.
 *   - Override: sets override_cap_usd for today (raises the cap for that user
 *     without bumping the global default).
 */

interface PausedRow {
  userId: string;
  email: string | null;
  firebaseUid: string | null;
  dayIso: string;
  totalCostUsd: number;
  pausedAt: string;
  pauseReason: string | null;
  overrideCapUsd: number | null;
  updatedAt: string;
}

export default function CostCapPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<PausedRow[]>([]);
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
      const res = await fetch("/api/admin/cost-cap", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Load failed (${res.status})`);
      }
      const { paused } = (await res.json()) as { paused: PausedRow[] };
      setRows(paused);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleUnfreeze(row: PausedRow, resetTotal: boolean) {
    if (!user) return;
    const reason = window.prompt(
      `Unfreeze reason for ${row.email ?? row.userId} (optional):`,
      "",
    );
    if (reason === null) return;
    const key = `${row.userId}|${row.dayIso}`;
    setActioningKey(key);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/cost-cap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "unfreeze",
          userId: row.userId,
          dayIso: row.dayIso,
          resetTotal,
          reason,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Unfreeze failed (${res.status})`);
      }
      setSuccessMessage(
        `Unfroze ${row.email ?? row.userId} for ${row.dayIso}${resetTotal ? " (total reset)" : ""}`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unfreeze failed");
    } finally {
      setActioningKey(null);
    }
  }

  async function handleOverride(row: PausedRow) {
    if (!user) return;
    const raw = window.prompt(
      `Set override_cap_usd for ${row.email ?? row.userId} on ${row.dayIso} (USD; blank to clear):`,
      row.overrideCapUsd != null ? String(row.overrideCapUsd) : "",
    );
    if (raw === null) return;
    const trimmed = raw.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError("Override must be a non-negative number or blank");
      return;
    }
    const key = `${row.userId}|${row.dayIso}`;
    setActioningKey(key);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/cost-cap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "override",
          userId: row.userId,
          dayIso: row.dayIso,
          overrideCapUsd: parsed,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Override failed (${res.status})`);
      }
      setSuccessMessage(
        `Set override_cap_usd=${parsed == null ? "null" : `$${parsed.toFixed(2)}`} for ${row.email ?? row.userId}`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    } finally {
      setActioningKey(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Cost-Cap Paused</h1>
        <p className="mt-1 text-sm text-gray-600">
          S74.6 §H.4 A4 — users currently paused on the $10/user/day Haiku
          spend cap. Last 7 days. Unfreeze to allow further calls; override
          to raise the cap for trusted users.
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
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          No paused users in the last 7 days.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Day</th>
                <th className="px-4 py-3 text-right">Total spend</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Override</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => {
                const key = `${row.userId}|${row.dayIso}`;
                const isActioning = actioningKey === key;
                return (
                  <tr key={key} className="align-top hover:bg-gray-50/60">
                    <td className="px-4 py-3 text-xs">
                      <div className="font-semibold text-gray-900">
                        {row.email ?? "(no email)"}
                      </div>
                      <div className="font-mono text-[10px] text-gray-500">
                        {row.userId.slice(0, 8)}…
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {row.dayIso}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      ${row.totalCostUsd.toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {row.pauseReason ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-xs">
                      {row.overrideCapUsd != null
                        ? `$${row.overrideCapUsd.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleUnfreeze(row, false)}
                          disabled={isActioning}
                          className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          Unfreeze
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUnfreeze(row, true)}
                          disabled={isActioning}
                          className="rounded border border-blue-200 bg-blue-50 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                          title="Unfreeze + reset day's total to 0"
                        >
                          Unfreeze + reset
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOverride(row)}
                          disabled={isActioning}
                          className="rounded border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                        >
                          Override cap
                        </button>
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

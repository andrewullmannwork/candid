"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

/**
 * /admin/code-identity-disambiguate — S74.6 §H.1 A1 (Session 89).
 *
 * Resolves pending `code_identity_admin_review_queue` rows. Each pending row
 * surfaces the 2-candidate ambiguous pair from the D4 Haiku description-match
 * (top-1 score ≥ 0.85, gap to top-2 < 0.05). Admin picks the winning slug →
 * resolver promotes the chosen `billing_code_identity` row to admin_verified,
 * rejects the sibling (admin_rejected), backfills peer claim_line_items.
 *
 * Decline button: marks BOTH candidates as admin_rejected, queue row as
 * 'rejected'. Used when neither candidate is actually right.
 */

interface CandidateSlug {
  slug: string;
  score: number;
}

interface QueueRow {
  id: string;
  identity_id: string;
  proposed_by_user_id: string | null;
  source_line_item_id: string | null;
  candidate_slugs: CandidateSlug[];
  status: string;
  created_at: string;
}

interface SeedIdentity {
  id: string;
  billing_code: string;
  billing_code_type: string;
  description_signature: string;
}

export default function CodeIdentityDisambiguatePage() {
  const { user } = useAuth();
  const { query } = useAdminQuery();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [identityMap, setIdentityMap] = useState<Map<string, SeedIdentity>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function load() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const data = await query({
        table: "code_identity_admin_review_queue",
        filters: [{ column: "status", op: "eq", value: "pending" }],
        order: { column: "created_at", ascending: false },
        limit: 100,
      });
      const queueRows = (data as QueueRow[]) ?? [];
      setRows(queueRows);

      // Hydrate seed identities so we can show the code + signature.
      const identityIds = Array.from(
        new Set(queueRows.map((r) => r.identity_id)),
      );
      if (identityIds.length > 0) {
        const idData = await query({
          table: "billing_code_identity",
          filters: [{ column: "id", op: "in", value: identityIds }],
          limit: 200,
        });
        const map = new Map<string, SeedIdentity>();
        for (const r of (idData as SeedIdentity[]) ?? []) {
          map.set(r.id, r);
        }
        setIdentityMap(map);
      } else {
        setIdentityMap(new Map());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleResolve(row: QueueRow, chosenSlug: string) {
    if (!user) return;
    setActioningId(row.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/code-identity/disambiguate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ queueId: row.id, chosenSlug }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Resolve failed (${res.status})`);
      }
      const result = await res.json();
      setSuccessMessage(
        `Resolved → ${chosenSlug}; rejected ${result.rejectedSiblings} siblings; backfilled ${result.backfillUpdatedRowCount} peer line items`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve failed");
    } finally {
      setActioningId(null);
    }
  }

  async function handleDecline(row: QueueRow) {
    if (!user) return;
    const reason = window.prompt(
      "Decline reason (optional — used in audit log):",
      "",
    );
    if (reason === null) return; // user hit Cancel
    setActioningId(row.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/code-identity/decline-ambiguous", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ queueId: row.id, reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Decline failed (${res.status})`);
      }
      const result = await res.json();
      setSuccessMessage(
        `Declined; rejected ${result.rejectedCount} ambiguous candidates`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decline failed");
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Disambiguate Code Identity
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          S74.6 §H.1 A1 — resolve pending ambiguous description-match results.
          Pick the winning slug to promote it + reject the sibling.
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
          No pending ambiguous candidates. The queue is empty.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const ident = identityMap.get(row.identity_id);
            const isActioning = actioningId === row.id;
            const candidates = Array.isArray(row.candidate_slugs)
              ? row.candidate_slugs
              : [];
            return (
              <div
                key={row.id}
                className="rounded-lg border border-gray-200 bg-white p-4"
              >
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <div className="font-mono text-sm font-semibold text-gray-900">
                      {ident
                        ? `${ident.billing_code} (${ident.billing_code_type})`
                        : "(identity row missing)"}
                    </div>
                    {ident && (
                      <div className="mt-0.5 font-mono text-xs text-gray-500">
                        Signature: {ident.description_signature}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-gray-400">
                      Enqueued {new Date(row.created_at).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDecline(row)}
                    disabled={isActioning}
                    className="rounded border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    Decline both
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {candidates.map((c, i) => (
                    <button
                      key={`${c.slug}-${i}`}
                      type="button"
                      onClick={() => handleResolve(row, c.slug)}
                      disabled={isActioning}
                      className="flex items-center justify-between rounded border border-blue-200 bg-blue-50 px-3 py-2 text-left hover:bg-blue-100 disabled:opacity-50"
                    >
                      <div>
                        <div className="font-mono text-xs font-semibold text-gray-900">
                          {c.slug}
                        </div>
                        <div className="mt-0.5 text-[10px] text-gray-600">
                          Pick this as the winning slug
                        </div>
                      </div>
                      <div className="ml-2 shrink-0 rounded bg-white px-2 py-1 font-mono text-xs text-blue-700">
                        {Number(c.score).toFixed(2)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

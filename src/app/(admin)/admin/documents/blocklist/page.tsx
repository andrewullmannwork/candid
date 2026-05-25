"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface BlocklistRow {
  file_hash: string;
  reason: string;
  added_by_email: string | null;
  added_at: string;
  notes: string | null;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export default function FileHashBlocklistPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<BlocklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [formHash, setFormHash] = useState("");
  const [formReason, setFormReason] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyHash, setBusyHash] = useState<string | null>(null);

  async function getToken() {
    return user!.firebaseUser.getIdToken();
  }

  async function loadRows() {
    try {
      const idToken = await getToken();
      const res = await fetch("/api/admin/documents/blocklist", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows || []);
      } else {
        setRows([]);
      }
    } catch (err) {
      console.error("[blocklist] load failed:", err);
      setRows([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRows();
  }, [user]);

  async function addHash(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const hash = formHash.trim().toLowerCase();
    const reason = formReason.trim();
    const notes = formNotes.trim();

    if (!SHA256_HEX.test(hash)) {
      setFormError("Hash must be 64-character lowercase hex (SHA-256).");
      return;
    }
    if (!reason) {
      setFormError("Reason is required.");
      return;
    }

    setSubmitting(true);
    try {
      const idToken = await getToken();
      const res = await fetch("/api/admin/documents/blocklist", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_hash: hash, reason, notes: notes || undefined }),
      });
      if (res.ok) {
        setFormHash("");
        setFormReason("");
        setFormNotes("");
        await loadRows();
      } else {
        const data = await res.json().catch(() => ({}));
        setFormError(data.error || "Failed to add hash.");
      }
    } catch {
      setFormError("Request failed.");
    }
    setSubmitting(false);
  }

  async function removeHash(hash: string) {
    if (!confirm(`Remove ${hash.slice(0, 12)}… from the blocklist?\n\nFuture uploads of this file will be accepted again.`)) {
      return;
    }
    setBusyHash(hash);
    try {
      const idToken = await getToken();
      const res = await fetch(`/api/admin/documents/blocklist?hash=${encodeURIComponent(hash)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.file_hash !== hash));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Remove failed: ${data.error || "Unknown error"}`);
      }
    } catch {
      alert("Remove request failed.");
    }
    setBusyHash(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">File Hash Blocklist</h1>
          <p className="text-sm text-gray-500 mt-1">
            Permanently reject uploads matching these SHA-256 hashes — before storage write, classifier, or Haiku spend. {rows.length} hash{rows.length !== 1 ? "es" : ""} blocked.
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); loadRows(); }}
          className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      <form
        onSubmit={addHash}
        className="mb-6 p-4 bg-white border border-gray-200 rounded-xl space-y-3"
      >
        <h2 className="text-sm font-semibold text-gray-900">Add hash</h2>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">File hash (SHA-256, 64 hex chars)</label>
          <input
            type="text"
            value={formHash}
            onChange={(e) => setFormHash(e.target.value)}
            placeholder="e.g. a3f1c9b2…"
            className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Reason (required)</label>
          <input
            type="text"
            value={formReason}
            onChange={(e) => setFormReason(e.target.value)}
            placeholder='e.g. "synthetic SBC sample 42" or "incident #2026-005 poisoning attempt"'
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
          <input
            type="text"
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            placeholder="Slack permalink, ticket ID, secondary reviewer, etc."
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400"
          />
        </div>

        {formError && (
          <p className="text-xs text-red-600">{formError}</p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? "Adding…" : "Block hash"}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="flex items-center justify-center min-h-32">
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl">
          No hashes blocked yet.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Hash</th>
                <th className="px-4 py-2 text-left font-medium">Reason</th>
                <th className="px-4 py-2 text-left font-medium">Added by</th>
                <th className="px-4 py-2 text-left font-medium">Added at</th>
                <th className="px-4 py-2 text-left font-medium">Notes</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.file_hash} className="hover:bg-gray-50/50">
                  <td className="px-4 py-2 font-mono text-xs text-gray-700" title={row.file_hash}>
                    {row.file_hash.slice(0, 12)}…
                  </td>
                  <td className="px-4 py-2 text-gray-900">{row.reason}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{row.added_by_email || "—"}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {new Date(row.added_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">{row.notes || "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => removeHash(row.file_hash)}
                      disabled={busyHash === row.file_hash}
                      className="px-3 py-1 text-xs font-medium text-gray-600 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50"
                    >
                      {busyHash === row.file_hash ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

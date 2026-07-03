/**
 * /admin/insurer-appeals — Phase 6.3 admin review queue
 *
 * Three cards:
 *   1. Pending changes (doc extraction + user corrections awaiting review)
 *   2. Stale addresses (admin_verified > 365d or doc_extraction < 3 verifications)
 *   3. Coverage gaps (insurers with no appeals address seeded)
 */
"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface PendingProposal {
  id: string;
  insurerId: string;
  insurerName: string;
  proposedBy: string;
  sourceExcerpt: string | null;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  confidence: number | null;
  createdAt: string;
}

interface StaleRow {
  id: string;
  name: string;
  appeals_source: string | null;
  appeals_verification_count: number;
  appeals_last_confirmed_at: string | null;
}

interface GapRow {
  id: string;
  name: string;
  appeals_source: string | null;
}

interface RecentRow {
  id: string;
  name: string;
  source: string | null;
  lastConfirmedAt: string | null;
  values: Record<string, string | null>;
}

// The editable appeals-address fields (snake_case — matches proposed_values + the review API).
const PROPOSED_FIELDS = ["address_line_1", "address_line_2", "city", "state", "postal_code", "phone"] as const;

function proposedToFields(proposed: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PROPOSED_FIELDS) out[k] = proposed[k] == null ? "" : String(proposed[k]);
  return out;
}

export default function InsurerAppealsAdminPage() {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingProposal[]>([]);
  const [stale, setStale] = useState<StaleRow[]>([]);
  const [gaps, setGaps] = useState<GapRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-proposal editable address fields (admin can fix a value before accepting).
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [reviewError, setReviewError] = useState<string | null>(null);
  // "Recently updated — revise" section: edit an already-set appeals address directly.
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [recentEdits, setRecentEdits] = useState<Record<string, Record<string, string>>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/insurer-appeals", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const nextPending: PendingProposal[] = data.pending ?? [];
      setPending(nextPending);
      setStale(data.stale ?? []);
      setGaps(data.coverageGaps ?? []);
      setEdits(Object.fromEntries(nextPending.map((p) => [p.id, proposedToFields(p.proposed)])));
      const nextRecent: RecentRow[] = data.recentlyUpdated ?? [];
      setRecent(nextRecent);
      setRecentEdits(Object.fromEntries(nextRecent.map((r) => [r.id, proposedToFields(r.values)])));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const review = async (proposalId: string, decision: "accept" | "reject") => {
    if (!user) return;
    setReviewError(null);
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/admin/insurer-appeals/review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      // On accept, send the (possibly-edited) fields; the API validates + writes these.
      body: JSON.stringify({
        proposalId,
        decision,
        ...(decision === "accept" ? { editedValues: edits[proposalId] } : {}),
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setReviewError(err.error ?? "Review failed. Check the address fields and try again.");
      return;
    }
    await refresh();
  };

  const saveRevision = async (insurerId: string) => {
    if (!user) return;
    setSaveMsg(null);
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/admin/insurer-appeals/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ insurerId, values: recentEdits[insurerId] }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setSaveMsg(err.error ?? "Save failed. Check the address fields.");
      return;
    }
    setSaveMsg("Saved.");
    await refresh();
  };

  if (loading) {
    return (
      <div className="p-6 text-sm text-slate-500">Loading insurer appeals review queue…</div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Insurer appeals review queue</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pattern 1 admin-review surface for the self-updating insurer appeals registry.
          All doc-extracted + user-proposed mutations land here before touching the canonical table.
        </p>
      </header>

      <Card title={`Pending changes (${pending.length})`}>
        {reviewError ? (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {reviewError}
          </div>
        ) : null}
        {pending.length === 0 ? (
          <EmptyState label="No pending proposals. Everything is up to date." />
        ) : (
          <ul className="divide-y divide-slate-200">
            {pending.map((p) => (
              <li key={p.id} className="py-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="font-semibold text-slate-900">{p.insurerName}</div>
                  <div className="text-xs text-slate-500">
                    {new Date(p.createdAt).toLocaleString("en-US")}
                  </div>
                </div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Proposed by {p.proposedBy.replace("_", " ")}
                  {p.confidence != null ? ` · confidence ${Math.round(p.confidence * 100)}%` : ""}
                </div>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <ValueBlock title="Current" values={p.current} />
                  <EditableProposed
                    fields={edits[p.id] ?? proposedToFields(p.proposed)}
                    onChange={(k, v) =>
                      setEdits((prev) => ({
                        ...prev,
                        [p.id]: { ...(prev[p.id] ?? proposedToFields(p.proposed)), [k]: v },
                      }))
                    }
                  />
                </div>
                {p.sourceExcerpt ? (
                  <blockquote className="mt-3 border-l-2 border-indigo-200 bg-slate-50 px-3 py-2 text-xs italic text-slate-700">
                    &ldquo;{p.sourceExcerpt}&rdquo;
                  </blockquote>
                ) : null}
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => review(p.id, "accept")}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => review(p.id, "reject")}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Stale addresses (${stale.length})`}>
        {stale.length === 0 ? (
          <EmptyState label="No stale addresses — everything verified recently." />
        ) : (
          <ul className="divide-y divide-slate-200 text-sm">
            {stale.map((s) => (
              <li key={s.id} className="py-2">
                <div className="font-medium text-slate-900">{s.name}</div>
                <div className="text-xs text-slate-500">
                  source: {s.appeals_source ?? "—"} · verifications: {s.appeals_verification_count} · last confirmed:{" "}
                  {s.appeals_last_confirmed_at
                    ? new Date(s.appeals_last_confirmed_at).toLocaleDateString("en-US")
                    : "never"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Coverage gaps (${gaps.length})`}>
        {gaps.length === 0 ? (
          <EmptyState label="No coverage gaps — every referenced insurer has appeals data." />
        ) : (
          <ul className="divide-y divide-slate-200 text-sm">
            {gaps.map((g) => (
              <li key={g.id} className="py-2">
                <div className="font-medium text-slate-900">{g.name}</div>
                <div className="text-xs text-slate-500">
                  {g.appeals_source ? `source: ${g.appeals_source}` : "no data"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Recently updated — revise (${recent.length})`}>
        {saveMsg ? (
          <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {saveMsg}
          </div>
        ) : null}
        {recent.length === 0 ? (
          <EmptyState label="No appeals addresses set yet." />
        ) : (
          <ul className="divide-y divide-slate-200">
            {recent.map((r) => (
              <li key={r.id} className="py-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="font-semibold text-slate-900">{r.name}</div>
                  <div className="text-xs text-slate-500">
                    {r.source ?? "—"}
                    {r.lastConfirmedAt ? ` · ${new Date(r.lastConfirmedAt).toLocaleDateString("en-US")}` : ""}
                  </div>
                </div>
                <EditableProposed
                  fields={recentEdits[r.id] ?? proposedToFields(r.values)}
                  onChange={(k, v) =>
                    setRecentEdits((prev) => ({
                      ...prev,
                      [r.id]: { ...(prev[r.id] ?? proposedToFields(r.values)), [k]: v },
                    }))
                  }
                />
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => saveRevision(r.id)}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    Save
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="py-6 text-center text-sm text-slate-500">{label}</div>;
}

function ValueBlock({
  title,
  values,
  highlight,
}: {
  title: string;
  values: Record<string, unknown>;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 text-xs ${
        highlight ? "border-emerald-300 bg-emerald-50/60" : "border-slate-200 bg-slate-50/60"
      }`}
    >
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <dl className="space-y-0.5 text-slate-800">
        {Object.entries(values).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-slate-500">{k}</dt>
            <dd className="truncate text-right">{v == null ? "—" : String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EditableProposed({
  fields,
  onChange,
}: {
  fields: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50/60 p-3 text-xs">
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Proposed (editable)</div>
      <dl className="space-y-1 text-slate-800">
        {PROPOSED_FIELDS.map((k) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-slate-500">{k}</dt>
            <input
              type="text"
              value={fields[k] ?? ""}
              onChange={(e) => onChange(k, e.target.value)}
              className="w-44 rounded border border-slate-300 bg-white px-2 py-1 text-right text-xs focus:border-emerald-500 focus:outline-none"
            />
          </div>
        ))}
      </dl>
    </div>
  );
}

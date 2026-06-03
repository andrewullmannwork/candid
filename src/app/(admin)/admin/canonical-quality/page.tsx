"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

// ── response shapes (mirror /api/admin/canonical-quality) ────────────────────
interface PromotionRow {
  canonical_plan_id: string;
  document_type: string;
  doctype_promoted: boolean;
  promotion_event_type: string | null;
  promoted_at: string | null;
  re_baseline_required: boolean;
  coverage_score: number | null;
  distinct_users_count: number;
  total_qualifying_uploads: number;
  last_evaluated_at: string | null;
}
interface InvalidationEvent {
  id: string;
  canonical_plan_id: string;
  document_type: string | null;
  event_type: string;
  triggering_user_ids: string[] | null;
  divergent_value_jsonb: Record<string, unknown> | null;
  baseline_value_jsonb: Record<string, unknown> | null;
  admin_disposition: string | null;
  admin_disposition_at: string | null;
  created_at: string;
}
interface DriftEvent {
  id: string;
  canonical_plan_id: string;
  document_type: string;
  detection_type: string;
  divergence_rate_30d: number | null;
  divergent_user_count_30d: number | null;
  window_days: number | null;
  triggered_re_baseline: boolean;
  created_at: string;
}
interface DivergenceRow {
  id: string;
  canonical_plan_id: string;
  document_type: string;
  field_name: string;
  minority_value_jsonb: Record<string, unknown>;
  minority_value_key: string | null;
  minority_weight: number;
  total_weight: number;
  minority_share: number | null;
  contributing_user_ids: string[] | null;
  divergence_type: string;
  status: string;
  admin_notes: string | null;
  created_at: string;
  updated_at: string | null;
}

type Tab = "promotion" | "invalidation" | "divergence";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "promotion", label: "Promotion state" },
  { value: "invalidation", label: "Invalidation & drift" },
  { value: "divergence", label: "Divergence review" },
];
const DIVERGENCE_TYPES = [
  "unclassified",
  "possible_plan_variant",
  "possible_adversarial",
  "possible_stale_doc",
  "possible_haiku_noise",
];

const short = (id: string) => `${id.slice(0, 8)}…`;
const fmt = (t: string | null) => (t ? new Date(t).toLocaleString() : "—");

export default function CanonicalQualityPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("promotion");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<PromotionRow[]>([]);
  const [events, setEvents] = useState<InvalidationEvent[]>([]);
  const [drift, setDrift] = useState<DriftEvent[]>([]);
  const [divergence, setDivergence] = useState<DivergenceRow[]>([]);
  const [promotedFilter, setPromotedFilter] = useState<"all" | "true" | "false">("all");
  const [divStatus, setDivStatus] = useState<"pending" | "all">("pending");

  const token = useCallback(async () => {
    if (!user) throw new Error("not signed in");
    return user.firebaseUser.getIdToken();
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const idToken = await token();
      const params = new URLSearchParams({ view: tab });
      if (tab === "promotion" && promotedFilter !== "all") params.set("promoted", promotedFilter);
      if (tab === "divergence") params.set("status", divStatus);
      const res = await fetch(`/api/admin/canonical-quality?${params}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Load failed");
      if (tab === "promotion") setPromotion(data.rows ?? []);
      else if (tab === "invalidation") {
        setEvents(data.events ?? []);
        setDrift(data.drift ?? []);
      } else setDivergence(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [user, tab, promotedFilter, divStatus, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function dispose(
    target: "divergence" | "invalidation",
    id: string,
    status: "confirmed" | "rejected" | "deferred",
    extra?: { divergence_type?: string; admin_notes?: string },
  ) {
    try {
      const idToken = await token();
      const res = await fetch("/api/admin/canonical-quality", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ target, id, status, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Disposition failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disposition failed");
    }
  }

  return (
    <div className="max-w-7xl">
      <h1 className="text-2xl font-bold text-gray-900">Canonical Quality (CF-40 v4)</h1>
      <p className="mt-1 text-sm text-gray-500">
        Layer-3 promotion state, Layer-4 invalidation/drift telemetry, and the minority-candidate
        admin queue. Empty until <code className="text-xs">cf40_v4_algorithm</code> is flipped ON (Ing-D.1).
      </p>

      <div className="mt-5 flex gap-2 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
              tab === t.value
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mt-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>}
      {loading && <div className="mt-4 text-sm text-gray-500">Loading…</div>}

      {/* ── Promotion state ── */}
      {!loading && tab === "promotion" && (
        <div className="mt-4">
          <div className="flex gap-2 mb-3 text-sm">
            <span className="text-gray-500">Promoted:</span>
            {(["all", "true", "false"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setPromotedFilter(v)}
                className={promotedFilter === v ? "font-semibold text-blue-700" : "text-gray-500"}
              >
                {v}
              </button>
            ))}
          </div>
          {promotion.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <Th>Canonical</Th><Th>Doc type</Th><Th>Promoted</Th><Th>Event</Th>
                  <Th>Coverage</Th><Th>Users</Th><Th>Uploads</Th><Th>Re-baseline</Th><Th>Evaluated</Th>
                </tr>
              </thead>
              <tbody>
                {promotion.map((r) => (
                  <tr key={`${r.canonical_plan_id}-${r.document_type}`} className="border-b hover:bg-gray-50">
                    <Td mono>{short(r.canonical_plan_id)}</Td>
                    <Td>{r.document_type}</Td>
                    <Td>{r.doctype_promoted ? "✅" : "—"}</Td>
                    <Td>{r.promotion_event_type ?? "—"}</Td>
                    <Td>{r.coverage_score ?? "—"}</Td>
                    <Td>{r.distinct_users_count}</Td>
                    <Td>{r.total_qualifying_uploads}</Td>
                    <Td>{r.re_baseline_required ? "⚠️ yes" : "no"}</Td>
                    <Td>{fmt(r.last_evaluated_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Invalidation & drift ── */}
      {!loading && tab === "invalidation" && (
        <div className="mt-4 space-y-8">
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Invalidation events</h2>
            {events.length === 0 ? (
              <Empty />
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <Th>Canonical</Th><Th>Doc</Th><Th>Event</Th><Th>Disposition</Th><Th>When</Th><Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-b hover:bg-gray-50">
                      <Td mono>{short(e.canonical_plan_id)}</Td>
                      <Td>{e.document_type ?? "—"}</Td>
                      <Td>{e.event_type}</Td>
                      <Td>{e.admin_disposition ?? "pending"}</Td>
                      <Td>{fmt(e.created_at)}</Td>
                      <Td>
                        {(e.admin_disposition === null || e.admin_disposition === "pending") && (
                          <DisposeButtons onDispose={(s) => dispose("invalidation", e.id, s)} />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Drift telemetry (fire + non-fire)</h2>
            {drift.length === 0 ? (
              <Empty />
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <Th>Canonical</Th><Th>Doc</Th><Th>Detector</Th><Th>Rate</Th><Th>Users</Th><Th>Window</Th><Th>Fired</Th><Th>When</Th>
                  </tr>
                </thead>
                <tbody>
                  {drift.map((d) => (
                    <tr key={d.id} className="border-b hover:bg-gray-50">
                      <Td mono>{short(d.canonical_plan_id)}</Td>
                      <Td>{d.document_type}</Td>
                      <Td>{d.detection_type}</Td>
                      <Td>{d.divergence_rate_30d ?? "—"}</Td>
                      <Td>{d.divergent_user_count_30d ?? "—"}</Td>
                      <Td>{d.window_days ?? "—"}d</Td>
                      <Td>{d.triggered_re_baseline ? "🔥" : "—"}</Td>
                      <Td>{fmt(d.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      {/* ── Divergence review ── */}
      {!loading && tab === "divergence" && (
        <div className="mt-4">
          <div className="flex gap-2 mb-3 text-sm">
            <span className="text-gray-500">Status:</span>
            {(["pending", "all"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setDivStatus(v)}
                className={divStatus === v ? "font-semibold text-blue-700" : "text-gray-500"}
              >
                {v}
              </button>
            ))}
          </div>
          {divergence.length === 0 ? (
            <Empty />
          ) : (
            <div className="space-y-3">
              {divergence.map((r) => (
                <DivergenceCard key={r.id} row={r} onDispose={dispose} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── small presentational helpers ─────────────────────────────────────────────
function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-2 pr-4 font-medium">{children}</th>;
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={`py-2 pr-4 ${mono ? "font-mono text-xs" : ""}`}>{children}</td>;
}
function Empty() {
  return <div className="text-sm text-gray-400 py-6 text-center border border-dashed rounded-lg">No rows.</div>;
}

function DisposeButtons({ onDispose }: { onDispose: (s: "confirmed" | "rejected" | "deferred") => void }) {
  return (
    <span className="flex gap-1">
      <button onClick={() => onDispose("confirmed")} className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200">Confirm</button>
      <button onClick={() => onDispose("rejected")} className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">Reject</button>
      <button onClick={() => onDispose("deferred")} className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200">Defer</button>
    </span>
  );
}

function DivergenceCard({
  row,
  onDispose,
}: {
  row: DivergenceRow;
  onDispose: (
    target: "divergence",
    id: string,
    status: "confirmed" | "rejected" | "deferred",
    extra?: { divergence_type?: string; admin_notes?: string },
  ) => void;
}) {
  const [type, setType] = useState(row.divergence_type);
  const [notes, setNotes] = useState(row.admin_notes ?? "");
  const v = row.minority_value_jsonb as { value?: unknown; baseline_value?: unknown; plausible?: boolean; source?: string };
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <div className="flex justify-between items-start">
        <div className="text-sm">
          <span className="font-mono text-xs text-gray-500">{short(row.canonical_plan_id)}</span>{" "}
          <span className="font-medium">{row.document_type}</span> ·{" "}
          <span className="font-medium">{row.field_name}</span>
          <div className="mt-1 text-gray-700">
            minority <b>{String(v.value ?? row.minority_value_key)}</b> vs baseline <b>{String(v.baseline_value ?? "?")}</b>
            {v.plausible === false && <span className="ml-2 text-amber-600 text-xs">⚠ implausible (likely parse noise)</span>}
          </div>
          <div className="mt-0.5 text-xs text-gray-400">
            weight {row.minority_weight}/{row.total_weight} (share {row.minority_share ?? "—"}) · {row.contributing_user_ids?.length ?? 0} users · {row.status} · src {v.source ?? "?"}
          </div>
        </div>
      </div>
      {row.status === "pending" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={type} onChange={(e) => setType(e.target.value)} className="text-xs border rounded px-2 py-1">
            {DIVERGENCE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="notes (optional)"
            className="text-xs border rounded px-2 py-1 flex-1 min-w-[120px]"
          />
          <button onClick={() => onDispose("divergence", row.id, "confirmed", { divergence_type: type, admin_notes: notes })} className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200">Confirm</button>
          <button onClick={() => onDispose("divergence", row.id, "rejected", { divergence_type: type, admin_notes: notes })} className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">Reject</button>
          <button onClick={() => onDispose("divergence", row.id, "deferred", { divergence_type: type, admin_notes: notes })} className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200">Defer</button>
        </div>
      )}
    </div>
  );
}

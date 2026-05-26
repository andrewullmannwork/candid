"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface SummaryResponse {
  view: "summary";
  window_days: number;
  total_decisions: number;
  match_rate: number;
  by_step: Record<string, number>;
}

interface SignatureRow {
  input_signature: string;
  distinct_canonicals_count: number;
  decision_count: number;
  step_counts: Record<string, number>;
  sample_input: { planName?: string; insurerId?: string; planYear?: number };
  last_seen: string;
}

interface SignaturesResponse {
  view: "signatures";
  window_days: number;
  total_signatures: number;
  signatures: SignatureRow[];
}

interface NearMissRow {
  id: string;
  document_id: string | null;
  input_signature: string;
  best_score: number | null;
  candidate_count: number;
  matched_canonical_id: string;
  rejected_top_candidate_id: string | null;
  sample_input: { planName?: string; insurerId?: string; planYear?: number };
  reason: string | null;
  created_at: string;
}

interface NearMissesResponse {
  view: "near_misses";
  window_days: number;
  count: number;
  near_misses: NearMissRow[];
}

const WINDOW_OPTIONS = [1, 7, 30, 90];
const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "signatures", label: "Signature duplicates" },
  { value: "near_misses", label: "Near-misses (0.5-0.7)" },
];

type View = "summary" | "signatures" | "near_misses";

export default function CanonicalMatchDecisionsPage() {
  const { user } = useAuth();
  const [windowDays, setWindowDays] = useState(7);
  const [view, setView] = useState<View>("summary");
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [signatures, setSignatures] = useState<SignaturesResponse | null>(null);
  const [nearMisses, setNearMisses] = useState<NearMissesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const idToken = await user!.firebaseUser.getIdToken();
      const res = await fetch(
        `/api/admin/canonical-match-decisions?window_days=${windowDays}&view=${view}`,
        { headers: { Authorization: `Bearer ${idToken}` } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to load decisions");
        return;
      }
      const data = await res.json();
      if (view === "summary") setSummary(data);
      else if (view === "signatures") setSignatures(data);
      else if (view === "near_misses") setNearMisses(data);
    } catch (err) {
      console.error("[canonical-match-decisions] load failed:", err);
      setError("Failed to load decisions");
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!user) return;
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, windowDays, view]);

  return (
    <div className="max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Canonical Match Decisions (Ing-K Phase 1)</h1>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-600">Window:</span>
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-3 py-1 rounded ${
                windowDays === d
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-200 hover:bg-gray-100"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-gray-600 mb-4">
        Every <code>findOrCreateCanonicalPlan</code> exit is logged here. Ing-K Phase 1 is
        observability only — Phase 2 ships a targeted matching fix based on the failure-mode
        distribution captured here. Three views below diagnose different root causes.
      </p>

      <div className="flex gap-2 mb-6 text-sm border-b border-gray-200">
        {VIEW_OPTIONS.map((v) => (
          <button
            key={v.value}
            onClick={() => setView(v.value)}
            className={`px-4 py-2 -mb-px border-b-2 ${
              view === v.value
                ? "border-blue-600 text-blue-600 font-semibold"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500">Loading…</div>}
      {error && <div className="text-red-600">{error}</div>}

      {view === "summary" && summary && (
        <SummaryView data={summary} />
      )}

      {view === "signatures" && signatures && (
        <SignaturesView data={signatures} />
      )}

      {view === "near_misses" && nearMisses && (
        <NearMissesView data={nearMisses} />
      )}
    </div>
  );
}

function SummaryView({ data }: { data: SummaryResponse }) {
  const stepOrder = ["group_number", "hios_id", "fuzzy_auto", "fuzzy_needs_confirmation", "create_new"];
  return (
    <>
      <div className="grid grid-cols-3 gap-4 mb-6">
        <SummaryCard label="Total decisions" value={data.total_decisions.toString()} />
        <SummaryCard label="Match rate" value={`${(data.match_rate * 100).toFixed(1)}%`} />
        <SummaryCard
          label="New canonicals created"
          value={(data.by_step["create_new"] ?? 0).toString()}
        />
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-2">Step</th>
              <th className="px-4 py-2 text-right">Decisions</th>
              <th className="px-4 py-2 text-right">% of total</th>
            </tr>
          </thead>
          <tbody>
            {stepOrder.map((step) => {
              const count = data.by_step[step] ?? 0;
              const pct = data.total_decisions > 0 ? (count / data.total_decisions) * 100 : 0;
              return (
                <tr key={step} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-xs">{step}</td>
                  <td className="px-4 py-2 text-right font-semibold">{count}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{pct.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SignaturesView({ data }: { data: SignaturesResponse }) {
  return (
    <>
      <p className="text-sm text-gray-600 mb-4">
        Signatures sorted by distinct canonicals created. Same SBC uploaded twice = same
        signature. <strong>distinct_canonicals_count &gt; 1 indicates Ing-K dedup-quality
        bug</strong> (the matcher failed to find the existing canonical on the second upload).
      </p>
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-2">Signature</th>
              <th className="px-4 py-2">Sample input (planName / insurerId / planYear)</th>
              <th className="px-4 py-2 text-right">Distinct canonicals</th>
              <th className="px-4 py-2 text-right">Decisions</th>
              <th className="px-4 py-2">Step counts</th>
              <th className="px-4 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data.signatures.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  No decisions recorded in this window.
                </td>
              </tr>
            ) : (
              data.signatures.map((s) => (
                <tr key={s.input_signature} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-[10px] text-gray-500">
                    {s.input_signature.slice(0, 12)}…
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <span className="font-medium">{s.sample_input.planName ?? "—"}</span>
                    <span className="text-gray-400 ml-1">
                      / {String(s.sample_input.insurerId ?? "—").slice(0, 8)}… /{" "}
                      {s.sample_input.planYear ?? "—"}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-2 text-right font-semibold ${
                      s.distinct_canonicals_count > 1 ? "text-red-600" : ""
                    }`}
                  >
                    {s.distinct_canonicals_count}
                  </td>
                  <td className="px-4 py-2 text-right">{s.decision_count}</td>
                  <td className="px-4 py-2 text-xs">
                    {Object.entries(s.step_counts)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(", ")}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {new Date(s.last_seen).toISOString().slice(0, 16)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NearMissesView({ data }: { data: NearMissesResponse }) {
  return (
    <>
      <p className="text-sm text-gray-600 mb-4">
        <code>create_new</code> decisions where the top candidate scored 0.5-0.7 (would have
        matched under a lower threshold). These are the most actionable surface for Phase 2
        threshold calibration. Sorted by score desc.
      </p>
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-2 text-right">Score</th>
              <th className="px-4 py-2">Sample input</th>
              <th className="px-4 py-2 text-right">Candidates</th>
              <th className="px-4 py-2">Rejected top candidate</th>
              <th className="px-4 py-2">Created new</th>
              <th className="px-4 py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {data.near_misses.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                  No near-misses in this window.
                </td>
              </tr>
            ) : (
              data.near_misses.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-right font-mono font-semibold text-amber-700">
                    {(r.best_score ?? 0).toFixed(3)}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <span className="font-medium">{r.sample_input.planName ?? "—"}</span>
                    <span className="text-gray-400 ml-1">
                      / {r.sample_input.planYear ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">{r.candidate_count}</td>
                  <td className="px-4 py-2 font-mono text-[10px] text-gray-500">
                    {r.rejected_top_candidate_id?.slice(0, 8) ?? "—"}…
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-gray-500">
                    {r.matched_canonical_id.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {new Date(r.created_at).toISOString().slice(0, 16)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
    </div>
  );
}

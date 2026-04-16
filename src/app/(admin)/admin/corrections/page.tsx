"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface CorrectionRow {
  id: string;
  user_id: string;
  service_slug: string;
  field: string;
  old_value: string | null;
  proposed_value: string;
  notes: string | null;
  status: string;
  review_notes: string | null;
  created_at: string;
}

export default function CorrectionsPage() {
  const { user } = useAuth();
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "applied" | "all">("pending");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/plan/corrections?status=${filter}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setCorrections(data.corrections || []);
        }
      } catch (err) {
        console.error("Failed to load corrections:", err);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user, filter]);

  async function loadCorrections() {
    if (!user) return;
    setLoading(true);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch(`/api/plan/corrections?status=${filter}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCorrections(data.corrections || []);
      }
    } catch (err) {
      console.error("Failed to load corrections:", err);
    }
    setLoading(false);
  }

  async function reviewCorrection(correctionId: string, decision: "approved" | "rejected") {
    if (!user) return;
    try {
      const idToken = await user.firebaseUser.getIdToken();
      await fetch("/api/plan/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ action: "review", correctionId, decision }),
      });
      loadCorrections();
    } catch (err) {
      console.error("Review failed:", err);
    }
  }

  async function applyCorrection(correctionId: string) {
    if (!user) return;
    try {
      const idToken = await user.firebaseUser.getIdToken();
      await fetch("/api/plan/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ action: "apply", correctionId }),
      });
      loadCorrections();
    } catch (err) {
      console.error("Apply failed:", err);
    }
  }

  const FIELD_LABELS: Record<string, string> = {
    copay: "Copay",
    coinsurance: "Coinsurance",
    covered: "Coverage",
    prior_auth: "Prior Auth",
    deductible_applies: "Deductible",
    annual_limit: "Annual Limit",
    other: "Other",
  };

  const STATUS_COLORS: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800",
    approved: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
    applied: "bg-blue-100 text-blue-800",
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Benefit Corrections</h1>
      <p className="text-sm text-gray-500 mb-6">Review and apply user-submitted benefit corrections.</p>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {(["pending", "approved", "rejected", "applied", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              filter === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading corrections...</p>
      ) : corrections.length === 0 ? (
        <p className="text-sm text-gray-400">No corrections found.</p>
      ) : (
        <div className="space-y-3">
          {corrections.map((c) => (
            <div key={c.id} className="p-4 bg-white border border-gray-200 rounded-xl">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900">
                      {c.service_slug.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}
                    </h3>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[c.status] || ""}`}>
                      {c.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    <strong>{FIELD_LABELS[c.field] || c.field}:</strong>{" "}
                    {c.old_value && <><span className="line-through text-red-500">{c.old_value}</span> &rarr; </>}
                    <span className="font-medium text-green-700">{c.proposed_value}</span>
                  </p>
                  {c.notes && <p className="text-xs text-gray-400 mt-1">Note: {c.notes}</p>}
                  <p className="text-[10px] text-gray-300 mt-1">{new Date(c.created_at).toLocaleDateString()}</p>
                </div>

                <div className="flex gap-2 shrink-0">
                  {c.status === "pending" && (
                    <>
                      <button
                        onClick={() => reviewCorrection(c.id, "approved")}
                        className="text-xs px-3 py-1.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => reviewCorrection(c.id, "rejected")}
                        className="text-xs px-3 py-1.5 bg-red-100 text-red-700 rounded-lg font-medium hover:bg-red-200"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {c.status === "approved" && (
                    <button
                      onClick={() => applyCorrection(c.id)}
                      className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
                    >
                      Apply to Plan
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

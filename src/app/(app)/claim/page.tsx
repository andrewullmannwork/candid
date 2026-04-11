"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { useEffect, useState } from "react";

interface Dispute {
  id: string;
  disputeType: string;
  status: string;
  amountDisputed: number;
  amountRecovered: number;
  filedDate: string;
  resolutionDate: string | null;
  claimId: string | null;
}

interface DisputeData {
  disputes: Dispute[];
  totalRecovered: number;
  activeCount: number;
}

const STATUS_STYLES: Record<string, string> = {
  filed: "text-blue-700 bg-blue-50",
  in_progress: "text-amber-700 bg-amber-50",
  won: "text-green-700 bg-green-50",
  lost: "text-red-700 bg-red-50",
  settled: "text-green-700 bg-green-50",
  withdrawn: "text-gray-700 bg-gray-50",
};

const STATUS_LABELS: Record<string, string> = {
  filed: "Filed",
  in_progress: "Under Review",
  won: "Won",
  lost: "Lost",
  settled: "Settled",
  withdrawn: "Withdrawn",
};

const TYPE_LABELS: Record<string, string> = {
  internal_appeal: "Insurance Appeal",
  external_appeal: "External Appeal",
  complaint: "Complaint",
  legal: "Legal Action",
  negotiation: "Billing Dispute",
};

export default function CandidClaimPage() {
  const { user } = useAuth();
  const [data, setData] = useState<DisputeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    fetch(`/api/disputes/outcome?userId=${user.userId}`)
      .then((res) => res.json())
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-gray-500">Loading claims...</p>
      </div>
    );
  }

  const hasDisputes = data && data.disputes.length > 0;
  const activeDisputes = data?.disputes.filter((d) => d.status === "filed" || d.status === "in_progress") || [];
  const resolvedDisputes = data?.disputes.filter((d) => d.status === "won" || d.status === "settled" || d.status === "lost" || d.status === "withdrawn") || [];

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Candid Claim</h1>
        <p className="mt-1 text-sm text-gray-500">Track disputes, recoveries, and connect with legal help.</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="p-4 bg-white border border-gray-100 rounded-xl">
          <p className="text-2xl font-bold text-green-600">${(data?.totalRecovered || 0).toLocaleString()}</p>
          <p className="text-xs font-medium text-gray-500 mt-1">Total Recovered</p>
        </div>
        <div className="p-4 bg-white border border-gray-100 rounded-xl">
          <p className="text-2xl font-bold text-gray-900">{data?.activeCount || 0}</p>
          <p className="text-xs font-medium text-gray-500 mt-1">Active Disputes</p>
        </div>
        <div className="p-4 bg-white border border-gray-100 rounded-xl">
          <p className="text-2xl font-bold text-gray-900">{data?.disputes.length || 0}</p>
          <p className="text-xs font-medium text-gray-500 mt-1">Total Disputes</p>
        </div>
      </div>

      {!hasDisputes && (
        <div className="p-8 bg-white border border-gray-100 rounded-xl text-center mb-6">
          <p className="text-sm text-gray-500 mb-4">No disputes yet. Upload a bill to get started with an audit.</p>
          <Link href="/upload" className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
            Upload a bill
          </Link>
        </div>
      )}

      {/* Active disputes */}
      {activeDisputes.length > 0 && (
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Active Disputes</h2>
          <div className="space-y-2">
            {activeDisputes.map((d) => (
              <DisputeCard key={d.id} dispute={d} onUpdate={(update) => handleOutcomeUpdate(d.id, update)} />
            ))}
          </div>
        </div>
      )}

      {/* Resolved disputes */}
      {resolvedDisputes.length > 0 && (
        <div className="mb-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Resolved</h2>
          <div className="space-y-2">
            {resolvedDisputes.map((d) => (
              <DisputeCard key={d.id} dispute={d} />
            ))}
          </div>
        </div>
      )}

      {/* Upload CTA */}
      <div className="p-5 bg-gray-50 border border-gray-100 rounded-xl">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Think you were overcharged?</h3>
        <p className="text-xs text-gray-500 mb-3">Upload your EOB or itemized bill and our audit engine will find billing errors.</p>
        <Link href="/upload" className="inline-flex px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
          Upload a bill
        </Link>
      </div>
    </div>
  );

  async function handleOutcomeUpdate(disputeId: string, update: { status: string; amountRecovered?: number }) {
    try {
      const res = await fetch("/api/disputes/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeId,
          status: update.status,
          amountRecovered: update.amountRecovered,
          resolutionDate: new Date().toISOString().split("T")[0],
        }),
      });
      if (res.ok && data) {
        // Refresh data
        const refreshed = await fetch(`/api/disputes/outcome?userId=${user?.userId}`).then((r) => r.json());
        setData(refreshed);
      }
    } catch (err) {
      console.error("Failed to update dispute:", err);
    }
  }
}

function DisputeCard({ dispute, onUpdate }: { dispute: Dispute; onUpdate?: (update: { status: string; amountRecovered?: number }) => void }) {
  const [showOutcome, setShowOutcome] = useState(false);
  const [recoveredAmount, setRecoveredAmount] = useState("");
  const isActive = dispute.status === "filed" || dispute.status === "in_progress";
  const [daysAgo] = useState(() => Math.floor((Date.now() - new Date(dispute.filedDate).getTime()) / (1000 * 60 * 60 * 24)));

  return (
    <div className="p-4 bg-white border border-gray-100 rounded-xl">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-gray-900">
              {TYPE_LABELS[dispute.disputeType] || dispute.disputeType}
            </p>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[dispute.status] || "text-gray-700 bg-gray-50"}`}>
              {STATUS_LABELS[dispute.status] || dispute.status}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Filed {dispute.filedDate} ({daysAgo} days ago)
            {dispute.resolutionDate && ` · Resolved ${dispute.resolutionDate}`}
          </p>
        </div>
        <div className="text-right shrink-0 ml-4">
          <p className="text-sm font-bold text-gray-900">${dispute.amountDisputed.toLocaleString()}</p>
          {dispute.amountRecovered > 0 && (
            <p className="text-xs font-semibold text-green-600">-${dispute.amountRecovered.toLocaleString()} recovered</p>
          )}
        </div>
      </div>

      {/* Outcome buttons for active disputes */}
      {isActive && onUpdate && !showOutcome && (
        <div className="mt-3 pt-3 border-t border-gray-100 flex gap-2">
          <button
            onClick={() => setShowOutcome(true)}
            className="text-xs font-medium text-green-600 hover:text-green-700"
          >
            Mark as resolved
          </button>
          <button
            onClick={() => onUpdate({ status: "in_progress" })}
            className="text-xs font-medium text-amber-600 hover:text-amber-700"
          >
            Mark in progress
          </button>
        </div>
      )}

      {/* Outcome form */}
      {showOutcome && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs text-gray-500">Amount recovered:</label>
            <input
              type="number"
              value={recoveredAmount}
              onChange={(e) => setRecoveredAmount(e.target.value)}
              placeholder="0.00"
              className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-lg"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { onUpdate?.({ status: "won", amountRecovered: parseFloat(recoveredAmount) || 0 }); setShowOutcome(false); }}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700"
            >
              Won
            </button>
            <button
              onClick={() => { onUpdate?.({ status: "settled", amountRecovered: parseFloat(recoveredAmount) || 0 }); setShowOutcome(false); }}
              className="px-3 py-1.5 text-xs font-semibold text-green-700 border border-green-200 rounded-lg hover:bg-green-50"
            >
              Settled
            </button>
            <button
              onClick={() => { onUpdate?.({ status: "lost" }); setShowOutcome(false); }}
              className="px-3 py-1.5 text-xs font-semibold text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
            >
              Lost
            </button>
            <button
              onClick={() => setShowOutcome(false)}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { Disclaimer } from "@/components/shared/Disclaimer";

interface DiscrepancyProps {
  discrepancy: {
    id: string;
    service_slug: string;
    tier: number;
    field: string;
    expected_value: string;
    actual_value: string;
    expected_source: string;
    expected_confidence: number;
    status: string;
    is_systemic: boolean;
    systemic_user_count: number | null;
    metadata: Record<string, unknown>;
    claim_line_items?: {
      description: string | null;
      billing_code: string | null;
      billing_code_type: string | null;
      billed_amount: number | null;
      patient_owes: number | null;
    };
  };
  onStatusChange: (id: string, newStatus: string) => void;
  onDispute: (discrepancy: DiscrepancyProps["discrepancy"]) => void;
}

const TIER_BADGE: Record<number, { label: string; className: string }> = {
  2: { label: "Coverage", className: "text-purple-700 bg-purple-50" },
  3: { label: "Cost", className: "text-orange-700 bg-orange-50" },
};

const FIELD_LABELS: Record<string, string> = {
  copay: "Copay Mismatch",
  coinsurance: "Coinsurance Mismatch",
  coverage_status: "Coverage Issue",
  unknown_service: "Unknown Service",
  code_substitution: "Code Substitution",
  deductible: "Deductible Mismatch",
  allowed_amount: "Allowed Amount Mismatch",
  other: "Billing Discrepancy",
};

const SOURCE_LABELS: Record<string, string> = {
  user_plan: "Your plan documents",
  canonical_plan: "Community plan data",
  canonical_network: "Community bills",
  bill_observed: "Previous bills",
  audit_rule: "Audit engine",
  code_intelligence: "Billing code analysis",
};

export function DiscrepancyCard({ discrepancy: d, onStatusChange, onDispute }: DiscrepancyProps) {
  const [updating, setUpdating] = useState(false);
  const tierBadge = TIER_BADGE[d.tier] || TIER_BADGE[3];
  const li = d.claim_line_items as DiscrepancyProps["discrepancy"]["claim_line_items"];

  async function handleIgnore() {
    setUpdating(true);
    onStatusChange(d.id, "ignored");
    setUpdating(false);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // Don't intercept clicks on buttons inside the card
        if ((e.target as HTMLElement).closest("button")) return;
        onDispute(d);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !(e.target as HTMLElement).closest("button")) {
          e.preventDefault();
          onDispute(d);
        }
      }}
      className={`cursor-pointer p-4 bg-white border rounded-xl transition-colors hover:bg-blue-50/20 ${d.is_systemic ? "border-red-200 ring-1 ring-red-100" : "border-gray-100 hover:border-blue-200"}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${tierBadge.className}`}>
            {tierBadge.label}
          </span>
          <span className="text-xs font-semibold text-gray-900">
            {FIELD_LABELS[d.field] || d.field}
          </span>
          {d.is_systemic && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-red-700 bg-red-50">
              Systemic Pattern {d.systemic_user_count ? `(${d.systemic_user_count} members)` : ""}
            </span>
          )}
        </div>
        <ConfidenceBadge confidence={d.expected_confidence} source={d.expected_source} />
      </div>

      {/* Service info */}
      <p className="text-xs text-gray-500 mb-2">
        {String(li?.description || "") || d.service_slug.replace(/_/g, " ")}
        {li?.billing_code && <span className="ml-1 font-mono text-gray-400">({String(li.billing_code)})</span>}
      </p>

      {/* Expected vs Actual */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="p-2.5 bg-green-50 rounded-lg">
          <p className="text-[10px] font-semibold text-green-600 uppercase tracking-wider mb-0.5">Expected</p>
          <p className="text-xs text-green-800">{d.expected_value}</p>
        </div>
        <div className="p-2.5 bg-red-50 rounded-lg">
          <p className="text-[10px] font-semibold text-red-600 uppercase tracking-wider mb-0.5">Actual</p>
          <p className="text-xs text-red-800">{d.actual_value}</p>
        </div>
      </div>

      {/* Systemic insurer pattern message */}
      {d.is_systemic && (
        <div className="mb-3 p-2.5 bg-red-50 border border-red-100 rounded-lg">
          <p className="text-xs text-red-700">
            <span className="font-semibold">Systemic insurer pattern:</span> This discrepancy affects multiple members on your plan. This is a high-priority dispute candidate backed by community evidence.
          </p>
        </div>
      )}

      {/* Code substitution details */}
      {d.field === "code_substitution" && !!d.metadata?.siblingCode && (
        <div className="mb-3 p-2.5 bg-amber-50 border border-amber-100 rounded-lg">
          <p className="text-xs text-amber-800">
            <span className="font-semibold">Billing code issue:</span> Code {d.metadata.deniedCode as string} is denied {((d.metadata.denialRate as number) * 100).toFixed(0)}% of the time, but code {d.metadata.siblingCode as string} for the same service is paid {((d.metadata.siblingPayRate as number) * 100).toFixed(0)}% of the time.
          </p>
          <p className="text-xs text-amber-700 mt-1">
            You can ask your provider to re-submit with the correct code, or file a dispute.
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
        <button
          onClick={handleIgnore}
          disabled={updating}
          className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
        >
          Ignore
        </button>
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600">
          Review line item
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence, source }: { confidence: number; source: string }) {
  const pct = Math.round(confidence * 100);
  const color = pct >= 70 ? "text-green-600" : pct >= 40 ? "text-amber-600" : "text-gray-400";
  return (
    <div className="text-right shrink-0">
      <p className={`text-[10px] font-semibold ${color}`}>{pct}% confidence</p>
      <p className="text-[10px] text-gray-400">{SOURCE_LABELS[source] || source}</p>
    </div>
  );
}

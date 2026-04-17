"use client";

import Link from "next/link";
import { Disclaimer } from "@/components/shared/Disclaimer";

interface EscalationCardProps {
  dispute: {
    id: string;
    disputeType: string;
    amountDisputed: number;
    isSystemic?: boolean;
    systemicUserCount?: number;
    insurerName?: string;
    planName?: string;
    serviceSlug?: string;
  };
  onEscalate?: (type: "case" | "small_claims" | "external_appeal") => void;
}

export function EscalationCard({ dispute, onEscalate }: EscalationCardProps) {
  const caseUrl = `/case?insurer=${encodeURIComponent(dispute.insurerName || "")}&service=${encodeURIComponent(dispute.serviceSlug || "")}&amount=${dispute.amountDisputed}${dispute.isSystemic ? `&systemic=true&affectedCount=${dispute.systemicUserCount || 0}` : ""}`;

  return (
    <div className="p-4 bg-white border border-gray-100 rounded-xl">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center">
          <span className="text-red-600 text-xs font-bold">!</span>
        </div>
        <h3 className="text-sm font-semibold text-gray-900">Your dispute was denied</h3>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Your {dispute.disputeType.replace(/_/g, " ")} for ${dispute.amountDisputed.toLocaleString()} was denied. You have several options:
      </p>

      {/* Systemic pattern callout */}
      {dispute.isSystemic && (
        <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg">
          <p className="text-xs text-red-800">
            <span className="font-semibold">Systemic insurer pattern detected:</span> {dispute.insurerName || "This insurer"} has
            a pattern of underpaying {dispute.serviceSlug?.replace(/_/g, " ") || "this service"} for
            {dispute.planName ? ` ${dispute.planName}` : " your plan"} members.
            {dispute.systemicUserCount && ` ${dispute.systemicUserCount} members affected, multiple disputes denied.`}
            {" "}A lawyer may be able to evaluate whether this warrants a class action or multi-party claim.
          </p>
        </div>
      )}

      {/* Escalation options */}
      <div className="space-y-3">
        {/* Option 1: External appeal */}
        <button
          onClick={() => onEscalate?.("external_appeal")}
          className="w-full p-3 text-left bg-blue-50 border border-blue-100 rounded-lg hover:bg-blue-100 transition-colors"
        >
          <p className="text-xs font-semibold text-blue-900">File an external appeal</p>
          <p className="text-[11px] text-blue-700 mt-0.5">
            Under the ACA, you have the right to an independent external review of your denial. This is free and required by law.
          </p>
        </button>

        {/* Option 2: Candid Case */}
        <Link
          href={caseUrl}
          onClick={() => onEscalate?.("case")}
          className="block w-full p-3 text-left bg-green-50 border border-green-100 rounded-lg hover:bg-green-100 transition-colors"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-green-900">Submit to Candid Case</p>
            <span className="text-[10px] font-semibold px-2 py-0.5 bg-green-200 text-green-800 rounded-full">
              Included with Pro
            </span>
          </div>
          <p className="text-[11px] text-green-700 mt-0.5">
            Connect with a lawyer who specializes in insurance disputes. No additional charge with your Candid Pro subscription.
          </p>
        </Link>

        {/* Option 3: Small claims */}
        <Link
          href="/small-claims"
          onClick={() => onEscalate?.("small_claims")}
          className="block w-full p-3 text-left bg-gray-50 border border-gray-100 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <p className="text-xs font-semibold text-gray-900">Prepare for small claims court</p>
          <p className="text-[11px] text-gray-600 mt-0.5">
            Candid can compile all your evidence into a court-ready package with filing information for your county.
          </p>
        </Link>
      </div>

      <Disclaimer variant="network_evidence" className="mt-3" />
    </div>
  );
}

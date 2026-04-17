"use client";

interface ClaimSummary {
  id: string;
  date_of_service: string | null;
  status: string;
  total_billed: number | null;
  total_patient_responsibility: number | null;
  lineItemCount: number;
  findingCount: number;
  providerName: string;
  created_at: string;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  processed: { label: "Clean", className: "text-green-700 bg-green-50" },
  flagged: { label: "Issues Found", className: "text-amber-700 bg-amber-50" },
  pending: { label: "Processing", className: "text-blue-700 bg-blue-50" },
  denied: { label: "Denied", className: "text-red-700 bg-red-50" },
};

export function ClaimsList({
  claims,
  onSelect,
}: {
  claims: ClaimSummary[];
  onSelect: (claimId: string) => void;
}) {
  if (claims.length === 0) {
    return (
      <div className="p-8 bg-white border border-gray-100 rounded-xl text-center">
        <p className="text-sm text-gray-500">No bills processed yet. Upload a bill to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {claims.map((claim) => {
        const badge = STATUS_BADGE[claim.status] || STATUS_BADGE.processed;
        return (
          <button
            key={claim.id}
            onClick={() => onSelect(claim.id)}
            className="w-full p-4 bg-white border border-gray-100 rounded-xl text-left hover:border-blue-200 hover:bg-blue-50/30 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {claim.providerName}
                  </p>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${badge.className}`}>
                    {badge.label}
                  </span>
                  {claim.findingCount > 0 && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-red-700 bg-red-50 shrink-0">
                      {claim.findingCount} finding{claim.findingCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {claim.date_of_service || "Unknown date"} · {claim.lineItemCount} line item{claim.lineItemCount !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="text-right shrink-0 ml-4">
                <p className="text-sm font-bold text-gray-900">
                  ${(claim.total_billed || 0).toLocaleString()}
                </p>
                {claim.total_patient_responsibility != null && (
                  <p className="text-xs text-gray-500">
                    You owe: ${claim.total_patient_responsibility.toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

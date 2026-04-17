"use client";

import { DiscrepancyCard } from "./DiscrepancyCard";
import { Disclaimer } from "@/components/shared/Disclaimer";

type Discrepancy = Parameters<typeof DiscrepancyCard>[0]["discrepancy"];

interface DiscrepancyListProps {
  discrepancies: Discrepancy[];
  summary: { total: number; tier2: number; tier3: number; systemic: number };
  onStatusChange: (id: string, newStatus: string) => void;
  onDispute: (discrepancy: Discrepancy) => void;
}

export function DiscrepancyList({ discrepancies, summary, onStatusChange, onDispute }: DiscrepancyListProps) {
  if (discrepancies.length === 0) {
    return (
      <div className="p-8 bg-white border border-gray-100 rounded-xl text-center">
        <p className="text-sm text-gray-500">No discrepancies detected. Upload more bills to check for billing issues.</p>
      </div>
    );
  }

  // Sort: systemic first, then tier 2 (coverage), then tier 3 (cost/code)
  const sorted = [...discrepancies].sort((a, b) => {
    if (a.is_systemic !== b.is_systemic) return a.is_systemic ? -1 : 1;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return 0;
  });

  return (
    <div>
      {/* Summary bar */}
      <div className="flex gap-3 mb-4">
        <SummaryChip label="Total" count={summary.total} className="text-gray-700 bg-gray-100" />
        {summary.tier2 > 0 && <SummaryChip label="Coverage" count={summary.tier2} className="text-purple-700 bg-purple-50" />}
        {summary.tier3 > 0 && <SummaryChip label="Cost" count={summary.tier3} className="text-orange-700 bg-orange-50" />}
        {summary.systemic > 0 && <SummaryChip label="Systemic" count={summary.systemic} className="text-red-700 bg-red-50" />}
      </div>

      {/* Cards */}
      <div className="space-y-3">
        {sorted.map((d) => (
          <DiscrepancyCard
            key={d.id}
            discrepancy={d}
            onStatusChange={onStatusChange}
            onDispute={onDispute}
          />
        ))}
      </div>

      <Disclaimer variant="discrepancy_alert" />
    </div>
  );
}

function SummaryChip({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${className}`}>
      {label}: {count}
    </span>
  );
}

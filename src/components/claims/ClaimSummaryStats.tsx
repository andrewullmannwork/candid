"use client";

interface ClaimStats {
  totalBills: number;
  flaggedBills: number;
  totalBilled: number;
  totalPatientResponsibility: number;
}

export function ClaimSummaryStats({ stats }: { stats: ClaimStats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <div className="p-4 bg-white border border-gray-100 rounded-xl">
        <p className="text-2xl font-bold text-gray-900">{stats.totalBills}</p>
        <p className="text-xs font-medium text-gray-500 mt-1">Bills Processed</p>
      </div>
      <div className="p-4 bg-white border border-gray-100 rounded-xl">
        <p className="text-2xl font-bold text-amber-600">{stats.flaggedBills}</p>
        <p className="text-xs font-medium text-gray-500 mt-1">Issues Found</p>
      </div>
      <div className="p-4 bg-white border border-gray-100 rounded-xl">
        <p className="text-2xl font-bold text-gray-900">${stats.totalBilled.toLocaleString()}</p>
        <p className="text-xs font-medium text-gray-500 mt-1">Total Billed</p>
      </div>
      <div className="p-4 bg-white border border-gray-100 rounded-xl">
        <p className="text-2xl font-bold text-gray-900">${stats.totalPatientResponsibility.toLocaleString()}</p>
        <p className="text-xs font-medium text-gray-500 mt-1">Your Responsibility</p>
      </div>
    </div>
  );
}

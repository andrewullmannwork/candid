"use client";

import { useState, useEffect } from "react";
import type { CareDataStatus } from "@/lib/care/types";

export default function CandidCarePage() {
  const [status, setStatus] = useState<CareDataStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch("/api/care/lookup");
        if (res.ok) {
          setStatus(await res.json());
        }
      } catch {
        // Silently handle — page will show default state
      } finally {
        setLoading(false);
      }
    }
    fetchStatus();
  }, []);

  if (loading) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900">Candid Care</h1>
        <p className="mt-2 text-gray-500">Loading...</p>
      </div>
    );
  }

  const totalPoints = status?.totalDataPoints || 0;
  const userPoints = status?.userBillPoints || 0;
  const regions = status?.regionsWithData || 0;
  const procedures = status?.uniqueProcedures || 0;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">Candid Care</h1>
      <p className="mt-2 text-gray-600">
        Find where care is cheapest and which providers bill fairly — powered by real billing
        data.
      </p>

      {/* Coming soon banner */}
      <div className="mt-6 p-6 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl">
        <div className="flex items-start gap-4">
          <div className="text-4xl">📊</div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Building Our Dataset
            </h2>
            <p className="mt-2 text-gray-600">
              Candid Care provides price transparency powered by real billing data — not
              estimates. Every bill processed through Candid Claim (with your consent)
              contributes anonymized pricing data to help everyone find fairer prices.
            </p>
            <p className="mt-2 text-sm text-gray-500">
              We&apos;re combining publicly available hospital pricing data with real
              user-verified bills to build the most accurate picture of what healthcare
              actually costs.
            </p>
          </div>
        </div>
      </div>

      {/* Data collection progress */}
      <div className="mt-6 grid grid-cols-2 gap-4">
        <DataCard
          label="Data Points Collected"
          value={totalPoints.toLocaleString()}
          detail={
            userPoints > 0
              ? `${userPoints.toLocaleString()} from user bills`
              : "Seeding from public data"
          }
        />
        <DataCard
          label="Regions Covered"
          value={regions.toString()}
          detail="States with pricing data"
        />
        <DataCard
          label="Procedures Tracked"
          value={procedures.toLocaleString()}
          detail="Unique procedure codes"
        />
        <DataCard
          label="Data Quality"
          value={
            userPoints > 0
              ? `${Math.round((userPoints / Math.max(totalPoints, 1)) * 100)}%`
              : "—"
          }
          detail="User-verified data points"
        />
      </div>

      {/* What Candid Care will offer */}
      <div className="mt-8">
        <h3 className="text-lg font-semibold text-gray-900">When Candid Care Goes Live</h3>
        <div className="mt-4 space-y-3">
          <FeaturePreview
            title="Price Comparison"
            description="See what you paid vs. what others paid for the same procedure at the same facility and in your region."
          />
          <FeaturePreview
            title="Provider Billing Scores"
            description="Which providers consistently bill fairly? Which ones have high rates of billing errors? Based on anonymized audit data."
          />
          <FeaturePreview
            title="Confidence Ratings"
            description="Every estimate shows how much data backs it up. Public-data-only estimates are clearly marked as lower confidence."
          />
          <FeaturePreview
            title="Regional Benchmarks"
            description="Compare prices across facilities in your area to find the best value for planned procedures."
          />
        </div>
      </div>

      {/* How to help */}
      <div className="mt-8 p-4 bg-green-50 border border-green-200 rounded-lg">
        <h3 className="text-sm font-semibold text-green-800">Help Build the Dataset</h3>
        <p className="mt-1 text-sm text-green-700">
          Every bill you upload and process through Candid Claim contributes anonymized
          pricing data. No personal information is ever included — just procedure codes,
          amounts, and facility data. The more bills we process, the sooner Candid Care goes
          live.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="mt-6 p-4 bg-gray-50 border rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed">
          Candid Care pricing data is based on a combination of publicly available hospital
          price transparency files, CMS data, and anonymized user-submitted bills. Estimates
          are not guarantees of what you will be charged. Actual costs vary by insurance plan,
          negotiated rates, and individual circumstances. Candid is an Airgetlam Labs LLC
          company.
        </p>
      </div>
    </div>
  );
}

function DataCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="p-4 bg-white border rounded-lg">
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-sm font-medium text-gray-700">{label}</div>
      <div className="text-xs text-gray-500 mt-1">{detail}</div>
    </div>
  );
}

function FeaturePreview({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 bg-white border rounded-lg">
      <div className="mt-0.5 w-2 h-2 rounded-full bg-blue-400 shrink-0" />
      <div>
        <h4 className="text-sm font-medium text-gray-900">{title}</h4>
        <p className="text-sm text-gray-600">{description}</p>
      </div>
    </div>
  );
}

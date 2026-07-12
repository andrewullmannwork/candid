"use client";

import { notFound } from "next/navigation";
import { useState } from "react";
import { GrowthMetricsView, type GrowthMetrics } from "@/app/(admin)/admin/growth/page";

/**
 * Dev-only visual preview of /admin/growth with realistic mock data (S121
 * component-preview pattern — /dev/* is public in middleware but MUST 404 in
 * PROD builds via the NODE_ENV guard below). Lets the page UI be reviewed
 * without admin auth or real data.
 */
const MOCK: GrowthMetrics = {
  generatedAt: "2026-07-12T10:00:00.000Z",
  window: "30d",
  totals: {
    signups: 36,
    verified: 29,
    uploaders: 14,
    uploads: 23,
    bills: 15,
    planDocs: 8,
    otherDocs: 0,
    attributedSignups: 27,
    attributedPct: 75,
  },
  bySource: [
    { source: "reddit", signups: 14, verified: 12, uploaders: 6, uploads: 9, bills: 8, planDocs: 1 },
    { source: "(direct / untagged)", signups: 9, verified: 6, uploaders: 3, uploads: 4, bills: 2, planDocs: 2 },
    { source: "google", signups: 6, verified: 5, uploaders: 2, uploads: 3, bills: 1, planDocs: 2 },
    { source: "creator-popcorn", signups: 4, verified: 4, uploaders: 2, uploads: 5, bills: 3, planDocs: 2 },
    { source: "chatgpt.com", signups: 3, verified: 2, uploaders: 1, uploads: 2, bills: 1, planDocs: 1 },
  ],
  byCampaign: [
    { campaign: "healthinsurance", source: "reddit", signups: 8 },
    { campaign: "creator-pilot-popcorn", source: "creator-popcorn", signups: 4 },
    { campaign: "medicalbills", source: "reddit", signups: 3 },
  ],
  topLanding: [
    { landing: "/", signups: 19 },
    { landing: "/auth/signup", signups: 6 },
    { landing: "/health-data", signups: 2 },
  ],
  topPages: [
    { path: "/", views: 412 },
    { path: "/auth/signup", views: 88 },
    { path: "/dashboard", views: 61 },
    { path: "/claim", views: 44 },
    { path: "/terms", views: 12 },
  ],
  weekly: [
    { weekStart: "2026-05-25", signups: 1, uploads: 0, topSource: "(direct / untagged)" },
    { weekStart: "2026-06-01", signups: 2, uploads: 1, topSource: "(direct / untagged)" },
    { weekStart: "2026-06-08", signups: 1, uploads: 1, topSource: "(direct / untagged)" },
    { weekStart: "2026-06-15", signups: 3, uploads: 2, topSource: "google" },
    { weekStart: "2026-06-22", signups: 4, uploads: 2, topSource: "reddit" },
    { weekStart: "2026-06-29", signups: 6, uploads: 4, topSource: "reddit" },
    { weekStart: "2026-07-06", signups: 9, uploads: 6, topSource: "reddit" },
    { weekStart: "2026-07-13", signups: 10, uploads: 7, topSource: "reddit" },
  ],
};

export default function GrowthMetricsPreviewPage() {
  // S121 pattern: every /dev/* page must guard itself out of PROD builds.
  if (process.env.NODE_ENV !== "development") notFound();
  const [win, setWin] = useState<GrowthMetrics["window"]>("30d");
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto mb-4 max-w-5xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[13px] text-amber-800">
        Dev preview — mock data. The real page lives at /admin/growth (admin-only).
      </div>
      <GrowthMetricsView data={{ ...MOCK, window: win }} window={win} onWindowChange={setWin} />
    </div>
  );
}

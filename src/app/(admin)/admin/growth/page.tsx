"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * /admin/growth — Growth Metrics (channel attribution; GTM playbook 04).
 *
 * The start of the metrics dashboards: signups → uploads by first-touch
 * channel (users.first_touch, mig 203). Conversions live HERE; raw traffic
 * (impressions/clicks) deliberately lives in GSC/Bing (linked below) — we run
 * no client-side analytics (S199).
 *
 * GrowthMetricsView is exported so /dev/growth-metrics-preview can render the
 * exact page UI with mock data (S121 dev-preview pattern, no admin auth).
 */

export interface GrowthMetrics {
  generatedAt: string;
  window: "7d" | "30d" | "all";
  totals: {
    signups: number;
    verified: number;
    uploaders: number;
    uploads: number;
    bills: number;
    planDocs: number;
    otherDocs: number;
    attributedSignups: number;
    attributedPct: number;
  };
  bySource: {
    source: string;
    signups: number;
    verified: number;
    uploaders: number;
    uploads: number;
    bills: number;
    planDocs: number;
  }[];
  byCampaign: { campaign: string; source: string; signups: number }[];
  weekly: { weekStart: string; signups: number; uploads: number; topSource: string }[];
  topLanding: { landing: string; signups: number }[];
  topPages: { path: string; views: number }[];
}

const WINDOWS: { key: GrowthMetrics["window"]; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];

const EXTERNAL_PANELS = [
  {
    label: "Google Search Console",
    sub: "impressions · clicks · queries · indexation",
    href: "https://search.google.com/search-console",
  },
  {
    label: "Bing Webmaster",
    sub: "Bing search performance (feeds ChatGPT)",
    href: "https://www.bing.com/webmasters",
  },
  {
    label: "Bing AI Performance",
    sub: "appearances in AI experiences (GEO)",
    href: "https://www.bing.com/webmasters",
  },
] as const;

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="text-[12px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-3xl font-bold tracking-tight text-gray-900">{value}</div>
      {sub && <div className="mt-1 text-[12px] text-gray-500">{sub}</div>}
    </div>
  );
}

function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

export function GrowthMetricsView({
  data,
  window: win,
  onWindowChange,
}: {
  data: GrowthMetrics;
  window: GrowthMetrics["window"];
  onWindowChange?: (w: GrowthMetrics["window"]) => void;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Growth Metrics</h1>
          <p className="mt-1 text-sm text-gray-500">
            Who signs up and uploads, by the channel that first brought them in. The one metric:{" "}
            <span className="font-medium text-gray-700">uploads by source</span>.
          </p>
        </div>
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => onWindowChange?.(w.key)}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                win === w.key ? "bg-blue-600 text-white shadow-sm" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Tile label="Signups" value={String(data.totals.signups)} sub="finished signup" />
        <Tile
          label="Verified"
          value={String(data.totals.verified)}
          sub={`${pct(data.totals.verified, data.totals.signups)} of signups (email confirmed)`}
        />
        <Tile label="Uploaders" value={String(data.totals.uploaders)} sub="users with ≥1 document" />
        <Tile
          label="Uploads"
          value={String(data.totals.uploads)}
          sub={`${data.totals.bills} bills · ${data.totals.planDocs} plan docs — the one metric`}
        />
        <Tile
          label="Attributed"
          value={`${data.totals.attributedPct}%`}
          sub={`${data.totals.attributedSignups} of ${data.totals.signups} signups tagged`}
        />
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-900">By source</h2>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Attribution began 2026-07-12 — users from before (and direct visits) show as{" "}
            <span className="font-mono">(direct / untagged)</span>.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[12px] uppercase tracking-wide text-gray-400">
              <th className="px-5 py-2.5 font-medium">Source</th>
              <th className="px-3 py-2.5 text-right font-medium">Signups</th>
              <th className="px-3 py-2.5 text-right font-medium">Verified</th>
              <th className="px-3 py-2.5 text-right font-medium">Uploaders</th>
              <th className="px-3 py-2.5 text-right font-medium">Bills</th>
              <th className="px-3 py-2.5 text-right font-medium">Plan docs</th>
              <th className="px-5 py-2.5 text-right font-medium">Signup → upload</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {data.bySource.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-8 text-center text-gray-400">
                  No signups in this window yet.
                </td>
              </tr>
            )}
            {data.bySource.map((r) => (
              <tr key={r.source} className="text-gray-700">
                <td className="px-5 py-2.5 font-medium text-gray-900">{r.source}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.signups}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.verified}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.uploaders}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.bills}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.planDocs}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{pct(r.uploaders, r.signups)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.totals.otherDocs > 0 && (
          <p className="border-t border-gray-50 px-5 py-2 text-[11px] text-gray-400">
            {data.totals.otherDocs} document(s) of other/unknown type counted in Uploads but not in
            the Bills / Plan docs split.
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Top campaigns</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-wide text-gray-400">
                <th className="px-5 py-2.5 font-medium">Campaign</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-5 py-2.5 text-right font-medium">Signups</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.byCampaign.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-gray-400">
                    No campaign-tagged signups yet.
                  </td>
                </tr>
              )}
              {data.byCampaign.map((c) => (
                <tr key={`${c.campaign}-${c.source}`} className="text-gray-700">
                  <td className="px-5 py-2.5 font-medium text-gray-900">{c.campaign}</td>
                  <td className="px-3 py-2.5">{c.source}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{c.signups}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Last 8 weeks</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-wide text-gray-400">
                <th className="px-5 py-2.5 font-medium">Week of</th>
                <th className="px-3 py-2.5 text-right font-medium">Signups</th>
                <th className="px-3 py-2.5 text-right font-medium">Uploads</th>
                <th className="px-5 py-2.5 font-medium">Top source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.weekly.map((w) => (
                <tr key={w.weekStart} className="text-gray-700">
                  <td className="px-5 py-2.5 font-medium text-gray-900">{w.weekStart}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{w.signups}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{w.uploads}</td>
                  <td className="px-5 py-2.5">{w.topSource}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Top pages</h2>
            <p className="mt-0.5 text-[12px] text-gray-500">
              Server-side counts (mig 204) — path-only, no user linkage; bots + prefetches
              filtered; /admin excluded. Includes your own non-admin visits.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-wide text-gray-400">
                <th className="px-5 py-2.5 font-medium">Path</th>
                <th className="px-5 py-2.5 text-right font-medium">Views</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.topPages.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-5 py-8 text-center text-gray-400">
                    No pageviews recorded yet (counting starts at deploy).
                  </td>
                </tr>
              )}
              {data.topPages.map((p) => (
                <tr key={p.path} className="text-gray-700">
                  <td className="px-5 py-2.5 font-mono text-[13px] text-gray-900">{p.path}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{p.views}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Top landing pages</h2>
            <p className="mt-0.5 text-[12px] text-gray-500">
              First page attributed signups arrived on (first-touch) — the pages that convert.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-wide text-gray-400">
                <th className="px-5 py-2.5 font-medium">Landing path</th>
                <th className="px-5 py-2.5 text-right font-medium">Signups</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.topLanding.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-5 py-8 text-center text-gray-400">
                    No attributed signups yet.
                  </td>
                </tr>
              )}
              {data.topLanding.map((l) => (
                <tr key={l.landing} className="text-gray-700">
                  <td className="px-5 py-2.5 font-mono text-[13px] text-gray-900">{l.landing}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{l.signups}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">Traffic (external panels)</h2>
        <p className="mt-0.5 text-[12px] text-gray-500">
          Impressions, clicks, queries, and AI citations live in the search consoles — by design
          (no client-side analytics on Candid).
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {EXTERNAL_PANELS.map((p) => (
            <a
              key={p.label}
              href={p.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl border border-gray-200 px-4 py-3 transition-colors hover:border-blue-200 hover:bg-blue-50"
            >
              <div className="text-[13px] font-semibold text-gray-900">{p.label} ↗</div>
              <div className="mt-0.5 text-[12px] text-gray-500">{p.sub}</div>
            </a>
          ))}
        </div>
      </div>

      <p className="text-right text-[11px] text-gray-400">
        founder/admin accounts excluded from all signup + upload metrics · generated{" "}
        {new Date(data.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}

export default function AdminGrowthPage() {
  const { user: authUser } = useAuth();
  const [win, setWin] = useState<GrowthMetrics["window"]>("30d");
  const [data, setData] = useState<GrowthMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    async function load() {
      try {
        const token = await authUser!.firebaseUser.getIdToken();
        const res = await fetch(`/api/admin/growth-metrics?window=${win}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as GrowthMetrics;
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    }
    setData(null);
    setError(null);
    load();
    return () => {
      cancelled = true;
    };
  }, [authUser, win]);

  if (error) {
    return <div className="p-8 text-sm text-red-600">Failed to load growth metrics: {error}</div>;
  }
  if (!data) {
    return <div className="p-8 text-sm text-gray-500">Loading growth metrics…</div>;
  }
  return <GrowthMetricsView data={data} window={win} onWindowChange={setWin} />;
}

/**
 * /admin/claims — consolidated admin surface for claim- and dispute-adjacent
 * review queues. Sections:
 *
 *   - Disputes missing plan year (anchor #missing-plan-year)
 *   - Insurer appeals — pending changes (anchor #insurer-appeals-pending)
 *   - Insurer appeals — stale addresses (anchor #insurer-appeals-stale)
 *   - Insurer appeals — coverage gaps (anchor #insurer-appeals-gaps)
 *
 * Replaces the standalone /admin/insurer-appeals page (kept as a redirect
 * for bookmark continuity via the dashboard). All data comes from a single
 * aggregator route at /api/admin/claims.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

interface PendingProposal {
  id: string;
  insurerId: string;
  insurerName: string;
  proposedBy: string;
  sourceExcerpt: string | null;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  confidence: number | null;
  createdAt: string;
}

interface StaleRow {
  id: string;
  name: string;
  appeals_source: string | null;
  appeals_verification_count: number;
  appeals_last_confirmed_at: string | null;
}

interface GapRow {
  id: string;
  name: string;
  appeals_source: string | null;
}

interface MissingPlanRow {
  id: string;
  disputeId: string;
  claimId: string;
  disputeType: string;
  status: string;
  amountDisputed: number | null;
  claimYear: number;
  dateOfService: string | null;
  providerName: string | null;
  createdAt: string;
}

interface ClaimsData {
  insurerAppeals: {
    pending: PendingProposal[];
    stale: StaleRow[];
    gaps: GapRow[];
  };
  disputesMissingPlan: MissingPlanRow[];
}

export default function AdminClaimsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<ClaimsData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/claims", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      setData((await res.json()) as ClaimsData);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const review = async (proposalId: string, decision: "accept" | "reject") => {
    if (!user) return;
    const token = await user.firebaseUser.getIdToken();
    await fetch("/api/admin/insurer-appeals/review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ proposalId, decision }),
    });
    await refresh();
  };

  if (loading || !data) {
    return (
      <div className="p-6 text-sm text-slate-500">Loading claims review queue…</div>
    );
  }

  const { insurerAppeals, disputesMissingPlan } = data;

  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Claims & Disputes</h1>
        <p className="mt-1 text-sm text-slate-600">
          Admin review surface for dispute-adjacent work: disputes waiting on historical plans,
          and the self-updating insurer appeals registry (Pattern 1).
        </p>
      </header>

      <QuickNav
        items={[
          { anchor: "missing-plan-year", label: "Disputes missing plan year", count: disputesMissingPlan.length, tone: disputesMissingPlan.length ? "amber" : "ok" },
          { anchor: "insurer-appeals-pending", label: "Insurer appeals · pending", count: insurerAppeals.pending.length, tone: insurerAppeals.pending.length ? "amber" : "ok" },
          { anchor: "insurer-appeals-stale", label: "Insurer appeals · stale", count: insurerAppeals.stale.length, tone: insurerAppeals.stale.length ? "amber" : "ok" },
          { anchor: "insurer-appeals-gaps", label: "Insurer appeals · gaps", count: insurerAppeals.gaps.length, tone: insurerAppeals.gaps.length ? "amber" : "ok" },
        ]}
      />

      <Section id="missing-plan-year" title={`Disputes missing plan year (${disputesMissingPlan.length})`}>
        {disputesMissingPlan.length === 0 ? (
          <EmptyState label="All pending disputes reference plans we have on file." />
        ) : (
          <ul className="divide-y divide-slate-200">
            {disputesMissingPlan.map((d) => (
              <li key={d.id} className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">
                      {d.providerName ?? "Unknown provider"} · {formatDate(d.dateOfService)}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {labelFor(d.disputeType)} · status: {d.status}{" "}
                      {d.amountDisputed != null ? `· ${formatUsd(d.amountDisputed)} disputed` : null}
                    </div>
                    <div className="mt-1 text-xs font-medium text-amber-800">
                      Missing user plan for {d.claimYear}. Letter falls back to generic copay text
                      until the user uploads a {d.claimYear} SBC.
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <Link
                      href={`/disputes?dispute=${d.disputeId}`}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      View dispute
                    </Link>
                    <Link
                      href={`/claim?claim=${d.claimId}`}
                      className="text-xs text-slate-500 underline-offset-2 hover:underline"
                    >
                      View claim
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="insurer-appeals-pending"
        title={`Insurer appeals · pending changes (${insurerAppeals.pending.length})`}
        subtitle="Doc-extracted + user-proposed mutations to insurer_catalog.appeals_* awaiting review."
      >
        {insurerAppeals.pending.length === 0 ? (
          <EmptyState label="No pending proposals. Everything is up to date." />
        ) : (
          <ul className="divide-y divide-slate-200">
            {insurerAppeals.pending.map((p) => (
              <li key={p.id} className="py-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="font-semibold text-slate-900">{p.insurerName}</div>
                  <div className="text-xs text-slate-500">
                    {new Date(p.createdAt).toLocaleString("en-US")}
                  </div>
                </div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Proposed by {p.proposedBy.replace("_", " ")}
                  {p.confidence != null ? ` · confidence ${Math.round(p.confidence * 100)}%` : ""}
                </div>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <ValueBlock title="Current" values={p.current} />
                  <ValueBlock title="Proposed" values={p.proposed} highlight />
                </div>
                {p.sourceExcerpt ? (
                  <blockquote className="mt-3 border-l-2 border-indigo-200 bg-slate-50 px-3 py-2 text-xs italic text-slate-700">
                    &ldquo;{p.sourceExcerpt}&rdquo;
                  </blockquote>
                ) : null}
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => review(p.id, "accept")}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => review(p.id, "reject")}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="insurer-appeals-stale"
        title={`Insurer appeals · stale addresses (${insurerAppeals.stale.length})`}
        subtitle="Admin_verified data older than 365 days, or doc_extraction sources with fewer than 3 corroborations."
      >
        {insurerAppeals.stale.length === 0 ? (
          <EmptyState label="No stale addresses — everything verified recently." />
        ) : (
          <ul className="divide-y divide-slate-200 text-sm">
            {insurerAppeals.stale.map((s) => (
              <li key={s.id} className="py-2">
                <div className="font-medium text-slate-900">{s.name}</div>
                <div className="text-xs text-slate-500">
                  source: {s.appeals_source ?? "—"} · verifications: {s.appeals_verification_count} · last confirmed:{" "}
                  {s.appeals_last_confirmed_at
                    ? new Date(s.appeals_last_confirmed_at).toLocaleDateString("en-US")
                    : "never"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="insurer-appeals-gaps"
        title={`Insurer appeals · coverage gaps (${insurerAppeals.gaps.length})`}
        subtitle="Insurers referenced by user plans but missing appeals data entirely."
      >
        {insurerAppeals.gaps.length === 0 ? (
          <EmptyState label="No coverage gaps — every referenced insurer has appeals data." />
        ) : (
          <ul className="divide-y divide-slate-200 text-sm">
            {insurerAppeals.gaps.map((g) => (
              <li key={g.id} className="py-2">
                <div className="font-medium text-slate-900">{g.name}</div>
                <div className="text-xs text-slate-500">
                  {g.appeals_source ? `source: ${g.appeals_source}` : "no data"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function QuickNav({
  items,
}: {
  items: Array<{ anchor: string; label: string; count: number; tone: "ok" | "amber" }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <a
          key={it.anchor}
          href={`#${it.anchor}`}
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-300"
        >
          {it.label}
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
              it.tone === "amber"
                ? "bg-amber-100 text-amber-800"
                : "bg-green-100 text-green-800"
            }`}
          >
            {it.count}
          </span>
        </a>
      ))}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="py-6 text-center text-sm text-slate-500">{label}</div>;
}

function ValueBlock({
  title,
  values,
  highlight,
}: {
  title: string;
  values: Record<string, unknown>;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 text-xs ${
        highlight ? "border-emerald-300 bg-emerald-50/60" : "border-slate-200 bg-slate-50/60"
      }`}
    >
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <dl className="space-y-0.5 text-slate-800">
        {Object.entries(values).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-slate-500">{k}</dt>
            <dd className="truncate text-right">{v == null ? "—" : String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function labelFor(disputeType: string): string {
  switch (disputeType) {
    case "internal_appeal":
      return "Appeal to insurer";
    case "negotiation":
      return "Self-pay negotiation";
    case "complaint":
      return "Balance billing / complaint";
    default:
      return disputeType.replace(/_/g, " ");
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

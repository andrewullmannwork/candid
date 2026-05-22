"use client";

/**
 * CoverageDiffPanel — S111 smoke iteration 5.
 *
 * Renders above the dispute letter when the GET response includes a
 * `coverageDiff` (computed when the user changed bound plans since the last
 * GET). Shows:
 *
 *   - Verdict pill: Still valid / Weakened / Invalidated
 *   - Before/after plan summary (insurer · plan name · year)
 *   - Per-line diff: service name, before/after coverage values, Δ discrepancy
 *   - Actions:
 *       * Proceed with dispute  → clears the snapshot (panel goes away)
 *       * Cancel dispute        → opens the existing OutcomeReportingModal
 *                                 with status='withdrawn' (handled by parent)
 *
 * Pattern 1 #2: per-line values are tagged with their source year so the
 * user understands the year disclosure honestly.
 */

import { useState } from "react";

export type CoverageDiffVerdict = "still_valid" | "weakened" | "invalidated";

export interface CoverageDiffLine {
  lineItemId: string;
  serviceName: string;
  billingCode: string | null;
  billingCodeType: string | null;
  change: "unchanged" | "updated" | "coverage_added" | "coverage_removed";
  before: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    sourceYear: number | null;
  } | null;
  after: {
    covered: boolean | null;
    copay: number | null;
    coinsurance: number | null;
    sourceYear: number | null;
  } | null;
  beforeDiscrepancy: number | null;
  afterDiscrepancy: number | null;
}

export interface CoverageDiff {
  verdict: CoverageDiffVerdict;
  verdictReason: string;
  before: {
    insurerName: string | null;
    planName: string | null;
    planYear: number | null;
    source: string;
  };
  after: {
    insurerName: string | null;
    planName: string | null;
    planYear: number | null;
    source: string;
  };
  lines: CoverageDiffLine[];
  totalBeforeDiscrepancy: number;
  totalAfterDiscrepancy: number;
}

export interface CoverageDiffPanelProps {
  diff: CoverageDiff;
  /** POSTs clear-coverage-diff + refetches parent. */
  onProceed: () => Promise<void>;
  /** Opens the existing OutcomeReportingModal with a withdraw status. */
  onCancelDispute: () => void;
}

export function CoverageDiffPanel({
  diff,
  onProceed,
  onCancelDispute,
}: CoverageDiffPanelProps) {
  const [proceeding, setProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleProceed = async () => {
    if (proceeding) return;
    setProceeding(true);
    setError(null);
    try {
      await onProceed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to acknowledge.");
      setProceeding(false);
    }
  };

  const verdictStyle =
    diff.verdict === "still_valid"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : diff.verdict === "weakened"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : "bg-rose-50 text-rose-700 ring-rose-200";
  const verdictLabel =
    diff.verdict === "still_valid"
      ? "Dispute still valid"
      : diff.verdict === "weakened"
        ? "Dispute weakened"
        : "Dispute may no longer apply";

  const meaningfulLines = diff.lines.filter(
    (l) => l.change !== "unchanged" || (l.afterDiscrepancy ?? 0) > 0,
  );

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Plan changed — review impact
          </h3>
          <p className="mt-1 text-sm text-slate-700">
            The cited plan was updated. Here&apos;s what changed and whether the
            dispute is still supported.
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${verdictStyle}`}
        >
          {verdictLabel}
        </span>
      </header>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        {diff.verdictReason}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PlanCard label="Before" plan={diff.before} />
        <PlanCard label="After" plan={diff.after} />
      </div>

      {meaningfulLines.length > 0 && (
        <div className="mt-5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Per-line changes
          </h4>
          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {meaningfulLines.map((line) => (
              <li key={line.lineItemId} className="px-3 py-2.5">
                <DiffLineRow line={line} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <div className="text-xs text-slate-600">
          Total expected discrepancy:{" "}
          <span className="font-mono tabular-nums text-slate-900">
            ${diff.totalBeforeDiscrepancy.toFixed(2)} → $
            {diff.totalAfterDiscrepancy.toFixed(2)}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancelDispute}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          >
            Cancel dispute
          </button>
          <button
            type="button"
            onClick={handleProceed}
            disabled={proceeding}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
          >
            {proceeding ? "Saving…" : "Proceed with dispute"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error}
        </div>
      )}
    </section>
  );
}

function PlanCard(props: {
  label: string;
  plan: CoverageDiff["before"];
}) {
  const { insurerName, planName, planYear, source } = props.plan;
  const sourceLabel = formatSourceLabel(source);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {props.label}
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-900">
        {planName ?? "—"}
      </p>
      <p className="mt-0.5 text-xs text-slate-600">
        {insurerName ?? "Insurer unknown"}
        {planYear != null ? ` · ${planYear}` : ""}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">{sourceLabel}</p>
    </div>
  );
}

function formatSourceLabel(source: string): string {
  switch (source) {
    case "user_exact":
      return "Your uploaded plan";
    case "canonical_archive":
      return "Community-corroborated canonical";
    case "user_fallback":
      return "Current plan (proxy)";
    case "no_coverage":
      return "No coverage cited";
    default:
      return source;
  }
}

function DiffLineRow(props: { line: CoverageDiffLine }) {
  const { line } = props;
  const codeLabel =
    line.billingCode && line.billingCodeType
      ? ` (${line.billingCodeType} ${line.billingCode})`
      : "";
  const changeStyle =
    line.change === "coverage_removed"
      ? "text-rose-700"
      : line.change === "coverage_added"
        ? "text-emerald-700"
        : line.change === "updated"
          ? "text-amber-700"
          : "text-slate-500";
  const changeLabel = formatChangeLabel(line.change);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-900">
          {line.serviceName}
          <span className="font-mono text-[11px] font-normal text-slate-500">
            {codeLabel}
          </span>
        </p>
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${changeStyle}`}>
          {changeLabel}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-1.5 text-[11px] text-slate-600 sm:grid-cols-2">
        <div>
          <span className="text-slate-400">Before:</span>{" "}
          <CoverageSummary cov={line.before} />
        </div>
        <div>
          <span className="text-slate-400">After:</span>{" "}
          <CoverageSummary cov={line.after} />
        </div>
      </div>
      {line.beforeDiscrepancy != null && line.afterDiscrepancy != null && (
        <p className="mt-1 text-[11px] text-slate-600">
          Discrepancy:{" "}
          <span className="font-mono tabular-nums text-slate-900">
            ${line.beforeDiscrepancy.toFixed(2)} → $
            {line.afterDiscrepancy.toFixed(2)}
          </span>
        </p>
      )}
    </div>
  );
}

function CoverageSummary(props: { cov: CoverageDiffLine["before"] }) {
  const { cov } = props;
  if (!cov) return <span className="italic text-slate-400">no data</span>;
  if (cov.covered === false) {
    return <span className="text-rose-700">not covered</span>;
  }
  const parts: string[] = [];
  if (cov.copay != null) parts.push(`$${cov.copay.toFixed(2)} copay`);
  if (cov.coinsurance != null)
    parts.push(`${Math.round(cov.coinsurance * 100)}% coinsurance`);
  if (cov.covered === true && parts.length === 0) parts.push("covered");
  const yearSuffix =
    cov.sourceYear != null ? (
      <span className="text-slate-400"> ({cov.sourceYear})</span>
    ) : null;
  return (
    <>
      {parts.length > 0 ? parts.join(" · ") : "covered"}
      {yearSuffix}
    </>
  );
}

function formatChangeLabel(change: CoverageDiffLine["change"]): string {
  switch (change) {
    case "coverage_added":
      return "Coverage added";
    case "coverage_removed":
      return "Coverage removed";
    case "updated":
      return "Updated";
    case "unchanged":
      return "Unchanged";
  }
}

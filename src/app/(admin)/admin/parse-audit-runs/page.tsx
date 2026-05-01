"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

/**
 * /admin/parse-audit-runs — Phase 3 Task 3J.
 *
 * Read-only dashboard for the parse_audit_runs table populated by Task 3H harness
 * (scripts/parse-harness.ts). Filters by parser_name + run_id, drills into per-field
 * gaps via the per_field_results JSONB column. Per Q-P3-6 lock; consumed alongside
 * the CLI report.
 */

interface ParseAuditRun {
  id: string;
  run_id: string;
  parser_version: string;
  parser_name: "sbc" | "bill" | "eob" | "card" | "eoc";
  fixture_id: string;
  fixture_kind: "annotated" | "bulk_unannotated" | "synthetic";
  recall: number | null;
  precision: number | null;
  fields_captured: number | null;
  fields_total: number | null;
  fields_correct: number | null;
  cost_usd: number | null;
  haiku_tokens_input: number | null;
  haiku_tokens_output: number | null;
  haiku_cache_read_tokens: number | null;
  haiku_cache_create_tokens: number | null;
  per_field_results: Record<string, FieldResult> | null;
  warnings: { meta_warnings?: string[]; accumulator_warnings?: string[] } | null;
  parse_duration_ms: number | null;
  parse_attempt_idx: number | null;
  parse_status: "success" | "timed_out" | "extraction_failed" | "truncated";
  created_at: string;
}

interface FieldResult {
  captured: boolean;
  correct?: boolean;
  expected?: unknown;
  actual?: unknown;
}

const PARSER_NAMES = ["all", "bill", "eob", "sbc", "card", "eoc"] as const;
type ParserFilter = (typeof PARSER_NAMES)[number];

export default function ParseAuditRunsPage() {
  const { user } = useAuth();
  const { query } = useAdminQuery();
  const [runs, setRuns] = useState<ParseAuditRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [parserFilter, setParserFilter] = useState<ParserFilter>("all");
  const [runIdFilter, setRunIdFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function load() {
      try {
        const filters: Array<{ column: string; op: string; value: unknown }> = [];
        if (parserFilter !== "all") {
          filters.push({ column: "parser_name", op: "eq", value: parserFilter });
        }
        if (runIdFilter.trim()) {
          filters.push({ column: "run_id", op: "eq", value: runIdFilter.trim() });
        }
        const data = await query({
          table: "parse_audit_runs",
          filters,
          order: { column: "created_at", ascending: false },
          limit: 200,
        });
        setRuns((data as ParseAuditRun[]) || []);
      } catch (err) {
        console.error("Failed to load parse audit runs:", err);
      }
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, parserFilter, runIdFilter]);

  // Aggregate stats per parser_name × fixture_id (median across attempts) to spot
  // regressions at a glance. Useful when one run_id has N=3 attempts.
  const summaries = useMemo(() => {
    const byKey = new Map<string, ParseAuditRun[]>();
    for (const r of runs) {
      const key = `${r.parser_name}|${r.fixture_id}|${r.run_id}`;
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    return Array.from(byKey.entries()).map(([key, list]) => {
      const recalls = list.map((r) => r.recall).filter((v): v is number => v != null);
      const costs = list.map((r) => r.cost_usd).filter((v): v is number => v != null);
      return {
        key,
        parser_name: list[0].parser_name,
        fixture_id: list[0].fixture_id,
        run_id: list[0].run_id,
        attempts: list.length,
        median_recall: recalls.length ? median(recalls) : null,
        max_recall: recalls.length ? Math.max(...recalls) : null,
        min_recall: recalls.length ? Math.min(...recalls) : null,
        total_cost: costs.reduce((s, c) => s + c, 0),
        latest_status: list[0].parse_status,
        latest_created_at: list[0].created_at,
      };
    });
  }, [runs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Parse Audit Runs</h1>
        <p className="text-sm text-gray-500 mt-1">
          Empirical parser recall + precision per fixture per attempt. Populated by{" "}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">scripts/parse-harness.ts</code>.
          See{" "}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
            plans/findings/dr3d_dogfood_findings.md
          </code>
          .
        </p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500">Parser:</span>
          <select
            value={parserFilter}
            onChange={(e) => setParserFilter(e.target.value as ParserFilter)}
            className="px-2 py-1 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {PARSER_NAMES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500">Run ID:</span>
          <input
            type="text"
            value={runIdFilter}
            onChange={(e) => setRunIdFilter(e.target.value)}
            placeholder="e.g. session_48_baseline"
            className="px-2 py-1 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-56"
          />
        </div>
        <span className="text-xs text-gray-400 ml-auto">
          {runs.length} {runs.length === 1 ? "row" : "rows"} · {summaries.length} fixture-run
          {summaries.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Aggregate summary by (parser, fixture, run_id) */}
      {summaries.length > 0 && (
        <div className="mb-6 overflow-x-auto border border-gray-200 rounded-xl bg-white">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-500 uppercase tracking-wide">
              <tr>
                <Th>Parser</Th>
                <Th>Fixture</Th>
                <Th>Run</Th>
                <Th>N</Th>
                <Th align="right">Median recall</Th>
                <Th align="right">Min/Max</Th>
                <Th align="right">Σ Cost (USD)</Th>
                <Th>Status</Th>
                <Th>Latest</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summaries.map((s) => (
                <tr key={s.key} className="hover:bg-gray-50">
                  <Td>
                    <code className="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">{s.parser_name}</code>
                  </Td>
                  <Td className="font-mono text-[11px] text-gray-700">{s.fixture_id}</Td>
                  <Td className="font-mono text-[11px] text-gray-500">{s.run_id}</Td>
                  <Td>{s.attempts}</Td>
                  <Td align="right">
                    {s.median_recall != null ? (
                      <span className={recallColor(s.median_recall)}>
                        {(s.median_recall * 100).toFixed(1)}%
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td align="right" className="text-gray-500">
                    {s.min_recall != null && s.max_recall != null
                      ? `${(s.min_recall * 100).toFixed(0)}-${(s.max_recall * 100).toFixed(0)}%`
                      : "—"}
                  </Td>
                  <Td align="right">${s.total_cost.toFixed(4)}</Td>
                  <Td>
                    <StatusBadge status={s.latest_status} />
                  </Td>
                  <Td className="text-gray-400">{new Date(s.latest_created_at).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-attempt detail table */}
      {runs.length === 0 ? (
        <div className="p-8 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl">
          No parse audit runs yet. Run{" "}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">npx tsx scripts/parse-harness.ts</code>
          {" "}to populate this table.
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-xl bg-white">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200 text-gray-500 uppercase tracking-wide">
              <tr>
                <Th>Created</Th>
                <Th>Parser</Th>
                <Th>Fixture</Th>
                <Th>Run</Th>
                <Th>Attempt</Th>
                <Th align="right">Recall</Th>
                <Th align="right">Precision</Th>
                <Th align="right">Fields</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Tok in/out</Th>
                <Th align="right">Cache hit</Th>
                <Th align="right">Duration</Th>
                <Th>Status</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.map((r) => {
                const isOpen = expanded === r.id;
                const cacheHit =
                  r.haiku_cache_read_tokens && r.haiku_tokens_input
                    ? r.haiku_cache_read_tokens / r.haiku_tokens_input
                    : null;
                return (
                  <>
                    <tr key={r.id} className="hover:bg-gray-50">
                      <Td className="text-gray-400 whitespace-nowrap">
                        {new Date(r.created_at).toLocaleString()}
                      </Td>
                      <Td>
                        <code className="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">{r.parser_name}</code>
                      </Td>
                      <Td className="font-mono text-[11px] text-gray-700">{r.fixture_id}</Td>
                      <Td className="font-mono text-[11px] text-gray-500">{r.run_id}</Td>
                      <Td>{r.parse_attempt_idx ?? "—"}</Td>
                      <Td align="right">
                        {r.recall != null ? (
                          <span className={recallColor(r.recall)}>{(r.recall * 100).toFixed(1)}%</span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td align="right">
                        {r.precision != null ? `${(r.precision * 100).toFixed(1)}%` : "—"}
                      </Td>
                      <Td align="right">
                        {r.fields_correct != null && r.fields_total != null
                          ? `${r.fields_correct}/${r.fields_total}`
                          : "—"}
                      </Td>
                      <Td align="right">${(r.cost_usd ?? 0).toFixed(4)}</Td>
                      <Td align="right" className="text-gray-500">
                        {r.haiku_tokens_input ?? "—"}/{r.haiku_tokens_output ?? "—"}
                      </Td>
                      <Td align="right">
                        {cacheHit != null ? (
                          <span className={cacheHit > 0.5 ? "text-green-700" : "text-gray-400"}>
                            {(cacheHit * 100).toFixed(0)}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td align="right" className="text-gray-500">
                        {r.parse_duration_ms != null ? `${r.parse_duration_ms}ms` : "—"}
                      </Td>
                      <Td>
                        <StatusBadge status={r.parse_status} />
                      </Td>
                      <Td>
                        <button
                          onClick={() => setExpanded(isOpen ? null : r.id)}
                          className="text-blue-600 hover:underline text-[11px] font-medium"
                        >
                          {isOpen ? "Hide" : "Drill"}
                        </button>
                      </Td>
                    </tr>
                    {isOpen && (
                      <tr key={`${r.id}-detail`} className="bg-gray-50/60">
                        <td colSpan={14} className="px-4 py-4">
                          <DrillDown run={r} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DrillDown({ run }: { run: ParseAuditRun }) {
  const fields = run.per_field_results
    ? Object.entries(run.per_field_results).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const metaWarnings = run.warnings?.meta_warnings ?? [];
  const accWarnings = run.warnings?.accumulator_warnings ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-[11px] text-gray-500">
        <span>
          <span className="font-semibold text-gray-700">Version:</span>{" "}
          <code className="bg-white px-1.5 py-0.5 rounded">{run.parser_version}</code>
        </span>
        <span>
          <span className="font-semibold text-gray-700">Kind:</span> {run.fixture_kind}
        </span>
        <span>
          <span className="font-semibold text-gray-700">Cache create:</span>{" "}
          {run.haiku_cache_create_tokens ?? 0}
        </span>
      </div>

      {(metaWarnings.length > 0 || accWarnings.length > 0) && (
        <div className="grid grid-cols-2 gap-4">
          {metaWarnings.length > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-[11px] font-semibold text-amber-800 mb-2">
                Meta warnings ({metaWarnings.length})
              </div>
              <ul className="text-[11px] text-amber-700 space-y-1 max-h-40 overflow-y-auto">
                {metaWarnings.map((w, i) => (
                  <li key={i} className="font-mono">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {accWarnings.length > 0 && (
            <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
              <div className="text-[11px] font-semibold text-orange-800 mb-2">
                Accumulator warnings ({accWarnings.length})
              </div>
              <ul className="text-[11px] text-orange-700 space-y-1 max-h-40 overflow-y-auto">
                {accWarnings.map((w, i) => (
                  <li key={i} className="font-mono">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {fields.length > 0 ? (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg">
          <table className="min-w-full text-[11px]">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <tr>
                <Th>Field</Th>
                <Th>Captured</Th>
                <Th>Correct</Th>
                <Th>Expected</Th>
                <Th>Actual</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fields.map(([fieldName, result]) => (
                <tr key={fieldName} className={result.captured ? "" : "bg-red-50/40"}>
                  <Td className="font-mono">{fieldName}</Td>
                  <Td>{result.captured ? "✓" : "✗"}</Td>
                  <Td>{result.correct == null ? "—" : result.correct ? "✓" : "✗"}</Td>
                  <Td className="font-mono text-gray-500 max-w-xs truncate">
                    {formatValue(result.expected)}
                  </Td>
                  <Td className="font-mono text-gray-500 max-w-xs truncate">
                    {formatValue(result.actual)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-3 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-400">
          No per-field results recorded for this run.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ParseAuditRun["parse_status"] }) {
  const colors: Record<ParseAuditRun["parse_status"], string> = {
    success: "bg-green-100 text-green-700",
    timed_out: "bg-amber-100 text-amber-700",
    extraction_failed: "bg-red-100 text-red-700",
    truncated: "bg-orange-100 text-orange-700",
  };
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${colors[status]}`}>
      {status}
    </span>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-3 py-2 text-${align} text-[10px] font-medium`}>{children}</th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 text-${align} ${className}`}>{children}</td>
  );
}

function recallColor(recall: number): string {
  if (recall >= 0.85) return "text-green-700 font-medium";
  if (recall >= 0.7) return "text-amber-700";
  return "text-red-600 font-medium";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 60);
}

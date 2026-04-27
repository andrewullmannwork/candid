"use client";

import { useState, useEffect } from "react";
import type { AuditReport, AuditFinding } from "@/lib/billing/types";
import { disputeUrlForResult } from "@/lib/disputes/url";

export default function AuditPage() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFileName, setPendingFileName] = useState<string | null>(null);

  // On mount, check for a pending audit from the upload flow
  useEffect(() => {
    const raw = sessionStorage.getItem("pendingAudit");
    if (!raw) return;
    try {
      const { documentId, billType, fileName } = JSON.parse(raw);
      sessionStorage.removeItem("pendingAudit");
      setPendingFileName(fileName || null);
      handleProcess(documentId, billType);
    } catch {
      sessionStorage.removeItem("pendingAudit");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProcess = async (documentId: string, billType: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, billType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setReport(data.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed");
    } finally {
      setLoading(false);
    }
  };

  const toggleFinding = (id: string) => {
    setSelectedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerateLetter = async () => {
    if (!report || selectedFindings.size === 0) return;

    try {
      const res = await fetch("/api/disputes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditReport: report,
          findingIds: Array.from(selectedFindings),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Prefer ?dispute=<id> so /disputes runs the always-regen + plan-context
      // + evidence-resolver path on load (Phase 1 + 4 + 7 of dispute letter v2).
      window.location.href = disputeUrlForResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Letter generation failed");
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Candid Claim</h1>

      {!report && !loading && (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-6xl mb-4">📋</div>
          <h2 className="text-xl font-semibold mb-2">No audit results yet</h2>
          <p className="text-gray-600 mb-6">
            Upload a medical bill from the{" "}
            <a href="/upload" className="text-blue-600 hover:underline">
              Upload page
            </a>{" "}
            to get started. We&apos;ll scan it for billing errors, overcharges,
            and potential savings.
          </p>
        </div>
      )}

      {loading && (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="animate-spin text-4xl mb-4">⚙️</div>
          <h2 className="text-xl font-semibold mb-2">Analyzing your bill...</h2>
          {pendingFileName && (
            <p className="text-sm text-gray-500 mb-1">{pendingFileName}</p>
          )}
          <p className="text-gray-600">
            Extracting line items, checking benchmarks, and looking for errors.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {report && (
        <>
          {/* Summary Card */}
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">Audit Summary</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SummaryCard
                label="Total Billed"
                value={`$${report.parsedBill.totals.totalBilled.toFixed(2)}`}
              />
              <SummaryCard
                label="Issues Found"
                value={report.summary.totalFindings.toString()}
                highlight={report.summary.totalFindings > 0}
              />
              <SummaryCard
                label="Est. Overcharges"
                value={`$${report.summary.totalEstimatedOvercharge.toFixed(2)}`}
                highlight={report.summary.totalEstimatedOvercharge > 0}
              />
              <SummaryCard
                label="Actionable"
                value={report.summary.actionableCount.toString()}
              />
            </div>
          </div>

          {/* Provider & Patient Info */}
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Provider:</span>{" "}
                <span className="font-medium">
                  {report.parsedBill.provider.name}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Service Date:</span>{" "}
                <span className="font-medium">
                  {report.parsedBill.serviceDate}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Confidence:</span>{" "}
                <span className="font-medium">
                  {(report.parsedBill.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            {report.parsedBill.parseErrors.length > 0 && (
              <div className="mt-3 text-sm text-amber-700 bg-amber-50 p-3 rounded">
                <strong>Note:</strong>{" "}
                {report.parsedBill.parseErrors.join("; ")}
              </div>
            )}
          </div>

          {/* Findings */}
          {report.findings.length > 0 ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Findings</h2>
                {selectedFindings.size > 0 && (
                  <button
                    onClick={handleGenerateLetter}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm"
                  >
                    Generate Dispute Letter ({selectedFindings.size} selected)
                  </button>
                )}
              </div>

              <div className="space-y-4">
                {report.findings.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    selected={selectedFindings.has(finding.id)}
                    onToggle={() => toggleFinding(finding.id)}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
              <div className="text-4xl mb-2">✅</div>
              <h3 className="text-lg font-semibold text-green-800">
                No issues found
              </h3>
              <p className="text-green-700">
                Your bill looks consistent with standard billing practices.
              </p>
            </div>
          )}

          {/* Line Items Table */}
          <div className="bg-white rounded-lg shadow mt-6 overflow-x-auto">
            <h2 className="text-lg font-semibold p-6 pb-3">Line Items</h2>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-3">#</th>
                  <th className="text-left p-3">Code</th>
                  <th className="text-left p-3">Category</th>
                  <th className="text-right p-3">Billed</th>
                  <th className="text-right p-3">Allowed</th>
                  <th className="text-right p-3">Ins. Paid</th>
                  <th className="text-right p-3">You Owe</th>
                </tr>
              </thead>
              <tbody>
                {report.parsedBill.lineItems.map((item) => (
                  <tr key={item.lineNumber} className="border-t">
                    <td className="p-3">{item.lineNumber}</td>
                    <td className="p-3 font-mono">{item.procedureCode}</td>
                    <td className="p-3">{item.category}</td>
                    <td className="p-3 text-right">
                      ${item.billedAmount.toFixed(2)}
                    </td>
                    <td className="p-3 text-right">
                      {item.allowedAmount !== undefined
                        ? `$${item.allowedAmount.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="p-3 text-right">
                      {item.insurancePaid !== undefined
                        ? `$${item.insurancePaid.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="p-3 text-right">
                      {item.patientResponsibility !== undefined
                        ? `$${item.patientResponsibility.toFixed(2)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`p-4 rounded-lg ${
        highlight ? "bg-red-50 border border-red-200" : "bg-gray-50"
      }`}
    >
      <div className="text-sm text-gray-500">{label}</div>
      <div
        className={`text-2xl font-bold ${
          highlight ? "text-red-600" : "text-gray-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function FindingCard({
  finding,
  selected,
  onToggle,
}: {
  finding: AuditFinding;
  selected: boolean;
  onToggle: () => void;
}) {
  const severityColors = {
    critical: "bg-red-100 text-red-800 border-red-300",
    high: "bg-orange-100 text-orange-800 border-orange-300",
    medium: "bg-yellow-100 text-yellow-800 border-yellow-300",
    low: "bg-blue-100 text-blue-800 border-blue-300",
  };

  return (
    <div
      className={`bg-white rounded-lg shadow p-5 border-l-4 ${
        selected ? "border-l-blue-600 ring-2 ring-blue-200" : "border-l-gray-200"
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${severityColors[finding.severity]}`}
            >
              {finding.severity}
            </span>
            <span className="text-xs text-gray-500 uppercase">
              {finding.type.replace("_", " ")}
            </span>
          </div>
          <h3 className="font-semibold text-gray-900">{finding.title}</h3>
          <p className="text-sm text-gray-600 mt-1">{finding.description}</p>
          <div className="flex gap-4 mt-3 text-sm">
            <span className="text-gray-500">
              Billed: <strong>${finding.billedAmount.toFixed(2)}</strong>
            </span>
            {finding.benchmarkAmount && (
              <span className="text-gray-500">
                Benchmark: <strong>${finding.benchmarkAmount.toFixed(2)}</strong>
              </span>
            )}
            <span className="text-red-600 font-medium">
              Est. overcharge: ${finding.estimatedOvercharge.toFixed(2)}
            </span>
          </div>
        </div>
        {finding.actionable && (
          <label className="flex items-center ml-4">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
        )}
      </div>
    </div>
  );
}

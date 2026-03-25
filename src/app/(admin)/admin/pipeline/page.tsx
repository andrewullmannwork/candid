"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface DiscoveryQueueItem {
  id: string;
  insurer_name_raw: string;
  source: string;
  source_document_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  matched_insurer_id: string | null;
  requested_by: string | null;
}

interface InsurerCatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  sbc_search_url: string | null;
  data_status: string;
  last_scraped_at: string | null;
  last_verified_at: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  unknown: "bg-gray-100 text-gray-600",
  queued: "bg-yellow-100 text-yellow-700",
  scraping: "bg-blue-100 text-blue-700",
  extracted: "bg-purple-100 text-purple-700",
  verified: "bg-green-100 text-green-700",
};

interface ProcessingStats {
  usage: {
    today: number;
    month: number;
    dailyLimit: number;
    monthlyLimit: number;
    ocrEnabled: boolean;
    autoProcess: boolean;
  };
  queuedDocuments: number;
}

export default function PipelinePage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"queue" | "catalog">("queue");
  const [queue, setQueue] = useState<DiscoveryQueueItem[]>([]);
  const [catalog, setCatalog] = useState<InsurerCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { query, update } = useAdminQuery();
  const [processingStats, setProcessingStats] = useState<ProcessingStats | null>(null);
  const [processingAction, setProcessingAction] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [queueData, catalogData] = await Promise.all([
        query({ table: "insurer_discovery_queue", order: { column: "created_at", ascending: false }, limit: 100 }),
        query({ table: "insurer_catalog", order: { column: "name", ascending: true } }),
      ]);
      setQueue(queueData || []);
      setCatalog(catalogData || []);

      // Load processing stats
      if (user) {
        const token = await user.firebaseUser.getIdToken();
        const statsRes = await fetch("/api/admin/processing", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (statsRes.ok) {
          setProcessingStats(await statsRes.json());
        }
      }
    } catch (err) {
      console.error("Failed to load pipeline data:", err);
    }
    setLoading(false);
  }

  async function processAllQueued() {
    if (!user) return;
    setProcessingAction(true);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/processing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "process_all_queued" }),
      });
      const result = await res.json();
      setExtractResult(result.message);
      loadData();
    } catch (err) {
      setExtractResult("Failed to process queued documents");
    }
    setProcessingAction(false);
  }

  async function updateQueueStatus(id: string, status: string) {
    await update("insurer_discovery_queue", id, {
      status,
      ...(status === "completed" ? { completed_at: new Date().toISOString() } : {}),
    });
    loadData();
  }

  async function updateInsurerStatus(id: string, dataStatus: string) {
    await update("insurer_catalog", id, {
      data_status: dataStatus,
      ...(dataStatus === "verified" ? { last_verified_at: new Date().toISOString() } : {}),
    });
    loadData();
  }

  const [extracting, setExtracting] = useState<string | null>(null);
  const [extractResult, setExtractResult] = useState<string | null>(null);
  const [scraping, setScraping] = useState<string | null>(null);

  async function extractSBC(documentId: string, queueId: string) {
    if (!user) return;
    setExtracting(queueId);
    setExtractResult(null);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/pipeline/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ documentId }),
      });
      const data = await res.json();
      if (res.ok) {
        setExtractResult(`Extracted ${data.benefitsExtracted} benefits from "${data.planName || "Unknown Plan"}". Confidence: ${Math.round(data.confidence * 100)}%`);
        await updateQueueStatus(queueId, "completed");
      } else {
        setExtractResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setExtractResult(`Extraction failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setExtracting(null);
    }
  }

  async function scrapeInsurer(insurerId: string) {
    if (!user) return;
    setScraping(insurerId);
    setExtractResult(null);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/pipeline/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ insurerId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setExtractResult(`Scraped ${data.planName}: ${data.benefitsExtracted} benefits extracted (${data.method}). Confidence: ${Math.round(data.confidence * 100)}%`);
      } else {
        setExtractResult(`Scrape: ${data.error || "Failed"}${data.suggestion ? ` — ${data.suggestion}` : ""}`);
      }
      loadData();
    } catch (err) {
      setExtractResult(`Scrape failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setScraping(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const pendingCount = queue.filter((q) => q.status === "pending").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Benefit Data Pipeline</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage insurer discovery, plan data ingestion, and benefit verification.
          </p>
        </div>
        <button
          onClick={loadData}
          className="px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100"
        >
          Refresh
        </button>
      </div>

      {/* Processing Stats Bar */}
      {processingStats && (
        <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Document AI Processing</h3>
            <div className="flex items-center gap-2">
              {processingStats.queuedDocuments > 0 && (
                <button
                  onClick={processAllQueued}
                  disabled={processingAction}
                  className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {processingAction ? "Processing..." : `Process ${processingStats.queuedDocuments} queued`}
                </button>
              )}
              <span className={`px-2 py-0.5 text-xs font-medium rounded ${processingStats.usage.ocrEnabled ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                OCR {processingStats.usage.ocrEnabled ? "ON" : "OFF"}
              </span>
              <span className={`px-2 py-0.5 text-xs font-medium rounded ${processingStats.usage.autoProcess ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                Auto-process {processingStats.usage.autoProcess ? "ON" : "OFF"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-xs">
            <div>
              <span className="text-gray-400">Today</span>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${processingStats.usage.today / processingStats.usage.dailyLimit > 0.8 ? "bg-red-500" : "bg-blue-500"}`}
                    style={{ width: `${Math.min(100, (processingStats.usage.today / processingStats.usage.dailyLimit) * 100)}%` }}
                  />
                </div>
                <span className="font-medium text-gray-600">{processingStats.usage.today}/{processingStats.usage.dailyLimit}</span>
              </div>
            </div>
            <div>
              <span className="text-gray-400">This Month</span>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${processingStats.usage.month / processingStats.usage.monthlyLimit > 0.8 ? "bg-red-500" : "bg-blue-500"}`}
                    style={{ width: `${Math.min(100, (processingStats.usage.month / processingStats.usage.monthlyLimit) * 100)}%` }}
                  />
                </div>
                <span className="font-medium text-gray-600">{processingStats.usage.month}/{processingStats.usage.monthlyLimit}</span>
              </div>
            </div>
            <div>
              <span className="text-gray-400">Queued</span>
              <p className="font-medium text-gray-600 mt-0.5">{processingStats.queuedDocuments} document{processingStats.queuedDocuments !== 1 ? "s" : ""}</p>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Insurers in Catalog" value={catalog.length} />
        <StatCard label="Verified" value={catalog.filter((c) => c.data_status === "verified").length} color="green" />
        <StatCard label="Discovery Queue" value={queue.length} />
        <StatCard label="Pending Review" value={pendingCount} color={pendingCount > 0 ? "yellow" : undefined} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab("queue")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === "queue" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Discovery Queue {pendingCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 bg-yellow-200 text-yellow-800 text-[10px] font-bold rounded-full">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("catalog")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === "catalog" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Insurer Catalog ({catalog.length})
        </button>
      </div>

      {/* Extract result banner */}
      {extractResult && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${extractResult.startsWith("Error") || extractResult.startsWith("Extraction failed") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {extractResult}
          <button onClick={() => setExtractResult(null)} className="ml-2 underline text-xs">Dismiss</button>
        </div>
      )}

      {/* Queue Tab */}
      {tab === "queue" && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {queue.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No discovery requests yet. Requests appear when users enter insurers not in the catalog.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Insurer (raw)</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Source</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Requested</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queue.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{item.insurer_name_raw}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-500 capitalize">{item.source}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[item.status] || "bg-gray-100"}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(item.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {item.status === "pending" && (
                        <div className="flex gap-1 justify-end">
                          {item.source_document_id && (
                            <button
                              onClick={() => extractSBC(item.source_document_id!, item.id)}
                              className="px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700"
                            >
                              Extract
                            </button>
                          )}
                          <button
                            onClick={() => updateQueueStatus(item.id, "processing")}
                            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                          >
                            Start
                          </button>
                          <button
                            onClick={() => updateQueueStatus(item.id, "completed")}
                            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                          >
                            Resolve
                          </button>
                        </div>
                      )}
                      {item.status === "processing" && (
                        <button
                          onClick={() => updateQueueStatus(item.id, "completed")}
                          className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          Complete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Catalog Tab */}
      {tab === "catalog" && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Insurer</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Aliases</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Data Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">SBC Direct URL</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Verified</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {catalog.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{entry.name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs max-w-xs truncate">
                    {entry.aliases?.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[entry.data_status] || "bg-gray-100"}`}>
                      {entry.data_status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <SbcUrlCell entry={entry} onSave={(url) => update("insurer_catalog", entry.id, { sbc_search_url: url }).then(loadData)} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {entry.last_verified_at ? new Date(entry.last_verified_at).toLocaleDateString() : "Never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-1 justify-end">
                      {(entry.data_status === "unknown" || entry.data_status === "failed") && (
                        <button
                          onClick={() => scrapeInsurer(entry.id)}
                          disabled={scraping === entry.id}
                          className="px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                        >
                          {scraping === entry.id ? "Scraping..." : "Scrape SBC"}
                        </button>
                      )}
                      {entry.data_status === "extracted" && (
                        <button
                          onClick={() => updateInsurerStatus(entry.id, "verified")}
                          className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          Verify
                        </button>
                      )}
                      {entry.data_status === "verified" && (
                        <span className="px-2 py-1 text-xs text-green-600 font-medium">Verified</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SbcUrlCell({ entry, onSave }: { entry: InsurerCatalogEntry; onSave: (url: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(entry.sbc_search_url || "");

  if (editing) {
    return (
      <div className="flex gap-1">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="w-full px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") { onSave(url); setEditing(false); }
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button onClick={() => { onSave(url); setEditing(false); }} className="px-1.5 text-xs text-blue-600 font-medium shrink-0">Save</button>
      </div>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="text-xs text-left max-w-[200px] truncate block">
      {entry.sbc_search_url ? (
        <span className="text-blue-600 hover:underline">{entry.sbc_search_url.replace(/^https?:\/\//, "").slice(0, 30)}...</span>
      ) : (
        <span className="text-gray-400 hover:text-blue-600">+ Add URL</span>
      )}
    </button>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="p-4 bg-white border border-gray-200 rounded-xl">
      <p className={`text-2xl font-bold ${
        color === "green" ? "text-green-600" : color === "yellow" ? "text-yellow-600" : "text-gray-900"
      }`}>
        {value}
      </p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface ServiceCatalogItem {
  id: string;
  slug: string;
  name: string;
  category: string;
  is_preventive_eligible: boolean;
  created_at: string;
}

const DEFAULT_SERVICE_CATEGORIES = [
  "office_visit",
  "emergency",
  "hospital",
  "preventive",
  "mental_health",
  "therapy",
  "rx",
  "imaging",
  "lab",
  "maternity",
  "dme",
  "long_term_care",
  "other",
];

const DEFAULT_CATEGORY_LABELS: Record<string, string> = {
  office_visit: "Office Visit",
  emergency: "Emergency",
  hospital: "Hospital",
  preventive: "Preventive",
  mental_health: "Mental Health",
  therapy: "Therapy",
  rx: "Rx / Pharmacy",
  imaging: "Imaging",
  lab: "Lab",
  maternity: "Maternity",
  dme: "DME",
  long_term_care: "Long-Term Care",
  other: "Other / Uncategorized",
};

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
  const [tab, setTab] = useState<"queue" | "catalog" | "services">("queue");
  const [queue, setQueue] = useState<DiscoveryQueueItem[]>([]);
  const [catalog, setCatalog] = useState<InsurerCatalogEntry[]>([]);
  const [services, setServices] = useState<ServiceCatalogItem[]>([]);
  const [serviceFilter, setServiceFilter] = useState<"all" | "other">("other");
  const [loading, setLoading] = useState(true);
  const { query, update, insert, deleteRecord } = useAdminQuery();
  const [addingService, setAddingService] = useState(false);
  const [newServiceName, setNewServiceName] = useState("");
  const [newServiceCategory, setNewServiceCategory] = useState("other");
  const [categories, setCategories] = useState<string[]>(DEFAULT_SERVICE_CATEGORIES);
  const [categoryLabels, setCategoryLabels] = useState<Record<string, string>>(DEFAULT_CATEGORY_LABELS);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategorySlug, setNewCategorySlug] = useState("");
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [deletingCategory, setDeletingCategory] = useState<string | null>(null);
  const [deleteCategoryReassign, setDeleteCategoryReassign] = useState("other");
  // Bulk selection for service catalog
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("other");
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  // Merge state
  const [showMerge, setShowMerge] = useState(false);
  const [mergeCanonicalId, setMergeCanonicalId] = useState<string>("");
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const [processingStats, setProcessingStats] = useState<ProcessingStats | null>(null);
  const [processingAction, setProcessingAction] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#services") {
      setTab("services");
    }
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [queueData, catalogData, serviceData] = await Promise.all([
        query({ table: "insurer_discovery_queue", order: { column: "created_at", ascending: false }, limit: 100 }),
        query({ table: "insurer_catalog", order: { column: "name", ascending: true }, limit: 1000 }),
        query({ table: "service_catalog", order: { column: "category", ascending: true }, limit: 1000 }),
      ]);
      setQueue(queueData || []);
      setCatalog(catalogData || []);
      // Filter out merged services
      const activeServices = (serviceData || []).filter((s: ServiceCatalogItem & { merged_into_id?: string | null }) => !s.merged_into_id);
      setServices(activeServices);

      // Load categories from DB (service_categories table)
      try {
        const token = await user?.firebaseUser.getIdToken();
        if (token) {
          const catRes = await fetch("/api/admin/services/categories", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (catRes.ok) {
            const { data: dbCategories } = await catRes.json();
            if (dbCategories && dbCategories.length > 0) {
              setCategories(dbCategories.map((c: { id: string }) => c.id));
              const labels: Record<string, string> = {};
              for (const c of dbCategories) labels[c.id] = c.label;
              setCategoryLabels(labels);
            }
          }
        }
      } catch {
        // Fall back to defaults if DB categories not available (migration not run yet)
      }

      // Load document statuses for discovery queue items
      if (queueData) {
        const docIds = (queueData as DiscoveryQueueItem[])
          .map((q) => q.source_document_id)
          .filter((id): id is string => !!id);
        if (docIds.length > 0) {
          const docs = await query({
            table: "documents",
            select: "id, status, classified_type, doc_type",
            filters: [{ column: "id", op: "in", value: docIds }],
          });
          if (docs) {
            const statusMap = new Map<string, { status: string; classified_type?: string; doc_type?: string }>();
            for (const d of docs) statusMap.set(d.id, { status: d.status, classified_type: d.classified_type, doc_type: d.doc_type });
            setDocStatuses(statusMap);
          }
        }
      }

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
      setReprocessResult(result.message);
      loadData();
    } catch (err) {
      setReprocessResult("Failed to process queued documents");
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

  const [reprocessing, setReprocessing] = useState<string | null>(null);
  const [reprocessResult, setReprocessResult] = useState<string | null>(null);
  const [scraping, setScraping] = useState<string | null>(null);
  const [docStatuses, setDocStatuses] = useState<Map<string, { status: string; classified_type?: string; doc_type?: string }>>(new Map());

  async function reprocessDocument(documentId: string, queueId: string) {
    if (!user) return;
    setReprocessing(queueId);
    setReprocessResult(null);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/processing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ action: "process_document", documentId }),
      });
      const data = await res.json();
      if (res.ok) {
        setReprocessResult(`Reprocessed document — ${data.servicesCreated ? `${data.servicesCreated} services extracted` : "processing started"}`);
        await updateQueueStatus(queueId, "completed");
        loadData();
      } else {
        setReprocessResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setReprocessResult(`Reprocess failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setReprocessing(null);
    }
  }

  async function scrapeInsurer(insurerId: string) {
    if (!user) return;
    setScraping(insurerId);
    setReprocessResult(null);
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
        setReprocessResult(`Scraped ${data.planName}: ${data.benefitsExtracted} benefits extracted (${data.method}). Confidence: ${Math.round(data.confidence * 100)}%`);
      } else {
        setReprocessResult(`Scrape: ${data.error || "Failed"}${data.suggestion ? ` — ${data.suggestion}` : ""}`);
      }
      loadData();
    } catch (err) {
      setReprocessResult(`Scrape failed: ${err instanceof Error ? err.message : "Unknown error"}`);
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
        <button
          onClick={() => setTab("services")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === "services" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Service Catalog {services.filter((s) => s.category === "other").length > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 bg-red-200 text-red-800 text-[10px] font-bold rounded-full">
              {services.filter((s) => s.category === "other").length}
            </span>
          )}
        </button>
      </div>

      {/* Extract result banner */}
      {reprocessResult && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${reprocessResult.startsWith("Error") || reprocessResult.startsWith("Reprocess failed") || reprocessResult.startsWith("Scrape failed") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {reprocessResult}
          <button onClick={() => setReprocessResult(null)} className="ml-2 underline text-xs">Dismiss</button>
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
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Review</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Doc Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Doc Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Requested</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queue.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {item.insurer_name_raw}
                      {item.matched_insurer_id ? (
                        <span className="ml-1.5 text-[10px] font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                          {catalog.find((c) => c.id === item.matched_insurer_id)?.name || "Matched"}
                        </span>
                      ) : (
                        <span className="ml-1.5 text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                          Not in catalog
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-500 capitalize">{item.source}</span>
                    </td>
                    <td className="px-4 py-3">
                      {item.status === "completed" ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Reviewed</span>
                      ) : (
                        <Link href="/admin/documents/review" className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors cursor-pointer">
                          Needs Review
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const ds = item.source_document_id ? docStatuses.get(item.source_document_id) : null;
                        if (!ds) return <span className="text-xs text-gray-400">—</span>;
                        const colors: Record<string, string> = {
                          processed: "bg-green-100 text-green-700",
                          processing: "bg-blue-100 text-blue-700",
                          queued: "bg-blue-100 text-blue-700",
                          pending_review: "bg-amber-100 text-amber-700",
                          error: "bg-red-100 text-red-700",
                          uploaded: "bg-gray-100 text-gray-600",
                        };
                        return (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[ds.status] || "bg-gray-100"}`}>
                            {ds.status}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {(() => {
                        const dt = item.source_document_id ? docStatuses.get(item.source_document_id)?.doc_type : null;
                        if (!dt) return "—";
                        const labels: Record<string, string> = { eob: "EOB", sbc: "SBC", plan_document: "Plan Doc", itemized_bill: "Itemized Bill" };
                        return labels[dt] || dt;
                      })()}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(item.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {item.status === "pending" && (
                        <div className="flex gap-1 justify-end">
                          {item.source_document_id && (
                            <button
                              onClick={() => reprocessDocument(item.source_document_id!, item.id)}
                              disabled={reprocessing === item.id || docStatuses.get(item.source_document_id!)?.status === "processed"}
                              className={`px-2 py-1 text-xs rounded ${
                                docStatuses.get(item.source_document_id!)?.status === "processed"
                                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                                  : "bg-purple-600 text-white hover:bg-purple-700"
                              }`}
                            >
                              {reprocessing === item.id ? "Processing..." : docStatuses.get(item.source_document_id!)?.status === "processed" ? "Processed" : "Reprocess"}
                            </button>
                          )}
                          <button
                            onClick={() => updateQueueStatus(item.id, "completed")}
                            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                          >
                            Mark Reviewed
                          </button>
                        </div>
                      )}
                      {item.status === "processing" && (
                        <button
                          onClick={() => updateQueueStatus(item.id, "completed")}
                          className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          Mark Reviewed
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

      {/* Services Tab */}
      {tab === "services" && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setServiceFilter("other")}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                serviceFilter === "other" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Needs Categorization ({services.filter((s) => s.category === "other").length})
            </button>
            <button
              onClick={() => setServiceFilter("all")}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                serviceFilter === "all" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              All Services ({services.length})
            </button>
          </div>
          {/* Add Service */}
          {addingService ? (
            <div className="mb-4 p-4 bg-white border border-gray-200 rounded-xl flex items-end gap-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-gray-500 mb-1 block">Service Name</label>
                <input
                  type="text"
                  value={newServiceName}
                  onChange={(e) => setNewServiceName(e.target.value)}
                  placeholder="e.g. Chiropractic Care"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Category</label>
                <select
                  value={newServiceCategory}
                  onChange={(e) => setNewServiceCategory(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>{categoryLabels[cat]}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={async () => {
                  if (!newServiceName.trim()) return;
                  const slug = newServiceName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                  const entry = { slug, name: newServiceName.trim(), category: newServiceCategory, description: "", is_preventive_eligible: false };
                  const existing = await query({ table: "service_catalog", filters: [{ column: "slug", op: "eq", value: slug }] });
                  if (existing && existing.length > 0) {
                    alert(`Service "${slug}" already exists`);
                    return;
                  }
                  const created = await insert("service_catalog", entry);
                  if (created) {
                    setServices((prev) => [...prev, created]);
                  } else {
                    loadData();
                  }
                  setNewServiceName("");
                  setNewServiceCategory("other");
                  setAddingService(false);
                }}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Add
              </button>
              <button
                onClick={() => { setAddingService(false); setNewServiceName(""); }}
                className="px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-2">
              <button
                onClick={() => setAddingService(true)}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                + Add Service
              </button>
              {addingCategory ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newCategorySlug}
                    onChange={(e) => setNewCategorySlug(e.target.value)}
                    placeholder="slug (e.g. vision)"
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 w-32"
                    autoFocus
                  />
                  <input
                    type="text"
                    value={newCategoryLabel}
                    onChange={(e) => setNewCategoryLabel(e.target.value)}
                    placeholder="Label (e.g. Vision & Dental)"
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
                  />
                  <button
                    onClick={async () => {
                      if (!newCategorySlug.trim() || !newCategoryLabel.trim() || !user) return;
                      const token = await user.firebaseUser.getIdToken();
                      const res = await fetch("/api/admin/services/categories", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ id: newCategorySlug.trim(), label: newCategoryLabel.trim() }),
                      });
                      if (res.ok) {
                        const { id, label } = await res.json();
                        setCategories((prev) => [...prev.filter((c) => c !== "other"), id, "other"]);
                        setCategoryLabels((prev) => ({ ...prev, [id]: label }));
                      } else {
                        const data = await res.json();
                        alert(`Failed: ${data.error}`);
                      }
                      setNewCategorySlug("");
                      setNewCategoryLabel("");
                      setAddingCategory(false);
                    }}
                    disabled={!newCategorySlug.trim() || !newCategoryLabel.trim()}
                    className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setAddingCategory(false); setNewCategorySlug(""); setNewCategoryLabel(""); }}
                    className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : deletingCategory ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-700 font-medium">Delete &quot;{categoryLabels[deletingCategory] || deletingCategory}&quot;</span>
                  <span className="text-xs text-gray-500">Reassign services to:</span>
                  <select
                    value={deleteCategoryReassign}
                    onChange={(e) => setDeleteCategoryReassign(e.target.value)}
                    className="px-2 py-1 text-xs border border-gray-200 rounded-lg"
                  >
                    {categories.filter((c) => c !== deletingCategory).map((cat) => (
                      <option key={cat} value={cat}>{categoryLabels[cat] || cat}</option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      if (!user) return;
                      const token = await user.firebaseUser.getIdToken();
                      const res = await fetch("/api/admin/services/categories", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ categoryId: deletingCategory, reassignTo: deleteCategoryReassign }),
                      });
                      if (res.ok) {
                        setCategories((prev) => prev.filter((c) => c !== deletingCategory));
                        setCategoryLabels((prev) => { const next = { ...prev }; delete next[deletingCategory!]; return next; });
                        setServices((prev) => prev.map((s) => s.category === deletingCategory ? { ...s, category: deleteCategoryReassign } : s));
                      } else {
                        const data = await res.json();
                        alert(`Failed: ${data.error}`);
                      }
                      setDeletingCategory(null);
                    }}
                    className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setDeletingCategory(null)}
                    className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAddingCategory(true)}
                    className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                  >
                    + Add Category
                  </button>
                  <select
                    onChange={(e) => { if (e.target.value) setDeletingCategory(e.target.value); e.target.value = ""; }}
                    className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-500"
                    defaultValue=""
                  >
                    <option value="" disabled>Delete category...</option>
                    {categories.filter((c) => c !== "other").map((cat) => (
                      <option key={cat} value={cat}>{categoryLabels[cat] || cat}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Merge result banner */}
          {mergeResult && (
            <div className="mb-3 p-3 bg-green-50 border border-green-100 rounded-xl flex items-center justify-between">
              <span className="text-sm text-green-800">{mergeResult}</span>
              <button onClick={() => setMergeResult(null)} className="text-xs text-green-500 hover:text-green-700">Dismiss</button>
            </div>
          )}

          {/* Bulk actions bar */}
          {selectedServices.size > 0 && (
            <div className="mb-3 p-3 bg-blue-50 border border-blue-100 rounded-xl">
              {showBulkDelete ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-red-800">
                    Delete {selectedServices.size} service{selectedServices.size !== 1 ? "s" : ""}? This cannot be undone.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      placeholder='Type "DELETE" to confirm'
                      className="px-3 py-1.5 text-sm border border-red-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-red-500 w-48"
                    />
                    <button
                      onClick={async () => {
                        for (const id of selectedServices) {
                          await deleteRecord("service_catalog", id);
                        }
                        setServices((prev) => prev.filter((s) => !selectedServices.has(s.id)));
                        setSelectedServices(new Set());
                        setShowBulkDelete(false);
                        setDeleteConfirmText("");
                      }}
                      disabled={deleteConfirmText !== "DELETE"}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Confirm Delete
                    </button>
                    <button
                      onClick={() => { setShowBulkDelete(false); setDeleteConfirmText(""); }}
                      className="px-3 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : showMerge ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-blue-800">
                    Merge {selectedServices.size} services — select the canonical (keep) service:
                  </p>
                  <div className="flex items-center gap-2">
                    <select
                      value={mergeCanonicalId}
                      onChange={(e) => setMergeCanonicalId(e.target.value)}
                      className="px-2 py-1.5 text-xs border border-blue-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-xs"
                    >
                      <option value="">Select canonical service...</option>
                      {services.filter((s) => selectedServices.has(s.id)).map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        if (!mergeCanonicalId || !user) return;
                        setMerging(true);
                        try {
                          const token = await user.firebaseUser.getIdToken();
                          const mergeIds = [...selectedServices].filter((id) => id !== mergeCanonicalId);
                          const res = await fetch("/api/admin/services/merge", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                            body: JSON.stringify({ canonicalServiceId: mergeCanonicalId, mergeServiceIds: mergeIds }),
                          });
                          const data = await res.json();
                          if (res.ok && data.success) {
                            const mergedIds = new Set(data.merged.map((m: { serviceId: string }) => m.serviceId));
                            setServices((prev) => prev.filter((s) => !mergedIds.has(s.id)));
                            setMergeResult(`Merged ${data.merged.length} service(s) into ${data.canonicalSlug}. Moved ${data.merged.reduce((a: number, m: { movedRows: number }) => a + m.movedRows, 0)} rows, deduped ${data.merged.reduce((a: number, m: { deletedDupes: number }) => a + m.deletedDupes, 0)}.`);
                          } else {
                            alert(`Merge failed: ${data.error || "Unknown error"}`);
                          }
                        } catch {
                          alert("Merge request failed");
                        }
                        setMerging(false);
                        setShowMerge(false);
                        setMergeCanonicalId("");
                        setSelectedServices(new Set());
                      }}
                      disabled={!mergeCanonicalId || merging}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {merging ? "Merging..." : "Confirm Merge"}
                    </button>
                    <button
                      onClick={() => { setShowMerge(false); setMergeCanonicalId(""); }}
                      className="px-3 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-xs text-blue-600">All coverage data from merged services will be migrated to the canonical service.</p>
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-medium text-blue-800">{selectedServices.size} selected</span>
                  <div className="flex items-center gap-2">
                    <select
                      value={bulkCategory}
                      onChange={(e) => setBulkCategory(e.target.value)}
                      className="px-2 py-1.5 text-xs border border-blue-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {categories.map((cat) => (
                        <option key={cat} value={cat}>{categoryLabels[cat] || cat}</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        for (const id of selectedServices) {
                          await update("service_catalog", id, { category: bulkCategory });
                        }
                        setServices((prev) =>
                          prev.map((s) => selectedServices.has(s.id) ? { ...s, category: bulkCategory } : s)
                        );
                        setSelectedServices(new Set());
                      }}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                    >
                      Assign Category
                    </button>
                  </div>
                  {selectedServices.size >= 2 && (
                    <button
                      onClick={() => setShowMerge(true)}
                      className="px-3 py-1.5 text-xs font-semibold text-purple-600 border border-purple-200 rounded-lg hover:bg-purple-50"
                    >
                      Merge Selected
                    </button>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={() => setShowBulkDelete(true)}
                    className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                  >
                    Delete Selected
                  </button>
                  <button
                    onClick={() => setSelectedServices(new Set())}
                    className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-3 py-3 text-left">
                    <input
                      type="checkbox"
                      checked={selectedServices.size > 0 && services.filter((s) => serviceFilter === "all" || s.category === "other").every((s) => selectedServices.has(s.id))}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const visible = services.filter((s) => serviceFilter === "all" || s.category === "other");
                          setSelectedServices(new Set(visible.map((s) => s.id)));
                        } else {
                          setSelectedServices(new Set());
                        }
                      }}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Service Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Slug</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Category</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Preventive</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Added</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {services
                  .filter((s) => serviceFilter === "all" || s.category === "other")
                  .map((svc) => (
                    <tr key={svc.id} className={`hover:bg-gray-50 ${selectedServices.has(svc.id) ? "bg-blue-50/40" : svc.category === "other" ? "bg-red-50/40" : ""}`}>
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selectedServices.has(svc.id)}
                          onChange={(e) => {
                            setSelectedServices((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(svc.id);
                              else next.delete(svc.id);
                              return next;
                            });
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{svc.name}</td>
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono">{svc.slug}</td>
                      <td className="px-4 py-3">
                        <select
                          value={svc.category}
                          onChange={async (e) => {
                            const newCategory = e.target.value;
                            await update("service_catalog", svc.id, { category: newCategory });
                            setServices((prev) =>
                              prev.map((s) => (s.id === svc.id ? { ...s, category: newCategory } : s))
                            );
                          }}
                          className={`px-2 py-1 text-xs font-medium rounded border ${
                            svc.category === "other"
                              ? "border-red-300 bg-red-50 text-red-700"
                              : "border-gray-200 bg-white text-gray-700"
                          } focus:outline-none focus:ring-1 focus:ring-blue-500`}
                        >
                          {categories.map((cat) => (
                            <option key={cat} value={cat}>
                              {categoryLabels[cat] || cat}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={svc.is_preventive_eligible}
                          onChange={async (e) => {
                            const val = e.target.checked;
                            await update("service_catalog", svc.id, { is_preventive_eligible: val });
                            setServices((prev) =>
                              prev.map((s) => (s.id === svc.id ? { ...s, is_preventive_eligible: val } : s))
                            );
                          }}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(svc.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={async () => {
                            if (!confirm(`Delete "${svc.name}"? This cannot be undone.`)) return;
                            await deleteRecord("service_catalog", svc.id);
                            setServices((prev) => prev.filter((s) => s.id !== svc.id));
                          }}
                          className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {services.filter((s) => serviceFilter === "all" || s.category === "other").length === 0 && (
              <div className="p-8 text-center text-gray-500">
                {serviceFilter === "other" ? "All services are categorized" : "No services in catalog yet"}
              </div>
            )}
          </div>
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

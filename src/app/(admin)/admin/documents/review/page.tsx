"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/auth/auth-context";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AdversarialAssessmentMeta {
  score: number;
  flagged: boolean;
  assessable: boolean;
  reasons: { code: string; weight: number; detail: string }[];
  mode: "shadow" | "enforce";
  threshold: number;
  review_state: "unreviewed" | "confirmed" | "cleared";
  ruleset_version?: string;
}

interface DocRecord {
  id: string;
  file_name: string;
  file_size: number | null;
  doc_type: string;
  classified_type: string | null;
  classification_confidence: number | null;
  type_mismatch: boolean | null;
  status: string;
  processing_step: string | null;
  processing_total_pages: number | null;
  processing_completed_pages: number | null;
  processing_error: string | null;
  processing_started_at: string | null;
  linked_insurance_plan_id: string | null;
  insurer_mismatch: { mismatch: boolean; type?: string; existingInsurer?: string; parsedInsurer?: string; existingPlanName?: string; parsedPlanName?: string } | null;
  created_at: string;
  user_id: string;
  user_email?: string;
  file_hash: string | null;
  metadata?: { adversarial_pdf_assessment?: AdversarialAssessmentMeta } | null;
}

interface PlanDetail {
  plan_name: string | null;
  insurer_name: string | null;
  plan_type: string | null;
  in_deductible_individual: number | null;
  out_deductible_individual: number | null;
  in_oop_max_individual: number | null;
  out_oop_max_individual: number | null;
  servicesCount: number;
}

type StatusFilter = "all" | "pending_review" | "processed" | "error" | "rejected" | "queued" | "adversarial";

const STATUS_COLORS: Record<string, string> = {
  processed: "bg-green-100 text-green-700",
  queued: "bg-blue-100 text-blue-700",
  processing: "bg-blue-100 text-blue-700",
  pending_review: "bg-amber-100 text-amber-700",
  error: "bg-red-100 text-red-700",
  rejected: "bg-gray-100 text-gray-500",
  uploaded: "bg-gray-100 text-gray-500",
};

const STATUS_LABELS: Record<string, string> = {
  pending_review: "Pending Review",
  processed: "Processed",
  error: "Error",
  rejected: "Rejected",
  queued: "Queued",
  processing: "Processing",
  uploaded: "Uploaded",
  adversarial: "⚠ Adversarial",
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function DocumentReviewPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("pending_review");
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [planDetails, setPlanDetails] = useState<Map<string, PlanDetail>>(new Map());
  const [processing, setProcessing] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<"approve" | "reject" | null>(null);
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  // Ing-G.4 — inline Block-hash action: target doc + reason input + busy state.
  const [blockTarget, setBlockTarget] = useState<{ docId: string; fileName: string; fileHash: string } | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [blockSubmitting, setBlockSubmitting] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  // ─── Data Loading ───────────────────────────────────────────────────────

  async function getToken() {
    return user!.firebaseUser.getIdToken();
  }

  async function adminQuery(body: Record<string, unknown>) {
    const idToken = await getToken();
    const res = await fetch("/api/admin/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    return data;
  }

  async function adminPatch(table: string, id: string, updates: Record<string, unknown>) {
    const idToken = await getToken();
    await fetch("/api/admin/query", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ table, id, updates }),
    });
  }

  async function loadDocuments() {
    try {
      const data = await adminQuery({
        table: "documents",
        select: "id, file_name, file_size, doc_type, classified_type, classification_confidence, type_mismatch, status, processing_step, processing_total_pages, processing_completed_pages, processing_error, processing_started_at, linked_insurance_plan_id, insurer_mismatch, created_at, user_id, file_hash, metadata",
        order: { column: "created_at", ascending: false },
        limit: 200,
      });

      if (data && data.length > 0) {
        // Batch fetch user emails
        const userIds = [...new Set(data.map((d: DocRecord) => d.user_id))];
        const users = await adminQuery({
          table: "users",
          select: "id, email",
          filters: [{ op: "in", column: "id", value: userIds }],
        });
        const emailMap = new Map(users?.map((u: { id: string; email: string }) => [u.id, u.email]) || []);
        setDocuments(data.map((d: DocRecord) => ({ ...d, user_email: emailMap.get(d.user_id) })));
      } else {
        setDocuments([]);
      }
    } catch (err) {
      console.error("[admin/review] Failed to load:", err);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!user) return;
    loadDocuments();
  }, [user]);

  async function loadPlanDetail(doc: DocRecord) {
    if (!doc.linked_insurance_plan_id || planDetails.has(doc.id)) return;
    try {
      const plans = await adminQuery({
        table: "insurance_plans",
        select: "plan_name, insurer_name, plan_type, in_deductible_individual, out_deductible_individual, in_oop_max_individual, out_oop_max_individual",
        filters: [{ op: "eq", column: "id", value: doc.linked_insurance_plan_id }],
      });
      const plan = plans?.[0];

      // Count extracted services
      const services = await adminQuery({
        table: "plan_covered_services",
        select: "id",
        filters: [{ op: "eq", column: "insurance_plan_id", value: doc.linked_insurance_plan_id }],
      });

      setPlanDetails((prev) => new Map(prev).set(doc.id, {
        plan_name: plan?.plan_name || null,
        insurer_name: plan?.insurer_name || null,
        plan_type: plan?.plan_type || null,
        in_deductible_individual: plan?.in_deductible_individual || null,
        out_deductible_individual: plan?.out_deductible_individual || null,
        in_oop_max_individual: plan?.in_oop_max_individual || null,
        out_oop_max_individual: plan?.out_oop_max_individual || null,
        servicesCount: services?.length || 0,
      }));
    } catch {
      // Non-critical
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  async function approveDocument(docId: string) {
    setProcessing(docId);
    try {
      const idToken = await getToken();
      const res = await fetch("/api/admin/processing", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process_document", documentId: docId }),
      });
      if (res.ok) {
        setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, status: "queued" } : d));
      } else {
        const data = await res.json();
        alert(`Processing failed: ${data.error || "Unknown error"}`);
      }
    } catch {
      alert("Processing request failed");
    }
    setProcessing(null);
  }

  async function rejectDocument(docId: string) {
    setProcessing(docId);
    await adminPatch("documents", docId, { status: "rejected" });
    setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, status: "rejected" } : d));
    setProcessing(null);
  }

  // Ing-G.2/3 — confirm/clear an adversarial flag. Read-modify-write the nested
  // metadata via the generic admin PATCH; never touches the doc's status (admin
  // triage only — the scorer never auto-rejects).
  async function setAdversarialReview(doc: DocRecord, state: "confirmed" | "cleared") {
    const a = doc.metadata?.adversarial_pdf_assessment;
    if (!a) return;
    setProcessing(doc.id);
    const newMetadata = { ...(doc.metadata ?? {}), adversarial_pdf_assessment: { ...a, review_state: state } };
    await adminPatch("documents", doc.id, { metadata: newMetadata });
    setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, metadata: newMetadata } : d)));
    setProcessing(null);
  }

  async function reprocessDocument(docId: string) {
    setProcessing(docId);
    try {
      const idToken = await getToken();
      const res = await fetch("/api/admin/processing", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process_document", documentId: docId }),
      });
      if (res.ok) {
        setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, status: "queued", processing_error: null } : d));
      } else {
        const data = await res.json();
        alert(`Reprocess failed: ${data.error || "Unknown error"}`);
      }
    } catch {
      alert("Reprocess request failed");
    }
    setProcessing(null);
  }

  async function bulkApprove() {
    setBulkAction("approve");
    setBulkResult(null);
    const pending = documents.filter((d) => d.status === "pending_review");
    let processed = 0;
    let errors = 0;
    for (const doc of pending) {
      try {
        const idToken = await getToken();
        const res = await fetch("/api/admin/processing", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "process_document", documentId: doc.id }),
        });
        if (res.ok) {
          processed++;
          setDocuments((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "queued" } : d));
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
    setBulkResult(`Approved ${processed} document${processed !== 1 ? "s" : ""}${errors > 0 ? `, ${errors} failed` : ""}`);
    setBulkAction(null);
  }

  async function submitBlockHash() {
    if (!blockTarget) return;
    const reason = blockReason.trim();
    if (!reason) {
      setBlockError("Reason is required.");
      return;
    }
    setBlockError(null);
    setBlockSubmitting(true);
    try {
      const idToken = await getToken();
      const res = await fetch("/api/admin/documents/blocklist", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_hash: blockTarget.fileHash,
          reason,
          notes: `Blocked from review page; source documentId=${blockTarget.docId}`,
        }),
      });
      if (res.ok) {
        setBlockTarget(null);
        setBlockReason("");
        alert("Hash blocked. Future uploads of this file will be rejected at the upload route.");
      } else {
        const data = await res.json().catch(() => ({}));
        setBlockError(data.error || "Failed to block hash.");
      }
    } catch {
      setBlockError("Request failed.");
    }
    setBlockSubmitting(false);
  }

  async function bulkReject() {
    setBulkAction("reject");
    setBulkResult(null);
    const pending = documents.filter((d) => d.status === "pending_review");
    for (const doc of pending) {
      await adminPatch("documents", doc.id, { status: "rejected" });
    }
    setDocuments((prev) => prev.map((d) => d.status === "pending_review" ? { ...d, status: "rejected" } : d));
    setBulkResult(`Rejected ${pending.length} document${pending.length !== 1 ? "s" : ""}`);
    setBulkAction(null);
    setShowRejectConfirm(false);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  function toggleExpand(doc: DocRecord) {
    if (expandedDoc === doc.id) {
      setExpandedDoc(null);
    } else {
      setExpandedDoc(doc.id);
      if (doc.linked_insurance_plan_id) loadPlanDetail(doc);
    }
  }

  // Ing-G.2/3 — the adversarial work-list: flagged ∧ not-yet-reviewed (any mode;
  // shadow rows are shown for FP measurement + carry a "shadow" chip).
  const adversarialDocs = documents.filter((d) => {
    const a = d.metadata?.adversarial_pdf_assessment;
    return a?.flagged === true && a.review_state === "unreviewed";
  });
  const adversarialCount = adversarialDocs.length;
  const filtered = filter === "all"
    ? documents
    : filter === "adversarial"
      ? adversarialDocs
      : documents.filter((d) => d.status === filter);
  const pendingCount = documents.filter((d) => d.status === "pending_review").length;

  // Precompute stuck document IDs (processing >10min with no progress)
  // eslint-disable-next-line react-hooks/purity
  const stuckCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const stuckDocIds = useMemo(() => {
    return new Set(
      documents
        .filter((d) => d.status === "processing" && d.processing_started_at && d.processing_started_at < stuckCutoff)
        .map((d) => d.id)
    );
  }, [documents, stuckCutoff]);
  const statusCounts: Record<string, number> = {};
  for (const d of documents) statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;

  function formatSize(bytes: number | null): string {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /* eslint-disable react-hooks/purity */
  function formatDuration(createdAt: string): string {
    const ms = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
  /* eslint-enable react-hooks/purity */

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Document Review</h1>
          <p className="text-sm text-gray-500 mt-1">
            {documents.length} total document{documents.length !== 1 ? "s" : ""}
            {pendingCount > 0 && ` · ${pendingCount} pending review`}
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); loadDocuments(); }}
          className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {(["pending_review", "adversarial", "all", "processed", "error", "queued", "rejected"] as StatusFilter[]).map((tab) => {
          const count = tab === "all" ? documents.length : tab === "adversarial" ? adversarialCount : (statusCounts[tab] || 0);
          if (tab !== "all" && tab !== "pending_review" && count === 0) return null;
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                filter === tab
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {tab === "all" ? "All" : STATUS_LABELS[tab] || tab} ({count})
            </button>
          );
        })}
      </div>

      {/* Bulk actions (when viewing pending_review and there are items) */}
      {pendingCount > 0 && filter === "pending_review" && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-amber-50 border border-amber-100 rounded-xl">
          <span className="text-sm font-medium text-amber-800">{pendingCount} document{pendingCount !== 1 ? "s" : ""} awaiting review</span>
          <div className="flex-1" />
          <button
            onClick={bulkApprove}
            disabled={bulkAction !== null}
            className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
          >
            {bulkAction === "approve" ? "Approving..." : `Approve All (${pendingCount})`}
          </button>
          <button
            onClick={() => setShowRejectConfirm(true)}
            disabled={bulkAction !== null}
            className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
          >
            Reject All ({pendingCount})
          </button>
        </div>
      )}

      {/* Reject All confirmation dialog */}
      {showRejectConfirm && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl">
          <p className="text-sm font-semibold text-red-800">
            Are you sure you want to reject {pendingCount} document{pendingCount !== 1 ? "s" : ""}?
          </p>
          <p className="text-xs text-red-600 mt-1">This cannot be undone. Rejected documents will need to be re-uploaded by users.</p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={bulkReject}
              disabled={bulkAction !== null}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {bulkAction === "reject" ? "Rejecting..." : "Yes, Reject All"}
            </button>
            <button
              onClick={() => setShowRejectConfirm(false)}
              className="px-3 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Ing-G.4 — Block hash confirmation dialog */}
      {blockTarget && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl">
          <p className="text-sm font-semibold text-red-800">
            Block file hash from future uploads?
          </p>
          <p className="text-xs text-red-700 mt-1">
            File: <span className="font-mono">{blockTarget.fileName}</span>
          </p>
          <p className="text-xs text-red-700">
            Hash: <span className="font-mono">{blockTarget.fileHash.slice(0, 16)}…</span>
          </p>
          <p className="text-xs text-red-600 mt-2">
            Future uploads matching this hash will be rejected at the upload route (before storage write or Haiku call). Existing documents rows with this hash are NOT affected. Reversible via the File Hash Blocklist admin page.
          </p>
          <label className="block text-xs font-medium text-red-800 mt-3 mb-1">Reason (required)</label>
          <input
            type="text"
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
            placeholder='e.g. "synthetic SBC — sample 42" or "incident #2026-005"'
            className="w-full px-3 py-2 text-sm border border-red-200 rounded-lg focus:outline-none focus:border-red-400"
          />
          {blockError && <p className="text-xs text-red-600 mt-1">{blockError}</p>}
          <div className="flex gap-2 mt-3">
            <button
              onClick={submitBlockHash}
              disabled={blockSubmitting}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {blockSubmitting ? "Blocking…" : "Confirm Block"}
            </button>
            <button
              onClick={() => { setBlockTarget(null); setBlockReason(""); setBlockError(null); }}
              disabled={blockSubmitting}
              className="px-3 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Bulk result banner */}
      {bulkResult && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-100 rounded-xl flex items-center justify-between">
          <span className="text-sm text-blue-800">{bulkResult}</span>
          <button onClick={() => setBulkResult(null)} className="text-xs text-blue-500 hover:text-blue-700">Dismiss</button>
        </div>
      )}

      {/* Document list */}
      {filtered.length === 0 ? (
        <div className="p-8 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl">
          {filter === "pending_review" ? "No documents pending review" : "No documents found"}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((doc) => {
            const isExpanded = expandedDoc === doc.id;
            const plan = planDetails.get(doc.id);
            const isPending = doc.status === "pending_review";
            const isError = doc.status === "error";
            const isStuck = stuckDocIds.has(doc.id);
            const adv = doc.metadata?.adversarial_pdf_assessment;

            return (
              <div key={doc.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                {/* Card header — clickable div (not button, so nested buttons work) */}
                <div
                  onClick={() => toggleExpand(doc)}
                  className="w-full text-left p-4 hover:bg-gray-50/50 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-900 truncate">{doc.file_name}</p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${STATUS_COLORS[doc.status] || "bg-gray-100 text-gray-600"}`}>
                          {STATUS_LABELS[doc.status] || doc.status}
                        </span>
                        {adv?.flagged && (
                          <span
                            title={adv.reasons.map((r) => `${r.code}: ${r.detail}`).join(" · ")}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-purple-100 text-purple-700"
                          >
                            ⚠ {adv.score.toFixed(2)}{adv.mode === "shadow" ? " shadow" : ""}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500">
                        <span>Selected: {doc.doc_type}</span>
                        {doc.classified_type && <span>Classified: {doc.classified_type}</span>}
                        {doc.classification_confidence != null && (
                          <span className={`font-semibold ${
                            doc.classification_confidence >= 0.8 ? "text-green-600"
                              : doc.classification_confidence >= 0.6 ? "text-amber-600"
                                : "text-red-600"
                          }`}>
                            {Math.round(doc.classification_confidence * 100)}% confidence
                          </span>
                        )}
                        {doc.file_size && <span>{formatSize(doc.file_size)}</span>}
                        {doc.user_email && <span>{doc.user_email}</span>}
                        <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-4 shrink-0">
                      {/* Inline actions for pending_review */}
                      {isPending && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); approveDocument(doc.id); }}
                            disabled={processing === doc.id}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                          >
                            {processing === doc.id ? "..." : "Approve"}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); rejectDocument(doc.id); }}
                            disabled={processing === doc.id}
                            className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {(isError || isStuck) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); reprocessDocument(doc.id); }}
                          disabled={processing === doc.id}
                          className="px-3 py-1.5 text-xs font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                        >
                          {processing === doc.id ? "..." : isStuck ? "Unstick" : "Reprocess"}
                        </button>
                      )}
                      {doc.file_hash && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setBlockTarget({ docId: doc.id, fileName: doc.file_name, fileHash: doc.file_hash! });
                            setBlockReason("");
                            setBlockError(null);
                          }}
                          className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-700"
                          title="Block this file hash from future uploads"
                        >
                          Block hash
                        </button>
                      )}
                      {filter === "adversarial" && adv && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); setAdversarialReview(doc, "cleared"); }}
                            disabled={processing === doc.id}
                            className="px-3 py-1.5 text-xs font-semibold text-green-600 border border-green-200 rounded-lg hover:bg-green-50 disabled:opacity-50"
                            title="Not adversarial — clear the flag (real document)"
                          >
                            {processing === doc.id ? "..." : "Clear (real)"}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setAdversarialReview(doc, "confirmed"); }}
                            disabled={processing === doc.id}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50"
                            title="Confirm this document is adversarial"
                          >
                            Confirm
                          </button>
                        </>
                      )}
                      <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="border-t border-gray-100 p-4 bg-gray-50/50 space-y-4">
                    {/* Document Info */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Document Info</h4>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <DetailItem label="File Size" value={formatSize(doc.file_size)} />
                        <DetailItem label="User Selected" value={doc.doc_type} />
                        <DetailItem label="AI Classified" value={doc.classified_type || "—"} />
                        <DetailItem label="Confidence" value={doc.classification_confidence != null ? `${Math.round(doc.classification_confidence * 100)}%` : "—"} />
                        <DetailItem label="Type Mismatch" value={doc.type_mismatch ? "Yes" : "No"} />
                        <DetailItem label="Uploaded" value={`${new Date(doc.created_at).toLocaleString()} (${formatDuration(doc.created_at)})`} />
                        <DetailItem label="User" value={doc.user_email || doc.user_id.slice(0, 8) + "..."} />
                        <DetailItem label="Document ID" value={doc.id.slice(0, 8) + "..."} />
                      </div>
                    </div>

                    {/* Processing Info */}
                    {(doc.processing_step || doc.processing_error || doc.processing_total_pages) && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Processing</h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {doc.processing_step && <DetailItem label="Current Step" value={doc.processing_step} />}
                          {doc.processing_total_pages && (
                            <DetailItem label="Pages" value={`${doc.processing_completed_pages || 0} / ${doc.processing_total_pages}`} />
                          )}
                          {doc.processing_error && (
                            <div className="col-span-2 md:col-span-4 p-2 bg-red-50 rounded-lg">
                              <p className="text-xs font-medium text-red-700">Error: {doc.processing_error}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Insurer Mismatch */}
                    {doc.insurer_mismatch?.mismatch && (
                      <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg">
                        <p className="text-xs font-semibold text-amber-800">Insurer Mismatch Detected</p>
                        <p className="text-xs text-amber-700 mt-1">
                          {doc.insurer_mismatch.type === "insurer"
                            ? `Profile: ${doc.insurer_mismatch.existingInsurer} → Document: ${doc.insurer_mismatch.parsedInsurer}`
                            : `Profile: ${doc.insurer_mismatch.existingPlanName} → Document: ${doc.insurer_mismatch.parsedPlanName}`
                          }
                        </p>
                      </div>
                    )}

                    {/* Plan Data (lazy-loaded) */}
                    {doc.linked_insurance_plan_id && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Linked Plan</h4>
                        {plan ? (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <DetailItem label="Plan Name" value={plan.plan_name || "—"} />
                            <DetailItem label="Insurer" value={plan.insurer_name || "—"} />
                            <DetailItem label="Plan Type" value={plan.plan_type || "—"} />
                            <DetailItem label="Services Extracted" value={String(plan.servicesCount)} highlight={plan.servicesCount > 0} />
                            <DetailItem label="In-Network Deductible" value={plan.in_deductible_individual != null ? `$${plan.in_deductible_individual}` : "—"} />
                            <DetailItem label="Out-of-Network Deductible" value={plan.out_deductible_individual != null ? `$${plan.out_deductible_individual}` : "—"} />
                            <DetailItem label="In-Network OOP Max" value={plan.in_oop_max_individual != null ? `$${plan.in_oop_max_individual}` : "—"} />
                            <DetailItem label="Out-of-Network OOP Max" value={plan.out_oop_max_individual != null ? `$${plan.out_oop_max_individual}` : "—"} />
                          </div>
                        ) : (
                          <p className="text-xs text-gray-400">Loading plan details...</p>
                        )}
                      </div>
                    )}

                    {/* Actions row */}
                    <div className="flex gap-2 pt-2 border-t border-gray-200">
                      {isPending && (
                        <>
                          <button
                            onClick={() => approveDocument(doc.id)}
                            disabled={processing === doc.id}
                            className="px-4 py-2 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                          >
                            {processing === doc.id ? "Processing..." : "Approve & Process"}
                          </button>
                          <button
                            onClick={() => rejectDocument(doc.id)}
                            disabled={processing === doc.id}
                            className="px-4 py-2 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {(isError || isStuck) && (
                        <button
                          onClick={() => reprocessDocument(doc.id)}
                          disabled={processing === doc.id}
                          className="px-4 py-2 text-xs font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                        >
                          {processing === doc.id ? "Reprocessing..." : isStuck ? "Unstick & Reprocess" : "Reprocess"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Detail Item ────────────────────────────────────────────────────────────

function DetailItem({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-sm font-medium mt-0.5 ${highlight ? "text-green-700" : "text-gray-900"}`}>{value}</p>
    </div>
  );
}

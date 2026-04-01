"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";

interface PendingDocument {
  id: string;
  file_name: string;
  doc_type: string;
  classified_type: string | null;
  classification_confidence: number | null;
  status: string;
  created_at: string;
  user_id: string;
  user_email?: string;
}

export default function DocumentReviewPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<PendingDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    loadPendingDocuments();
  }, [user]);

  async function loadPendingDocuments() {
    const supabase = createBrowserClient();
    const { data } = await supabase
      .from("documents")
      .select("id, file_name, doc_type, classified_type, classification_confidence, status, created_at, user_id")
      .in("status", ["pending_review", "queued"])
      .order("created_at", { ascending: false });

    if (data) {
      // Fetch user emails
      const userIds = [...new Set(data.map((d) => d.user_id))];
      const { data: users } = await supabase
        .from("users")
        .select("id, email")
        .in("id", userIds);

      const emailMap = new Map(users?.map((u) => [u.id, u.email]) || []);
      setDocuments(data.map((d) => ({ ...d, user_email: emailMap.get(d.user_id) })));
    }
    setLoading(false);
  }

  async function approveDocument(docId: string) {
    if (!user) return;
    setProcessing(docId);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/processing", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "process_document", documentId: docId }),
      });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
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
    const supabase = createBrowserClient();
    await supabase.from("documents").update({ status: "rejected" }).eq("id", docId);
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-32">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Document Review</h1>
          <p className="text-sm text-gray-500 mt-1">
            {documents.length} document{documents.length !== 1 ? "s" : ""} pending review
          </p>
        </div>
        <button
          onClick={loadPendingDocuments}
          className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="p-8 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl">
          No documents pending review
        </div>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => (
            <div key={doc.id} className="p-4 bg-white border border-gray-200 rounded-xl">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">{doc.file_name}</p>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                      doc.status === "pending_review"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-gray-100 text-gray-600"
                    }`}>
                      {doc.status === "pending_review" ? "Pending review" : doc.status}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                    <span>Selected: {doc.doc_type}</span>
                    {doc.classified_type && (
                      <span>Classified: {doc.classified_type}</span>
                    )}
                    {doc.classification_confidence != null && (
                      <span className={`font-semibold ${
                        doc.classification_confidence >= 0.6 ? "text-amber-600" : "text-red-600"
                      }`}>
                        {Math.round(doc.classification_confidence * 100)}% confidence
                      </span>
                    )}
                    {doc.user_email && <span>{doc.user_email}</span>}
                    <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <button
                    onClick={() => approveDocument(doc.id)}
                    disabled={processing === doc.id}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {processing === doc.id ? "Processing..." : "Approve"}
                  </button>
                  <button
                    onClick={() => rejectDocument(doc.id)}
                    className="px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

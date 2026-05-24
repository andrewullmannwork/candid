"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";

export interface UserDocument {
  id: string;
  doc_type: string | null;
  file_name: string;
  created_at: string;
}

interface Props {
  value: string | null;
  onChange: (id: string | null) => void;
  getIdToken: () => Promise<string>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function docTypeLabel(t: string | null): string {
  if (!t) return "Document";
  const map: Record<string, string> = {
    bill: "Bill",
    eob: "EOB",
    sbc: "SBC",
    plan_document: "Plan doc",
    insurance_card: "Insurance card",
    other: "Document",
  };
  return map[t] ?? t.replace(/_/g, " ");
}

export default function DocumentLinkPicker({ value, onChange, getIdToken }: Props) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<UserDocument[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || docs !== null) return;
    let cancelled = false;
    async function fetchDocs() {
      setLoading(true);
      setError(null);
      try {
        const token = await getIdToken();
        const res = await fetch("/api/user/documents-list", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Failed to load documents");
        const data = await res.json();
        if (!cancelled) setDocs(data.documents ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load documents");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchDocs();
    return () => {
      cancelled = true;
    };
  }, [open, docs, getIdToken]);

  const selected = docs?.find((d) => d.id === value) ?? null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all text-left",
          selected
            ? "border-blue-200 bg-blue-50/40"
            : "border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100",
        )}
      >
        <div className="w-10 h-10 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-gray-500 flex-shrink-0">
          <svg width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d={selected
                ? "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                : "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"}
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          {selected ? (
            <>
              <div className="font-medium text-gray-900 truncate">{selected.file_name}</div>
              <div className="text-sm text-gray-500">
                {docTypeLabel(selected.doc_type)} · {formatDate(selected.created_at)}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-gray-500">Pick a document from your library</div>
              <div className="text-sm text-gray-400">Bills, EOBs, and plan docs you&apos;ve uploaded</div>
            </>
          )}
        </div>
        <svg width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" className="text-gray-400 flex-shrink-0">
          <path strokeLinecap="round" strokeLinejoin="round" d={open ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
        </svg>
      </button>

      {open && (
        <div className="border border-gray-200 rounded-xl bg-white max-h-80 overflow-y-auto">
          {loading && <div className="p-4 text-sm text-gray-500">Loading documents…</div>}
          {error && <div className="p-4 text-sm text-red-600">{error}</div>}
          {!loading && !error && docs && docs.length === 0 && (
            <div className="p-4 text-sm text-gray-500">
              No documents uploaded yet. Upload one from{" "}
              <a href="/upload" className="text-blue-600 underline">/upload</a>.
            </div>
          )}
          {!loading && !error && docs && docs.length > 0 && (
            <ul>
              {value && (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 border-b border-gray-100"
                  >
                    Clear selection
                  </button>
                </li>
              )}
              {docs.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(d.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0",
                      value === d.id && "bg-blue-50/60",
                    )}
                  >
                    <div className="font-medium text-gray-900 truncate">{d.file_name}</div>
                    <div className="text-sm text-gray-500">
                      {docTypeLabel(d.doc_type)} · {formatDate(d.created_at)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

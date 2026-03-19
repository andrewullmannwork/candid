"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase/client";

interface DocRow {
  id: string;
  file_name: string;
  file_size: number;
  doc_type: string;
  status: string;
  created_at: string;
  user_id: string;
}

export default function AdminDocumentsPage() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createBrowserClient();
    async function load() {
      const { data } = await supabase
        .from("documents")
        .select("*")
        .order("created_at", { ascending: false });
      setDocs(data || []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="text-gray-500">Loading documents...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Documents ({docs.length})</h1>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="pb-2 pr-4">File</th>
              <th className="pb-2 pr-4">Type</th>
              <th className="pb-2 pr-4">Size</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id} className="border-b">
                <td className="py-2 pr-4">{doc.file_name}</td>
                <td className="py-2 pr-4 text-gray-500">{doc.doc_type}</td>
                <td className="py-2 pr-4 text-gray-500">
                  {(doc.file_size / 1024).toFixed(0)} KB
                </td>
                <td className="py-2 pr-4">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs ${
                      doc.status === "processed"
                        ? "bg-green-100 text-green-700"
                        : doc.status === "error"
                        ? "bg-red-100 text-red-700"
                        : "bg-yellow-100 text-yellow-700"
                    }`}
                  >
                    {doc.status}
                  </span>
                </td>
                <td className="py-2 text-gray-500">
                  {new Date(doc.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {docs.length === 0 && <p className="mt-4 text-gray-500">No documents uploaded yet.</p>}
      </div>
    </div>
  );
}

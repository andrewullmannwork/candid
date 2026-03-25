"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface CopyRow {
  id: string;
  key: string;
  value: string;
  section: string;
  description: string | null;
  updated_at: string;
}

export default function AdminCopyPage() {
  const { user: authUser } = useAuth();
  const [copy, setCopy] = useState<CopyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!authUser) return;
    async function load() {
      const token = await authUser!.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/copy", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setCopy(data.copy || []);
      setLoading(false);
    }
    load();
  }, [authUser]);

  async function handleSave(key: string) {
    if (!authUser) return;
    setSaving(true);
    const token = await authUser.firebaseUser.getIdToken();

    const res = await fetch("/api/admin/copy", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ key, value: editValue }),
    });

    if (res.ok) {
      setCopy((prev) =>
        prev.map((c) =>
          c.key === key ? { ...c, value: editValue, updated_at: new Date().toISOString() } : c
        )
      );
      setEditingKey(null);
    }
    setSaving(false);
  }

  if (loading) return <div className="text-gray-500">Loading site copy...</div>;

  const sections = [...new Set(copy.map((c) => c.section))];
  const filtered = filter ? copy.filter((c) => c.section === filter) : copy;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Site Copy Management</h1>
      <p className="mt-1 text-sm text-gray-500">
        Edit all site text without code changes. Changes apply after page reload.
      </p>

      {/* Section filter */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => setFilter("")}
          className={`px-3 py-1 rounded text-sm ${
            !filter ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          }`}
        >
          All
        </button>
        {sections.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded text-sm capitalize ${
              filter === s ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Copy entries */}
      <div className="mt-6 space-y-3">
        {filtered.map((c) => (
          <div key={c.key} className="bg-white border rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-700">
                    {c.key}
                  </code>
                  <span className="text-xs text-gray-400 capitalize">{c.section}</span>
                </div>
                {c.description && (
                  <p className="text-xs text-gray-400 mt-0.5">{c.description}</p>
                )}

                {editingKey === c.key ? (
                  <div className="mt-2">
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 border rounded text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => handleSave(c.key)}
                        disabled={saving}
                        className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={() => setEditingKey(null)}
                        className="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-gray-800">{c.value}</p>
                )}
              </div>

              {editingKey !== c.key && (
                <button
                  onClick={() => {
                    setEditingKey(c.key);
                    setEditValue(c.value);
                  }}
                  className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded"
                >
                  Edit
                </button>
              )}
            </div>
            <div className="mt-1 text-xs text-gray-400">
              Updated {new Date(c.updated_at).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

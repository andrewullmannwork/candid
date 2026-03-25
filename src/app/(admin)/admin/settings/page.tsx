"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

interface Flag {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

const BOOLEAN_FLAGS = new Set([
  "OCR_ENABLED",
  "AUTO_PROCESS_ON_UPLOAD",
  "CLAUDE_EXTRACTION_ENABLED",
  "ON_DEMAND_EXTRACTION_ENABLED",
]);

const FLAG_LABELS: Record<string, string> = {
  OCR_ENABLED: "Document AI OCR",
  AUTO_PROCESS_ON_UPLOAD: "Auto-Process on Upload",
  OCR_MONTHLY_PAGE_LIMIT: "Monthly OCR Page Limit",
  OCR_DAILY_PAGE_LIMIT: "Daily OCR Page Limit",
  CLAUDE_EXTRACTION_ENABLED: "Claude API Extraction",
  UPLOAD_MAX_FILE_SIZE: "Max File Size (bytes)",
  UPLOAD_MAX_PAGES: "Max Pages per PDF",
  UPLOAD_MAX_PER_USER: "Max Docs per User",
  ON_DEMAND_EXTRACTION_ENABLED: "On-Demand Plan Extraction",
};

const FLAG_GROUPS: Record<string, string[]> = {
  "Document Processing": [
    "OCR_ENABLED",
    "AUTO_PROCESS_ON_UPLOAD",
    "OCR_DAILY_PAGE_LIMIT",
    "OCR_MONTHLY_PAGE_LIMIT",
  ],
  "AI Features": [
    "CLAUDE_EXTRACTION_ENABLED",
    "ON_DEMAND_EXTRACTION_ENABLED",
  ],
  "Upload Limits": [
    "UPLOAD_MAX_FILE_SIZE",
    "UPLOAD_MAX_PAGES",
    "UPLOAD_MAX_PER_USER",
  ],
};

export default function AdminSettingsPage() {
  const { user } = useAuth();
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingFlag, setEditingFlag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    if (user) loadFlags();
  }, [user]);

  async function loadFlags() {
    if (!user) return;
    setLoading(true);
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/admin/flags", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const { flags: data } = await res.json();
      setFlags(data || []);
    }
    setLoading(false);
  }

  async function updateFlag(key: string, value: string) {
    if (!user) return;
    setSaving(key);
    const token = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/admin/flags", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      setFlags((prev) =>
        prev.map((f) =>
          f.key === key
            ? { ...f, value, updated_at: new Date().toISOString() }
            : f
        )
      );
      setEditingFlag(null);
    }
    setSaving(null);
  }

  function toggleBool(flag: Flag) {
    const newVal = flag.value === "true" ? "false" : "true";
    updateFlag(flag.key, newVal);
  }

  function getFlag(key: string): Flag | undefined {
    return flags.find((f) => f.key === key);
  }

  if (loading) return <div className="text-gray-500">Loading settings...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">
        Feature flags and cost protection controls. Changes take effect immediately.
      </p>

      <div className="mt-6 space-y-8">
        {Object.entries(FLAG_GROUPS).map(([group, keys]) => (
          <div key={group}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {group}
            </h2>
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
              {keys.map((key) => {
                const flag = getFlag(key);
                if (!flag) return null;
                const isBool = BOOLEAN_FLAGS.has(key);
                const isOn = flag.value === "true";

                return (
                  <div key={key} className="flex items-center justify-between p-4">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">
                        {FLAG_LABELS[key] || key}
                      </p>
                      {flag.description && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {flag.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      {isBool ? (
                        <button
                          onClick={() => toggleBool(flag)}
                          disabled={saving === key}
                          className={`relative w-11 h-6 rounded-full transition-colors ${
                            isOn ? "bg-blue-600" : "bg-gray-300"
                          } ${saving === key ? "opacity-50" : ""}`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                              isOn ? "translate-x-5" : ""
                            }`}
                          />
                        </button>
                      ) : editingFlag === key ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-24 px-2 py-1 text-sm border rounded focus:ring-2 focus:ring-blue-500 focus:outline-none"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") updateFlag(key, editValue);
                              if (e.key === "Escape") setEditingFlag(null);
                            }}
                          />
                          <button
                            onClick={() => updateFlag(key, editValue)}
                            disabled={saving === key}
                            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingFlag(null)}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingFlag(key);
                            setEditValue(flag.value);
                          }}
                          className="flex items-center gap-2 text-sm"
                        >
                          <code className="px-2 py-0.5 bg-gray-100 rounded text-gray-700">
                            {key === "UPLOAD_MAX_FILE_SIZE"
                              ? `${Math.round(parseInt(flag.value) / 1024 / 1024)}MB`
                              : flag.value}
                          </code>
                          <span className="text-xs text-blue-600 hover:text-blue-700">
                            Edit
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 p-4 bg-gray-50 border border-gray-200 rounded-xl">
        <p className="text-xs text-gray-500">
          <strong>Note:</strong> Environment variables in <code>.env.local</code> or Vercel override database values.
          Remove the env var to let the database value take effect.
        </p>
      </div>
    </div>
  );
}

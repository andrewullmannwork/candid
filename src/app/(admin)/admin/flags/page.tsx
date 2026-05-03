"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { useAdminQuery } from "@/lib/admin/use-admin-query";

interface FlagRule {
  id: string;
  flag_key: string;
  enabled: boolean;
  description: string | null;
  target_type: "global" | "users" | "percentage";
  target_users: string[];
  target_percentage: number;
  // Phase 4 Task 4-B (Session 56 mig 067) — typed config payload for non-boolean
  // flag tuning (e.g., pattern1_corroboration_threshold has {value: 3} for the
  // distinct-user threshold for canonical-source corroboration). Read at runtime
  // via `readFeatureFlagConfig<T>` in src/lib/config/product-flags.ts. Edit UI
  // exposed in this admin page (Phase 4 Task 4 bonus, Session 57).
  config: Record<string, unknown> | null;
  updated_at: string;
}

export default function FeatureFlagsPage() {
  const { user } = useAuth();
  const { query, update, insert } = useAdminQuery();
  const [flags, setFlags] = useState<FlagRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [editingUsers, setEditingUsers] = useState<string | null>(null);
  const [userInput, setUserInput] = useState("");
  // Phase 4 bonus: per-flag config editing state. `editingConfig` is the flag.id
  // currently being edited; `configDraft` holds the unsaved JSON text; `configError`
  // surfaces parse errors inline (does NOT block the input — user can iterate).
  const [editingConfig, setEditingConfig] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);

  async function loadFlags() {
    try {
      const data = await query({
        table: "feature_flag_rules",
        order: { column: "flag_key", ascending: true },
        limit: 100,
      });
      setFlags(data || []);
    } catch (err) {
      console.error("Failed to load flags:", err);
    }
    setLoading(false);
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!user) return;
    loadFlags();
  }, [user]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function toggleFlag(flag: FlagRule) {
    const newEnabled = !flag.enabled;
    await update("feature_flag_rules", flag.id, {
      enabled: newEnabled,
      updated_at: new Date().toISOString(),
    });
    setFlags((prev) => prev.map((f) => f.id === flag.id ? { ...f, enabled: newEnabled, updated_at: new Date().toISOString() } : f));
  }

  async function updateTargetType(flag: FlagRule, targetType: string) {
    await update("feature_flag_rules", flag.id, {
      target_type: targetType,
      updated_at: new Date().toISOString(),
    });
    setFlags((prev) => prev.map((f) => f.id === flag.id ? { ...f, target_type: targetType as FlagRule["target_type"], updated_at: new Date().toISOString() } : f));
  }

  async function updatePercentage(flag: FlagRule, pct: number) {
    await update("feature_flag_rules", flag.id, {
      target_percentage: pct,
      updated_at: new Date().toISOString(),
    });
    setFlags((prev) => prev.map((f) => f.id === flag.id ? { ...f, target_percentage: pct, updated_at: new Date().toISOString() } : f));
  }

  async function saveUsers(flag: FlagRule, users: string[]) {
    await update("feature_flag_rules", flag.id, {
      target_users: users,
      updated_at: new Date().toISOString(),
    });
    setFlags((prev) => prev.map((f) => f.id === flag.id ? { ...f, target_users: users, updated_at: new Date().toISOString() } : f));
    setEditingUsers(null);
    setUserInput("");
  }

  // Phase 4 bonus: parse + persist the JSON config payload for a flag. Validates
  // JSON inline; only writes to DB on successful parse. Empty input clears the
  // config to null (semantically "no config"; readFeatureFlagConfig returns the
  // caller's fallback).
  async function saveConfig(flag: FlagRule) {
    const trimmed = configDraft.trim();
    let parsed: Record<string, unknown> | null = null;
    if (trimmed.length > 0) {
      try {
        const candidate: unknown = JSON.parse(trimmed);
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          Array.isArray(candidate)
        ) {
          setConfigError("Config must be a JSON object (e.g. { \"value\": 3 })");
          return;
        }
        parsed = candidate as Record<string, unknown>;
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }
    setConfigError(null);
    await update("feature_flag_rules", flag.id, {
      config: parsed,
      updated_at: new Date().toISOString(),
    });
    setFlags((prev) =>
      prev.map((f) => (f.id === flag.id ? { ...f, config: parsed, updated_at: new Date().toISOString() } : f)),
    );
    setEditingConfig(null);
    setConfigDraft("");
  }

  function startConfigEdit(flag: FlagRule) {
    setEditingConfig(flag.id);
    setConfigDraft(flag.config ? JSON.stringify(flag.config, null, 2) : "");
    setConfigError(null);
  }

  function cancelConfigEdit() {
    setEditingConfig(null);
    setConfigDraft("");
    setConfigError(null);
  }

  async function addFlag() {
    if (!newKey.trim()) return;
    const slug = newKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    await insert("feature_flag_rules", {
      flag_key: slug,
      description: newDesc.trim() || null,
      enabled: false,
      target_type: "global",
      target_users: [],
      target_percentage: 100,
    });
    setNewKey("");
    setNewDesc("");
    setAdding(false);
    loadFlags();
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
          <h1 className="text-xl font-bold text-gray-900">Feature Flags</h1>
          <p className="text-sm text-gray-500 mt-1">
            Control product feature rollouts. Separate from system flags in Settings.
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          + Add Flag
        </button>
      </div>

      {adding && (
        <div className="mb-4 p-4 bg-gray-50 border border-gray-200 rounded-xl">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="flag_key (e.g., new_dashboard)"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
              autoFocus
            />
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Description"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 flex-1"
            />
            <button
              onClick={addFlag}
              disabled={!newKey.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => { setAdding(false); setNewKey(""); setNewDesc(""); }}
              className="px-3 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {flags.length === 0 ? (
        <div className="p-8 text-center text-gray-400 border border-dashed border-gray-200 rounded-xl">
          No feature flags configured. Click &quot;+ Add Flag&quot; to create one.
        </div>
      ) : (
        <div className="space-y-3">
          {flags.map((flag) => (
            <div key={flag.id} className={`p-4 border rounded-xl transition-colors ${flag.enabled ? "bg-green-50/30 border-green-200" : "bg-white border-gray-200"}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <code className="text-sm font-semibold text-gray-900 bg-gray-100 px-2 py-0.5 rounded">{flag.flag_key}</code>
                    <button
                      onClick={() => toggleFlag(flag)}
                      className={`relative w-11 h-6 rounded-full transition-colors ${flag.enabled ? "bg-green-500" : "bg-gray-300"}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${flag.enabled ? "translate-x-5" : ""}`} />
                    </button>
                    <span className={`text-xs font-medium ${flag.enabled ? "text-green-700" : "text-gray-400"}`}>
                      {flag.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  {flag.description && (
                    <p className="mt-1 text-sm text-gray-500">{flag.description}</p>
                  )}
                </div>
                <span className="text-xs text-gray-400">
                  {new Date(flag.updated_at).toLocaleDateString()}
                </span>
              </div>

              {/* Targeting controls */}
              <div className="mt-3 flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-500">Target:</span>
                  <select
                    value={flag.target_type}
                    onChange={(e) => updateTargetType(flag, e.target.value)}
                    className="px-2 py-1 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="global">Global (all users)</option>
                    <option value="users">Specific Users</option>
                    <option value="percentage">Percentage Rollout</option>
                  </select>
                </div>

                {flag.target_type === "percentage" && (
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={flag.target_percentage}
                      onChange={(e) => updatePercentage(flag, parseInt(e.target.value))}
                      className="w-32 accent-blue-600"
                    />
                    <span className="text-xs font-semibold text-blue-700 w-8">{flag.target_percentage}%</span>
                  </div>
                )}

                {flag.target_type === "users" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {flag.target_users.map((email) => (
                      <span key={email} className="inline-flex items-center gap-1 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                        {email}
                        <button
                          onClick={() => saveUsers(flag, flag.target_users.filter((e) => e !== email))}
                          className="text-blue-400 hover:text-blue-600"
                        >
                          x
                        </button>
                      </span>
                    ))}
                    {editingUsers === flag.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="email"
                          value={userInput}
                          onChange={(e) => setUserInput(e.target.value)}
                          placeholder="user@email.com"
                          className="px-2 py-0.5 text-xs border border-blue-200 rounded-lg w-40 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && userInput.includes("@")) {
                              saveUsers(flag, [...flag.target_users, userInput.trim()]);
                            }
                          }}
                        />
                        <button
                          onClick={() => {
                            if (userInput.includes("@")) saveUsers(flag, [...flag.target_users, userInput.trim()]);
                          }}
                          disabled={!userInput.includes("@")}
                          className="px-2 py-0.5 text-xs font-medium bg-blue-600 text-white rounded-lg disabled:opacity-50"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => { setEditingUsers(null); setUserInput(""); }}
                          className="px-2 py-0.5 text-xs text-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingUsers(flag.id)}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        + Add user
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Phase 4 bonus: typed JSON config editor (Session 57). Surfaces
                  feature_flag_rules.config payload added by mig 067. Read at
                  runtime via readFeatureFlagConfig<T>(flagKey, configKey, fallback)
                  in src/lib/config/product-flags.ts. Used today by:
                  pattern1_corroboration_threshold = {"value": 3}.            */}
              <div className="mt-3 pt-3 border-t border-gray-100">
                {editingConfig === flag.id ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-700">
                        Editing <code className="font-mono bg-gray-100 px-1 rounded">{flag.flag_key}.config</code>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => saveConfig(flag)}
                          className="px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelConfigEdit}
                          className="px-2 py-1 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={configDraft}
                      onChange={(e) => { setConfigDraft(e.target.value); setConfigError(null); }}
                      placeholder='{ "value": 3 }'
                      rows={3}
                      className="w-full px-2 py-1.5 text-xs font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    {configError && (
                      <p className="text-xs text-red-600">{configError}</p>
                    )}
                    <p className="text-[11px] text-gray-400">
                      JSON object only (e.g. <code className="font-mono">{"{ \"value\": 3 }"}</code>). Empty clears the config.
                      Read at runtime via <code className="font-mono">readFeatureFlagConfig(flagKey, configKey, fallback)</code>.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-500">Config:</span>
                      {flag.config ? (
                        <code className="text-xs font-mono bg-gray-50 text-gray-700 px-2 py-0.5 rounded border border-gray-200">
                          {JSON.stringify(flag.config)}
                        </code>
                      ) : (
                        <span className="text-xs text-gray-300 italic">none</span>
                      )}
                    </div>
                    <button
                      onClick={() => startConfigEdit(flag)}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      {flag.config ? "Edit" : "+ Add config"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

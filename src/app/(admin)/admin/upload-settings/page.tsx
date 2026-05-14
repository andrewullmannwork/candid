"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * /admin/upload-settings — S91 admin tuning for the doc-type override resolver.
 *
 * Knobs:
 *   - enabled: kill switch
 *   - classifier_confidence_override: Rule 1 confidence threshold (0-1)
 *   - sbc_max_pages: Rule 2 SBC max page ceiling (positive integer)
 *
 * Wires to the doc_type_override_v1 feature flag row via
 * /api/admin/upload-settings.
 */

interface SettingsState {
  enabled: boolean;
  classifier_confidence_override: number;
  sbc_max_pages: number;
  rowExists: boolean;
  description: string | null;
}

const DEFAULTS: SettingsState = {
  enabled: true,
  classifier_confidence_override: 0.8,
  sbc_max_pages: 20,
  rowExists: false,
  description: null,
};

export default function UploadSettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<SettingsState>(DEFAULTS);
  const [draft, setDraft] = useState<SettingsState>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function load() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/upload-settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Load failed (${res.status})`);
      }
      const data = (await res.json()) as SettingsState;
      setSettings(data);
      setDraft(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const dirty =
    draft.enabled !== settings.enabled ||
    draft.classifier_confidence_override !== settings.classifier_confidence_override ||
    draft.sbc_max_pages !== settings.sbc_max_pages;

  async function handleSave() {
    if (!user) return;
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/upload-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled: draft.enabled,
          classifier_confidence_override: draft.classifier_confidence_override,
          sbc_max_pages: draft.sbc_max_pages,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      const data = (await res.json()) as SettingsState & { success?: boolean };
      setSettings(data);
      setDraft(data);
      setSuccessMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  function resetDraft() {
    setDraft(settings);
    setError(null);
    setSuccessMessage(null);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900 mb-2">Upload Settings</h1>
      <p className="text-sm text-slate-600 mb-6">
        Tunes the effective-doc-type resolver that overrides the user&rsquo;s upload-form pick when the
        Haiku classifier strongly disagrees (Rule 1) or when an SBC pick is contradicted by the page
        count (Rule 2 safety net). When disabled, the resolver bypasses both rules and trusts the
        user&rsquo;s pick verbatim. See <code>src/lib/documents/effective-doc-type.ts</code>.
      </p>

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && (
        <div className="space-y-6 bg-white border border-slate-200 rounded-2xl p-6">
          {!settings.rowExists && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              No <code>doc_type_override_v1</code> row in <code>feature_flag_rules</code> yet —
              showing defaults. Saving will create the row.
            </div>
          )}

          <div className="flex items-center gap-3">
            <input
              id="enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="w-4 h-4"
            />
            <label htmlFor="enabled" className="text-sm font-medium text-slate-900">
              Resolver enabled
            </label>
            <span className="text-xs text-slate-500">
              (kill switch — uncheck to trust user pick always)
            </span>
          </div>

          <div>
            <label
              htmlFor="confidence"
              className="block text-sm font-medium text-slate-900 mb-1"
            >
              Classifier confidence override threshold
            </label>
            <p className="text-xs text-slate-500 mb-2">
              Rule 1 fires when classifier disagrees with user AND its confidence ≥ this value.
              Default 0.8. Lower = more aggressive override; higher = more conservative.
            </p>
            <div className="flex items-center gap-3">
              <input
                id="confidence"
                type="range"
                min="0.5"
                max="1"
                step="0.05"
                value={draft.classifier_confidence_override}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    classifier_confidence_override: parseFloat(e.target.value),
                  })
                }
                disabled={!draft.enabled}
                className="flex-1"
              />
              <span className="font-mono text-sm text-slate-900 w-12 text-right">
                {draft.classifier_confidence_override.toFixed(2)}
              </span>
            </div>
          </div>

          <div>
            <label htmlFor="sbcMax" className="block text-sm font-medium text-slate-900 mb-1">
              SBC max page count (Rule 2 safety net)
            </label>
            <p className="text-xs text-slate-500 mb-2">
              When a user picks SBC and the document has more pages than this, force routing to the
              Plan Doc parser. SBCs cap at 8 pages by federal rule; ~15 typical with state addenda;
              20 is the safe ceiling. Default 20.
            </p>
            <input
              id="sbcMax"
              type="number"
              min="1"
              max="200"
              value={draft.sbc_max_pages}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  sbc_max_pages: Math.max(1, parseInt(e.target.value || "1", 10)),
                })
              }
              disabled={!draft.enabled}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-24"
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
              {error}
            </div>
          )}
          {successMessage && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
              {successMessage}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              onClick={resetDraft}
              disabled={!dirty || saving}
              className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Discard changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

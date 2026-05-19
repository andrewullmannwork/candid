"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * /admin/classifier-fallback-settings — S94 B5 admin tuning for the
 * classifier_haiku_regex_fallback_v1 flag.
 *
 * Knobs:
 *   - enabled: kill switch (all three defenses bypass when false)
 *   - haiku_failure_fallback: 'regex' | 'user_pick'
 *   - sanity_gate_enabled + min_pages + sbc_phrase_count
 *   - confirmation_ui_enabled + regex_threshold
 *
 * Wires to /api/admin/classifier-fallback-settings.
 */

interface SettingsState {
  enabled: boolean;
  haiku_failure_fallback: "regex" | "user_pick";
  sanity_gate_enabled: boolean;
  sanity_gate_min_pages: number;
  sanity_gate_sbc_phrase_count: number;
  confirmation_ui_enabled: boolean;
  confirmation_regex_threshold: number;
  rowExists: boolean;
  description: string | null;
}

const DEFAULTS: SettingsState = {
  enabled: false,
  haiku_failure_fallback: "regex",
  sanity_gate_enabled: true,
  sanity_gate_min_pages: 10,
  sanity_gate_sbc_phrase_count: 2,
  confirmation_ui_enabled: true,
  confirmation_regex_threshold: 0.5,
  rowExists: false,
  description: null,
};

export default function ClassifierFallbackSettingsPage() {
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
      const res = await fetch("/api/admin/classifier-fallback-settings", {
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
    draft.haiku_failure_fallback !== settings.haiku_failure_fallback ||
    draft.sanity_gate_enabled !== settings.sanity_gate_enabled ||
    draft.sanity_gate_min_pages !== settings.sanity_gate_min_pages ||
    draft.sanity_gate_sbc_phrase_count !== settings.sanity_gate_sbc_phrase_count ||
    draft.confirmation_ui_enabled !== settings.confirmation_ui_enabled ||
    draft.confirmation_regex_threshold !== settings.confirmation_regex_threshold;

  async function handleSave() {
    if (!user) return;
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/classifier-fallback-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enabled: draft.enabled,
          haiku_failure_fallback: draft.haiku_failure_fallback,
          sanity_gate_enabled: draft.sanity_gate_enabled,
          sanity_gate_min_pages: draft.sanity_gate_min_pages,
          sanity_gate_sbc_phrase_count: draft.sanity_gate_sbc_phrase_count,
          confirmation_ui_enabled: draft.confirmation_ui_enabled,
          confirmation_regex_threshold: draft.confirmation_regex_threshold,
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
      <h1 className="text-2xl font-semibold text-slate-900 mb-2">
        Classifier Fallback Settings
      </h1>
      <p className="text-sm text-slate-600 mb-6">
        Tunes three S94 B5 defenses against doc-type resolver misses. Defense 1
        kicks in when the Haiku classifier errors. Defense 2 refuses the bill
        parser on documents that look structurally like SBCs. Defense 3 surfaces
        a confirmation modal when the regex classifier disagrees with the user
        pick at moderate confidence. When the master switch is off, all three
        defenses bypass — see <code>src/lib/config/classifier-fallback-config.ts</code>.
      </p>

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && (
        <div className="space-y-6 bg-white border border-slate-200 rounded-2xl p-6">
          {!settings.rowExists && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              No <code>classifier_haiku_regex_fallback_v1</code> row in
              <code> feature_flag_rules</code> yet — showing defaults. Saving will create the row.
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
              Master switch — flag enabled
            </label>
            <span className="text-xs text-slate-500">(uncheck to bypass all three defenses)</span>
          </div>

          <fieldset className="space-y-2 border-t pt-4">
            <legend className="text-sm font-semibold text-slate-900">
              Defense 1 — Haiku failure fallback
            </legend>
            <p className="text-xs text-slate-500">
              When the post-OCR Haiku classifier crashes (network, JSON parse,
              etc.), which signal should the pipeline trust?
            </p>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="haiku_failure_fallback"
                  value="regex"
                  checked={draft.haiku_failure_fallback === "regex"}
                  onChange={() => setDraft({ ...draft, haiku_failure_fallback: "regex" })}
                  disabled={!draft.enabled}
                />
                <span>Regex classifier on full OCR (recommended)</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="haiku_failure_fallback"
                  value="user_pick"
                  checked={draft.haiku_failure_fallback === "user_pick"}
                  onChange={() => setDraft({ ...draft, haiku_failure_fallback: "user_pick" })}
                  disabled={!draft.enabled}
                />
                <span>User&rsquo;s upload-form pick (legacy)</span>
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-2 border-t pt-4">
            <legend className="text-sm font-semibold text-slate-900">
              Defense 2 — Bill parser sanity gate
            </legend>
            <p className="text-xs text-slate-500">
              Refuse to run the bill parser when the document looks structurally
              like an SBC (too many pages OR too many SBC-specific phrases).
            </p>
            <div className="flex items-center gap-3 mt-2">
              <input
                id="sanity_gate_enabled"
                type="checkbox"
                checked={draft.sanity_gate_enabled}
                onChange={(e) =>
                  setDraft({ ...draft, sanity_gate_enabled: e.target.checked })
                }
                disabled={!draft.enabled}
                className="w-4 h-4"
              />
              <label htmlFor="sanity_gate_enabled" className="text-sm text-slate-900">
                Enable sanity gate
              </label>
            </div>
            <div className="flex items-center gap-6 mt-2">
              <label className="text-sm text-slate-900 flex items-center gap-2">
                <span>Min pages to trip:</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={draft.sanity_gate_min_pages}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      sanity_gate_min_pages: Math.max(1, parseInt(e.target.value || "1", 10)),
                    })
                  }
                  disabled={!draft.enabled || !draft.sanity_gate_enabled}
                  className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-20"
                />
              </label>
              <label className="text-sm text-slate-900 flex items-center gap-2">
                <span>SBC phrase matches to trip:</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={draft.sanity_gate_sbc_phrase_count}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      sanity_gate_sbc_phrase_count: Math.max(
                        1,
                        parseInt(e.target.value || "1", 10),
                      ),
                    })
                  }
                  disabled={!draft.enabled || !draft.sanity_gate_enabled}
                  className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-16"
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-2 border-t pt-4">
            <legend className="text-sm font-semibold text-slate-900">
              Defense 3 — Doc-type confirmation modal
            </legend>
            <p className="text-xs text-slate-500">
              Halt the upload pipeline + show a confirmation modal when the
              regex classifier disagrees with the user pick at moderate
              confidence (above this threshold but below the Pattern P hard
              override at <code>/admin/upload-settings</code>).
            </p>
            <div className="flex items-center gap-3 mt-2">
              <input
                id="confirmation_ui_enabled"
                type="checkbox"
                checked={draft.confirmation_ui_enabled}
                onChange={(e) =>
                  setDraft({ ...draft, confirmation_ui_enabled: e.target.checked })
                }
                disabled={!draft.enabled}
                className="w-4 h-4"
              />
              <label htmlFor="confirmation_ui_enabled" className="text-sm text-slate-900">
                Enable confirmation modal
              </label>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <input
                id="confirmation_regex_threshold"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.confirmation_regex_threshold}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    confirmation_regex_threshold: parseFloat(e.target.value),
                  })
                }
                disabled={!draft.enabled || !draft.confirmation_ui_enabled}
                className="flex-1"
              />
              <span className="font-mono text-sm text-slate-900 w-12 text-right">
                {draft.confirmation_regex_threshold.toFixed(2)}
              </span>
            </div>
          </fieldset>

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

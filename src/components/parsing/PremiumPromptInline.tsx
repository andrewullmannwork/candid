"use client";

/**
 * Premium prompt — inline post-parse, pre-redirect on plan_doc/SBC uploads.
 *
 * SBCs don't include premium (federally-mandated content doesn't disclose
 * monthly cost), so when an SBC parse succeeds with no `premium_monthly` on
 * the linked `insurance_plans` row, we hold the auto-redirect to /plan and
 * surface this prompt for the user to fill in their premium amount.
 *
 * CF-35 (Session 72): premium is OPTIONAL — Skip button lets users who don't
 * know their premium proceed without entering a value. They can edit it later
 * from the plan page.
 *
 * Extracted from src/app/(app)/upload/page.tsx:2112-2198 verbatim (S100 Stage
 * 7c Phase 1). Same behavior, same JSX, same API call. Just relocated so
 * ParseTerminalView can compose it.
 */
import { useState } from "react";

interface PremiumPromptInlineProps {
  planId: string;
  user: { firebaseUser: { getIdToken(): Promise<string> } };
  onSaved: (premium: number) => void;
  onSkip: () => void;
}

export function PremiumPromptInline({
  planId,
  user,
  onSaved,
  onSkip,
}: PremiumPromptInlineProps) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num < 0 || num > 100000) {
      setError("Enter a valid monthly amount.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/premium", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ planId, premiumMonthly: num }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Save failed");
      }
      onSaved(num);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-2xl">
      <p className="text-sm font-semibold text-slate-900">What&rsquo;s your monthly premium?</p>
      <p className="text-xs text-slate-600 mt-1 leading-relaxed">
        SBCs don&rsquo;t include the premium — adding it here unlocks total-cost projections
        and powers Candid Compare. You can always edit this later.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-slate-500 text-sm">$</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="350.00"
          disabled={saving}
          className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
        />
        <span className="text-slate-500 text-xs">/ month</span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!value || saving}
          className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <button
        type="button"
        onClick={onSkip}
        disabled={saving}
        className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-900 underline disabled:opacity-50"
      >
        Skip for now — I&rsquo;ll add it later
      </button>
    </div>
  );
}

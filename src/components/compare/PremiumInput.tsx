"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * B3.3 — Inline "ADD YOURS" premium input per D-§1.C.3-K.
 *
 * Renders ONLY when:
 *   1. plan is the user's ACTIVE insurance plan (passed via active-plan ID check
 *      in NumbersTable parent), AND
 *   2. premium_monthly value is null/missing.
 *
 * On save, POSTs to /api/plan/field (same endpoint legacy FieldInlineEdit used
 * inside CompareHeader pre-B3.3); calls onSaved(value) on success so parent can
 * apply optimistic update via existing onFieldSaved callback (S107 pattern).
 */

interface PremiumInputProps {
  planId: string;
  onSaved: (value: number) => void;
}

export function PremiumInput({ planId, onSaved }: PremiumInputProps) {
  const { user } = useAuth();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!user) return;
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num < 0 || num > 1_000_000) {
      setError("Enter a valid amount");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/field", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ planId, field: "premium_monthly", value: num }),
      });
      if (!res.ok) throw new Error("save failed");
      onSaved(num);
    } catch {
      setError("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="text-center">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-blue-600 mb-1.5">
        Add yours
      </p>
      <div className="flex items-center justify-center gap-1">
        <span className="text-slate-500 text-sm">$</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
          }}
          placeholder="0"
          disabled={saving}
          aria-label="Your monthly premium"
          className="w-20 px-2 py-1 rounded-lg border border-slate-200 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!value || saving}
          className="px-2.5 py-1 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "…" : "Save"}
        </button>
      </div>
      {error && <p className="text-[10px] text-red-600 mt-1">{error}</p>}
    </div>
  );
}

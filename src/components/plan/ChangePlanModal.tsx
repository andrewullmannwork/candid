"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/modal";
import { ComparePickerV2 } from "@/components/compare/v2/ComparePickerV2";
import { useAuth } from "@/lib/auth/auth-context";
import type { SlotState } from "@/components/compare/PlanSlot";

/**
 * ChangePlanModal (bugbash Stretch 1) — replace the user's active insurance
 * plan from /plan. Reuses the existing ComparePickerV2 search design (the
 * gorgeous library picker), so a library pick does an in-modal, link-only swap
 * via POST /api/plan/set-active. Upload hands off to the proven /upload flow
 * (Option 1) rather than duplicating its Turnstile + polling + consent pipeline.
 *
 * allowUpload={false} on the picker so its in-modal UploadPicker isn't used;
 * the "Upload a new plan document" handoff button below covers the upload path.
 */
export function ChangePlanModal({
  open,
  onClose,
  currentCanonicalId,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** The user's current canonical plan id — excluded from search results. */
  currentCanonicalId?: string | null;
  /** Called after the active plan is successfully replaced (parent re-analyzes). */
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePick(slot: SlotState) {
    if (slot.kind !== "search" || !slot.selected || busy || !user) return;
    const canonicalPlanId = slot.selected.canonicalPlanId ?? slot.selected.id;
    if (!canonicalPlanId) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/set-active", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ canonicalPlanId }),
      });
      if (!res.ok) throw new Error(`set-active ${res.status}`);
      onChanged();
      onClose();
    } catch {
      setError("Couldn't switch to that plan. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={busy ? () => {} : onClose}
      tone="info"
      size="md"
      title="Change your plan"
      subtitle="Search the plan library, or upload a new plan document."
    >
      <div className="space-y-3">
        {busy && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            Updating your plan…
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <ComparePickerV2
          currentPlan={null}
          excludeIds={currentCanonicalId ? [currentCanonicalId] : []}
          recents={[]}
          allowUpload={false}
          onPick={handlePick}
        />

        {/* Upload handoff (Option 1): the full upload pipeline (Turnstile,
            doc-type confirmation, progress) lives on /upload — we hand off
            rather than duplicate it. */}
        <button
          type="button"
          onClick={() => router.push("/upload")}
          className="group w-full flex items-start gap-2.5 p-3 rounded-xl bg-slate-50 hover:bg-blue-50 ring-1 ring-slate-200 hover:ring-blue-300 transition-all text-left"
        >
          <span className="shrink-0 w-7 h-7 rounded-lg bg-white ring-1 ring-slate-200 group-hover:text-blue-600 flex items-center justify-center text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-slate-900 group-hover:text-blue-700">
              Upload a new plan document
            </span>
            <span className="block text-[11px] text-slate-500 mt-0.5">
              SBC or plan PDF — we&rsquo;ll read it and switch you over
            </span>
          </span>
        </button>
      </div>
    </ModalShell>
  );
}

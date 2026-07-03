/**
 * AddPlanDetailsModal — Cost-Share v2 (W3 / §7b), the manual "add plan details"
 * form behind the §5 V4/insufficient banner. Progressive: Step 1 captures the
 * plan's cost-share for THIS service (the gap that made the bill uncheckable);
 * Step 2 (optional) captures the plan's in-network deductible / OOP max.
 *
 * All writes are user-scoped (Rules #4/#10): Step 1 → the cost-share-override
 * API (service_cost; the route sets covered=true + source='manual'); Step 2 →
 * the existing /api/plan/field.
 *
 * Optimistic save (S263): the WRITE is awaited (the quick, honest confirmation),
 * then we show "Saved" + kick off the parent refetch in the BACKGROUND (that
 * re-fetch + cost-share recompute is the slow part) and auto-close — so the save
 * feels instant instead of blocking on the refetch.
 *
 * The parent only opens this for a line that HAS a service_slug (a null-slug
 * line routes to CategoryCorrectionModal to identify the service first).
 *
 * §7b's "Covered? Yes/No" is intentionally omitted: the override API only writes
 * covered=true, and entering a cost already implies coverage. "It's not covered"
 * / "it should be covered" are the V3 path, not this form.
 */
"use client";

import { useState } from "react";

interface AddPlanDetailsModalProps {
  open: boolean;
  claimId: string;
  planId: string | null;
  serviceSlug: string;
  serviceLabel: string;
  getAuthToken: () => Promise<string | null>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  /** Pre-fill for re-open/edit (S263) — the service's current cost-share so the
   *  user can CORRECT a mistake, not start blank. Copay in dollars; coinsurance
   *  already normalized to 0-100 (percent) by the caller. */
  initialCopay?: number | null;
  initialCoinsurancePercent?: number | null;
}

export function AddPlanDetailsModal({
  open,
  claimId,
  planId,
  serviceSlug,
  serviceLabel,
  getAuthToken,
  onClose,
  onSaved,
  initialCopay,
  initialCoinsurancePercent,
}: AddPlanDetailsModalProps) {
  const [shareType, setShareType] = useState<"copay" | "coinsurance">(
    initialCopay == null && initialCoinsurancePercent != null ? "coinsurance" : "copay",
  );
  const [value, setValue] = useState(
    initialCopay != null
      ? String(initialCopay)
      : initialCoinsurancePercent != null
        ? String(initialCoinsurancePercent)
        : "",
  );
  const [deductibleApplies, setDeductibleApplies] = useState<boolean | null>(null);
  const [showLimits, setShowLimits] = useState(false);
  const [deductible, setDeductible] = useState("");
  const [oop, setOop] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const hasCost = value.trim() !== "";
  const hasLimits = deductible.trim() !== "" || oop.trim() !== "";
  const canSave = hasCost || hasLimits;

  async function handleSave() {
    setError(null);

    // ── Validate synchronously BEFORE any "saving" state (so bad input never
    //    flashes a spinner) ───────────────────────────────────────────────────
    const cost = hasCost ? Number(value) : null;
    if (hasCost) {
      if (cost === null || !Number.isFinite(cost) || cost < 0) {
        setError("Enter a valid amount.");
        return;
      }
      if (shareType === "coinsurance" && cost > 100) {
        setError("Coinsurance can't be more than 100%.");
        return;
      }
    }
    const limitEntries: Array<[string, number]> = [];
    if (hasLimits) {
      if (!planId) {
        setError("This bill has no linked plan to attach limits to.");
        return;
      }
      for (const [field, raw] of [
        ["in_deductible_individual", deductible],
        ["in_oop_max_individual", oop],
      ] as const) {
        if (raw.trim() === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          setError("Enter valid plan limits.");
          return;
        }
        limitEntries.push([field, n]);
      }
    }

    setSaving(true);
    try {
      const token = await getAuthToken();
      if (!token) {
        setError("Please sign in again.");
        setSaving(false);
        return;
      }
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      // Step 1 — the service's cost-share (await: the quick, honest confirmation).
      if (hasCost && cost !== null) {
        const body: Record<string, unknown> = { field: "service_cost", serviceSlug };
        if (shareType === "copay") body.copay = cost;
        else body.coinsurancePercent = cost;
        if (deductibleApplies != null) body.deductibleApplies = deductibleApplies;
        const res = await fetch(`/api/claims/${claimId}/cost-share-override`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || `Couldn't save the cost (${res.status}).`);
          setSaving(false);
          return;
        }
      }

      // Step 2 — plan limits (optional).
      for (const [field, val] of limitEntries) {
        const res = await fetch(`/api/plan/field`, {
          method: "POST",
          headers,
          body: JSON.stringify({ planId, field, value: val }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || `Couldn't save plan limits (${res.status}).`);
          setSaving(false);
          return;
        }
      }

      // Write confirmed → show "Saved", refetch in the BACKGROUND (the slow
      // part — full claim re-fetch + cost-share recompute), then auto-close.
      setSaved(true);
      void onSaved();
      setTimeout(onClose, 750);
    } catch {
      setError("Couldn't save. Please try again.");
      setSaving(false);
    }
  }

  const busy = saving || saved;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {saved ? (
          /* ── Optimistic success state ───────────────────────────────────── */
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-green-600">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
            <div className="text-[15px] font-semibold text-gray-900">Saved</div>
            <div className="text-[13px] text-gray-500">Updating this bill…</div>
          </div>
        ) : (
          <>
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
                </svg>
              </span>
              <h2 className="text-[15px] font-semibold text-gray-900">Add plan details</h2>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-gray-500">
              We&apos;ll use this to check this bill and your other bills on this plan — saved to your account.
            </p>

            {/* ── Step 1 — service cost-share ─────────────────────────────── */}
            <div className="mt-5">
              <p className="text-sm font-medium text-gray-800">
                What does your plan charge for {serviceLabel}?
              </p>

              {/* Segmented Copay / Coinsurance */}
              <div className="mt-2.5 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                {(["copay", "coinsurance"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setShareType(t)}
                    className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
                      shareType === t
                        ? "bg-white text-blue-700 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {t === "copay" ? "Copay $" : "Coinsurance %"}
                  </button>
                ))}
              </div>

              {/* Amount input with affordant prefix */}
              <div className="mt-3 flex items-center rounded-lg border border-gray-200 bg-white pl-3 transition focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 sm:w-44">
                <span className="text-sm font-medium text-gray-400">
                  {shareType === "copay" ? "$" : "%"}
                </span>
                <input
                  type="number"
                  min={0}
                  max={shareType === "coinsurance" ? 100 : undefined}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={shareType === "copay" ? "e.g. 30" : "e.g. 20"}
                  className="w-full rounded-lg bg-transparent px-2 py-2 text-sm text-gray-900 outline-none"
                  aria-label={shareType === "copay" ? "Copay amount" : "Coinsurance percent"}
                />
              </div>

              {/* Deductible-applies segmented Yes / No */}
              <div className="mt-4">
                <p className="text-xs font-medium text-gray-600">Counts toward your deductible?</p>
                <div className="mt-1.5 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                  {([["Yes", true], ["No", false]] as const).map(([label, val]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setDeductibleApplies(val)}
                      className={`rounded-md px-4 py-1.5 text-xs font-semibold transition ${
                        deductibleApplies === val
                          ? "bg-white text-blue-700 shadow-sm"
                          : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Step 2 — plan limits (optional) ─────────────────────────── */}
            <div className="mt-5 border-t border-gray-100 pt-4">
              {!showLimits ? (
                <button
                  type="button"
                  onClick={() => setShowLimits(true)}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                >
                  + Add your plan&apos;s deductible &amp; out-of-pocket max (optional)
                </button>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-sm font-medium text-gray-800">Your plan&apos;s in-network limits</p>
                  {([["Deductible", deductible, setDeductible, "In-network individual deductible"],
                     ["Out-of-pocket max", oop, setOop, "In-network individual out-of-pocket max"]] as const).map(
                    ([label, val, setter, aria]) => (
                      <div key={label} className="flex items-center gap-3">
                        <label className="w-32 text-xs text-gray-600">{label}</label>
                        <div className="flex flex-1 items-center rounded-lg border border-gray-200 bg-white pl-3 transition focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
                          <span className="text-sm font-medium text-gray-400">$</span>
                          <input
                            type="number"
                            min={0}
                            value={val}
                            onChange={(e) => setter(e.target.value)}
                            className="w-full rounded-lg bg-transparent px-2 py-2 text-sm text-gray-900 outline-none"
                            aria-label={aria}
                          />
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>

            {error && (
              <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600">{error}</p>
            )}

            {/* ── Actions ─────────────────────────────────────────────────── */}
            <div className="mt-6 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !canSave}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

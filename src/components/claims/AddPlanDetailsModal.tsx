/**
 * AddPlanDetailsModal — Cost-Share v2 (W3 / §7b), the manual "add plan details"
 * form behind the §5 V4/insufficient banner. Progressive: Step 1 captures the
 * plan's cost-share for THIS service (the gap that made the bill uncheckable);
 * Step 2 (optional) captures the plan's in-network deductible / OOP max.
 *
 * All writes are user-scoped (Rules #4/#10): Step 1 → the cost-share-override
 * API (service_cost; the route sets covered=true + source='manual'); Step 2 →
 * the existing /api/plan/field. All writes are batched, then ONE refetch so the
 * engine recomputes live.
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
}: AddPlanDetailsModalProps) {
  const [shareType, setShareType] = useState<"copay" | "coinsurance">("copay");
  const [value, setValue] = useState("");
  const [deductibleApplies, setDeductibleApplies] = useState<boolean | null>(null);
  const [showLimits, setShowLimits] = useState(false);
  const [deductible, setDeductible] = useState("");
  const [oop, setOop] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const hasCost = value.trim() !== "";
  const hasLimits = deductible.trim() !== "" || oop.trim() !== "";
  const canSave = hasCost || hasLimits;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const token = await getAuthToken();
      if (!token) {
        setError("Please sign in again.");
        return;
      }
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      // Step 1 — the service's cost-share.
      if (hasCost) {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) {
          setError("Enter a valid amount.");
          return;
        }
        if (shareType === "coinsurance" && num > 100) {
          setError("Coinsurance can't be more than 100%.");
          return;
        }
        const body: Record<string, unknown> = { field: "service_cost", serviceSlug };
        if (shareType === "copay") body.copay = num;
        else body.coinsurancePercent = num;
        if (deductibleApplies != null) body.deductibleApplies = deductibleApplies;
        const res = await fetch(`/api/claims/${claimId}/cost-share-override`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || `Couldn't save the cost (${res.status}).`);
          return;
        }
      }

      // Step 2 — plan limits (optional).
      if (hasLimits) {
        if (!planId) {
          setError("This bill has no linked plan to attach limits to.");
          return;
        }
        const entries: Array<[string, string]> = [
          ["in_deductible_individual", deductible],
          ["in_oop_max_individual", oop],
        ];
        for (const [field, raw] of entries) {
          if (raw.trim() === "") continue;
          const num = Number(raw);
          if (!Number.isFinite(num) || num < 0) {
            setError("Enter valid plan limits.");
            return;
          }
          const res = await fetch(`/api/plan/field`, {
            method: "POST",
            headers,
            body: JSON.stringify({ planId, field, value: num }),
          });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            setError(d.error || `Couldn't save plan limits (${res.status}).`);
            return;
          }
        }
      }

      await onSaved();
      onClose();
    } catch {
      setError("Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-gray-900">Add plan details</h2>
        <p className="mt-1 text-xs text-gray-500">
          We&apos;ll use this to check this bill and your other bills on this plan. Saved to your
          account.
        </p>

        {/* Step 1 — service cost-share. */}
        <div className="mt-4">
          <p className="text-sm font-medium text-gray-800">
            What does your plan charge for {serviceLabel}?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setShareType("copay")}
              className={`rounded border px-3 py-1 text-xs font-medium ${shareType === "copay" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-600"}`}
            >
              Copay $
            </button>
            <button
              type="button"
              onClick={() => setShareType("coinsurance")}
              className={`rounded border px-3 py-1 text-xs font-medium ${shareType === "coinsurance" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-600"}`}
            >
              Coinsurance %
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-gray-500">{shareType === "copay" ? "$" : "%"}</span>
            <input
              type="number"
              min={0}
              max={shareType === "coinsurance" ? 100 : undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={shareType === "copay" ? "e.g. 30" : "e.g. 20"}
              className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
              aria-label={shareType === "copay" ? "Copay amount" : "Coinsurance percent"}
            />
          </div>
          <div className="mt-3">
            <p className="text-xs text-gray-600">Counts toward your deductible?</p>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => setDeductibleApplies(true)}
                className={`rounded border px-3 py-1 text-xs font-medium ${deductibleApplies === true ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-600"}`}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setDeductibleApplies(false)}
                className={`rounded border px-3 py-1 text-xs font-medium ${deductibleApplies === false ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-600"}`}
              >
                No
              </button>
            </div>
          </div>
        </div>

        {/* Step 2 — plan limits (optional). */}
        <div className="mt-4 border-t border-gray-100 pt-3">
          {!showLimits ? (
            <button
              type="button"
              onClick={() => setShowLimits(true)}
              className="text-xs font-medium text-blue-700 hover:text-blue-900"
            >
              + Add your plan&apos;s deductible &amp; out-of-pocket max (optional)
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-800">Your plan&apos;s in-network limits</p>
              <div className="flex items-center gap-2">
                <label className="w-28 text-xs text-gray-600">Deductible</label>
                <span className="text-sm text-gray-500">$</span>
                <input
                  type="number"
                  min={0}
                  value={deductible}
                  onChange={(e) => setDeductible(e.target.value)}
                  className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                  aria-label="In-network individual deductible"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="w-28 text-xs text-gray-600">Out-of-pocket max</label>
                <span className="text-sm text-gray-500">$</span>
                <input
                  type="number"
                  min={0}
                  value={oop}
                  onChange={(e) => setOop(e.target.value)}
                  className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                  aria-label="In-network individual out-of-pocket max"
                />
              </div>
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !canSave}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * /admin/plan-aca-overrides — S74.6 §H.5 A5 (Session 89).
 *
 * Lists insurance_plans rows where the ACA-compliance flag was INFERRED
 * (basis ∈ {inferred_marketplace, inferred_employer_post_2010, unknown}).
 * Admin can flip is_aca_compliant for an individual user's plan when the
 * user reports grandfathered status (or similar exceptions).
 *
 * Per Subplan §1: the plan-upload confirmation page UX was permanently
 * descoped, so this admin surface is the ONLY override mechanism.
 */

interface PlanRow {
  id: string;
  userId: string;
  email: string | null;
  planName: string | null;
  insurerName: string | null;
  planYear: number | null;
  isAcaCompliant: boolean | null;
  acaComplianceBasis: string | null;
  acaComplianceExcerpt: string | null;
  acaComplianceSource: string | null;
  updatedAt: string;
}

export default function PlanAcaOverridesPage() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function load() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/plan-aca-overrides", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Load failed (${res.status})`);
      }
      const { plans: p } = (await res.json()) as { plans: PlanRow[] };
      setPlans(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleOverride(plan: PlanRow, isAcaCompliant: boolean) {
    if (!user) return;
    const reason = window.prompt(
      `${isAcaCompliant ? "Mark ACA-compliant" : "Mark NOT ACA-compliant"} reason for ${plan.planName ?? plan.id} (optional, ≤500 chars):`,
      "",
    );
    if (reason === null) return;
    setActioningId(plan.id);
    setError(null);
    setSuccessMessage(null);
    try {
      const token = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/admin/plan-aca-overrides", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId: plan.id,
          isAcaCompliant,
          reason,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Override failed (${res.status})`);
      }
      setSuccessMessage(
        `${isAcaCompliant ? "Marked ACA-compliant" : "Marked NOT ACA-compliant"}: ${plan.planName ?? plan.id}`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Plan ACA-Compliance Overrides
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          S74.6 §H.5 A5 — plans where ACA-compliance was inferred (not
          explicitly attested in the document). Override the flag when a user
          reports grandfathered status or other exceptions.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {successMessage}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          Loading…
        </div>
      ) : plans.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
          No plans with inferred ACA-compliance basis.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Year</th>
                <th className="px-4 py-3 text-center">ACA?</th>
                <th className="px-4 py-3">Basis</th>
                <th className="px-4 py-3">Excerpt</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {plans.map((plan) => {
                const isActioning = actioningId === plan.id;
                return (
                  <tr key={plan.id} className="align-top hover:bg-gray-50/60">
                    <td className="px-4 py-3 text-xs">
                      <div className="font-semibold text-gray-900">
                        {plan.planName ?? "(unnamed)"}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        {plan.insurerName ?? "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <div className="text-gray-700">
                        {plan.email ?? "(no email)"}
                      </div>
                      <div className="font-mono text-[10px] text-gray-500">
                        {plan.userId.slice(0, 8)}…
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {plan.planYear ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center text-xs">
                      {plan.isAcaCompliant === true ? (
                        <span className="rounded bg-green-100 px-2 py-0.5 font-mono text-[10px] text-green-700">
                          yes
                        </span>
                      ) : plan.isAcaCompliant === false ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 font-mono text-[10px] text-red-700">
                          no
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-gray-400">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      <span className="font-mono text-[10px]">
                        {plan.acaComplianceBasis ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      <div
                        className="max-w-xs truncate"
                        title={plan.acaComplianceExcerpt ?? ""}
                      >
                        {plan.acaComplianceExcerpt
                          ? plan.acaComplianceExcerpt.slice(0, 80)
                          : "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleOverride(plan, true)}
                          disabled={isActioning || plan.isAcaCompliant === true}
                          className="rounded bg-green-600 px-3 py-1 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          Mark ACA
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOverride(plan, false)}
                          disabled={isActioning || plan.isAcaCompliant === false}
                          className="rounded border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                        >
                          Mark not ACA
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

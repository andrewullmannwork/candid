"use client";

/**
 * Shared client hook: fetch the accumulator ledger for one (plan, year) from
 * GET /api/plan/accumulators (gated `accumulator_ledger_v1`). Returns null when the
 * flag is OFF, the plan/user is missing, the request fails, or there's no ledger —
 * so every consumer degrades to "render nothing." Used by the /plan panel + the
 * dashboard mini so both read the tally identically.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import type { AccumulatorLedger } from "@/lib/claims/accumulator-ledger";

export function useAccumulatorLedger(
  insurancePlanId?: string | null,
  planYear?: number | null,
): AccumulatorLedger | null {
  const { user } = useAuth();
  const [ledger, setLedger] = useState<AccumulatorLedger | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!user || !insurancePlanId) {
        if (!cancelled) setLedger(null);
        return;
      }
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const params = new URLSearchParams({ planId: insurancePlanId });
        if (planYear) params.set("year", String(planYear));
        const res = await fetch(`/api/plan/accumulators?${params.toString()}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) {
          if (!cancelled) setLedger(null);
          return;
        }
        const data = await res.json();
        if (!cancelled) setLedger(data?.enabled ? (data.ledger ?? null) : null);
      } catch {
        if (!cancelled) setLedger(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [user, insurancePlanId, planYear]);

  return ledger;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * StrandedPlanBanner — recovery path for a parsed plan document that never
 * became active (S291).
 *
 * The onboarding doc step used to drop `insurerMismatch` on the floor, so a
 * fully-parsed `document_verified` plan could sit at `is_active=false` while
 * `/plan` rendered a weaker card-derived plan and told the user "your insurance
 * card alone doesn't reveal your specific coverage" — with no way to reach the
 * document they'd already given us. The prompt is wired now, but that only
 * covers new uploads; this covers everyone the bug already stranded.
 *
 * Deliberately a PROMPT, never an auto-switch: silently repointing someone's
 * active plan is the same class of mistake in the other direction. `/api/plan/
 * stranded` only returns a plan the user was never actually asked about, and
 * either choice here records a disambiguation, which permanently retires the
 * banner for that document.
 */

interface StrandedPlan {
  insurancePlanId: string;
  documentId: string;
  planName: string | null;
  insurerName: string | null;
  serviceCount: number;
}

export function StrandedPlanBanner({
  onActivated,
  onDashboard = false,
}: {
  onActivated?: () => void;
  /** Dashboard placement — drops the "below" that only makes sense on /plan. */
  onDashboard?: boolean;
}) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<StrandedPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/stranded", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { plan?: StrandedPlan | null };
        if (!cancelled) setPlan(data.plan ?? null);
      } catch {
        /* the banner is additive — a failed probe just means no banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const resolve = useCallback(
    async (choice: "use" | "keep") => {
      if (!user || !plan) return;
      setBusy(true);
      setFailed(false);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        // Record the answer FIRST so the banner retires even if activation then
        // fails — otherwise a persistent server error would re-nag on every load.
        await fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            documentId: plan.documentId,
            action: "record_disambiguation",
            choice: choice === "use" ? "use_this_plan" : "keep_current",
            modalType: "insurer_mismatch",
          }),
        }).catch(() => {
          /* telemetry only */
        });

        if (choice === "use") {
          const res = await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ documentId: plan.documentId, action: "activate_plan" }),
          });
          if (!res.ok) throw new Error("activate_plan failed");
          setPlan(null);
          // The whole page reads the now-stale active plan — let the parent
          // refetch rather than leaving mixed old/new data on screen.
          if (onActivated) onActivated();
          else window.location.reload();
          return;
        }
        setPlan(null);
      } catch (err) {
        console.error("[stranded-plan] resolve failed:", err);
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [user, plan, onActivated],
  );

  if (!plan) return null;

  const label =
    [plan.planName, plan.insurerName].filter(Boolean).join(" — ") || "the plan you uploaded";

  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">Use the plan you uploaded?</p>
      <p className="mt-1 text-xs leading-relaxed text-amber-800">
        We read <strong>{label}</strong>
        {plan.serviceCount > 0 ? ` — ${plan.serviceCount} covered services` : ""}. Your benefits
        {onDashboard ? "" : " below"} still come from your insurance card, which doesn’t show what
        services actually cost.
      </p>
      {failed && (
        <p className="mt-2 text-xs font-medium text-red-700">
          We couldn’t switch your plan just now. Please try again.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void resolve("use")}
          disabled={busy}
          className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:flex-none sm:px-4"
        >
          Use this plan
        </button>
        <button
          onClick={() => void resolve("keep")}
          disabled={busy}
          className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 sm:flex-none sm:px-4"
        >
          Not my plan
        </button>
      </div>
    </div>
  );
}

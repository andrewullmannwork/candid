"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * ReclaimCheckBanner — the S315 A-6 email bridge's offer surface.
 *
 * Mirrors StrandedPlanBanner's idiom exactly: an additive, fail-silent probe
 * on mount; a PROMPT, never an auto-merge (the server enforces the same —
 * verified-email match, POST only on the click). Declining is dismissal;
 * unclaimed checks age out with the anonymous-retention window.
 */

interface ReclaimableCheck {
  anonUserId: string;
  checkedAt: string;
  documents: number;
  claims: number;
}

export function ReclaimCheckBanner({ onReclaimed }: { onReclaimed?: () => void }) {
  const { user } = useAuth();
  const [checks, setChecks] = useState<ReclaimableCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!user || user.isAnonymous) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/check/reclaim", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { checks?: ReclaimableCheck[] };
        if (!cancelled) setChecks(data.checks ?? []);
      } catch {
        /* additive — a failed probe just means no banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const reclaim = useCallback(
    async (anonUserId: string) => {
      if (!user || busy) return;
      setBusy(true);
      setFailed(false);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/check/reclaim", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ anonUserId }),
        });
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setChecks((c) => c.filter((x) => x.anonUserId !== anonUserId));
        onReclaimed?.();
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [user, busy, onReclaimed],
  );

  if (!checks.length || dismissed) return null;
  const c = checks[0];
  const when = new Date(c.checkedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });

  return (
    <div className="mb-4 rounded-xl border border-blue-100 bg-gradient-to-b from-blue-50 to-white p-4">
      <p className="text-sm font-semibold text-gray-900">
        We found a bill check run with this email on {when} — restore it into your account?
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        {c.documents} document{c.documents === 1 ? "" : "s"} · {c.claims} claim{c.claims === 1 ? "" : "s"}. Restoring
        brings the bill, its findings, and any plan document into this account.
      </p>
      {failed && <p className="mt-1 text-xs text-red-600">Restore hit a snag — nothing was lost; try again.</p>}
      <div className="mt-2.5 flex gap-3">
        <button
          onClick={() => void reclaim(c.anonUserId)}
          disabled={busy}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Restoring…" : "Restore it"}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-sm font-medium text-gray-400 transition hover:text-gray-600"
        >
          No thanks
        </button>
      </div>
    </div>
  );
}

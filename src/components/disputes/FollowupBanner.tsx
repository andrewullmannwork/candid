"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { parseLetterDate } from "@/lib/disputes/letter-type";

/**
 * FollowupBanner — the standing per-CLAIM waiting pointer.
 *
 * S300 phase 2b (agenda §0.9c + §0 item 6): ONE CLAIM PER POINTER. The banner
 * is not an event, it is a state summary — one row per bill, one button to
 * that claim's rail, where every waiting card is adjacent and visible on
 * arrival. It reaches; the rail acts.
 *
 * What this replaced, and why:
 *  - It rendered ONE follow-up row at a time (`followups[activeIndex]`, an
 *    index that never advanced) with a "N pending followups" count. There was
 *    no per-claim grouping to preserve — the grouping is new, and it happens
 *    server-side (`groupFollowupsByClaim`) so nothing derives case state twice.
 *  - It carried its own outcome capture (Log response / Won / Settled / Lost /
 *    Still waiting). That was a SECOND, cruder outcome path beside the rail's
 *    modal — two writers for one fact. Removed: the rail owns outcomes.
 *  - The ✕ stays, now claim-scoped. It is the user's only way to quiet a nudge
 *    without logging an outcome, and with the action row gone it is the only
 *    escape hatch left on this surface. (The other half of that guarantee is
 *    server-side: logging ANY response re-anchors the chain — see
 *    `quietOutcomeFollowups`.)
 *
 * Deep-linking is deliberately to the rail TOP (`/claim?claim=<id>`), not to a
 * step: §0.9c gives per-step landing to EMAILS, which are per-letter events.
 * A banner row covers several letters at once, so it has no single step to
 * point at.
 */

interface ClaimFollowupGroup {
  claimId: string;
  providerName: string | null;
  letterCount: number;
  nextDeadline: string | null;
  followupIds: string[];
}

/** Rows shown before collapsing into a "+N more" pointer — a wall of banners
 *  is not a nudge. Never silent: the remainder is stated, with a way through. */
const MAX_ROWS = 3;

export function FollowupBanner({ suppressClaimId }: { suppressClaimId?: string | null } = {}) {
  const { user } = useAuth();
  const [claims, setClaims] = useState<ClaimFollowupGroup[]>([]);
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function loadFollowups() {
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/disputes/followups", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setClaims(Array.isArray(data.claims) ? data.claims : []);
        }
      } catch {
        // Silent — banner is non-critical
      }
    }
    loadFollowups();
  }, [user]);

  const dismissClaim = useCallback(
    async (group: ClaimFollowupGroup) => {
      if (submitting) return;
      setSubmitting(group.claimId);
      try {
        const token = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/disputes/followups", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ followupIds: group.followupIds, action: "dismiss" }),
        });
        if (res.ok) {
          setClaims((prev) => prev.filter((c) => c.claimId !== group.claimId));
        }
      } catch {
        // Silent
      }
      setSubmitting(null);
    },
    [submitting, user],
  );

  // On /claim the open bill's own row would be a button to where the user
  // already is — and its waiting cards are on screen. Suppress it.
  const visible = claims.filter((c) => c.claimId !== suppressClaimId);
  if (visible.length === 0) return null;

  const rows = visible.slice(0, MAX_ROWS);
  const overflow = visible.length - rows.length;

  return (
    <div className="mb-4 space-y-2">
      {rows.map((group) => (
        <FollowupRow
          key={group.claimId}
          group={group}
          disabled={submitting !== null}
          onDismiss={() => dismissClaim(group)}
        />
      ))}
      {overflow > 0 && (
        <a
          href="/claim"
          className="block px-1 text-xs font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900"
        >
          {overflow === 1
            ? "1 more bill is waiting on a response"
            : `${overflow} more bills are waiting on responses`}
        </a>
      )}
    </div>
  );
}

function FollowupRow({
  group,
  disabled,
  onDismiss,
}: {
  group: ClaimFollowupGroup;
  disabled: boolean;
  onDismiss: () => void;
}) {
  const title = group.providerName ?? "Your bill";
  const waiting =
    group.letterCount === 1
      ? "1 letter waiting on a response"
      : `${group.letterCount} letters waiting on responses`;
  // Date-only string → LOCAL midnight (the S299 one letter-date rule; calendar
  // math is client-side, never the server's timezone).
  const deadline = group.nextDeadline ? parseLetterDate(group.nextDeadline) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white">
      <div className="flex items-start gap-3 px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 ring-1 ring-amber-200">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-amber-900">{title}</p>
              <p className="mt-0.5 text-xs text-amber-800">
                {waiting}
                {deadline
                  ? ` · next deadline ${deadline.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}`
                  : ""}
              </p>
            </div>

            <button
              type="button"
              onClick={onDismiss}
              disabled={disabled}
              aria-label={`Dismiss reminders for ${title}`}
              className="shrink-0 rounded-md p-1 text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900 disabled:opacity-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <a
            href={`/claim?claim=${group.claimId}`}
            className="mt-3 inline-flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700"
          >
            Open your claim
            <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </div>
  );
}

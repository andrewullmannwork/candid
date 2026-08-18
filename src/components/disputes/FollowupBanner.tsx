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
 *
 * WHERE IT RENDERS: `/dashboard` ONLY (Andrew, S300). `/claim` already shows
 * the same state visually in its own idiom — per-bill amber on the list cards,
 * per-letter waiting cards in the rail — so a pointer row there duplicated,
 * more weakly, what the page renders natively. (It also could never have
 * rendered on the claim DETAIL view: that branch returns early, "render that
 * view only", D-§1.D.1-E.) A `suppressClaimId` prop existed briefly for the
 * open-bill case; with the claim-page mount gone it could not fire in any
 * state, so it was removed rather than left as a switch wired to nothing.
 *
 * ⚠ This is a stopgap shape. A roll-up of "what needs you" wants a real
 * needs-attention surface, not an amber strip that grows a row per claim —
 * tracker Item AA.
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

export function FollowupBanner() {
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

  const post = useCallback(
    async (group: ClaimFollowupGroup, action: "dismiss" | "acknowledge") => {
      const token = await user!.firebaseUser.getIdToken();
      return fetch("/api/disputes/followups", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ followupIds: group.followupIds, action }),
        // Survives the page unload on the acknowledge path.
        keepalive: true,
      });
    },
    [user],
  );

  const dismissClaim = useCallback(
    async (group: ClaimFollowupGroup) => {
      if (submitting) return;
      setSubmitting(group.claimId);
      try {
        const res = await post(group, "dismiss");
        if (res.ok) {
          setClaims((prev) => prev.filter((c) => c.claimId !== group.claimId));
        }
      } catch {
        // Silent
      }
      setSubmitting(null);
    },
    [submitting, post],
  );

  /**
   * "Open your claim" = ACKNOWLEDGE (Andrew, S300): the row clears so returning
   * to the dashboard doesn't re-show what you just acted on, but the check-in
   * chain advances a rung — only a logged outcome retires the ask for good.
   *
   * The write is issued BEFORE navigating, then navigation happens whether it
   * resolved or failed, with a 1s ceiling so a slow request can never trap the
   * user on the dashboard. Losing the write costs one duplicate nudge; losing
   * the navigation costs the click.
   */
  const openClaim = useCallback(
    (group: ClaimFollowupGroup, href: string) => {
      let navigated = false;
      const go = () => {
        if (navigated) return;
        navigated = true;
        window.location.assign(href);
      };
      window.setTimeout(go, 1000);
      void post(group, "acknowledge")
        .then((res) => {
          // Navigation wins either way, which means a rejected write shows NO
          // user-visible symptom — that is exactly how the S300 E2E found a
          // 400 that had been swallowed on every click. Leave a trace.
          if (!res.ok) {
            console.error("[FollowupBanner] acknowledge failed:", res.status, group.claimId);
          }
        })
        .catch((err) => {
          console.error("[FollowupBanner] acknowledge threw:", err);
        })
        .finally(go);
    },
    [post],
  );

  if (claims.length === 0) return null;

  const rows = claims.slice(0, MAX_ROWS);
  const overflow = claims.length - rows.length;

  // S319 (Andrew) — ONE claim keeps today's single banner; two or more
  // collapse into ONE amber container with a line per claim ("if there is
  // more than one banner, they collapse into one banner with multiple
  // lines"). Same grouped data, same acknowledge/dismiss handlers, same
  // real-<a> semantics — only the frame changed. Tracker Item AA's first
  // shape.
  if (claims.length === 1) {
    return (
      <div className="mb-4">
        <FollowupRow
          group={claims[0]}
          disabled={submitting !== null}
          onDismiss={() => dismissClaim(claims[0])}
          onOpen={openClaim}
        />
      </div>
    );
  }

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 ring-1 ring-amber-200">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p className="text-sm font-bold text-amber-900">
          {claims.length} bills are waiting on responses
        </p>
      </div>
      <div className="mt-2.5 divide-y divide-amber-100 border-t border-amber-100">
        {rows.map((group) => (
          <CollapsedFollowupLine
            key={group.claimId}
            group={group}
            disabled={submitting !== null}
            onDismiss={() => dismissClaim(group)}
            onOpen={openClaim}
          />
        ))}
      </div>
      {overflow > 0 && (
        <a
          href="/claim"
          className="mt-2 block text-xs font-semibold text-amber-800 underline underline-offset-2 hover:text-amber-900"
        >
          {overflow === 1
            ? "1 more bill is waiting on a response"
            : `${overflow} more bills are waiting on responses`}
        </a>
      )}
    </div>
  );
}

/** S319 — one claim's line inside the collapsed banner. Identical strings and
 *  handlers to FollowupRow (the single-claim card); only the chrome shrank. */
function CollapsedFollowupLine({
  group,
  disabled,
  onDismiss,
  onOpen,
}: {
  group: ClaimFollowupGroup;
  disabled: boolean;
  onDismiss: () => void;
  onOpen: (group: ClaimFollowupGroup, href: string) => void;
}) {
  const title = group.providerName ?? "Your bill";
  const waiting =
    group.letterCount === 1
      ? "1 letter waiting on a response"
      : `${group.letterCount} letters waiting on responses`;
  const deadline = group.nextDeadline ? parseLetterDate(group.nextDeadline) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-bold text-amber-900">{title}</span>
        <span className="ml-2 text-xs text-amber-800">
          {waiting}
          {deadline
            ? ` · next deadline ${deadline.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}`
            : ""}
        </span>
      </div>
      {/* Same real-<a> contract as the single card: modifier clicks pass
          through; a plain click acknowledges then navigates. */}
      <a
        href={`/claim?claim=${group.claimId}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(group, `/claim?claim=${group.claimId}`);
        }}
        className="shrink-0 text-xs font-bold text-amber-700 hover:text-amber-900"
      >
        Open your claim →
      </a>
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
  );
}

function FollowupRow({
  group,
  disabled,
  onDismiss,
  onOpen,
}: {
  group: ClaimFollowupGroup;
  disabled: boolean;
  onDismiss: () => void;
  onOpen: (group: ClaimFollowupGroup, href: string) => void;
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

          {/* A real <a> (middle-click / open-in-new-tab keep working); the
              acknowledge write rides the default click only. */}
          <a
            href={`/claim?claim=${group.claimId}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              onOpen(group, `/claim?claim=${group.claimId}`);
            }}
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

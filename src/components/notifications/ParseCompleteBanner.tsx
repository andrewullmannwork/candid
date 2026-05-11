"use client";

/**
 * S78 — async ingestion notification banner.
 *
 * Shows on every authed page (mounted in app layout). Polls
 * /api/documents/recent every 30s while the tab is visible to detect when
 * a large-doc parse (>30 pages, async UX path) has completed in the
 * background. When found, renders a closable banner at the top of the
 * content area; click "See results" → routes to /plan.
 *
 * Visibility rules:
 *   - localStorage `dismissed_doc_notifications` (string[] of doc IDs):
 *     once dismissed (close-click OR auto-dismiss after window expires),
 *     never show that doc again on this device.
 *   - localStorage `first_seen_doc_notifications` (Record<doc_id, ms>):
 *     timestamp of first banner render for each doc. If (now - first_seen)
 *     exceeds AUTO_DISMISS_WINDOW_MS, the doc is auto-dismissed (added to
 *     dismissed set) so it doesn't return on refresh.
 *   - Email is the persistent fallback record — banner is just an
 *     in-session nudge that fades away.
 *
 * If the feature flag (`async_ingestion_ux_v1`) is OFF, /api/documents/recent
 * returns an empty list and this component renders nothing — the polling
 * itself is harmless (one quick query per 30s).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

const POLL_INTERVAL_MS = 30_000;
const AUTO_DISMISS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DISMISSED_KEY = "dismissed_doc_notifications";
const FIRST_SEEN_KEY = "first_seen_doc_notifications";

interface RecentDoc {
  id: string;
  file_name: string;
  processing_total_pages: number | null;
  created_at: string;
}

function readDismissedSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissedSet(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage may be full or disabled (private mode). Banner just won't
    // persist dismissal across reloads in that case — acceptable degradation.
  }
}

function readFirstSeenMap(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(FIRST_SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeFirstSeenMap(map: Record<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(map));
  } catch {
    // ignore — see above
  }
}

export function ParseCompleteBanner() {
  const { user } = useAuth();
  const [eligibleDoc, setEligibleDoc] = useState<RecentDoc | null>(null);

  const fetchRecent = useCallback(async () => {
    if (!user?.firebaseUser) return;

    let token: string;
    try {
      token = await user.firebaseUser.getIdToken();
    } catch {
      return;
    }

    let docs: RecentDoc[] = [];
    try {
      const res = await fetch("/api/documents/recent", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = await res.json();
      docs = Array.isArray(json.documents) ? json.documents : [];
    } catch {
      return;
    }

    if (docs.length === 0) {
      setEligibleDoc(null);
      return;
    }

    const dismissed = readDismissedSet();
    const firstSeen = readFirstSeenMap();
    const now = Date.now();

    // Find the most-recent doc that isn't dismissed AND is still within the
    // 10-minute auto-dismiss window (or hasn't been seen yet, which we treat
    // as "still in window").
    let chosen: RecentDoc | null = null;
    for (const d of docs) {
      if (dismissed.has(d.id)) continue;

      const seenAt = firstSeen[d.id];
      if (seenAt && now - seenAt > AUTO_DISMISS_WINDOW_MS) {
        // Auto-dismiss: window expired — move to dismissed set so we stop
        // re-rendering / re-checking on subsequent polls.
        dismissed.add(d.id);
        continue;
      }

      chosen = d;
      break; // docs are ordered created_at DESC; pick the freshest non-dismissed
    }

    // Persist any auto-dismissals we just decided.
    writeDismissedSet(dismissed);

    // Record first-seen timestamp for the chosen doc (start its 10-min clock).
    if (chosen && !firstSeen[chosen.id]) {
      firstSeen[chosen.id] = now;
      writeFirstSeenMap(firstSeen);
    }

    setEligibleDoc(chosen);
  }, [user]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return; // pause when tab hidden
      await fetchRecent();
    };

    // Initial fetch immediately, then poll.
    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);

    // Re-fetch on visibility change (catches the case where the user comes
    // back to the tab after a parse completed in the background).
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        tick();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [user, fetchRecent]);

  const dismiss = useCallback(() => {
    if (!eligibleDoc) return;
    const dismissed = readDismissedSet();
    dismissed.add(eligibleDoc.id);
    writeDismissedSet(dismissed);
    setEligibleDoc(null);
  }, [eligibleDoc]);

  if (!eligibleDoc) return null;

  // file_name can be long — truncate gracefully in the banner copy.
  const displayName =
    eligibleDoc.file_name.length > 60
      ? eligibleDoc.file_name.slice(0, 57) + "…"
      : eligibleDoc.file_name;

  return (
    <div className="mb-4 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
        <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-emerald-900">
          Your upload of <span className="font-semibold">{displayName}</span> is complete.{" "}
          <Link href="/plan" className="font-semibold underline hover:no-underline">
            See results
          </Link>
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss notification"
        className="w-7 h-7 rounded-lg text-emerald-700 hover:bg-emerald-100 flex items-center justify-center shrink-0 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

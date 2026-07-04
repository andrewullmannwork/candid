"use client";

/**
 * S78 / Cost-H (S267) — async ingestion status banner (two states).
 *
 * Shows on every authed page (mounted in the app layout). Polls
 * /api/documents/recent to surface a large doc the user may have navigated
 * away from while it processes in the background:
 *   - reading → "We're still reading your {doc}…" (in-flight: queued/processing)
 *   - ready   → "Your upload of {doc} is complete. See results" (processed)
 *
 * The reading state is NOT dismissible and dismisses ITSELF: it is derived
 * purely from the latest poll, so the instant the doc's status leaves
 * queued/processing (→ processed, or errored/aged-out) the endpoint stops
 * returning it as "reading" and the banner flips to ready (or clears). Polls
 * every 10s while a reading banner is up (30s otherwise) + immediately on tab
 * re-focus, so the flip is prompt.
 *
 * The ready state is dismissible (X) and auto-dismisses 10 min after it is
 * first ACTUALLY RENDERED (not merely fetched) — the render-time first_seen
 * stamp is what prevents the S267-discovered self-destruct where the clock ran
 * down while the banner was suppressed on /upload.
 *
 * Suppressed only while the /upload page's own in-page splash/modal is active
 * for a doc (UploadFlowContext.inPageFlowActive) — so returning to an idle
 * /upload still surfaces the banner.
 *
 * If async_ingestion_ux_v1 is OFF, /api/documents/recent returns [] and this
 * renders nothing.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { useUploadFlow } from "@/lib/upload/upload-flow-context";

const POLL_INTERVAL_MS = 30_000;
const READING_POLL_MS = 10_000; // faster cadence while a reading banner is up → prompt flip to ready
const AUTO_DISMISS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (ready state only)
const DISMISSED_KEY = "dismissed_doc_notifications";
const FIRST_SEEN_KEY = "first_seen_doc_notifications";

interface RecentDoc {
  id: string;
  file_name: string;
  processing_total_pages: number | null;
  created_at: string;
  status: string;
  classified_type: string | null;
  state: "reading" | "ready";
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

// Route "See results" to the surface that owns this doc type — mirrors the
// upload page's own post-parse routing (bills → /audit, plan docs → /plan).
// Once REDIRECT drops to 15, large itemized bills reach this banner too, so a
// blanket → /plan would misroute them.
function resultsPathFor(classifiedType: string | null): string {
  if (classifiedType === "eob" || classifiedType === "itemized_bill") return "/audit";
  return "/plan";
}

export function ParseCompleteBanner() {
  const { user } = useAuth();
  const { inPageFlowActive } = useUploadFlow();
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

    // docs are created_at DESC — pick the freshest one we should show.
    let chosen: RecentDoc | null = null;
    for (const d of docs) {
      if (d.state === "reading") {
        // In-flight: always eligible, never dismissed/auto-dismissed. It clears
        // itself when the next poll no longer returns it as "reading".
        chosen = d;
        break;
      }
      // ready: honor dismissal + the 10-min post-render auto-dismiss window.
      if (dismissed.has(d.id)) continue;
      const seenAt = firstSeen[d.id];
      if (seenAt && now - seenAt > AUTO_DISMISS_WINDOW_MS) {
        dismissed.add(d.id); // window expired — stop re-checking on later polls
        continue;
      }
      chosen = d;
      break;
    }

    writeDismissedSet(dismissed);
    setEligibleDoc(chosen);
  }, [user]);

  // Suppress while the /upload page owns the in-page flow for a doc.
  const suppressed = inPageFlowActive;
  const readingActive = eligibleDoc?.state === "reading";

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return; // pause when tab hidden
      await fetchRecent();
    };

    // Immediate fetch, then poll — faster while a reading banner is showing so
    // it flips to ready promptly.
    tick();
    const timer = setInterval(tick, readingActive ? READING_POLL_MS : POLL_INTERVAL_MS);

    // Re-fetch on visibility change (catches the user coming back to the tab
    // after a parse completed in the background → prompt reading→ready flip).
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [user, fetchRecent, readingActive]);

  // Start the ready-state auto-dismiss clock only when the banner is ACTUALLY on
  // screen (ready + not suppressed) — the S267 self-destruct fix (previously the
  // clock ran while the banner was hidden on /upload, so it expired unseen).
  useEffect(() => {
    if (suppressed || !eligibleDoc || eligibleDoc.state !== "ready") return;
    const firstSeen = readFirstSeenMap();
    if (firstSeen[eligibleDoc.id]) return;
    firstSeen[eligibleDoc.id] = Date.now();
    writeFirstSeenMap(firstSeen);
  }, [eligibleDoc, suppressed]);

  const dismiss = useCallback(() => {
    if (!eligibleDoc) return;
    const dismissed = readDismissedSet();
    dismissed.add(eligibleDoc.id);
    writeDismissedSet(dismissed);
    setEligibleDoc(null);
  }, [eligibleDoc]);

  if (!eligibleDoc) return null;
  if (suppressed) return null;

  // file_name can be long — truncate gracefully in the banner copy.
  const displayName =
    eligibleDoc.file_name.length > 60
      ? eligibleDoc.file_name.slice(0, 57) + "…"
      : eligibleDoc.file_name;

  if (eligibleDoc.state === "reading") {
    return (
      <div className="mb-4 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-blue-900">
            We&rsquo;re still reading <span className="font-semibold">{displayName}</span> — we&rsquo;ll show your
            results the moment they&rsquo;re ready.
          </p>
        </div>
      </div>
    );
  }

  // ready
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
          <Link
            href={resultsPathFor(eligibleDoc.classified_type)}
            className="font-semibold underline hover:no-underline"
          >
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

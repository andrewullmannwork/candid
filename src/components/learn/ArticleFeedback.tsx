"use client";

import { useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client";

/**
 * S290 — "Was this article helpful?" thumbs at the foot of every /learn
 * article. Anonymous-first (the surface is public); when a session exists the
 * Firebase token rides along and the API stamps the verified identity.
 *
 * One vote per article per browser (localStorage). The vote itself is
 * fire-and-forget — the thank-you renders optimistically and a network
 * failure never disturbs the reader.
 *
 * Styling lives with the rest of the /learn system in globals.css
 * (.learn-feedback*) — tokens only, no ad-hoc colors.
 */

const storageKey = (slug: string) => `candid_learn_feedback_${slug}`;

export function ArticleFeedback({ slug }: { slug: string }) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Deferred (not sync-in-effect, per lint rule): hydrate the prior vote
    // from localStorage after mount; SSR renders the placeholder either way.
    const t = window.setTimeout(() => {
      try {
        const prior = window.localStorage.getItem(storageKey(slug));
        setVoted(prior === "up" || prior === "down" ? prior : null);
      } catch {
        /* private mode etc. — voting still works, just re-askable */
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, [slug]);

  const vote = (helpful: boolean) => {
    const v = helpful ? "up" : "down";
    setVoted(v);
    try {
      window.localStorage.setItem(storageKey(slug), v);
    } catch {
      /* non-fatal */
    }
    void (async () => {
      try {
        const token = await getFirebaseAuth()
          .currentUser?.getIdToken()
          .catch(() => null);
        await fetch("/api/learn/feedback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ slug, helpful }),
        });
      } catch {
        /* fire-and-forget — never disturb the reader */
      }
    })();
  };

  // Render nothing until hydration resolves the prior-vote state — avoids a
  // one-frame ask→thanks flicker for returning readers.
  if (!hydrated) return <div className="learn-feedback" aria-hidden />;

  return (
    <div className="learn-feedback" role="group" aria-label="Article feedback">
      {voted ? (
        <p className="learn-feedback-thanks">
          <span className="learn-feedback-check" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </span>
          Thanks — this helps us write better guides.
        </p>
      ) : (
        <>
          <p className="learn-feedback-q">Was this article helpful?</p>
          <div className="learn-feedback-actions">
            <button type="button" className="learn-feedback-btn" onClick={() => vote(true)} aria-label="Yes, this article was helpful">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 10v12M15 5.88L14 10h5.83a2 2 0 011.92 2.56l-2.33 8A2 2 0 0117.5 22H4a2 2 0 01-2-2v-8a2 2 0 012-2h2.76a2 2 0 001.79-1.11L12 2a3.13 3.13 0 013 3.88z" />
              </svg>
              Yes
            </button>
            <button type="button" className="learn-feedback-btn" onClick={() => vote(false)} aria-label="No, this article was not helpful">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 14V2M9 18.12L10 14H4.17a2 2 0 01-1.92-2.56l2.33-8A2 2 0 016.5 2H20a2 2 0 012 2v8a2 2 0 01-2 2h-2.76a2 2 0 00-1.79 1.11L12 22a3.13 3.13 0 01-3-3.88z" />
              </svg>
              No
            </button>
          </div>
        </>
      )}
    </div>
  );
}

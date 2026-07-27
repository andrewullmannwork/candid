"use client";

import { useEffect } from "react";
import { captureLastGuide } from "@/lib/attribution/first-touch";

/**
 * Records which guide the reader is on, so a later signup can be attributed to
 * the article that actually converted them (see captureLastGuide). Renders
 * nothing, writes one localStorage key, makes no network call — the value
 * leaves the browser only inside the existing signup POST.
 *
 * Keyed on slug so client-side navigation between guides re-records.
 */
export function LearnVisit({ slug }: { slug: string }) {
  useEffect(() => {
    captureLastGuide(slug);
  }, [slug]);
  return null;
}

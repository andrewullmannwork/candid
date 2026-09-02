"use client";
/**
 * DfyIntentBanner — the one nudge for a member who signed up to have Candid
 * handle an appeal: upload the denied bill, then press "Handle my appeal" on
 * it. Lives in the app layout so it follows them through onboarding's exit,
 * /upload and the claim page; clears itself when they dismiss it or when the
 * request is sent (ClaimDetail clears the intent).
 */
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { clearDfyIntent, hasDfyIntent, noDfyIntentOnServer, subscribeDfyIntent } from "@/lib/dfy/intent";
import { useDfyEntry } from "@/lib/dfy/use-dfy-entry";

export function DfyIntentBanner() {
  const entry = useDfyEntry();
  const show = useSyncExternalStore(subscribeDfyIntent, hasDfyIntent, noDfyIntentOnServer);
  if (!show || entry !== true) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-[13px] text-violet-900">
      <span><b>Next: upload the denied bill.</b> Then press <b>Handle my appeal</b> on it and sign the documents. We take it from there.</span>
      <Link href="/upload" className="rounded-lg bg-violet-700 px-3 py-1 text-[12px] font-semibold text-white">Upload the bill</Link>
      <button type="button" onClick={() => clearDfyIntent()} className="text-[12px] text-violet-700 underline">Not now</button>
    </div>
  );
}

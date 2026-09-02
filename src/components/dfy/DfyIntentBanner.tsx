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
    <div className="mb-5 flex flex-wrap items-center gap-4 rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-white px-5 py-4 text-[14.5px] text-gray-800 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <span className="min-w-[240px] flex-1"><b className="text-gray-900">Next: upload the denied bill.</b> Then press <b>Handle my appeal</b> on it and sign the documents. We take it from there.</span>
      <Link href="/upload" className="rounded-xl bg-blue-600 px-5 py-2.5 text-[14px] font-semibold text-white shadow-sm hover:bg-blue-700">Upload the bill</Link>
      <button type="button" onClick={() => clearDfyIntent()} className="text-[13px] font-medium text-gray-500 underline-offset-2 hover:underline">Not now</button>
    </div>
  );
}

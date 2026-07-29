"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import {
  OB_COMPLETE_THRESHOLD,
  OB_METER_COPY,
  OB_METER_ITEMS,
  obStrength,
  slotsFromProfile,
  type OnboardingProfileShape,
  type StrengthSlots,
} from "@/lib/onboarding/simplified";

/**
 * Dashboard profile-strength meter (design handoff 2026-07-17) — where
 * deferred onboarding data lands. Three states:
 *   no coverage docs → loud amber callout ("Your audits can't run yet")
 *   partial          → strength % + bar + missing-items checklist
 *   ≥ threshold      → slim emerald "Profile complete" row
 *
 * Data is fetched PER MOUNT (the v7 banner cached a flag read in module scope
 * for the whole SPA session — mid-session flips were invisible until hard
 * reload; that lesson is why nothing here caches). The FLAG gate lives in the
 * dashboard page (which also suppresses the legacy complete-profile banner
 * when the meter is on — never render both).
 */
export function ProfileMeter() {
  const { user } = useAuth();
  const router = useRouter();
  const [slots, setSlots] = useState<StrengthSlots | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/profile", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as OnboardingProfileShape;
        if (!cancelled) setSlots(slotsFromProfile(data));
      } catch {
        /* meter simply doesn't render on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!slots) return null;

  const strength = obStrength(slots);
  const noDocs = !slots.card && !slots.doc;
  // S292 — EDIT modes, never signup replay. `/onboarding?step=N` (no mode)
  // re-enters the full signup flow: a completed user clicking "Add card" was
  // walked through STEP 1 OF 3 → 2 → 3 all over again, and finishing
  // re-stamped completion. The meter lives on the dashboard — its rows are
  // deferred EDITS, so they route like every other edit entry point (S288
  // mode system: /plan "Change plan" → ?mode=plan; profile about-edits →
  // ?mode=about). Edit modes never stamp completion and exit back here.
  //   card/doc rows (steps 1-2) → ?mode=plan   (card + plan, one screen)
  //   about rows   (step 3)     → ?mode=about  (the about-you step alone)
  const go = (step?: 1 | 2 | 3) =>
    router.push(
      step === 3
        ? "/onboarding?mode=about&from=/dashboard"
        : "/onboarding?mode=plan&from=/dashboard",
    );

  /* ── No coverage docs — loud amber callout ─────────────────────────────── */
  if (noDocs) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-[20px] border border-amber-200 bg-gradient-to-b from-amber-50 to-white px-5 py-4 sm:flex-row sm:items-center">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[13px] border border-amber-200 bg-amber-50 text-amber-600">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold tracking-tight text-gray-900">
            {OB_METER_COPY.nodocsTitle}
          </p>
          <p className="mt-0.5 max-w-[64ch] text-[13px] leading-relaxed text-gray-700">
            Add your <strong>insurance card</strong> or a <strong>plan document</strong> (SBC, EOC,
            or any bill) and Candid fills in your plan, arms your audits, and starts checking every
            charge.
          </p>
          <div className="mt-2 flex items-center gap-2.5">
            <div className="h-[5px] w-full max-w-[170px] overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-amber-600"
                style={{ width: `${Math.max(4, strength)}%` }}
              />
            </div>
            <span className="text-[11.5px] font-semibold text-amber-700">
              {OB_METER_COPY.strengthLabel} {strength}%
            </span>
          </div>
        </div>
        <div className="shrink-0">
          <button
            onClick={() => go()}
            className="whitespace-nowrap rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            {OB_METER_COPY.nodocsCta} →
          </button>
        </div>
      </div>
    );
  }

  /* ── Complete — slim emerald row ───────────────────────────────────────── */
  if (strength >= OB_COMPLETE_THRESHOLD) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-[13.5px] font-semibold text-emerald-700">
        <svg className="shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.1V12a10 10 0 11-5.93-9.14" />
          <path d="M22 4L12 14l-3-3" />
        </svg>
        {OB_METER_COPY.completeRow}
        <button
          onClick={() => router.push("/profile")}
          className="ml-auto text-[12.5px] font-bold text-emerald-700 opacity-80 hover:underline"
        >
          {OB_METER_COPY.review}
        </button>
      </div>
    );
  }

  /* ── Partial — strength + checklist ────────────────────────────────────── */
  const missing = OB_METER_ITEMS.filter((it) => !slots[it.slot]).length;
  return (
    <div className="rounded-[20px] border border-gray-200 bg-white px-6 py-5">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="text-[15px] font-bold text-gray-900">{OB_METER_COPY.strengthLabel}</span>
        <span className="text-[13px] font-bold tabular-nums text-blue-600">{strength}%</span>
        <div className="h-[7px] min-w-[160px] flex-1 overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500"
            style={{ width: `${Math.max(4, strength)}%` }}
          />
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-semibold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          {missing === 1 ? "1 item left" : `${missing} items left`}
          <svg
            className={`transition-transform ${open ? "rotate-90" : ""}`}
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {OB_METER_ITEMS.map((it) => {
            const done = slots[it.slot];
            return (
              <div key={it.slot} className="flex items-center gap-2.5 py-1.5 text-[13.5px]">
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                    done ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {done ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
                  )}
                </span>
                <span className={done ? "font-medium text-gray-500" : "font-medium text-gray-700"}>
                  {it.label} <span className="text-xs text-gray-400">· {it.why}</span>
                </span>
                {!done && (
                  <button
                    onClick={() => go(it.step)}
                    className="ml-auto whitespace-nowrap text-[12.5px] font-bold text-blue-600 hover:text-blue-700 hover:underline"
                  >
                    {it.cta}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

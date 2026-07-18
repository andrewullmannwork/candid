"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import {
  OB_COPY,
  OB_STEP_NAMES,
  obDobOk,
  obDobFromIso,
  obDobToIso,
  obZipOk,
  type HouseholdId,
  type ObChip,
  type SituationId,
} from "@/lib/onboarding/simplified";
import { OnboardingCardStep, type CardSlotValue } from "./OnboardingCardStep";
import { OnboardingDocStep, type DocSlotValue } from "./OnboardingDocStep";
import { OnboardingAboutStep, type AboutState } from "./OnboardingAboutStep";

const fmtPhone = (digits: string): string =>
  /^\d{10}$/.test(digits)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : digits;

const fmtMoney = (n: unknown): string | null => {
  const v = typeof n === "number" ? n : typeof n === "string" ? parseFloat(n) : NaN;
  if (!isFinite(v)) return null;
  return `$${Math.round(v).toLocaleString()}`;
};

/**
 * Simplified onboarding — the guided 3-step flow (2026-07-17 design handoff).
 * Full-screen shell (no app sidebar), 3 segment-bar progress, every step
 * skippable, "I'll do this later →" always available. Finish AND skip both
 * stamp completion (Q4: skips count as done) and land on /dashboard, where
 * the profile meter carries whatever's missing.
 *
 * State hydrates from GET /api/profile (returning users see their done
 * states) and writes through to the same profile store the dashboard reads.
 */
export function OnboardingFlow() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const stepParam = parseInt(searchParams.get("step") || "1", 10);
  const [step, setStep] = useState<number>(isNaN(stepParam) ? 0 : Math.min(Math.max(stepParam - 1, 0), 2));
  const [hydrated, setHydrated] = useState(false);
  const [card, setCard] = useState<CardSlotValue | null>(null);
  const [doc, setDoc] = useState<DocSlotValue | null>(null);
  const [about, setAbout] = useState<AboutState>({
    household: null,
    sex: null,
    zip: "",
    dob: "",
    dobFromProfile: false,
    situations: [],
    note: "",
  });
  const [tryFin, setTryFin] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");
  const prefillFiredRef = useRef(false);

  // One consent instance for both upload surfaces — a grant in step 1 covers
  // step 2 (consent is per-type, not per-file).
  const { hasConsented, grantConsent } = useConsent("health_data_upload");

  /* ── Hydration — returning/partial users see their done states ──────────── */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/profile", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          profile?: {
            insurer?: string | null;
            member_id?: string | null;
            group_number?: string | null;
            household?: HouseholdId | null;
            situation_tags?: string[] | null;
            primary_concern?: string | null;
            zip_code?: string | null;
            date_of_birth?: string | null;
            sex?: string | null;
            phone?: string | null;
            in_deductible_individual?: unknown;
            in_oop_max_individual?: unknown;
          } | null;
          insurancePlan?: {
            in_deductible_individual?: unknown;
            in_oop_max_individual?: unknown;
          } | null;
          hasCard?: boolean;
          hasPlanOrBill?: boolean;
        };
        if (cancelled) return;
        const prof = data.profile;

        if (data.hasCard === true || prof?.member_id) {
          const chips: ObChip[] = [];
          if (prof?.insurer) chips.push({ label: "Insurer", value: prof.insurer });
          if (prof?.member_id) chips.push({ label: "Member ID", value: prof.member_id, mono: true });
          if (prof?.group_number) chips.push({ label: "Group", value: prof.group_number, mono: true });
          setCard({ chips, manual: data.hasCard !== true, fileName: null });
        }

        if (data.hasPlanOrBill === true) {
          const chips: ObChip[] = [];
          const src = data.insurancePlan ?? prof;
          const ded = fmtMoney(src?.in_deductible_individual);
          const oop = fmtMoney(src?.in_oop_max_individual);
          if (ded) chips.push({ label: "Deductible", value: ded, verified: true });
          if (oop) chips.push({ label: "OOP max", value: oop, verified: true });
          setDoc({ kind: "plan", fileName: null, chips });
        }

        // DOB source of truth: profiles.date_of_birth; else the signup ?dob=
        // param (email path threads it — YYYY-MM-DD from <input type=date>).
        const urlDob = searchParams.get("dob") || "";
        const urlPhone = searchParams.get("phone") || "";
        const profileDobDisplay = obDobFromIso(prof?.date_of_birth);
        const urlDobDisplay = obDobFromIso(urlDob);
        setAbout({
          household: (prof?.household as HouseholdId | null) ?? null,
          sex: prof?.sex ?? null,
          zip: prof?.zip_code ?? "",
          dob: profileDobDisplay || urlDobDisplay || "",
          dobFromProfile: !!(profileDobDisplay || urlDobDisplay),
          situations: (prof?.situation_tags as SituationId[] | null) ?? [],
          note: prof?.primary_concern ?? "",
        });

        // Parity with the legacy wizard's prefill effect: persist the signup
        // params if the profile doesn't have them yet (best-effort — the
        // meter re-asks if this write is lost).
        if (!prefillFiredRef.current && (urlDob || urlPhone)) {
          prefillFiredRef.current = true;
          const prefill: Record<string, string> = {};
          if (urlDob && !prof?.date_of_birth) prefill.date_of_birth = urlDob;
          if (urlPhone && !prof?.phone) prefill.phone = fmtPhone(urlPhone);
          if (Object.keys(prefill).length > 0) {
            fetch("/api/profile", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
              body: JSON.stringify(prefill),
            }).catch(() => {});
          }
        }
      } catch {
        /* empty state — flow still works, meter re-asks */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, searchParams]);

  /* ── Step-3 write-through + completion ──────────────────────────────────── */

  const saveAbout = useCallback(
    async (opts: { requireValid: boolean }) => {
      if (!user) return;
      const payload: Record<string, unknown> = {};
      if (about.household) payload.household = about.household;
      if (about.sex) payload.sex = about.sex;
      payload.situation_tags = about.situations;
      if (about.note.trim()) payload.primary_concern = about.note.trim();
      if (obZipOk(about.zip)) {
        payload.zip_code = about.zip;
        // County powers local-rate resolution; single-county ZIPs resolve
        // silently, multi-county ZIPs stay point-of-need (best-effort).
        try {
          const res = await fetch(`/api/profile/resolve-county?zip=${about.zip}`);
          const data = (await res.json().catch(() => ({}))) as {
            counties?: { fips?: string; name?: string }[];
          };
          if (data.counties?.length === 1 && data.counties[0].fips) {
            payload.county_fips = data.counties[0].fips;
            payload.county_name = data.counties[0].name ?? null;
          }
        } catch {
          /* county optional */
        }
      } else if (opts.requireValid) {
        throw new Error("invalid-zip");
      }
      const iso = obDobOk(about.dob) ? obDobToIso(about.dob) : null;
      if (iso) payload.date_of_birth = iso;
      else if (opts.requireValid) throw new Error("invalid-dob");

      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Couldn't save your answers.");
      }
    },
    [user, about],
  );

  const stampComplete = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.firebaseUser.getIdToken();
      await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
    } catch {
      /* idempotent; the profile-page redirect re-offers onboarding if lost */
    }
  }, [user]);

  /** "I'll do this later" — Q4: a skip is an answer. Save whatever's valid,
   *  stamp complete, land on the dashboard (the meter owns what's missing). */
  const handleLater = useCallback(async () => {
    try {
      await saveAbout({ requireValid: false });
    } catch {
      /* best-effort */
    }
    await stampComplete();
    router.push("/dashboard");
  }, [saveAbout, stampComplete, router]);

  const handleFinish = useCallback(async () => {
    if (!obZipOk(about.zip) || !obDobOk(about.dob)) {
      setTryFin(true);
      return;
    }
    setFinishing(true);
    setFinishError("");
    try {
      await saveAbout({ requireValid: true });
      await stampComplete();
      router.push("/dashboard");
    } catch (err) {
      setFinishing(false);
      setFinishError(
        err instanceof Error && err.message && !err.message.startsWith("invalid-")
          ? err.message
          : "Couldn't save — check your answers and try again.",
      );
    }
  }, [about, saveAbout, stampComplete, router]);

  const noDocs = !card && !doc;

  /* ── Shell ──────────────────────────────────────────────────────────────── */

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <div className="gradient-mesh flex flex-1 flex-col">
        {/* Topbar */}
        <div className="flex items-center justify-between px-6 py-5 sm:px-8">
          <div className="flex items-center gap-2.5">
            <div className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-blue-600 text-white shadow-sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </div>
            <span className="text-[15px] font-bold tracking-tight text-gray-900">Candid</span>
          </div>
          <button
            onClick={handleLater}
            className="rounded-[10px] px-2.5 py-2 text-[13px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            {OB_COPY.later} →
          </button>
        </div>

        {/* Column */}
        <div className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-20 pt-7">
          {/* Progress — 3 segment bars + STEP n OF 3 */}
          <div className="mb-7">
            <div className="mb-2.5 flex gap-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    i < step ? "bg-blue-600" : i === step ? "bg-blue-400" : "bg-gray-200"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-bold tracking-[0.12em] text-blue-600">
                STEP {step + 1} OF 3
              </span>
              <span className="text-xs text-gray-400">{OB_STEP_NAMES[step]}</span>
            </div>
          </div>

          {!hydrated ? (
            <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
          ) : (
            <>
              {step === 0 && (
                <div>
                  <div className="mb-2.5 text-[11px] font-bold tracking-[0.14em] text-blue-600">
                    {OB_COPY.eyebrow}
                  </div>
                  <h1 className="mb-2 text-[27px] font-bold leading-[1.15] tracking-tight text-gray-900">
                    {OB_COPY.s1TitleManual}
                  </h1>
                  <p className="mb-6 text-[14.5px] leading-relaxed text-gray-500">
                    {OB_COPY.s1SubManual}
                  </p>
                  <OnboardingCardStep
                    value={card}
                    onSaved={setCard}
                    onReplace={() => setCard(null)}
                    hasConsented={hasConsented}
                    grantConsent={grantConsent}
                  />
                  <div className="mt-8 flex flex-col gap-3.5">
                    {card ? (
                      <>
                        <button
                          onClick={() => setStep(1)}
                          className="w-full rounded-[14px] bg-blue-600 px-6 py-3.5 text-[15px] font-semibold text-white transition-colors [box-shadow:var(--glow-blue)] hover:bg-blue-700 hover:[box-shadow:var(--glow-blue-hover)]"
                        >
                          {OB_COPY.continueCta} →
                        </button>
                        <div className="text-center">
                          <button
                            onClick={() => setStep(1)}
                            className="rounded-[10px] px-2.5 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                          >
                            {OB_COPY.s1Skip}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        onClick={() => setStep(1)}
                        className="w-full rounded-[14px] border border-gray-200 bg-white px-6 py-3.5 text-[15px] font-medium text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
                      >
                        {OB_COPY.s1Skip} →
                      </button>
                    )}
                  </div>
                </div>
              )}

              {step === 1 && (
                <div>
                  <h1 className="mb-2 text-[27px] font-bold leading-[1.15] tracking-tight text-gray-900">
                    {OB_COPY.s2Title}
                  </h1>
                  <p className="mb-6 text-[14.5px] leading-relaxed text-gray-500">{OB_COPY.s2Sub}</p>
                  <OnboardingDocStep
                    value={doc}
                    onDone={setDoc}
                    onReplace={() => setDoc(null)}
                    hasConsented={hasConsented}
                    grantConsent={grantConsent}
                  />
                  <div className="mt-8 flex flex-col gap-3.5">
                    {doc ? (
                      <>
                        <button
                          onClick={() => setStep(2)}
                          className="w-full rounded-[14px] bg-blue-600 px-6 py-3.5 text-[15px] font-semibold text-white transition-colors [box-shadow:var(--glow-blue)] hover:bg-blue-700 hover:[box-shadow:var(--glow-blue-hover)]"
                        >
                          {OB_COPY.continueCta} →
                        </button>
                        <div className="text-center">
                          <button
                            onClick={() => setStep(2)}
                            className="rounded-[10px] px-2.5 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                          >
                            {OB_COPY.s2Skip}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        onClick={() => setStep(2)}
                        className="w-full rounded-[14px] border border-gray-200 bg-white px-6 py-3.5 text-[15px] font-medium text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
                      >
                        {OB_COPY.s2Skip} →
                      </button>
                    )}
                    <button
                      onClick={() => setStep(0)}
                      className="flex items-center gap-1.5 self-start rounded-[10px] px-2 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
                      Back
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div>
                  <h1 className="mb-2 text-[27px] font-bold leading-[1.15] tracking-tight text-gray-900">
                    {OB_COPY.s3Title}
                  </h1>
                  <p className="mb-6 text-[14.5px] leading-relaxed text-gray-500">{OB_COPY.s3Sub}</p>
                  <OnboardingAboutStep
                    value={about}
                    onChange={(patch) => setAbout((prev) => ({ ...prev, ...patch }))}
                    tryFin={tryFin}
                  />
                  <div className="mt-8 flex flex-col gap-3.5">
                    {noDocs && (
                      <div className="flex items-start gap-2.5 rounded-[14px] border border-amber-200 bg-amber-50 px-3.5 py-3 text-left text-[13px] leading-relaxed text-amber-700">
                        <svg className="mt-0.5 shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
                        </svg>
                        <span>{OB_COPY.consequence}</span>
                      </div>
                    )}
                    {finishError && (
                      <div className="rounded-xl border border-red-100 bg-red-50 p-3">
                        <p className="text-sm text-red-700">{finishError}</p>
                      </div>
                    )}
                    <button
                      onClick={handleFinish}
                      disabled={finishing}
                      className="w-full rounded-[14px] bg-blue-600 px-6 py-3.5 text-[15px] font-semibold text-white transition-colors [box-shadow:var(--glow-blue)] hover:bg-blue-700 hover:[box-shadow:var(--glow-blue-hover)] disabled:cursor-default disabled:opacity-60"
                    >
                      {finishing ? "Saving…" : `${OB_COPY.s3Cta} →`}
                    </button>
                    <button
                      onClick={() => setStep(1)}
                      className="flex items-center gap-1.5 self-start rounded-[10px] px-2 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
                      Back
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hasDfyIntent } from "@/lib/dfy/intent";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import {
  OB_COPY,
  OB_STEP_NAMES,
  chipsFromClaimSummary,
  chipsFromPlanAnalyze,
  obDobOk,
  obDobFromIso,
  obDobToIso,
  obFmtMoney,
  obZipOk,
  OB_DOC_COPY,
  type ClaimChipSource,
  type HouseholdId,
  type ObChip,
  type PlanAnalyzeChipSource,
  type RecentCoverageDoc,
  type SituationId,
} from "@/lib/onboarding/simplified";
import { getDocTypeClass, type DocType } from "@/lib/classifier/doc-type-vocabulary";
import { Banner } from "@/components/banner";
import { OnboardingCardStep, type CardSlotValue } from "./OnboardingCardStep";
import { OnboardingDocStep, type DocSlotValue } from "./OnboardingDocStep";
import { OnboardingAboutStep, type AboutState } from "./OnboardingAboutStep";

const fmtPhone = (digits: string): string =>
  /^\d{10}$/.test(digits)
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : digits;

/**
 * Simplified onboarding — the guided 3-step flow (2026-07-17 design handoff).
 * Full-screen shell (no app sidebar), 3 segment-bar progress, every step
 * skippable. "I'll do this later →" shows on steps 1 and 3 (S286 — on step 2
 * it duplicated the in-step skip; on step 3 it's the Q4 dismiss for users who
 * decline the required fields — decision ⑪, DOB-less stamped accounts).
 * Finish AND skip both stamp completion (Q4: skips count as done) and land on
 * /dashboard, where the profile meter carries whatever's missing.
 *
 * State hydrates from GET /api/profile (returning users see their done
 * states) and writes through to the same profile store the dashboard reads.
 */
export function OnboardingFlow() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // S288 mode system — ONE flow, served in scoped modes:
  //   signup (default): steps 1-2-3; finish/skip stamp onboarding_completed_at;
  //   ?mode=plan:  card + plan steps only (Dashboard "Update plan", /plan
  //                "Change plan" — every plan entry point lands here);
  //   ?mode=about: the about-you step only (profile "about" edits).
  // Edit modes NEVER stamp completion and exit to ?from= (default /dashboard).
  const modeParam = searchParams.get("mode");
  const mode: "signup" | "plan" | "about" =
    modeParam === "plan" ? "plan" : modeParam === "about" ? "about" : "signup";
  const modeSteps = mode === "plan" ? [0, 1] : mode === "about" ? [2] : [0, 1, 2];
  const fromParam = searchParams.get("from") || "/dashboard";
  const exitTo = fromParam.startsWith("/") && !fromParam.startsWith("//") ? fromParam : "/dashboard";

  const stepParam = parseInt(searchParams.get("step") || "1", 10);
  const initialStep = isNaN(stepParam) ? modeSteps[0] : Math.min(Math.max(stepParam - 1, 0), 2);
  const [step, setStep] = useState<number>(modeSteps.includes(initialStep) ? initialStep : modeSteps[0]);
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
  // S288: profile-derived search seed (plan_name > insurer) — the card slot's
  // own values win over this when the card step ran this session.
  const [profileSeed, setProfileSeed] = useState<string | null>(null);
  /* S317 — the post-plan-change card prompt. Session-scoped by design (see
     OB_COPY.cardPromptTitle): it answers an event, so it dies with the event. */
  const [cardPromptOpen, setCardPromptOpen] = useState(false);
  const cardSectionRef = useRef<HTMLDivElement | null>(null);
  // S317 (Andrew) — the insurer we already hold, threaded to the card step so a
  // visitor who has given us a plan doesn't retype it. Deliberately NOT
  // `profileSeed`: that one is `plan_name || insurer` and would drop a plan name
  // into an insurer field. Same source as the card chips below, so the two
  // renderings of "who insures you" cannot disagree. Null for a raw signup with
  // no plan, which is what makes this self-scoping — no origin detection.
  const [planInsurer, setPlanInsurer] = useState<string | null>(null);
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
            plan_name?: string | null;
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
            source?: string | null;
            plan_name?: string | null;
            insurer_name?: string | null;
          } | null;
          hasCard?: boolean;
          hasPlanOrBill?: boolean;
          recentCoverageDocs?: RecentCoverageDoc[];
          coverageDocCount?: number;
        };
        if (cancelled) return;
        const prof = data.profile;
        setProfileSeed(prof?.plan_name || prof?.insurer || null);
        setPlanInsurer(prof?.insurer || null);

        if (data.hasCard === true || prof?.member_id) {
          const chips: ObChip[] = [];
          if (prof?.insurer) chips.push({ label: "Insurer", value: prof.insurer });
          if (prof?.member_id) chips.push({ label: "Member ID", value: prof.member_id, mono: true });
          if (prof?.group_number) chips.push({ label: "Group", value: prof.group_number, mono: true });
          setCard({ chips, manual: data.hasCard !== true, fileName: null });
        }

        // S290 (Andrew E2E #12): in plan-mode the doc card renders as "YOUR
        // CURRENT PLAN" — a BILL must never occupy it (the newest-doc rule let
        // an uploaded bill visually displace the search-selected plan, even
        // though persistence was correct). Plan-mode restricts the pool to
        // plan-kind docs and falls through to the catalog_match search card
        // when only bills exist. The full signup flow keeps newest-of-any-kind:
        // its step-2 slot is genuinely "plan doc or a bill".
        const allDocs = data.recentCoverageDocs ?? [];
        const docPool =
          mode === "plan"
            ? allDocs.filter(
                (d) => getDocTypeClass((d.doc_type ?? "plan_document") as DocType) !== "bill",
              )
            : allDocs;
        if (data.hasPlanOrBill === true && (mode !== "plan" || docPool.length > 0)) {
          // S286 restore fidelity: rebuild the slot from the ACTUAL newest
          // coverage docs — real filename(s), right kind, in-flight vs parsed —
          // instead of a generic "plan" card. Chips re-fetch through the same
          // shaping the live path uses (chips pop in; hydration stays fast).
          const docs = docPool;
          const primary = docs[0];
          if (primary) {
            const extraFiles = docs.slice(1, 4).map((d) => d.file_name || "Document");
            // S316 (Andrew, approved mock B) — the extra docs render as
            // labeled rows (kind + parse state), not a faint filename list;
            // the kind label derives from the same doc_type the pool filter
            // already reads.
            const kindLabelOf = (t: string | null): string | null =>
              t === "itemized_bill" ? "Itemized bill"
              : t === "eob" ? "EOB"
              : t === "sbc" ? "SBC"
              : t === "plan_document" ? "Plan document"
              : t === "eoc" ? "Plan document"
              : null;
            const extraDocs = docs.slice(1, 4).map((d) => ({
              fileName: d.file_name || "Document",
              kindLabel: kindLabelOf(d.doc_type),
              checked: d.status === "processed",
            }));
            // In plan-mode the +N counter must not count the bills we filtered
            // out of the pool — derive from the pool alone there.
            const moreCount =
              mode === "plan"
                ? Math.max(0, docs.length - 1 - extraFiles.length)
                : Math.max(0, (data.coverageDocCount ?? docs.length) - docs.length);
            if (primary.status !== "processed") {
              setDoc({ kind: "background", fileName: primary.file_name, chips: [], extraFiles, extraDocs, moreCount });
            } else {
              const kind =
                getDocTypeClass((primary.doc_type ?? "plan_document") as DocType) === "bill" ? "bill" : "plan";
              setDoc({ kind, fileName: primary.file_name, chips: [], extraFiles, extraDocs, moreCount });
              void (async () => {
                try {
                  let chips: ObChip[] = [];
                  if (kind === "bill") {
                    const cr = await fetch(`/api/claims?documentId=${encodeURIComponent(primary.id)}&limit=1`, {
                      headers: { Authorization: `Bearer ${idToken}` },
                    });
                    const cd = (await cr.json().catch(() => ({}))) as { claims?: ClaimChipSource[] };
                    chips = chipsFromClaimSummary(cd.claims?.[0]);
                  } else {
                    const ar = await fetch("/api/plan/analyze", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                      body: JSON.stringify({}),
                    });
                    const ad = (await ar.json().catch(() => ({}))) as PlanAnalyzeChipSource;
                    chips = chipsFromPlanAnalyze(ad);
                  }
                  if (!cancelled && chips.length > 0) {
                    setDoc((prev) => (prev ? { ...prev, chips } : prev));
                  }
                } catch {
                  /* chips are decorative — the card stands without them */
                }
              })();
            }
          } else {
            // Legacy fallback (older API body without recentCoverageDocs).
            const chips: ObChip[] = [];
            const src = data.insurancePlan ?? prof;
            const ded = obFmtMoney(src?.in_deductible_individual);
            const oop = obFmtMoney(src?.in_oop_max_individual);
            if (ded) chips.push({ label: "Deductible", value: ded, verified: true });
            if (oop) chips.push({ label: "OOP max", value: oop, verified: true });
            setDoc({ kind: "plan", fileName: null, chips });
          }
        } else if (data.insurancePlan?.source === "catalog_match") {
          // S288: a search-selected plan has NO document — restore it as the
          // search done-card so re-entering the flow never looks like the
          // selection vanished (chips re-fetch like the doc-restore path).
          setDoc({
            kind: "plan",
            via: "search",
            fileName:
              [data.insurancePlan.plan_name, data.insurancePlan.insurer_name]
                .filter(Boolean)
                .join(" — ") || null,
            chips: [],
          });
          void (async () => {
            try {
              const ar = await fetch("/api/plan/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({}),
              });
              const ad = (await ar.json().catch(() => ({}))) as PlanAnalyzeChipSource;
              const chips = chipsFromPlanAnalyze(ad);
              if (!cancelled && chips.length > 0) {
                setDoc((prev) => (prev && prev.via === "search" ? { ...prev, chips } : prev));
              }
            } catch {
              /* chips are decorative */
            }
          })();
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
    // `mode` derives from searchParams but the S290 plan-mode doc-pool filter
    // reads it directly — keep it in deps for exhaustive-deps correctness.
  }, [user, searchParams, mode]);

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
   *  stamp complete, land on the dashboard (the meter owns what's missing).
   *  Edit modes (S288): this is a plain Cancel — no stamp, no writes, exit. */
  const handleLater = useCallback(async () => {
    if (mode !== "signup") {
      router.push(exitTo);
      return;
    }
    try {
      await saveAbout({ requireValid: false });
    } catch {
      /* best-effort */
    }
    await stampComplete();
    router.push(hasDfyIntent() ? "/upload" : "/dashboard");
  }, [mode, exitTo, saveAbout, stampComplete, router]);

  const handleFinish = useCallback(async () => {
    if (!obZipOk(about.zip) || !obDobOk(about.dob)) {
      setTryFin(true);
      return;
    }
    setFinishing(true);
    setFinishError("");
    try {
      await saveAbout({ requireValid: true });
      // S288: edit modes never stamp completion (an unstamped user wandering
      // into ?mode=about must not get silently marked onboarded).
      if (mode === "signup") await stampComplete();
      router.push(mode === "signup" ? (hasDfyIntent() ? "/upload" : "/dashboard") : exitTo);
    } catch (err) {
      setFinishing(false);
      setFinishError(
        err instanceof Error && err.message && !err.message.startsWith("invalid-")
          ? err.message
          : "Couldn't save — check your answers and try again.",
      );
    }
  }, [about, mode, exitTo, saveAbout, stampComplete, router]);

  const noDocs = !card && !doc;

  // S288: in plan mode the doc/search step is the LAST step — Continue/Skip exit.
  const advanceFromDoc = () => (mode === "plan" ? router.push(exitTo) : setStep(2));

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
          {/* S286: hidden on the doc step (its in-step skip covers it); kept on
              step 1 (clean full-exit) + step 3 (the Q4 dismiss — decision ⑪). */}
          {mode !== "plan" && step !== 1 && (
            <button
              onClick={handleLater}
              className="rounded-[10px] px-2.5 py-2 text-[13px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            >
              {mode === "signup" ? <>{OB_COPY.later} →</> : OB_COPY.cancel}
            </button>
          )}
        </div>

        {/* Column */}
        <div className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-20 pt-7">
          {/* Progress — segment bars + STEP n OF N (hidden in the single-screen
              plan-change mode — S288, Andrew: no step-before, just the cards). */}
          {mode !== "plan" && (
          <div className="mb-7">
            <div className="mb-2.5 flex gap-2">
              {modeSteps.map((s) => (
                <div
                  key={s}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    s < step ? "bg-blue-600" : s === step ? "bg-blue-400" : "bg-gray-200"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-bold tracking-[0.12em] text-blue-600">
                STEP {modeSteps.indexOf(step) + 1} OF {modeSteps.length}
              </span>
              <span className="text-xs text-gray-400">{OB_STEP_NAMES[step]}</span>
            </div>
          </div>
          )}

          {!hydrated ? (
            <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
          ) : mode === "plan" ? (
            /* ── Plan-change mode: ONE screen, no step-before (S288, Andrew) —
               the prominent current-plan card and the matching current-card
               card, each with its own Replace; Done/Cancel exit to origin. ── */
            <div>
              <h1 className="mb-2 text-[27px] font-bold leading-[1.15] tracking-tight text-gray-900">
                {OB_COPY.coverageModeTitle}
              </h1>
              <p className="mb-6 text-[14.5px] leading-relaxed text-gray-500">{OB_COPY.coverageModeSub}</p>
              {/* S317 (Andrew, approved) — the page does two jobs; each gets a
                  heading that states what it changes and what it doesn't. The
                  bill/EOB affordances are withheld here (plan-mode copy props):
                  a line-item audit isn't this page's job, and the shared signup
                  strings stay exactly as S289 approved them. */}
              <h2 className="mb-1 text-[16px] font-bold tracking-tight text-gray-900">
                {OB_COPY.planSectionTitle}
              </h2>
              <p className="mb-3 text-[13px] leading-relaxed text-gray-500">{OB_COPY.planSectionSub}</p>
              <OnboardingDocStep
                value={doc}
                dropTitle={OB_DOC_COPY.planModeDropTitle}
                searchSeed={card?.planName || card?.insurer || profileSeed}
                emphasizeCurrent
                onCardCleared={() => setCard(null)}
                onDone={(v) => {
                  // S317 — a plan change just landed, so the IDs on the card are
                  // now suspect. Session state, deliberately: the prompt answers
                  // an EVENT that just happened, so it retires with the event and
                  // needs no persistence, no schema, and no "remembered forever"
                  // problem. A later plan change asks again because it is a new
                  // event — which is exactly the "per plan change" behaviour.
                  setCardPromptOpen(true);
                  setDoc((prev) => {
                    if (!prev) return v;
                    const prevNames = [prev.fileName, ...(prev.extraFiles ?? [])].filter(
                      (x): x is string => !!x && x !== v.fileName,
                    );
                    return {
                      ...v,
                      extraFiles: prevNames.slice(0, 3),
                      moreCount: (prev.moreCount ?? 0) + Math.max(0, prevNames.length - 3),
                    };
                  });
                }}
                onReplace={() => setDoc(null)}
                hasConsented={hasConsented}
                grantConsent={grantConsent}
              />
              <div className="mt-8" ref={cardSectionRef}>
                <h2 className="mb-1 text-[16px] font-bold tracking-tight text-gray-900">
                  {OB_COPY.cardSectionTitle}
                </h2>
                <p className="mb-3 text-[13px] leading-relaxed text-gray-500">{OB_COPY.cardSectionSub}</p>
                {/* S317 (Andrew, approved mock) — after a plan change the card's
                    IDs are probably stale, and those IDs are what letters to the
                    insurer carry. Amber = worth your attention, never a block:
                    "Skip for now" leaves the card exactly as it was and nothing
                    is written either way. Uses the shared Banner (tone="warn"
                    already carries the amber tokens + typed primary/ghost
                    actions) rather than a bespoke amber block. */}
                {cardPromptOpen && (
                  <div className="mb-4">
                    <Banner
                      tone="warn"
                      title={OB_COPY.cardPromptTitle}
                      body={OB_COPY.cardPromptBody}
                      action={{
                        label: OB_COPY.cardPromptUpdate,
                        onClick: () => {
                          setCardPromptOpen(false);
                          cardSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                        },
                      }}
                      secondary={{
                        label: OB_COPY.cardPromptSkip,
                        variant: "ghost",
                        onClick: () => setCardPromptOpen(false),
                      }}
                    />
                  </div>
                )}
                <OnboardingCardStep
                  value={card}
                  emphasizeCurrent
                  onSaved={setCard}
                  onReplace={() => setCard(null)}
                  hasConsented={hasConsented}
                  grantConsent={grantConsent}
                  planInsurer={planInsurer}
                />
              </div>
              <div className="mt-8 flex flex-col gap-3.5">
                <button
                  onClick={() => router.push(exitTo)}
                  className="w-full rounded-[14px] bg-blue-600 px-6 py-3.5 text-[15px] font-semibold text-white transition-colors [box-shadow:var(--glow-blue)] hover:bg-blue-700 hover:[box-shadow:var(--glow-blue-hover)]"
                >
                  {OB_COPY.done} →
                </button>
                <div className="text-center">
                  <button
                    onClick={() => router.push(exitTo)}
                    className="rounded-[10px] px-2.5 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                  >
                    {OB_COPY.cancel}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {step === 0 && (
                <div>
                  {mode === "signup" && (
                    <div className="mb-2.5 text-[11px] font-bold tracking-[0.14em] text-blue-600">
                      {OB_COPY.eyebrow}
                    </div>
                  )}
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
                    planInsurer={planInsurer}
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
                  {/* S322 (Andrew) — the s2Sub subtitle is replaced by the doc
                      step's own collapsed find-guide bar. */}
                  <OnboardingDocStep
                    value={doc}
                    searchSeed={card?.planName || card?.insurer || profileSeed}
                    onCardCleared={() => setCard(null)}
                    onDone={(v) =>
                      setDoc((prev) => {
                        // S286: a fresh upload becomes the primary row; prior
                        // docs stay visible as history under it (≤3 names).
                        if (!prev) return v;
                        const prevNames = [prev.fileName, ...(prev.extraFiles ?? [])].filter(
                          (x): x is string => !!x && x !== v.fileName,
                        );
                        return {
                          ...v,
                          extraFiles: prevNames.slice(0, 3),
                          moreCount: (prev.moreCount ?? 0) + Math.max(0, prevNames.length - 3),
                        };
                      })
                    }
                    onReplace={() => setDoc(null)}
                    hasConsented={hasConsented}
                    grantConsent={grantConsent}
                  />
                  <div className="mt-8 flex flex-col gap-3.5">
                    {doc ? (
                      <>
                        <button
                          onClick={advanceFromDoc}
                          className="w-full rounded-[14px] bg-blue-600 px-6 py-3.5 text-[15px] font-semibold text-white transition-colors [box-shadow:var(--glow-blue)] hover:bg-blue-700 hover:[box-shadow:var(--glow-blue-hover)]"
                        >
                          {OB_COPY.continueCta} →
                        </button>
                        <div className="text-center">
                          <button
                            onClick={advanceFromDoc}
                            className="rounded-[10px] px-2.5 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                          >
                            {OB_COPY.s2Skip}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        onClick={advanceFromDoc}
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
                    {mode === "signup" && noDocs && (
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
                      {finishing
                        ? "Saving…"
                        : `${mode === "about" ? OB_COPY.saveChanges : OB_COPY.s3Cta} →`}
                    </button>
                    {mode !== "about" && (
                      <button
                        onClick={() => setStep(1)}
                        className="flex items-center gap-1.5 self-start rounded-[10px] px-2 py-1.5 text-[13.5px] font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
                        Back
                      </button>
                    )}
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

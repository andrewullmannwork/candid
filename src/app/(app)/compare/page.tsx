"use client";

/**
 * S70 + S70 follow-up + B3.3 — /compare page (Candid Compare).
 *
 * Unified per-slot UX: each of the (up to 3) plan slots independently supports
 * three input modes — "Use my current plan" (slot 0 only, when user has an
 * active insurance_plans row that resolves to a canonical), "Search by name",
 * and "Upload a document". Modes can be mixed across slots.
 *
 * On submit ("Compare these plans"):
 *   - Slots in "current" or "search-with-selection" mode resolve immediately
 *     to canonical PlanRef.
 *   - Slots in "upload-with-file" mode trigger sequential uploads via the
 *     existing /api/documents/upload pipeline (single Turnstile widget reused
 *     across uploads with reset between each), poll status until processed,
 *     then resolve to user_plan PlanRef via documents.linked_insurance_plan_id.
 *
 * Auth-gated by (app) layout. Additional email-verified gate inside this page
 * (Q-S70-5 carrot — verify-email CTA renders if user.emailVerified=false).
 *
 * Backend gate: /api/plan/compare returns 503 when benefits_comparison_v1 flag
 * is OFF — surface a "Coming soon" state at submit time.
 *
 * B3.3 — picker hero + plan summary cards + collapsible service-by-service
 * categories + IN/OON cells. Adopts §1.C.3 wholesale. ShareWithFriend
 * compare_picker placement un-gated (drops the S124 `share_with_friend_new_surfaces_v1`
 * 406 path; matches S125 B3.1 /dashboard pattern). CF-31 debug logs stripped
 * (flow stable since S72). Auth gates / Turnstile / consent / UnifiedParseScreen
 * / Mig 078 purpose=comparison / browser-back popstate / 503+403 error handling
 * / S107 canonical_plans search source / CF-31 prefer-user_plan ref all PRESERVED
 * verbatim per §R.1 + S70/S107/Mig 078 NON-NEGOTIABLE preservation list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "@/components/security/TurnstileWidget";
import { useConsent } from "@/lib/consent/use-consent";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { uploadDocumentFile } from "@/lib/upload/client-upload";
import {
  PlanSlot,
  type SlotState,
  type CurrentPlanSummary,
} from "@/components/compare/PlanSlot";
import {
  UnifiedParseScreen,
  type ParseDoc,
} from "@/components/parsing/UnifiedParseScreen";
import type { ComparePlanPayload, PlanRef } from "@/lib/plan/compare";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { CompareTopbar } from "@/components/compare/CompareTopbar";
import { PlanSummaryCards } from "@/components/compare/PlanSummaryCards";
import { NumbersTable } from "@/components/compare/NumbersTable";
import { BreadthTable } from "@/components/compare/BreadthTable";
import { ServiceCategoryAccordions } from "@/components/compare/ServiceCategoryAccordions";
import { ResultsViewV2 } from "@/components/compare/v2/ResultsViewV2";
import { BuildViewV2 } from "@/components/compare/v2/BuildViewV2";
import { CompareSessionsBar } from "@/components/compare/v2/CompareSessionsBar";
import {
  loadSessions,
  saveSession,
  loadRecents,
  pushRecent,
  type CompareSession,
} from "@/components/compare/compare-sessions";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { useMinHoldLoading } from "@/lib/loading/use-min-hold";

type Mode = "build" | "parsing" | "results";

type EditableField =
  | "premium_monthly"
  | "in_deductible_individual"
  | "out_deductible_individual"
  | "in_oop_max_individual"
  | "out_oop_max_individual";

// ── Page ─────────────────────────────────────────────────────────────────

export default function ComparePage() {
  const { user, loading: authLoading } = useAuth();
  const showCubeLoader = useMinHoldLoading(authLoading);

  if (showCubeLoader) {
    return (
      <PageShell>
        <LoadingState />
      </PageShell>
    );
  }

  if (!user) {
    return (
      <PageShell>
        <SignedOutState />
      </PageShell>
    );
  }

  if (!user.emailVerified) {
    return (
      <PageShell>
        <EmailVerifyCarrot />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <CompareInterface />
    </PageShell>
  );
}

// ── Shells & gates ──────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-blue-50/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 sm:py-14">{children}</div>
    </div>
  );
}

function LoadingState() {
  return <CubeLoaderBuilding />;
}

function SignedOutState() {
  return (
    <div className="text-center py-20">
      <h1 className="text-3xl font-semibold text-slate-900">Sign in to use Candid Compare</h1>
      <p className="text-sm text-slate-600 mt-3">
        Compare up to 3 plans side-by-side once you&rsquo;re signed in.
      </p>
      <Link
        href="/auth/signin"
        className="inline-block mt-6 px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
      >
        Sign in
      </Link>
    </div>
  );
}

function EmailVerifyCarrot() {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleResend() {
    if (!user) return;
    setSending(true);
    setError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) setSent(true);
      else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Couldn't send the verification email. Try again in a moment.");
      }
    } catch {
      setError("Couldn't send the verification email. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-12 sm:py-16">
      <div className="bg-white rounded-3xl shadow-xl shadow-blue-100/40 ring-1 ring-slate-200/60 p-8 sm:p-10 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 mb-6 shadow-lg shadow-blue-200">
          <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">Verify your email to unlock Candid Compare</h1>
        <p className="text-sm text-slate-600 mt-3 leading-relaxed">
          We&rsquo;ll only enable side-by-side plan comparison for verified accounts so the cross-user data we
          surface stays trustworthy. One quick click in your inbox is all it takes.
        </p>
        <div className="mt-8">
          {sent ? (
            <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-200 px-4 py-3">
              <p className="text-sm font-medium text-emerald-800">
                Sent! Check <span className="font-semibold">{user?.email}</span> (and spam).
              </p>
            </div>
          ) : (
            <button
              onClick={handleResend}
              disabled={sending}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-semibold shadow-md shadow-blue-200 hover:shadow-lg disabled:opacity-60"
            >
              {sending ? "Sending…" : "Send verification email"}
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          {error && <p className="text-sm text-rose-600 mt-3">{error}</p>}
        </div>
        <p className="text-xs text-slate-500 mt-8 leading-relaxed">
          Already verified? Refresh this page after clicking the link in your email.
        </p>
      </div>
    </div>
  );
}

// ── Main interactive surface ─────────────────────────────────────────────

function CompareInterface() {
  const { user } = useAuth();
  const [mode, setMode] = useState<Mode>("build");
  const [slots, setSlots] = useState<SlotState[]>([
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
  ]);
  const [currentPlan, setCurrentPlan] = useState<CurrentPlanSummary | null>(null);
  const [results, setResults] = useState<ComparePlanPayload[] | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);

  // Compare v2 redesign rollout gate (S157). Read the flag from the server
  // endpoint (NOT a browser-Supabase query): Candid authenticates via Firebase,
  // which is invisible to Supabase RLS, so a client-side `feature_flag_rules`
  // read always runs as anon and RLS returns []  — i.e. it can never see an
  // enabled flag. /api/feature-flags/[flagKey] resolves it server-side via
  // isFeatureEnabled. Mirrors the profile-dashboard flag-read pattern. Falls
  // back to OFF on any non-200 / error → existing results view renders
  // byte-identical (graceful degradation, compare_v2_redesign.md §4.4).
  const [v2On, setV2On] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/feature-flags/compare_v2_redesign")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => {
        if (!cancelled) setV2On(d?.enabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Compare v2 (PR5) — localStorage sessions ("Pick up where you left off") +
  // single-plan recents. Loaded post-mount (SSR-safe; never reads storage on the
  // server so hydration can't mismatch).
  const [sessions, setSessions] = useState<CompareSession[]>([]);
  const [recents, setRecents] = useState<ReturnType<typeof loadRecents>>([]);
  useEffect(() => {
    setSessions(loadSessions());
    setRecents(loadRecents());
  }, []);

  // Parsing-screen state for upload slots.
  const [parseDocs, setParseDocs] = useState<ParseDoc[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  // Consent + Turnstile state (only used when at least one slot is upload).
  const { hasConsented, grantConsent } = useConsent("health_data_upload");
  const consentDoc = getConsentDocument("health_data_upload");
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  // Compare v2 (PR6) — results-editor upload-swap state. An editor upload reuses
  // the SAME parse pipeline as the build path (uploadOne + pollOne + the stackV3
  // UnifiedParseScreen). These track (a) an in-flight results-mode upload so the
  // persistent Turnstile widget mounts outside build mode, and (b) the consent
  // gate for a user who reached results without ever uploading (never consented).
  const [editorUploadActive, setEditorUploadActive] = useState(false);
  const [pendingEditorUpload, setPendingEditorUpload] = useState<{
    action: "replace" | "add";
    columnIndex: number | null;
    file: File;
  } | null>(null);
  const [editorConsentChecked, setEditorConsentChecked] = useState(false);

  useEffect(() => {
    turnstileTokenRef.current = turnstileToken;
  }, [turnstileToken]);

  // Session 72: Browser-back history handling. The build → parsing → results
  // transitions all happen inside this single component on the same URL, so the
  // browser's history stack doesn't naturally track them — clicking Back would
  // jump straight to whatever page preceded /compare (typically /dashboard).
  // Push a sentinel history entry whenever we leave "build" so the user's Back
  // returns them to the slot picker instead of leaving /compare entirely.
  useEffect(() => {
    if (mode === "build") return;
    window.history.pushState({ candidCompareMode: mode }, "");
    const handler = () => {
      // Back from results/parsing → reset slots to build view (no page nav).
      setMode("build");
      setResults(null);
      setResultsError(null);
      setParseDocs([]);
      setParseError(null);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [mode]);

  // ── Load user's active plan via /api/plan/current ──────────────────────
  // Server-side endpoint (bypasses RLS). The previous browser-Supabase-client
  // chain 406'd because Firebase auth isn't visible to RLS policies that gate
  // on auth.uid(). Now: single Bearer-token GET.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/current", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) return;
        if (cancelled) return;
        const body = (await res.json()) as { plan: CurrentPlanSummary | null };
        if (cancelled) return;
        if (body.plan) setCurrentPlan(body.plan);
      } catch {
        // Silent failure — affordance just won't render when fetch fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // ── Slot helpers ──────────────────────────────────────────────────────
  const setSlot = useCallback(
    (idx: number, next: SlotState) => {
      setSlots((prev) => {
        const arr = [...prev];
        arr[idx] = next;
        return arr;
      });
    },
    [],
  );

  const filledCount = slots.filter((s) => isResolved(s)).length;
  const hasUploadSlot = slots.some((s) => s.kind === "upload" && s.file);
  const canSubmit = filledCount >= 2;

  // ── Submit flow ──────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!user || !canSubmit) return;
    setResultsError(null);
    setParseError(null);

    // Branch on consent if any upload slot is present.
    if (hasUploadSlot && !hasConsented && !consentChecked) {
      setShowConsent(true);
      return;
    }
    if (hasUploadSlot && !hasConsented) {
      setConsentSubmitting(true);
      try {
        await grantConsent();
      } catch {
        setResultsError("Couldn't record your consent. Try again.");
        setConsentSubmitting(false);
        return;
      }
      setConsentSubmitting(false);
    }

    setShowConsent(false);

    // Build the planRefs list, processing uploads inline.
    const refs: PlanRef[] = [];
    const uploadIndexes: number[] = [];
    slots.forEach((s, i) => {
      if (s.kind === "upload" && s.file) uploadIndexes.push(i);
    });

    if (uploadIndexes.length > 0) {
      // Compare v2 (S160): flag ON shows ONE aggregate stackV3 doc (summed page
      // count); flag OFF keeps the byte-identical legacy per-doc loader. Each
      // returns a slot→insurance_plan_id map, or null after surfacing an error
      // (UI already reset to the build view).
      const uploadResults = v2On
        ? await runBuildUploadsV2(uploadIndexes)
        : await runBuildUploadsLegacy(uploadIndexes);
      if (!uploadResults) return;

      // Build refs in slot order, mixing canonical + user_plan kinds.
      // S107: search results' `canonicalPlanId` mirrors `id` (search source is
      // canonical_plans). The else-branch console.warn below catches a future
      // silent regression (e.g., schema drift or partial canonical promotion)
      // before it drops a slot below the 2-plan threshold and surfaces as a
      // generic error.
      const finalRefs: PlanRef[] = [];
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s.kind === "current") {
          // CF-31 follow-up (Session 72): prefer the user_plan ref so the user's
          // own SBC-parsed values show up (deductible / OOP / premium / etc.).
          // The previous "prefer canonical" rule meant any canonical with sparse
          // cross-user data wiped out the user's actual plan numbers ("—").
          // resolveUserPlan inherits canonical fields via field_provenance when
          // they're richer, so canonical data still bubbles up where useful.
          finalRefs.push({ kind: "user_plan", id: s.plan.insurancePlanId });
        } else if (s.kind === "search" && s.selected) {
          if (s.selected.canonicalPlanId) {
            finalRefs.push({ kind: "canonical", id: s.selected.canonicalPlanId });
          } else {
            console.warn(
              "[compare] search slot missing canonicalPlanId — should be unreachable post-S107",
              s.selected,
            );
          }
        } else if (s.kind === "upload" && s.file) {
          const ipid = uploadResults.get(i);
          if (ipid) finalRefs.push({ kind: "user_plan", id: ipid });
        }
      }
      await callCompareApi(finalRefs);
    } else {
      // No uploads — refs resolve immediately.
      slots.forEach((s) => {
        if (s.kind === "current") {
          // CF-31 follow-up: prefer user_plan so the user's own SBC-parsed
          // values render (canonical with sparse cross-user data wiped them
          // to "—" / "Estimated"). Mirrors the upload-branch fix above.
          refs.push({ kind: "user_plan", id: s.plan.insurancePlanId });
        } else if (s.kind === "search" && s.selected) {
          if (s.selected.canonicalPlanId) {
            refs.push({ kind: "canonical", id: s.selected.canonicalPlanId });
          } else {
            console.warn(
              "[compare] search slot missing canonicalPlanId — should be unreachable post-S107",
              s.selected,
            );
          }
        }
      });
      await callCompareApi(refs);
    }
  }

  // Compare v2 (S160) — the upload pipeline split into two reusable passes so the
  // build path can collect all page counts up front (a stable aggregate total)
  // and the results-editor swap can reuse the exact same upload + poll logic.
  //
  // uploadOne: POST the file (mig 078 purpose="comparison", never overwrites the
  // primary plan) and return its documentId + the classifier's original page
  // count. Turnstile: reset + wait for a fresh token between uploads; for a first
  // upload, wait if no token is present yet (the results-editor mounts the widget
  // on demand, so a token may not have been issued at call time).
  async function uploadOne(opts: {
    file: File;
    isFirst: boolean;
  }): Promise<{ documentId: string; pageCount: number | null } | null> {
    if (!user) return null;
    const { file, isFirst } = opts;

    if (!isFirst) {
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      turnstileTokenRef.current = null;
    }
    if (!turnstileTokenRef.current) {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (turnstileTokenRef.current) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    try {
      const idToken = await user.firebaseUser.getIdToken();
      const tok = turnstileTokenRef.current;

      // S322 — shared client helper (legacy body-POST or direct-to-storage
      // past the Vercel body cap). Mig 078 — comparison uploads must never
      // overwrite the user's primary plan (they live in insurance_plans for
      // the canonical-corroboration flywheel but stay is_active=false;
      // profile.active_insurance_plan_id is left untouched).
      const uploadRes = await uploadDocumentFile({
        file,
        docType: "sbc",
        purpose: "comparison",
        idToken,
        turnstileToken: tok ?? undefined,
      });
      if (!uploadRes.ok) return null;
      const uploadBody = (await uploadRes.json()) as {
        documentId?: string;
        classification?: { pageCount?: number };
      };
      if (!uploadBody.documentId) return null;
      return {
        documentId: uploadBody.documentId,
        pageCount: uploadBody.classification?.pageCount ?? null,
      };
    } catch {
      return null;
    }
  }

  // pollOne: poll /api/documents/status until the doc is processed (server-side,
  // bypasses RLS — replaces a browser Supabase query that 406'd on the user's own
  // fresh documents row). Fires needsTrigger when the backend asks, surfaces each
  // poll to onPoll (the caller maps it onto the aggregate ParseDoc), and returns
  // the linked insurance_plan_id on success or null on error/stuck.
  async function pollOne(
    documentId: string,
    onPoll: (statusBody: {
      status?: string;
      isStuck?: boolean;
      totalPages?: number;
      step?: string | null;
      completedPages?: number;
    }) => void,
  ): Promise<string | null> {
    try {
      while (true) {
        await new Promise((r) => setTimeout(r, 4000));
        const statusRes = await fetch(`/api/documents/status?id=${documentId}`);
        if (!statusRes.ok) continue;
        const statusBody = await statusRes.json();
        if (statusBody.needsTrigger) {
          await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId }),
          });
        }
        onPoll(statusBody);
        if (statusBody.status === "processed") {
          return (statusBody.linkedInsurancePlanId as string | null) ?? null;
        }
        if (statusBody.status === "error" || statusBody.isStuck) return null;
      }
    } catch {
      return null;
    }
  }

  // Compare v2 (S160) — flag-ON build-path loader: present every uploaded file as
  // ONE aggregate stackV3 "document" (page count = SUM of each file's original
  // classify-time count). The loader is pure frontend chrome — nothing binds it
  // 1:1 to a backend document. PASS 1 uploads + classifies all (so the combined
  // total is stable BEFORE the synthetic counter starts — a growing total would
  // reset it to 0); PASS 2 polls each to completion. The backend parses each
  // upload as its own document (unchanged). Returns slot→insurance_plan_id, or
  // null after surfacing an error (UI reset to build).
  async function runBuildUploadsV2(uploadIndexes: number[]): Promise<Map<number, string> | null> {
    setMode("parsing");
    const aggId = "compare-upload";
    const firstSlot = slots[uploadIndexes[0]];
    const firstName =
      firstSlot.kind === "upload" && firstSlot.file ? firstSlot.file.name : "Document";
    setParseDocs([
      {
        id: aggId,
        label:
          uploadIndexes.length === 1
            ? "Your plan document"
            : `Your ${uploadIndexes.length} plan documents`,
        fileName: uploadIndexes.length === 1 ? firstName : `${uploadIndexes.length} documents`,
        phase: "uploading",
        uploadProgress: 5,
        totalPages: null,
        step: null,
        realCompletedPages: null,
      },
    ]);

    const failAggregate = () => {
      setParseDocs((prev) =>
        prev.map((d) =>
          d.id === aggId
            ? { ...d, phase: "error", errorMessage: "Couldn't process this document." }
            : d,
        ),
      );
      setParseError("One or more documents couldn't be processed. Switch them to search instead.");
      setMode("build");
    };

    // PASS 1 — upload + classify all (fresh Turnstile token reset between each).
    const uploaded: { idx: number; documentId: string; pageCount: number | null }[] = [];
    for (let n = 0; n < uploadIndexes.length; n++) {
      const idx = uploadIndexes[n];
      const slot = slots[idx];
      if (slot.kind !== "upload" || !slot.file) continue;
      const res = await uploadOne({ file: slot.file, isFirst: n === 0 });
      if (!res) {
        failAggregate();
        return null;
      }
      uploaded.push({ idx, documentId: res.documentId, pageCount: res.pageCount });
      setParseDocs((prev) =>
        prev.map((d) =>
          d.id === aggId
            ? { ...d, uploadProgress: Math.round(((n + 1) / uploadIndexes.length) * 100) }
            : d,
        ),
      );
    }

    // Stable combined total = sum of each file's original page count.
    const summedPages = uploaded.reduce((s, u) => s + (u.pageCount ?? 0), 0);
    const aggTotal = summedPages > 0 ? summedPages : null;
    setParseDocs((prev) =>
      prev.map((d) =>
        d.id === aggId ? { ...d, phase: "parsing", uploadProgress: 100, totalPages: aggTotal } : d,
      ),
    );

    // PASS 2 — poll each to completion; drive the aggregate's progress
    // cumulatively (completedBase carries the pages of already-finished docs).
    const isSingleUpload = uploaded.length === 1;
    const uploadResults = new Map<number, string>();
    let completedBase = 0;
    for (const u of uploaded) {
      const planId = await pollOne(u.documentId, (statusBody) => {
        setParseDocs((prev) =>
          prev.map((d) => {
            if (d.id !== aggId) return d;
            // Single-doc: refine totalPages from the backend if it arrives
            // (legacy seed-preserve). Multi-doc: keep the summed total stable —
            // changing it would reset the synthetic page counter to 0.
            const backendPages =
              typeof statusBody.totalPages === "number" && statusBody.totalPages > 0
                ? statusBody.totalPages
                : null;
            const nextTotal = isSingleUpload ? backendPages ?? d.totalPages : d.totalPages;
            const docCompleted =
              typeof statusBody.completedPages === "number" ? statusBody.completedPages : 0;
            return {
              ...d,
              phase: "parsing",
              totalPages: nextTotal,
              step: statusBody.step ?? null,
              realCompletedPages: completedBase + docCompleted,
            };
          }),
        );
      });
      if (!planId) {
        failAggregate();
        return null;
      }
      uploadResults.set(u.idx, planId);
      completedBase += u.pageCount ?? 0;
    }

    // Snap the synthetic counter to done before the comparison loads.
    setParseDocs((prev) => prev.map((d) => (d.id === aggId ? { ...d, phase: "complete" } : d)));
    return uploadResults;
  }

  // Compare v2 (S160) — flag-OFF build-path loader: the byte-identical pre-S160
  // multi-doc-card behavior on the deprecated loader variant. One ParseDoc per
  // upload slot, processed sequentially (queued → uploading → complete). Returns
  // slot→insurance_plan_id, or null after surfacing an error (UI reset to build).
  async function runBuildUploadsLegacy(
    uploadIndexes: number[],
  ): Promise<Map<number, string> | null> {
    setMode("parsing");
    const initial: ParseDoc[] = uploadIndexes.map((i, n) => {
      const slot = slots[i];
      const file = slot.kind === "upload" && slot.file ? slot.file : null;
      return {
        id: `slot-${i}`,
        label: `Plan ${String.fromCharCode(65 + i)}`,
        fileName: file?.name ?? "Unknown",
        phase: n === 0 ? "uploading" : "queued",
        uploadProgress: n === 0 ? 5 : 0,
        totalPages: null,
        step: null,
        realCompletedPages: null,
      };
    });
    setParseDocs(initial);

    const uploadResults = new Map<number, string>();
    for (let n = 0; n < uploadIndexes.length; n++) {
      const idx = uploadIndexes[n];
      const slot = slots[idx];
      if (slot.kind !== "upload" || !slot.file) continue;
      const insurancePlanId = await processOneUpload({
        file: slot.file,
        docId: `slot-${idx}`,
        isFirst: n === 0,
      });
      if (insurancePlanId) {
        uploadResults.set(idx, insurancePlanId);
        setParseDocs((prev) => {
          const arr = [...prev];
          const myEntry = arr.findIndex((d) => d.id === `slot-${idx}`);
          if (myEntry >= 0) arr[myEntry] = { ...arr[myEntry], phase: "complete", uploadProgress: 100 };
          const nextQueued = arr.findIndex((d) => d.phase === "queued");
          if (nextQueued >= 0) {
            arr[nextQueued] = { ...arr[nextQueued], phase: "uploading", uploadProgress: 5 };
          }
          return arr;
        });
      } else {
        setParseDocs((prev) => {
          const arr = [...prev];
          const myEntry = arr.findIndex((d) => d.id === `slot-${idx}`);
          if (myEntry >= 0) {
            arr[myEntry] = {
              ...arr[myEntry],
              phase: "error",
              errorMessage: "Couldn't process this document.",
            };
          }
          return arr;
        });
        setParseError("One or more documents couldn't be processed. Switch them to search instead.");
        setMode("build");
        return null;
      }
    }
    return uploadResults;
  }

  // Legacy per-doc upload (flag-OFF path). Wraps uploadOne + pollOne to reproduce
  // the pre-S160 per-card behavior: seed this doc's totalPages from the classifier,
  // then update its card on each poll.
  async function processOneUpload(opts: {
    file: File;
    docId: string;
    isFirst: boolean;
  }): Promise<string | null> {
    const up = await uploadOne({ file: opts.file, isFirst: opts.isFirst });
    if (!up) return null;
    setParseDocs((prev) =>
      prev.map((d) => {
        if (d.id !== opts.docId) return d;
        const seeded = up.pageCount && up.pageCount > 0 ? up.pageCount : d.totalPages;
        return {
          ...d,
          phase: seeded && seeded > 0 ? "parsing" : "uploading",
          uploadProgress: 100,
          totalPages: seeded,
        };
      }),
    );
    return pollOne(up.documentId, (statusBody) => {
      setParseDocs((prev) =>
        prev.map((d) => {
          if (d.id !== opts.docId) return d;
          const backendPages =
            typeof statusBody.totalPages === "number" && statusBody.totalPages > 0
              ? statusBody.totalPages
              : null;
          const nextTotalPages = backendPages ?? d.totalPages;
          const terminal: ParseDoc["phase"] | null =
            statusBody.status === "processed"
              ? "complete"
              : statusBody.status === "error" || statusBody.isStuck
                ? "error"
                : null;
          const nextPhase: ParseDoc["phase"] =
            terminal ?? (nextTotalPages && nextTotalPages > 0 ? "parsing" : "uploading");
          return {
            ...d,
            phase: nextPhase,
            totalPages: nextTotalPages,
            step: statusBody.step ?? null,
            realCompletedPages:
              typeof statusBody.completedPages === "number" ? statusBody.completedPages : null,
          };
        }),
      );
    });
  }

  async function callCompareApi(planRefs: PlanRef[]) {
    if (!user || planRefs.length < 2) {
      setResultsError("Need at least 2 plans to compare.");
      setMode("results");
      return;
    }
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/compare", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ planRefs }),
      });
      if (res.status === 503) {
        setResultsError("Candid Compare isn't available yet. We're rolling it out — check back shortly.");
        setMode("results");
        return;
      }
      if (res.status === 403) {
        setResultsError("Verify your email to unlock Candid Compare.");
        setMode("results");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResultsError(body.error ?? "Couldn't load the comparison. Try again in a moment.");
        setMode("results");
        return;
      }
      const data = (await res.json()) as { plans: ComparePlanPayload[] };
      const resolved = data.plans.filter((p) => "planSummary" in p) as ComparePlanPayload[];
      setResults(resolved);
      setMode("results");
      // PR5 — persist the comparison + canonical recents for "pick up where you
      // left off". Only canonical refs become recents (clean re-resolution; an
      // own/uploaded plan has no re-pickable search identity).
      if (resolved.length >= 2) {
        setSessions(
          saveSession(resolved.map((p) => ({ ref: p.ref, name: p.planName, sub: planLabelSub(p) }))),
        );
        resolved.forEach((p) => {
          if (p.ref.kind === "canonical") {
            pushRecent({ ref: p.ref, name: p.planName, sub: planLabelSub(p) });
          }
        });
        setRecents(loadRecents());
      }
    } catch {
      setResultsError("Couldn't load the comparison. Try again in a moment.");
      setMode("results");
    }
  }

  function startOver() {
    setMode("build");
    setSlots([{ kind: "empty" }, { kind: "empty" }, { kind: "empty" }]);
    setResults(null);
    setResultsError(null);
    setParseDocs([]);
    setParseError(null);
  }

  // ── PR5 sessions + results-editor (ref-space) ──────────────────────────
  // Restore a saved comparison: re-resolve the stored refs straight to results.
  const resumeSession = (session: CompareSession) => {
    void callCompareApi(session.plans.map((p) => p.ref));
  };

  // Resolve a non-upload picked SlotState to a PlanRef. Search/current resolve
  // immediately; an upload slot is intercepted earlier (requestEditorUpload) and
  // never reaches here, so this returns null for it (defensive).
  const slotToRef = (slot: SlotState): PlanRef | null => {
    if (slot.kind === "current") return { kind: "user_plan", id: slot.plan.insurancePlanId };
    if (slot.kind === "search" && slot.selected) {
      const id = slot.selected.canonicalPlanId ?? slot.selected.id;
      return id ? { kind: "canonical", id } : null;
    }
    return null;
  };
  const currentRefs = (): PlanRef[] => (results ?? []).map((p) => p.ref);

  // Compare v2 (S160) — results-editor upload-swap. Reuses the SAME parse pipeline
  // as the build path (uploadOne + pollOne + the stackV3 UnifiedParseScreen): the
  // editor upload switches to the parsing screen, parses the one file, then
  // replaces/adds that results column and re-runs the comparison. Backend
  // unchanged. doEditorUpload assumes consent is granted; requestEditorUpload gates.
  async function doEditorUpload(action: "replace" | "add", columnIndex: number | null, file: File) {
    if (!user) return;
    const baseRefs = currentRefs();
    if (
      action === "replace" &&
      (columnIndex == null || columnIndex < 0 || columnIndex >= baseRefs.length)
    )
      return;
    if (action === "add" && baseRefs.length >= 3) return;

    setResultsError(null);
    setParseError(null);
    setEditorUploadActive(true); // mounts the persistent Turnstile widget in results mode
    // Force a fresh token from the freshly-mounted widget (avoid reusing a stale one).
    turnstileRef.current?.reset();
    setTurnstileToken(null);
    turnstileTokenRef.current = null;
    setMode("parsing");
    const aggId = "editor-upload";
    setParseDocs([
      {
        id: aggId,
        label: action === "add" ? "Adding a plan" : "Swapping a plan",
        fileName: file.name,
        phase: "uploading",
        uploadProgress: 5,
        totalPages: null,
        step: null,
        realCompletedPages: null,
      },
    ]);

    const up = await uploadOne({ file, isFirst: true });
    if (!up) {
      setEditorUploadActive(false);
      setResultsError("Couldn't read that document. Try another file or search instead.");
      setMode("results");
      return;
    }
    setParseDocs((prev) =>
      prev.map((d) =>
        d.id === aggId
          ? {
              ...d,
              phase: "parsing",
              uploadProgress: 100,
              totalPages: up.pageCount && up.pageCount > 0 ? up.pageCount : null,
            }
          : d,
      ),
    );

    const planId = await pollOne(up.documentId, (statusBody) => {
      setParseDocs((prev) =>
        prev.map((d) => {
          if (d.id !== aggId) return d;
          const backendPages =
            typeof statusBody.totalPages === "number" && statusBody.totalPages > 0
              ? statusBody.totalPages
              : null;
          return {
            ...d,
            phase: "parsing",
            totalPages: backendPages ?? d.totalPages,
            step: statusBody.step ?? null,
            realCompletedPages:
              typeof statusBody.completedPages === "number" ? statusBody.completedPages : null,
          };
        }),
      );
    });

    setEditorUploadActive(false);
    if (!planId) {
      setResultsError("Couldn't process that document. Try another file or search instead.");
      setMode("results");
      return;
    }
    setParseDocs((prev) => prev.map((d) => (d.id === aggId ? { ...d, phase: "complete" } : d)));

    const newRef: PlanRef = { kind: "user_plan", id: planId };
    const refs = [...baseRefs];
    if (action === "replace" && columnIndex != null) refs[columnIndex] = newRef;
    else refs.push(newRef);
    await callCompareApi(refs);
  }
  // Gate the editor upload on the health_data_upload consent. If never granted
  // (reached results without uploading), stash the request + open the consent
  // overlay; its Continue grants consent then runs the upload.
  const requestEditorUpload = (
    action: "replace" | "add",
    columnIndex: number | null,
    file: File,
  ) => {
    if (!user) return;
    if (!hasConsented) {
      setEditorConsentChecked(false);
      setPendingEditorUpload({ action, columnIndex, file });
      return;
    }
    void doEditorUpload(action, columnIndex, file);
  };
  async function confirmEditorConsent() {
    if (!pendingEditorUpload || !editorConsentChecked) return;
    const req = pendingEditorUpload;
    setConsentSubmitting(true);
    try {
      await grantConsent();
    } catch {
      setResultsError("Couldn't record your consent. Try again.");
      setConsentSubmitting(false);
      return;
    }
    setConsentSubmitting(false);
    setPendingEditorUpload(null);
    void doEditorUpload(req.action, req.columnIndex, req.file);
  }
  const cancelEditorConsent = () => {
    setPendingEditorUpload(null);
    setEditorConsentChecked(false);
  };

  const onReplaceColumn = (columnIndex: number, slot: SlotState) => {
    if (slot.kind === "upload" && slot.file) {
      requestEditorUpload("replace", columnIndex, slot.file);
      return;
    }
    const ref = slotToRef(slot);
    if (!ref) return;
    const refs = currentRefs();
    if (columnIndex < 0 || columnIndex >= refs.length) return;
    refs[columnIndex] = ref;
    void callCompareApi(refs);
  };
  const onAddColumn = (slot: SlotState) => {
    if (slot.kind === "upload" && slot.file) {
      requestEditorUpload("add", null, slot.file);
      return;
    }
    const ref = slotToRef(slot);
    if (!ref) return;
    const refs = currentRefs();
    if (refs.length >= 3) return;
    void callCompareApi([...refs, ref]);
  };
  const onRemoveColumn = (columnIndex: number) => {
    const refs = currentRefs().filter((_, i) => i !== columnIndex);
    if (refs.length < 2) return;
    void callCompareApi(refs);
  };

  // ── Render ────────────────────────────────────────────────────────────
  // Single return wraps body + persistent Turnstile mount. Keeping the widget
  // in a stable JSX position across mode transitions lets Cloudflare maintain
  // its iframe/token lifecycle without remount-thrashing — required for the
  // multi-upload reset() flow AND prevents the "display:none" iframe-not-loaded
  // bug that bit single-upload submission in the prior revision.
  return (
    <>
      {mode === "results" ? (
        <ResultsView
          plans={results}
          error={resultsError}
          v2On={v2On}
          onStartOver={startOver}
          onBackToPicker={() => setMode("build")}
          currentPlan={currentPlan}
          recents={recents}
          onReplaceColumn={onReplaceColumn}
          onAddColumn={onAddColumn}
          onRemoveColumn={onRemoveColumn}
          userActiveInsurancePlanId={currentPlan?.insurancePlanId ?? null}
          onFieldSaved={(planId, field, value) => {
            // Optimistic update: drop the new value into the matching user_plan
            // slot's planSummary so the cell re-renders without a full API
            // round-trip. decoratedShape() unwraps either raw `number` or
            // `DecoratedValue`, so a plain number is fine here.
            const dbToSummaryKey: Record<string, keyof ComparePlanPayload["planSummary"]> = {
              premium_monthly: "premiumMonthly",
              in_deductible_individual: "inDeductible",
              out_deductible_individual: "outDeductible",
              in_oop_max_individual: "inOopMax",
              out_oop_max_individual: "outOopMax",
            };
            const summaryKey = dbToSummaryKey[field];
            if (!summaryKey) return;
            setResults((prev) => {
              if (!prev) return prev;
              return prev.map((p) => {
                if (p.ref.kind === "user_plan" && p.ref.id === planId) {
                  return {
                    ...p,
                    planSummary: { ...p.planSummary, [summaryKey]: value },
                  };
                }
                return p;
              });
            });
          }}
        />
      ) : mode === "parsing" ? (
        <UnifiedParseScreen
          docs={parseDocs}
          loaderVariant={v2On ? "stackV3" : "deprecated"}
          title="Reading your plan documents"
          subtitle="We meticulously go over every detail in your plans not once but twice. That takes a while, but we know it's worth it."
          onCancel={() => {
            // S100 v3 — leave the parsing screen. In-flight polling loops finish
            // independently; their results are ignored since we re-render away.
            // S160 — an editor upload-swap returns to results (not the build picker).
            setParseError(null);
            setParseDocs([]);
            if (editorUploadActive) {
              setEditorUploadActive(false);
              setMode("results");
            } else {
              setMode("build");
            }
          }}
          footer={
            parseError ? (
              <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-4 text-center">
                <p className="text-sm text-rose-700">{parseError}</p>
                <button
                  onClick={() => setMode("build")}
                  className="mt-3 text-sm font-semibold text-rose-700 underline"
                >
                  Back
                </button>
              </div>
            ) : undefined
          }
        />
      ) : (
        // Build mode
        <div>
          {/* Compare v2 (PR5): reskinned picker + sessions when the flag is ON;
              the consent gate / submit CTA / Turnstile mount below stay shared.
              Flag OFF → the v1 hero + slots render byte-identical. */}
          {v2On ? (
            <BuildViewV2
              slots={slots}
              setSlot={setSlot}
              currentPlan={currentPlan}
              recents={recents}
            />
          ) : (
            <>
              <BuildHeader />

              {/* Side-by-side on lg+; stacked on mobile/tablet. */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
                {slots.map((slot, idx) => (
                  <PlanSlot
                    key={idx}
                    index={idx}
                    optional={idx === 2}
                    currentPlan={currentPlan}
                    state={slot}
                    onChange={(next) => setSlot(idx, next)}
                    disabled={consentSubmitting}
                  />
                ))}
              </div>
            </>
          )}

          {showConsent && (
            <div className="max-w-3xl mx-auto mt-6 bg-white rounded-2xl ring-1 ring-amber-200 p-6 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-900">Quick consent before we read your plan documents</p>
                  <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">{consentDoc?.summary}</p>
                  <label className="flex items-start gap-3 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={consentChecked}
                      onChange={(e) => setConsentChecked(e.target.checked)}
                      className="mt-1 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-slate-700">
                      I&rsquo;ve read and agree to the {consentDoc?.title ?? "consent terms"} above.
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          <div className="max-w-3xl mx-auto mt-8">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || consentSubmitting || (showConsent && !consentChecked) || (hasUploadSlot && !turnstileToken)}
              className={`w-full py-4 rounded-2xl text-base font-semibold transition-all ${
                canSubmit && !consentSubmitting && !(showConsent && !consentChecked) && !(hasUploadSlot && !turnstileToken)
                  ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-200 hover:shadow-xl hover:shadow-blue-300 hover:-translate-y-0.5"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed"
              }`}
            >
              {consentSubmitting
                ? "Saving consent…"
                : showConsent
                  ? "Continue and compare"
                  : filledCount < 2
                    ? `Add at least 2 plans to compare (${filledCount}/2)`
                    : hasUploadSlot && !turnstileToken
                      ? "Verifying you're human…"
                      : `Compare ${filledCount} plan${filledCount === 1 ? "" : "s"} →`}
            </button>
            {resultsError && <p className="text-sm text-rose-600 mt-3 text-center">{resultsError}</p>}
          </div>

          {/* S289 (Andrew) — saved comparisons BELOW the submit CTA: the
              primary action reads first. v2-only (sessions are a v2 feature;
              moved out of BuildViewV2). */}
          {v2On && (
            <div className="mt-2">
              <CompareSessionsBar sessions={sessions} onResume={resumeSession} />
            </div>
          )}

          {/* B3.3 — soft-variant ShareWithFriend embed below the Compare CTA
              (picker view only). Un-gated inline per S125 B3.1 /dashboard
              pattern (bypasses S124 PostgREST 406 on flag query). */}
          <div className="max-w-3xl mx-auto mt-6">
            <ShareWithFriend variant="soft" surface="compare_picker" />
          </div>
        </div>
      )}

      {/* Persistent Turnstile mount — stays in DOM across mode transitions so
          the Cloudflare iframe lifecycle works (token capture + reset()).
          CF-34 (Session 72): appearance="execute" keeps the widget invisible
          when Cloudflare silently issues a token (no visible Success badge);
          the interactive challenge UI only renders when Cloudflare actually
          wants to challenge — and is positioned discretely. */}
      {(hasUploadSlot || editorUploadActive) && (
        <div
          className={
            mode === "build"
              ? "max-w-3xl mx-auto mt-5 flex flex-col items-center"
              : "fixed bottom-4 right-4 z-50 opacity-60 hover:opacity-100 transition-opacity scale-90 origin-bottom-right"
          }
        >
          <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} appearance="execute" />
        </div>
      )}

      {/* Compare v2 (S160) — consent gate for a results-editor upload-swap when
          the user reached results without ever uploading (so never granted the
          health_data_upload consent). Reuses the same consent document as the
          build-path gate; Continue grants consent then runs the upload. */}
      {pendingEditorUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl ring-1 ring-amber-200 p-6 max-w-md w-full shadow-xl">
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-9 h-9 rounded-xl bg-amber-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-900">Quick consent before we read your plan document</p>
                <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">{consentDoc?.summary}</p>
                <label className="flex items-start gap-3 mt-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editorConsentChecked}
                    onChange={(e) => setEditorConsentChecked(e.target.checked)}
                    className="mt-1 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700">
                    I&rsquo;ve read and agree to the {consentDoc?.title ?? "consent terms"} above.
                  </span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={cancelEditorConsent}
                disabled={consentSubmitting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmEditorConsent}
                disabled={!editorConsentChecked || consentSubmitting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {consentSubmitting ? "Saving…" : "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function planLabelSub(p: ComparePlanPayload): string {
  return [p.insurerName, p.planSummary.metalLevel, p.planSummary.year]
    .filter(Boolean)
    .join(" · ");
}

function isResolved(s: SlotState): boolean {
  if (s.kind === "current") return true;
  if (s.kind === "search" && s.selected) return true;
  if (s.kind === "upload" && s.file) return true;
  return false;
}

function BuildHeader() {
  return (
    <div className="mb-10 sm:mb-12">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700 mb-6"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to dashboard
      </Link>
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-blue-700 bg-blue-50 px-3 py-1 rounded-full ring-1 ring-blue-100 mb-5">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l2.39 7.36H22l-6.18 4.49 2.36 7.36L12 16.71l-6.18 4.5 2.36-7.36L2 9.36h7.61z" />
          </svg>
          New · Candid Compare
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-slate-900 tracking-tight">
          Compare 3 plans, side by side.
        </h1>
        <p className="text-base sm:text-lg text-slate-600 mt-4 max-w-xl mx-auto leading-relaxed">
          Premiums, deductibles, OOP max, service breadth + depth — every number traced back to the source.
        </p>
      </div>
    </div>
  );
}

// ── Results view ─────────────────────────────────────────────────────────

function ResultsView({
  plans,
  error,
  v2On,
  onStartOver,
  onBackToPicker,
  currentPlan,
  recents,
  onReplaceColumn,
  onAddColumn,
  onRemoveColumn,
  userActiveInsurancePlanId,
  onFieldSaved,
}: {
  plans: ComparePlanPayload[] | null;
  error: string | null;
  v2On: boolean;
  onStartOver: () => void;
  onBackToPicker: () => void;
  currentPlan: CurrentPlanSummary | null;
  recents: ReturnType<typeof loadRecents>;
  onReplaceColumn: (columnIndex: number, slot: SlotState) => void;
  onAddColumn: (slot: SlotState) => void;
  onRemoveColumn: (columnIndex: number) => void;
  userActiveInsurancePlanId: string | null;
  onFieldSaved?: (planId: string, field: EditableField, value: number) => void;
}) {
  if (error) {
    return (
      <div className="max-w-xl mx-auto py-12 text-center">
        <div className="bg-white rounded-3xl ring-1 ring-slate-200 p-8 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">
            {error.includes("Verify") ? error : "Something went wrong"}
          </h2>
          {!error.includes("Verify") && <p className="text-sm text-slate-600 mt-2">{error}</p>}
          <button
            onClick={onStartOver}
            className="mt-6 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="max-w-xl mx-auto py-12 text-center">
        <p className="text-sm text-slate-600">No plans to compare yet.</p>
        <button
          onClick={onStartOver}
          className="mt-6 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
        >
          Start over
        </button>
      </div>
    );
  }

  // compare_v2_redesign ON → the reskinned results view (same /api/plan/compare
  // payload, new presentation + distinct na/nc/unk empty states). plans is
  // guaranteed non-null + non-empty here (error + empty states handled above,
  // shared across v1/v2). Flag OFF → the v1 body below renders byte-identical.
  if (v2On) {
    return (
      <ResultsViewV2
        plans={plans}
        onStartOver={onStartOver}
        onBackToPicker={onBackToPicker}
        currentPlan={currentPlan}
        recents={recents}
        onReplaceColumn={onReplaceColumn}
        onAddColumn={onAddColumn}
        onRemoveColumn={onRemoveColumn}
        userActiveInsurancePlanId={userActiveInsurancePlanId}
        onFieldSaved={onFieldSaved}
      />
    );
  }

  return (
    <div>
      <CompareTopbar planCount={plans.length} onStartOver={onStartOver} />

      {/* B3.3 — each data table stacks 1-col on mobile (below sm) via
          compareGridClass; no horizontal scroll needed at any viewport. */}
      <div>
        <PlanSummaryCards
          plans={plans}
          userActiveInsurancePlanId={userActiveInsurancePlanId}
        />
        <NumbersTable
          plans={plans}
          userActiveInsurancePlanId={userActiveInsurancePlanId}
          onFieldSaved={onFieldSaved}
        />
        <BreadthTable plans={plans} />
        <ServiceCategoryAccordions plans={plans} />
      </div>

      {/* D-§1.C.3-M bottom disclaimer — Pattern 1 #11 methodology disclosure. */}
      <p className="mt-10 text-[12px] text-slate-500 leading-relaxed max-w-3xl mx-auto text-center px-4">
        Comparisons are built from your uploaded plan documents and verified data from Candid members
        on the same plan. Out-of-network details vary by provider — confirm with your insurer before
        scheduling care.
      </p>

      <div className="mt-8">
        <ShareWithFriend surface="compare_results" />
      </div>
    </div>
  );
}

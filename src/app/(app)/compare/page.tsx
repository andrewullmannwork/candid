"use client";

/**
 * S70 — /compare page (Candid Compare).
 *
 * Up to 3 plans side-by-side via two entry paths:
 *   1. Search & pick — autocomplete via /api/plan/search → canonical plan IDs.
 *   2. Upload documents — multi-upload via /api/documents/upload → poll
 *      /api/documents/status → resolve to insurance_plans IDs.
 *
 * Auth-gated by (app) layout. Additional email-verified gate inside this page
 * (Q-S70-5 carrot — verify-email CTA renders if user.emailVerified=false).
 *
 * Backend gate: /api/plan/compare returns 503 when benefits_comparison_v1 flag
 * is OFF, in which case we surface a "Coming soon" state at submit time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "@/components/security/TurnstileWidget";
import { useConsent } from "@/lib/consent/use-consent";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { CompareHeader } from "@/components/compare/CompareHeader";
import { CompareCategories } from "@/components/compare/CompareCategories";
import { MultiDocUploader } from "@/components/compare/MultiDocUploader";
import {
  PlayfulParsingScreen,
  type ParseDoc,
} from "@/components/parsing/PlayfulParsingScreen";
import type { ComparePlanPayload, PlanRef } from "@/lib/plan/compare";

// ── Types ────────────────────────────────────────────────────────────────

interface PlanSearchResult {
  id: string;
  name: string;
  type?: string;
  state?: string;
  metalLevel?: string;
  deductible?: number | null;
  oopMax?: number | null;
  year?: number;
  insurerName?: string;
}

type Mode = "search" | "upload" | "parsing" | "results";

// ── Page ─────────────────────────────────────────────────────────────────

export default function ComparePage() {
  const { user, loading: authLoading } = useAuth();

  if (authLoading) {
    return <PageShell><LoadingState /></PageShell>;
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

// ── Page shell ───────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/40">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {children}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function SignedOutState() {
  return (
    <div className="text-center py-20">
      <h1 className="text-2xl font-semibold text-slate-900">Sign in to use Candid Compare</h1>
      <p className="text-sm text-slate-600 mt-2">
        Compare up to 3 plans side-by-side once you&rsquo;re signed in.
      </p>
      <Link
        href="/auth/signin"
        className="inline-block mt-6 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
      });
      if (res.ok) {
        setSent(true);
      } else {
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
          We&rsquo;ll only enable side-by-side plan comparison for verified accounts so the cross-user
          data we surface stays trustworthy. One quick click in your inbox is all it takes.
        </p>

        <div className="mt-8">
          {sent ? (
            <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-200 px-4 py-3">
              <p className="text-sm font-medium text-emerald-800">
                Sent! Check <span className="font-semibold">{user?.email}</span> (and your spam folder).
              </p>
            </div>
          ) : (
            <button
              onClick={handleResend}
              disabled={sending}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-semibold shadow-md shadow-blue-200 hover:shadow-lg hover:shadow-blue-300 disabled:opacity-60"
            >
              {sending ? "Sending…" : `Send verification email`}
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
  const [mode, setMode] = useState<Mode>("search");
  const [results, setResults] = useState<ComparePlanPayload[] | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const callCompare = useCallback(
    async (planRefs: PlanRef[]) => {
      if (!user) return;
      setComparing(true);
      setResultsError(null);
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
          setResultsError(
            "Candid Compare isn't available yet. We're rolling it out to all users — check back shortly.",
          );
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
        setResults(data.plans.filter((p) => "planSummary" in p) as ComparePlanPayload[]);
        setMode("results");
      } catch {
        setResultsError("Couldn't load the comparison. Try again in a moment.");
        setMode("results");
      } finally {
        setComparing(false);
      }
    },
    [user],
  );

  function startOver() {
    setMode("search");
    setResults(null);
    setResultsError(null);
  }

  if (mode === "results") {
    return (
      <ResultsView
        plans={results}
        error={resultsError}
        onStartOver={startOver}
      />
    );
  }

  if (mode === "parsing") {
    return null; // UploadFlow renders PlayfulParsingScreen inline.
  }

  return (
    <div>
      <Header />
      <ModeTabs mode={mode} setMode={setMode} />
      <div className="mt-6">
        {mode === "search" ? (
          <SearchFlow comparing={comparing} onCompare={callCompare} />
        ) : (
          <UploadFlow
            comparing={comparing}
            onCompare={callCompare}
            onModeChange={setMode}
          />
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="text-center mb-10">
      <span className="inline-block text-[11px] font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-3 py-1 rounded-full ring-1 ring-blue-100">
        New · Candid Compare
      </span>
      <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-4">
        Compare up to 3 plans, side by side.
      </h1>
      <p className="text-sm sm:text-base text-slate-600 mt-3 max-w-xl mx-auto leading-relaxed">
        Premiums, deductibles, OOP max, service breadth, and depth — all in one view, with every
        number traced back to the source document.
      </p>
    </div>
  );
}

function ModeTabs({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex bg-white rounded-2xl ring-1 ring-slate-200 p-1 shadow-sm">
        <TabButton
          active={mode === "search"}
          onClick={() => setMode("search")}
          label="Search & pick"
        />
        <TabButton
          active={mode === "upload"}
          onClick={() => setMode("upload")}
          label="Upload documents"
        />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-semibold rounded-xl transition-all ${
        active
          ? "bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow"
          : "text-slate-600 hover:text-slate-900"
      }`}
    >
      {label}
    </button>
  );
}

// ── Search-and-pick flow ─────────────────────────────────────────────────

function SearchFlow({
  comparing,
  onCompare,
}: {
  comparing: boolean;
  onCompare: (refs: PlanRef[]) => void;
}) {
  const { user } = useAuth();
  const [activePlanPrefilled, setActivePlanPrefilled] = useState(false);
  const [slots, setSlots] = useState<Array<PlanSearchResult | null>>([null, null, null]);

  // Pre-fill slot 0 with user's active plan when its canonical_plan_id resolves.
  useEffect(() => {
    if (activePlanPrefilled || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = createBrowserClient();
        const { data: u } = await supabase
          .from("users")
          .select("id")
          .eq("firebase_uid", user.userId)
          .single();
        if (!u) return;
        const { data: profile } = await supabase
          .from("profiles")
          .select("active_insurance_plan_id")
          .eq("user_id", u.id)
          .single();
        if (!profile?.active_insurance_plan_id) return;
        const { data: plan } = await supabase
          .from("insurance_plans")
          .select("canonical_plan_id, plan_name, plan_type, state, plan_year, metal_level, insurer_name, in_deductible_individual, in_oop_max_individual")
          .eq("id", profile.active_insurance_plan_id)
          .single();
        if (!plan?.canonical_plan_id || cancelled) return;
        setSlots((prev) => {
          if (prev[0]) return prev;
          const next = [...prev];
          next[0] = {
            id: plan.canonical_plan_id as string,
            name: plan.plan_name as string,
            type: plan.plan_type as string,
            state: plan.state as string,
            metalLevel: plan.metal_level as string,
            year: plan.plan_year as number,
            insurerName: plan.insurer_name as string,
            deductible: plan.in_deductible_individual as number | null,
            oopMax: plan.in_oop_max_individual as number | null,
          };
          return next;
        });
      } catch {
        // Non-critical — skip prefill on failure.
      } finally {
        setActivePlanPrefilled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, activePlanPrefilled]);

  function setSlot(idx: number, plan: PlanSearchResult | null) {
    setSlots((prev) => {
      const next = [...prev];
      next[idx] = plan;
      return next;
    });
  }

  const filledCount = slots.filter(Boolean).length;
  const canCompare = filledCount >= 2 && !comparing;

  function handleCompare() {
    const refs: PlanRef[] = slots
      .filter((s): s is PlanSearchResult => Boolean(s))
      .map((s) => ({ kind: "canonical", id: s.id }));
    onCompare(refs);
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-6">
        <p className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-4">
          Pick 2-3 plans to compare
        </p>
        <div className="space-y-3">
          {slots.map((slot, idx) => (
            <SearchPlanSlot
              key={idx}
              idx={idx}
              slot={slot}
              onSelect={(p) => setSlot(idx, p)}
              onClear={() => setSlot(idx, null)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={handleCompare}
          disabled={!canCompare}
          className={`mt-6 w-full py-3 rounded-xl text-sm font-semibold transition-all ${
            canCompare
              ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-200 hover:shadow-lg hover:shadow-blue-300"
              : "bg-slate-100 text-slate-400 cursor-not-allowed"
          }`}
        >
          {comparing
            ? "Loading comparison…"
            : filledCount < 2
              ? `Add at least 2 plans (${filledCount}/2)`
              : `Compare ${filledCount} plan${filledCount === 1 ? "" : "s"}`}
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-4 text-center">
        Can&rsquo;t find your plan? Switch to <span className="font-semibold">Upload documents</span> to add it.
      </p>
    </div>
  );
}

function SearchPlanSlot({
  idx,
  slot,
  onSelect,
  onClear,
}: {
  idx: number;
  slot: PlanSearchResult | null;
  onSelect: (p: PlanSearchResult) => void;
  onClear: () => void;
}) {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlanSearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planLetter = String.fromCharCode(65 + idx);

  useEffect(() => {
    if (slot || !user || query.length < 3) {
      setResults([]);
      setShowResults(false);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ query }),
        });
        if (res.ok) {
          const { plans } = await res.json();
          setResults(plans || []);
          setShowResults((plans || []).length > 0);
        }
      } catch {
        // ignore
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, user, slot]);

  if (slot) {
    return (
      <div className="flex items-center gap-3 p-3 rounded-xl bg-blue-50/50 ring-1 ring-blue-200">
        <div className="w-9 h-9 rounded-lg bg-white ring-1 ring-blue-200 flex items-center justify-center shrink-0">
          <span className="text-xs font-bold text-blue-700">Plan {planLetter}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 truncate">{slot.name}</p>
          <p className="text-xs text-slate-500 truncate">
            {slot.insurerName ? `${slot.insurerName} · ` : ""}
            {slot.type}
            {slot.metalLevel ? ` · ${slot.metalLevel}` : ""}
            {slot.state ? ` · ${slot.state}` : ""}
          </p>
        </div>
        <button
          onClick={onClear}
          className="text-slate-400 hover:text-rose-600 transition-colors p-1"
          aria-label="Remove this plan"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-3 p-3 rounded-xl bg-white ring-1 ring-slate-200 focus-within:ring-blue-300 focus-within:bg-slate-50/50 transition-all">
        <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
          <span className="text-xs font-bold text-slate-500">Plan {planLetter}</span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setShowResults(true)}
          onBlur={() => setTimeout(() => setShowResults(false), 200)}
          placeholder="Type a plan name…"
          className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none min-w-0"
        />
        {searching && (
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
        )}
      </div>
      {showResults && results.length > 0 && (
        <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white rounded-xl ring-1 ring-slate-200 shadow-xl max-h-72 overflow-y-auto">
          {results.map((plan) => (
            <button
              key={plan.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(plan);
                setQuery("");
                setShowResults(false);
              }}
              className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-slate-100 last:border-b-0 transition-colors"
            >
              <p className="text-sm font-medium text-slate-900">{plan.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {plan.insurerName ? `${plan.insurerName} · ` : ""}
                {plan.type ?? ""}
                {plan.metalLevel ? ` · ${plan.metalLevel}` : ""}
                {plan.state ? ` · ${plan.state}` : ""}
                {plan.deductible != null ? ` · $${plan.deductible.toLocaleString()} deductible` : ""}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Upload flow ──────────────────────────────────────────────────────────

interface UploadDoc {
  id: string;
  file: File;
  documentId: string | null;
  insurancePlanId: string | null;
  phase: ParseDoc["phase"];
  progress: number;
  detail?: string;
  errorMessage?: string;
}

function UploadFlow({
  comparing,
  onCompare,
  onModeChange,
}: {
  comparing: boolean;
  onCompare: (refs: PlanRef[]) => void;
  onModeChange: (m: Mode) => void;
}) {
  const { user } = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [uploadDocs, setUploadDocs] = useState<UploadDoc[]>([]);
  const [stage, setStage] = useState<"select" | "consent" | "uploading">("select");
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  useEffect(() => {
    turnstileTokenRef.current = turnstileToken;
  }, [turnstileToken]);

  const { hasConsented, loading: consentLoading, grantConsent } = useConsent("health_data_upload");
  const consentDoc = getConsentDocument("health_data_upload");
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);

  const allComplete = uploadDocs.length > 0 && uploadDocs.every((d) => d.phase === "complete");

  // Once all docs are parsed, surface the compare CTA.
  useEffect(() => {
    if (allComplete && uploadDocs.length >= 2) {
      const refs: PlanRef[] = uploadDocs
        .filter((d) => d.insurancePlanId)
        .map((d) => ({ kind: "user_plan" as const, id: d.insurancePlanId! }));
      if (refs.length >= 2) {
        onCompare(refs);
      } else {
        setError("We couldn't link these documents to plan records. Try uploading SBC PDFs.");
      }
    }
  }, [allComplete, uploadDocs, onCompare]);

  function handleSubmit() {
    if (files.length < 2) return;
    setError(null);
    if (!hasConsented && !consentChecked) {
      setStage("consent");
      return;
    }
    beginUploads();
  }

  async function ensureConsent(): Promise<boolean> {
    if (hasConsented) return true;
    if (!consentChecked) return false;
    setConsentSubmitting(true);
    try {
      await grantConsent();
      return true;
    } catch {
      setError("Couldn't record your consent. Try again.");
      return false;
    } finally {
      setConsentSubmitting(false);
    }
  }

  async function beginUploads() {
    if (!user) return;
    const ok = await ensureConsent();
    if (!ok) return;
    const docs: UploadDoc[] = files.map((f, i) => ({
      id: `${Date.now()}-${i}`,
      file: f,
      documentId: null,
      insurancePlanId: null,
      phase: i === 0 ? "uploading" : "queued",
      progress: i === 0 ? 5 : 0,
    }));
    setUploadDocs(docs);
    setStage("uploading");
    // Sequential upload — single turnstile widget reused with reset between uploads.
    for (let i = 0; i < docs.length; i++) {
      const result = await uploadOne(docs[i], i);
      if (!result) {
        // Mark this doc as error; continue to the next.
        setUploadDocs((prev) => {
          const next = [...prev];
          next[i] = {
            ...next[i],
            phase: "error",
            errorMessage: "Upload or processing failed.",
          };
          // Promote next queued doc to uploading.
          if (i + 1 < next.length && next[i + 1].phase === "queued") {
            next[i + 1] = { ...next[i + 1], phase: "uploading", progress: 5 };
          }
          return next;
        });
        continue;
      }
      // Promote next doc when this one finishes uploading + parsing.
      setUploadDocs((prev) => {
        const next = [...prev];
        if (i + 1 < next.length && next[i + 1].phase === "queued") {
          next[i + 1] = { ...next[i + 1], phase: "uploading", progress: 5 };
        }
        return next;
      });
    }
  }

  async function uploadOne(doc: UploadDoc, idx: number): Promise<boolean> {
    if (!user) return false;

    // Wait for a fresh turnstile token (reset between uploads). The first upload
    // can use the initial token captured by the widget at mount; subsequent
    // uploads need the widget reset to issue a new single-use token.
    if (idx > 0) {
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      turnstileTokenRef.current = null;
      // Wait up to 10s for token to arrive (Cloudflare typically issues in <2s).
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (turnstileTokenRef.current) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    try {
      const idToken = await user.firebaseUser.getIdToken();
      const formData = new FormData();
      formData.append("file", doc.file);
      // Plan-document-or-SBC heuristic — let server classify. Pass "sbc" since
      // users selecting compare-via-upload most often have SBCs; classifier will
      // refine if needed.
      formData.append("docType", "sbc");
      const tok = turnstileTokenRef.current;
      if (tok) formData.append("turnstileToken", tok);

      const uploadRes = await fetch("/api/documents/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });
      if (!uploadRes.ok) return false;
      const uploadBody = (await uploadRes.json()) as { documentId?: string };
      if (!uploadBody.documentId) return false;

      setUploadDocs((prev) => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          documentId: uploadBody.documentId!,
          phase: "parsing",
          progress: 25,
        };
        return next;
      });

      // Poll until processed.
      const startedAt = Date.now();
      while (true) {
        await new Promise((r) => setTimeout(r, 4000));
        const statusRes = await fetch(`/api/documents/status?id=${uploadBody.documentId}`);
        if (!statusRes.ok) continue;
        const statusBody = await statusRes.json();
        if (statusBody.needsTrigger) {
          await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId: uploadBody.documentId }),
          });
        }

        const phase: ParseDoc["phase"] =
          statusBody.status === "processed"
            ? "complete"
            : statusBody.status === "error" || statusBody.isStuck
              ? "error"
              : statusBody.completedPages != null && statusBody.totalPages != null
                ? "cross_referencing"
                : "parsing";
        const progress =
          statusBody.completedPages && statusBody.totalPages
            ? Math.min(95, 25 + Math.round((statusBody.completedPages / statusBody.totalPages) * 60))
            : Math.min(85, 25 + Math.round((Date.now() - startedAt) / 1000));
        const detail =
          statusBody.completedPages != null && statusBody.totalPages != null
            ? `Page ${statusBody.completedPages} of ${statusBody.totalPages}`
            : statusBody.step ?? undefined;

        setUploadDocs((prev) => {
          const next = [...prev];
          next[idx] = { ...next[idx], phase, progress, detail };
          return next;
        });

        if (statusBody.status === "processed") {
          // Resolve the document → its insurance_plans row for compare.
          const supabase = createBrowserClient();
          const { data: docRow } = await supabase
            .from("documents")
            .select("linked_insurance_plan_id")
            .eq("id", uploadBody.documentId)
            .single();
          const insurancePlanId = (docRow?.linked_insurance_plan_id as string | null) ?? null;
          setUploadDocs((prev) => {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              phase: "complete",
              progress: 100,
              insurancePlanId,
            };
            return next;
          });
          return true;
        }
        if (statusBody.status === "error" || statusBody.isStuck) return false;
      }
    } catch {
      return false;
    }
  }

  if (stage === "consent") {
    return (
      <div className="max-w-xl mx-auto bg-white rounded-2xl ring-1 ring-slate-200 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Quick consent before we read your plan documents</h2>
        <p className="text-sm text-slate-600 mt-2 leading-relaxed">{consentDoc?.summary}</p>
        <label className="flex items-start gap-3 mt-4 cursor-pointer">
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
        <button
          onClick={() => beginUploads()}
          disabled={!consentChecked || consentSubmitting || consentLoading}
          className="mt-6 w-full py-3 rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-200 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {consentSubmitting ? "Saving consent…" : "Continue and upload"}
        </button>
        <button
          onClick={() => onModeChange("search")}
          className="mt-3 w-full text-xs text-slate-500 hover:text-slate-700"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (stage === "uploading") {
    const parseDocs: ParseDoc[] = uploadDocs.map((d, i) => ({
      id: d.id,
      label: `Plan ${String.fromCharCode(65 + i)}`,
      fileName: d.file.name,
      phase: d.phase,
      progress: d.progress,
      detail: d.detail,
      errorMessage: d.errorMessage,
    }));
    return (
      <div>
        <PlayfulParsingScreen
          docs={parseDocs}
          title="Reading your plan documents"
          subtitle={
            comparing
              ? "Loading the comparison…"
              : "We're extracting every detail — this usually takes 30-90 seconds per plan."
          }
          footer={
            error ? (
              <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-4 text-center">
                <p className="text-sm text-rose-700">{error}</p>
                <button
                  onClick={() => onModeChange("search")}
                  className="mt-3 text-sm font-semibold text-rose-700 underline"
                >
                  Switch to search
                </button>
              </div>
            ) : undefined
          }
        />
        <div className="hidden">
          <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 shadow-sm p-6">
        <p className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-4">
          Upload 2-3 plan PDFs (SBC or summary booklet)
        </p>
        <MultiDocUploader
          selected={files}
          onChange={setFiles}
          max={3}
          onSubmit={handleSubmit}
          submitLabel={
            files.length < 2
              ? `Add at least 2 plans (${files.length}/2)`
              : `Compare ${files.length} plan${files.length === 1 ? "" : "s"}`
          }
        />
        <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} />
      </div>
      {error && <p className="text-sm text-rose-600 mt-4 text-center">{error}</p>}
    </div>
  );
}

// ── Results view ─────────────────────────────────────────────────────────

function ResultsView({
  plans,
  error,
  onStartOver,
}: {
  plans: ComparePlanPayload[] | null;
  error: string | null;
  onStartOver: () => void;
}) {
  if (error) {
    return (
      <div className="max-w-xl mx-auto py-12 text-center">
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-8 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">{error.includes("Verify") ? error : "Something went wrong"}</h2>
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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900">Your comparison</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {plans.length} plan{plans.length === 1 ? "" : "s"} side-by-side
          </p>
        </div>
        <button
          onClick={onStartOver}
          className="text-sm font-semibold text-blue-600 hover:text-blue-700"
        >
          Start over
        </button>
      </div>

      {/* Mobile note */}
      <p className="sm:hidden text-xs text-slate-500 mb-3">
        Scroll horizontally to see all columns →
      </p>

      <div className="space-y-6 overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <div className="min-w-[680px] space-y-6">
          <CompareHeader plans={plans} />
          <CompareCategories plans={plans} />
        </div>
      </div>
    </div>
  );
}


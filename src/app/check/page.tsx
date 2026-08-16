"use client";

/**
 * /check — the no-account bill check (S315 A-2/A-3; flag `anonymous_bill_check_v1`).
 *
 * Design record: vault plans/s315-anonymous-funnel-design.md (mock rev 4
 * approved 2026-08-15). Strings are the approved ledger entries (L*, C*, P*,
 * I*, Y*, E*); every asserted number downstream comes from existing machinery.
 * Visual language: the Candid token system (globals.css — candid-blue scale,
 * fg/bg neutrals, glow-blue, gradient-mesh, radius scale) + the display-state
 * badge vocabulary (emerald Verified family / amber estimated).
 *
 * REUSE MAP (design §7.2): DropIdle/DropUploading (upload) ·
 * UnifiedParseScreen stackV3 (the SAME parsing screens) · /api/plan/search
 * (the canonical picker both existing surfaces use) · /api/profile
 * catalog_match write (the flow U8/U9/U10 used — canonical link happens
 * server-side) · ClaimDetail (the results surface) · consent stack v1.7 docs ·
 * TurnstileWidget · startAnonymousCheck (A-1).
 *
 * DEVIATION from the mock's "PlanSearchModal as-is" note: that modal is
 * dispute-scoped (binds via /api/disputes/[id]/bind-canonical) and /check has
 * no dispute at identity time — so the identity step reuses the PROFILE
 * picker's machinery instead (same search endpoint, same write path, same
 * canonical linking). Recorded in the design doc.
 *
 * Audience guards: full account → /upload · flag OFF → / · anonymous stays.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { EmailAuthProvider, linkWithCredential } from "firebase/auth";
import { useAuth } from "@/lib/auth/auth-context";
import { useFeatureFlag } from "@/lib/config/use-feature-flag";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/security/TurnstileWidget";
import { useDropzone } from "react-dropzone";
import { DropIdle, DropHover, DropUploading } from "@/components/upload/DropZoneStates";
import { UnifiedParseScreen, type ParseDoc } from "@/components/parsing/UnifiedParseScreen";
import { ClaimDetail } from "@/components/claims/ClaimDetail";
import { getConsentDocument } from "@/lib/consent/consent-documents";

type Phase = "entry" | "parsing" | "confirmGap" | "identity" | "results" | "error";

interface SearchResult {
  id: string;
  name: string;
  insurerName: string;
  state: string | null;
  year: number | null;
  metalLevel: string | null;
  badgeLevel: "verified" | "community" | "estimated";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── shared visual atoms (Candid token system) ──────────────────────────────
const CARD = "rounded-2xl border border-gray-200 bg-white shadow-sm";
const BTN_PRIMARY =
  "inline-block rounded-xl bg-blue-600 px-6 py-3 text-[15px] font-semibold text-white glow-blue transition hover:bg-blue-700 disabled:opacity-50";
const BTN_GHOST =
  "inline-block rounded-xl border-[1.5px] border-blue-100 bg-white px-5 py-2.5 text-sm font-semibold text-blue-600 transition hover:border-blue-200 hover:bg-blue-50/50";
const INPUT =
  "w-full rounded-xl border border-gray-300 px-3.5 py-2.5 text-[15px] text-gray-900 placeholder:text-gray-400 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100";
const LABEL = "block text-[13px] font-semibold text-gray-800";

const BADGE_STYLES: Record<SearchResult["badgeLevel"], string> = {
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  community: "bg-green-50 text-green-700 ring-green-200",
  estimated: "bg-amber-50 text-amber-700 ring-amber-200",
};
const BADGE_LABELS: Record<SearchResult["badgeLevel"], string> = {
  verified: "Verified",
  community: "Community",
  estimated: "Estimated",
};

function StepPills({ phase }: { phase: Phase }) {
  const steps: Array<{ label: string; active: boolean; done: boolean }> = [
    {
      label: "Bill",
      active: phase === "entry" || phase === "parsing",
      done: ["confirmGap", "identity", "results"].includes(phase),
    },
    { label: "Your plan", active: phase === "identity", done: phase === "results" },
    { label: "Results", active: phase === "results", done: false },
  ];
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <span
          key={s.label}
          className={
            "flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs transition " +
            (s.active
              ? "bg-blue-600 font-semibold text-white glow-blue"
              : s.done
                ? "bg-emerald-50 font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200"
                : "bg-gray-100 font-medium text-gray-400")
          }
        >
          {s.done ? (
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
              <path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <span className={s.active ? "" : "opacity-70"}>{i + 1}</span>
          )}
          {s.label}
        </span>
      ))}
    </div>
  );
}

export default function CheckPage() {
  const router = useRouter();
  const { user, loading: authLoading, startAnonymousCheck } = useAuth();
  const { enabled, loading: flagLoading } = useFeatureFlag("anonymous_bill_check_v1");

  const [phase, setPhase] = useState<Phase>("entry");
  const [email, setEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  // Stage-then-check (Andrew, testing round 2): the file can be added BEFORE
  // email/consent; NOTHING uploads or parses until "Check my bill".
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [parseDoc, setParseDoc] = useState<ParseDoc | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [claimDosYear, setClaimDosYear] = useState<number | null>(null);

  // identity step
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [yearRelaxed, setYearRelaxed] = useState(false);
  const [identityDone, setIdentityDone] = useState<"picked" | "uploaded" | "skipped" | null>(null);
  const [missMode, setMissMode] = useState(false);

  // upgrade panel (A-4)
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradePassword, setUpgradePassword] = useState("");
  const [upgradeEmail, setUpgradeEmail] = useState("");
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  // ── Turnstile token plumbing: tokens are single-use (sync consumes one,
  // upload consumes another) — queue waiters across resets.
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const tokenRef = useRef<string | null>(null);
  const tokenWaitersRef = useRef<Array<(t: string) => void>>([]);
  const onToken = useCallback((t: string | null) => {
    tokenRef.current = t;
    if (t) {
      const waiters = tokenWaitersRef.current.splice(0);
      for (const w of waiters) w(t);
    }
  }, []);
  const takeToken = useCallback(async (): Promise<string> => {
    const t = tokenRef.current;
    if (t) {
      tokenRef.current = null;
      return t;
    }
    return new Promise((resolve, reject) => {
      const waiter = (tok: string) => {
        clearTimeout(timer);
        resolve(tok);
      };
      const timer = setTimeout(() => {
        const i = tokenWaitersRef.current.indexOf(waiter);
        if (i >= 0) tokenWaitersRef.current.splice(i, 1);
        reject(new Error("The security check didn't finish. Give it a moment, then press the button again."));
      }, 20_000);
      tokenWaitersRef.current.push(waiter);
    });
  }, []);

  const settled = !authLoading && !flagLoading;
  const isFullAccount = !!user && !user.isAnonymous;
  const entryReady = EMAIL_RE.test(email.trim()) && consented;

  // A2-L2 fix, part 2: a file dropped OUTSIDE the active zone (or onto the
  // dimmed one, which carries no handlers) must not navigate the browser to
  // the file. Window-level preventDefault is the standard react-dropzone
  // companion for full-page safety.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);
  useEffect(() => {
    if (!settled) return;
    if (!enabled) router.replace("/");
    else if (isFullAccount) router.replace("/upload");
  }, [settled, enabled, isFullAccount, router]);

  // ── upload one file through the existing pipeline ──
  const uploadFile = useCallback(
    async (file: File, docType: "itemized_bill" | "sbc") => {
      const authed = user ?? null;
      const fbUser = authed?.firebaseUser;
      if (!fbUser) throw new Error("no session");
      const idToken = await fbUser.getIdToken();
      const token = await takeToken();
      const formData = new FormData();
      formData.append("file", file);
      formData.append("docType", docType);
      formData.append("turnstileToken", token);
      setUploadProgress(0);
      const res = await new Promise<Response>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        });
        xhr.addEventListener("load", () =>
          resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "content-type": "application/json" } })),
        );
        xhr.addEventListener("error", () => reject(new Error("Upload failed")));
        xhr.open("POST", "/api/documents/upload");
        xhr.setRequestHeader("Authorization", `Bearer ${idToken}`);
        xhr.send(formData);
      });
      turnstileRef.current?.reset();
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || "Upload failed. Please try again.");
      }
      return (await res.json()) as {
        documentId?: string;
        deduplicated?: boolean;
        status?: string;
        error?: string;
        classification?: { pageCount?: number };
      };
    },
    [user, takeToken],
  );

  // ── the bill entry: staged file + consent → anonymous account → upload → parse ──
  const runCheck = useCallback(
    async (file: File) => {
      setBusy(true);
      setErrorMsg(null);
      setFileName(file.name);
      try {
        if (!user) {
          const consents = (["tos", "privacy_policy", "health_data_upload"] as const).map((t) => {
            const doc = getConsentDocument(t);
            return { type: t, version: doc.version, hash: doc.hash };
          });
          const token = await takeToken();
          await startAnonymousCheck(email.trim(), consents, token);
          turnstileRef.current?.reset();
        }
        const up = await uploadFile(file, "itemized_bill");
        if (!up.documentId) throw new Error("Upload failed. Please try again.");
        setDocumentId(up.documentId);
        if (up.status === "error") {
          throw new Error(up.error || "We couldn't process that document. Please try again.");
        }
        if (up.status === "awaiting_user_confirmation") {
          // The confirm-modal floor fired at classification time — /check v1
          // routes this to the honest interim card (tree-flagged gap).
          setPhase("confirmGap");
          return;
        }
        setParseDoc({
          id: up.documentId,
          label: "Your bill",
          fileName: file.name,
          phase: "parsing",
          uploadProgress: 100,
          totalPages: typeof up.classification?.pageCount === "number" ? up.classification.pageCount : null,
          step: null,
          realCompletedPages: null,
        });
        setPhase("parsing");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [user, email, startAnonymousCheck, uploadFile, takeToken],
  );

  // ── status polling during parse — MIRRORS /upload's proven loop exactly:
  // GET /api/documents/status?id=<id> (query param, no auth header), POST the
  // trigger when needsTrigger (the pipeline is CLIENT-DRIVEN — without the
  // trigger a queued document never processes; the round-3 hang), terminal on
  // processed / pending_review / error / isStuck, 4s cadence. ──
  useEffect(() => {
    if (phase !== "parsing" || !documentId || !user) return;
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        const res = await fetch(`/api/documents/status?id=${documentId}`);
        if (!res.ok || !active) return;
        const data = (await res.json()) as {
          status?: string; step?: string | null; completedPages?: number; totalPages?: number;
          needsTrigger?: boolean; processingError?: string | null; isStuck?: boolean;
          smartSkipOutcome?: string | null;
        };
        setParseDoc((d) =>
          d
            ? {
                ...d,
                step: data.step ?? d.step,
                totalPages: data.totalPages && data.totalPages > 0 ? data.totalPages : d.totalPages,
                realCompletedPages: data.completedPages ?? d.realCompletedPages,
                smartSkipOutcome: data.smartSkipOutcome ?? d.smartSkipOutcome,
                phase: data.status === "processed" ? "complete" : d.phase,
              }
            : d,
        );
        if (data.status === "processed") {
          active = false;
          const idToken = await user.firebaseUser.getIdToken();
          const claimsRes = await fetch(`/api/claims?documentId=${documentId}`, {
            headers: { Authorization: `Bearer ${idToken}` },
          });
          const claims = (await claimsRes.json().catch(() => ({}))) as {
            claims?: Array<{ id: string; date_of_service?: string | null }>;
          };
          const claim = claims.claims?.[0];
          if (claim) {
            setClaimId(claim.id);
            const y = claim.date_of_service ? new Date(claim.date_of_service).getFullYear() : null;
            setClaimDosYear(Number.isFinite(y as number) ? (y as number) : null);
            setPhase("identity");
          } else {
            setErrorMsg("The bill parsed, but we couldn't build a claim from it. Try the PDF version if you have one.");
            setPhase("error");
          }
          return;
        }
        if (data.status === "pending_review") {
          active = false;
          setPhase("confirmGap");
          return;
        }
        if (data.status === "error" || data.isStuck) {
          active = false;
          setErrorMsg(
            data.processingError ||
              "Processing hit a snag. Try the PDF version if you have one, or a clearer photo.",
          );
          setPhase("error");
          return;
        }
        if (data.needsTrigger) {
          await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentId }),
          });
        }
      } catch {
        /* transient poll error — next interval retries */
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [phase, documentId, user]);

  // ── identity search (the same endpoint every existing picker uses) ──
  const runSearch = useCallback(
    async (q: string) => {
      if (!user || q.trim().length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const doSearch = async (withYear: boolean) => {
          const res = await fetch("/api/plan/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
              query: q.trim(),
              ...(withYear && claimDosYear ? { planYear: claimDosYear } : {}),
            }),
          });
          const body = (await res.json().catch(() => ({}))) as { plans?: SearchResult[] };
          return body.plans ?? [];
        };
        let plans = await doSearch(true);
        let relaxed = false;
        if (plans.length === 0 && claimDosYear) {
          plans = await doSearch(false);
          relaxed = plans.length > 0;
        }
        setResults(plans.slice(0, 8));
        setYearRelaxed(relaxed);
      } finally {
        setSearching(false);
      }
    },
    [user, claimDosYear],
  );
  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 350);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const pickPlan = useCallback(
    async (r: SearchResult) => {
      if (!user) return;
      setBusy(true);
      setErrorMsg(null);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        // The same write path the existing picker uses (source=catalog_match);
        // the canonical link happens server-side in the profile route.
        const res = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            insurer: r.insurerName,
            plan_name: r.name,
            state: r.state ?? undefined,
            plan_source: "catalog_match",
            matched_plan_id: r.id,
          }),
        });
        if (!res.ok) throw new Error("Couldn't save that plan. Please try again.");
        setIdentityDone("picked");
        setPhase("results");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Couldn't save that plan.");
      } finally {
        setBusy(false);
      }
    },
    [user],
  );

  const handleSbcFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setErrorMsg(null);
      try {
        const up = await uploadFile(file, "sbc");
        if (!up.documentId) throw new Error("Upload failed. Please try again.");
        // The plan-doc pipeline runs in the background and links the plan when
        // done; the check proceeds now and the results page reads live state.
        setIdentityDone("uploaded");
        setPhase("results");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Upload failed. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [uploadFile],
  );

  // ── A-4: account upgrade (linkWithCredential — uid unchanged, data follows) ──
  const handleUpgrade = useCallback(async () => {
    if (!user) return;
    setUpgradeError(null);
    const em = (upgradeEmail || user.email).trim();
    if (!EMAIL_RE.test(em)) {
      setUpgradeError("Enter a valid email address.");
      return;
    }
    if (upgradePassword.length < 8) {
      setUpgradeError("Password needs at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const cred = EmailAuthProvider.credential(em, upgradePassword);
      await linkWithCredential(user.firebaseUser, cred);
      await user.firebaseUser.getIdToken(true);
      // Passive resync flips is_anonymous + clears contact_email server-side;
      // the auth listener picks up the new state. Route into the full app.
      router.push("/claim");
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "auth/email-already-in-use" || code === "auth/credential-already-in-use") {
        setUpgradeError(
          "That email already has a Candid account. Sign in to it from the Sign in page — this check stays saved to this browser session.",
        );
      } else if (code === "auth/weak-password") {
        setUpgradeError("That password is too weak — try a longer one.");
      } else {
        setUpgradeError("Couldn't create the account. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }, [user, upgradeEmail, upgradePassword, router]);

  // ── drag-and-drop (mirrors /upload: react-dropzone + DropHover; without
  // this a dropped file navigates the browser to the file itself — A2-L2's
  // first FAIL). Type/size validation matches the upload page exactly.
  const validateFile = useCallback((file: File): string | null => {
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"];
    const isHeic = /\.(heic|heif)$/i.test(file.name);
    if (!allowedTypes.includes(file.type) && !isHeic) {
      return "Accepted formats: PDF, JPEG, PNG, or HEIC (iPhone photos).";
    }
    if (file.size > 20 * 1024 * 1024) return "File must be under 20MB.";
    return null;
  }, []);
  const onBillDrop = useCallback(
    (accepted: File[]) => {
      const file = accepted[0];
      if (!file) return;
      const bad = validateFile(file);
      if (bad) {
        setErrorMsg(bad);
        return;
      }
      setErrorMsg(null);
      setStagedFile(file);
    },
    [validateFile],
  );
  const onSbcDrop = useCallback(
    (accepted: File[]) => {
      const file = accepted[0];
      if (!file) return;
      const bad = validateFile(file);
      if (bad) {
        setErrorMsg(bad);
        return;
      }
      void handleSbcFile(file);
    },
    [validateFile, handleSbcFile],
  );
  const FILE_ACCEPT = {
    "application/pdf": [".pdf"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/heic": [".heic"],
    "image/heif": [".heif"],
  };
  const billDrop = useDropzone({
    onDrop: onBillDrop,
    accept: FILE_ACCEPT,
    maxFiles: 1,
    noKeyboard: true,
    disabled: busy,
  });
  const sbcDrop = useDropzone({
    onDrop: onSbcDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
    noKeyboard: true,
    disabled: busy,
  });

  if (!settled || !enabled || isFullAccount) {
    return <CubeLoaderBuilding className="min-h-screen" />;
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className={phase === "entry" ? "gradient-mesh" : undefined}>
        <div className="mx-auto max-w-2xl px-4 pb-16 pt-7">
          {/* header row */}
          <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
            <Link href="/" className="text-[19px] font-bold tracking-tight text-blue-600">
              candid
            </Link>
            <div className="flex items-center gap-4">
              <StepPills phase={phase} />
              {!user && phase === "entry" && (
                <Link href="/auth/signin" className="text-xs font-medium text-gray-400 transition hover:text-gray-600">
                  Sign in
                </Link>
              )}
            </div>
          </div>

          {errorMsg && phase !== "error" && (
            <div className="animate-fade-in mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMsg}
            </div>
          )}

          {phase === "entry" && (
            <div className={`${CARD} animate-fade-in p-8 sm:p-9`}>
              <span className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3.5 py-1.5 text-xs font-semibold text-blue-700 ring-1 ring-inset ring-blue-100">
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                No account needed
              </span>
              <h1 className="mt-4 text-[28px] font-extrabold leading-[1.15] tracking-tight text-gray-900">
                Check your medical bill — <span className="text-blue-600">free, no account</span>
              </h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-gray-500">
                Upload a bill. We check it for duplicate charges, billing math that doesn&apos;t add up, and — if you
                tell us your plan — charges that don&apos;t match what your plan says you owe.
              </p>
              <div className="mt-4 rounded-xl bg-emerald-50 px-3.5 py-2.5 text-sm font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
                We only flag what your documents prove. No estimates. No &quot;typical prices.&quot;
              </div>

              <div className="mt-6">
                {busy && fileName ? (
                  <DropUploading fileName={fileName} uploadProgress={uploadProgress} onCancel={() => {}} />
                ) : (
                  <div {...billDrop.getRootProps({ className: "cursor-pointer" })}>
                    <input {...billDrop.getInputProps()} />
                    {billDrop.isDragActive ? (
                      <DropHover />
                    ) : stagedFile ? (
                      <div className="flex items-center justify-between gap-3 rounded-xl bg-blue-50/60 px-4 py-3.5 ring-1 ring-inset ring-blue-100">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-blue-500" fill="none" aria-hidden>
                            <path d="M5 2.5h6.5L15 6v11.5H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                            <path d="M11.5 2.5V6H15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                          </svg>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-gray-900">{stagedFile.name}</span>
                            <span className="block text-xs text-gray-500">
                              {(stagedFile.size / 1024 / 1024).toFixed(1)} MB · click to choose a different file
                            </span>
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStagedFile(null);
                          }}
                          className="shrink-0 text-xs font-semibold text-gray-400 transition hover:text-red-500"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <DropIdle kind="bill" onPickFile={() => {}} tipsOpen={false} onToggleTips={() => {}} />
                    )}
                  </div>
                )}
              </div>
              <p className="mt-2.5 text-center text-xs text-gray-400">
                One bill per check · 14 pages max · PDF or photo
              </p>

              <div className="mt-7 border-t border-gray-100 pt-6">
                <label className={LABEL} htmlFor="check-email">
                  Email for your results
                </label>
                <input
                  id="check-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={`${INPUT} mt-1.5`}
                />
                <p className="mt-1.5 text-xs leading-relaxed text-gray-400">
                  We use your email to send your results and to honor deletion requests. Nothing else without your
                  say-so.
                </p>

                <label className="mt-5 flex cursor-pointer items-start gap-2.5 text-[13.5px] leading-relaxed text-gray-600">
                  <input
                    type="checkbox"
                    checked={consented}
                    onChange={(e) => setConsented(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-blue-600"
                  />
                  <span>
                    I agree to the{" "}
                    <Link href="/terms" className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-2">
                      Terms of Service
                    </Link>{" "}
                    and the{" "}
                    <Link href="/health-data" className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-2">
                      Consumer Health Data Privacy Policy
                    </Link>
                    , and{" "}
                    <Link href="/health-data" className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-2">
                      consent
                    </Link>{" "}
                    to Candid collecting and processing the health information I upload.
                  </span>
                </label>
                <p className="ml-[26px] mt-2 text-xs leading-relaxed text-gray-400">
                  Candid keeps de-identified, aggregated data — never your name, contact, or account details — to
                  improve price and coverage results for everyone. Details in the Health Data Consent.
                </p>
              </div>

              <button
                type="button"
                onClick={() => stagedFile && void runCheck(stagedFile)}
                disabled={!entryReady || !stagedFile || busy}
                className={`${BTN_PRIMARY} mt-7 w-full disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none`}
              >
                {busy ? "Checking…" : "Check my bill"}
              </button>

              <div className="mb-2 mt-7 flex justify-center">
                <TurnstileWidget ref={turnstileRef} onToken={onToken} action="anon_check" />
              </div>
            </div>
          )}

          {phase === "parsing" && parseDoc && (
            <div className="animate-fade-in">
              <UnifiedParseScreen
                docs={[parseDoc]}
                loaderVariant="stackV3"
                title="Reading your bill…"
                subtitle="Checking the charges…"
              />
            </div>
          )}

          {phase === "confirmGap" && (
            <div className={`${CARD} animate-fade-in p-8 text-center`}>
              <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-amber-50 text-lg font-bold text-amber-600 ring-1 ring-inset ring-amber-200">
                !
              </div>
              <h2 className="mt-4 text-lg font-bold tracking-tight text-gray-900">
                We need a second look at a couple of details.
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-gray-500">
                Your bill parsed, but a value needs your confirmation before we can assert anything from it — and
                this early version of the free check can&apos;t collect that yet. Your upload is saved; creating a
                free account lets you finish the review.
              </p>
              <Link href="/auth/signup" className={`${BTN_PRIMARY} mt-5`}>
                Create your free account
              </Link>
            </div>
          )}

          {phase === "identity" && (
            <div className={`${CARD} animate-fade-in p-8 sm:p-9`}>
              <h2 className="text-[22px] font-bold leading-tight tracking-tight text-gray-900">
                Which health plan were you on when you got this care?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-500">
                Your plan&apos;s own terms are what make a dispute stick. We compare this bill against what YOUR plan
                says you owe — never a look-alike plan.
              </p>
              {claimDosYear && (
                <p className="mt-1.5 text-xs text-gray-400">
                  This care is from {claimDosYear}, so we&apos;re asking about your {claimDosYear} plan.
                </p>
              )}

              {!missMode ? (
                <>
                  <div className="relative mt-5">
                    <svg
                      viewBox="0 0 20 20"
                      className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                      fill="none"
                      aria-hidden
                    >
                      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Insurer or plan name — e.g. Blue Cross Bronze"
                      className={`${INPUT} pl-10`}
                    />
                  </div>
                  {yearRelaxed && claimDosYear && (
                    <p className="mt-2.5 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 ring-1 ring-inset ring-amber-200">
                      We have your plan&apos;s current terms, but this care is from {claimDosYear}. We can cite the
                      current terms as a clearly-labeled reference, but we can&apos;t claim they applied in{" "}
                      {claimDosYear}.
                    </p>
                  )}
                  {(searching || results.length > 0 || query.trim().length >= 2) && (
                    <div className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-xl ring-1 ring-gray-200">
                      {searching && <div className="px-4 py-3.5 text-sm text-gray-400">Searching…</div>}
                      {!searching && query.trim().length >= 2 && results.length === 0 && (
                        <div className="px-4 py-3.5 text-sm text-gray-500">
                          No matches — try fewer words, or use &quot;My plan isn&apos;t listed&quot;.
                        </div>
                      )}
                      {!searching &&
                        results.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => void pickPlan(r)}
                            disabled={busy}
                            className="flex w-full items-center justify-between bg-white px-4 py-3.5 text-left transition hover:bg-blue-50/60 disabled:opacity-50"
                          >
                            <span className="min-w-0 pr-3">
                              <span className="block truncate text-sm font-medium text-gray-900">{r.name}</span>
                              <span className="mt-0.5 block text-xs text-gray-500">
                                {r.insurerName}
                                {r.state ? ` · ${r.state}` : ""}
                                {r.year ? ` · ${r.year}` : ""}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset ${BADGE_STYLES[r.badgeLevel]}`}
                            >
                              {BADGE_LABELS[r.badgeLevel]}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button onClick={() => setMissMode(true)} className={BTN_GHOST}>
                      My plan isn&apos;t listed
                    </button>
                    <button
                      onClick={() => {
                        setIdentityDone("skipped");
                        setPhase("results");
                      }}
                      className="text-sm text-gray-400 underline decoration-gray-300 underline-offset-2 transition hover:text-gray-600"
                    >
                      Skip — check the bill alone
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="mt-6 font-semibold text-gray-900">We don&apos;t have your plan&apos;s terms yet.</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
                    Upload your plan&apos;s Summary of Benefits and Coverage (SBC) — the coverage PDF your insurer or
                    employer gave you — and we&apos;ll read it and use it for this check.
                  </p>
                  <div className={`mt-4 transition ${busy ? "opacity-40" : ""}`}>
                    {busy && fileName ? (
                      <DropUploading fileName={fileName} uploadProgress={uploadProgress} onCancel={() => {}} />
                    ) : (
                      <div {...sbcDrop.getRootProps({ className: "cursor-pointer" })}>
                        <input {...sbcDrop.getInputProps()} />
                        {sbcDrop.isDragActive ? (
                          <DropHover />
                        ) : (
                          <DropIdle kind="plan" onPickFile={() => {}} tipsOpen={false} onToggleTips={() => {}} />
                        )}
                      </div>
                    )}
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-gray-400">
                    Plan documents also improve Candid&apos;s coverage of that plan for everyone. Your name, ID
                    numbers, and personal details are never shared.
                  </p>
                  <div className="mt-4 flex justify-center">
                    <TurnstileWidget ref={turnstileRef} onToken={onToken} action="anon_check_sbc" />
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-4">
                    <button
                      onClick={() => setMissMode(false)}
                      className="text-sm font-medium text-blue-600 underline decoration-blue-200 underline-offset-2"
                    >
                      Back to search
                    </button>
                    <button
                      onClick={() => {
                        setIdentityDone("skipped");
                        setPhase("results");
                      }}
                      className="text-sm text-gray-400 underline decoration-gray-300 underline-offset-2 transition hover:text-gray-600"
                    >
                      Skip — check the bill alone
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {phase === "results" && claimId && (
            <div className="animate-fade-in">
              {identityDone === "skipped" && (
                <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-500 ring-1 ring-inset ring-gray-200">
                  Checked without your plan
                </div>
              )}
              {identityDone === "uploaded" && (
                <div className="mb-3 rounded-xl bg-blue-50 px-3.5 py-2.5 text-xs leading-relaxed text-blue-700 ring-1 ring-inset ring-blue-100">
                  Your plan document is being read — plan-based findings appear here as soon as it finishes.
                </div>
              )}
              <ClaimDetail claimId={claimId} onBack={() => setPhase("identity")} backLabel="Change your plan" />

              <div className="mt-7 rounded-2xl border border-blue-100 bg-gradient-to-b from-blue-50 to-white p-6 text-center sm:p-7">
                <h3 className="text-[17px] font-bold tracking-tight text-gray-900">Keep these results — and act on them</h3>
                <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-gray-500">
                  A free account saves this check, lets you add the EOB or your plan documents later, and turns
                  findings into a dispute letter you approve word by word.
                </p>
                {!upgradeOpen ? (
                  <button
                    onClick={() => {
                      setUpgradeEmail(email);
                      setUpgradeOpen(true);
                    }}
                    className={`${BTN_PRIMARY} mt-4`}
                  >
                    Create your free account
                  </button>
                ) : (
                  <div className="mx-auto mt-4 max-w-sm text-left">
                    <label className={LABEL}>Email</label>
                    <input
                      type="email"
                      value={upgradeEmail}
                      onChange={(e) => setUpgradeEmail(e.target.value)}
                      className={`${INPUT} mt-1`}
                    />
                    <label className={`${LABEL} mt-3`}>Password</label>
                    <input
                      type="password"
                      value={upgradePassword}
                      onChange={(e) => setUpgradePassword(e.target.value)}
                      className={`${INPUT} mt-1`}
                    />
                    {upgradeError && <p className="mt-2 text-xs leading-relaxed text-red-600">{upgradeError}</p>}
                    <button onClick={() => void handleUpgrade()} disabled={busy} className={`${BTN_PRIMARY} mt-4 w-full`}>
                      {busy ? "Creating…" : "Create your free account"}
                    </button>
                  </div>
                )}
                <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-gray-400">
                  A letter demands money in your name. That takes an account — you review every word before anything
                  is sent, and the response gets tracked.
                </p>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className={`${CARD} animate-fade-in p-8 text-center`}>
              <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-red-50 text-lg font-bold text-red-500 ring-1 ring-inset ring-red-200">
                !
              </div>
              <h2 className="mt-4 text-lg font-bold tracking-tight text-gray-900">That didn&apos;t work.</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-gray-500">{errorMsg}</p>
              <button
                onClick={() => {
                  setPhase("entry");
                  setErrorMsg(null);
                  setParseDoc(null);
                  setDocumentId(null);
                }}
                className={`${BTN_GHOST} mt-5`}
              >
                Try another file
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

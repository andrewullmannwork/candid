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
import { useAuth } from "@/lib/auth/auth-context";
import { useFeatureFlag } from "@/lib/config/use-feature-flag";
import { CubeLoaderBuilding } from "@/components/loaders/CubeLoaderBuilding";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/security/TurnstileWidget";
import { useDropzone } from "react-dropzone";
import { DropIdle, DropHover, DropUploading } from "@/components/upload/DropZoneStates";
import { UnifiedParseScreen, type ParseDoc } from "@/components/parsing/UnifiedParseScreen";
import { ClaimDetail } from "@/components/claims/ClaimDetail";
import { PlanSearchCountLine } from "@/components/shared/PlanSearchCountLine";
import { getConsentDocument } from "@/lib/consent/consent-documents";
import { DisputeDraftOverlayProvider } from "@/lib/loading/dispute-draft-overlay";
import { UploadFlowProvider } from "@/lib/upload/upload-flow-context";

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

// S316 — the anonymous letter gate: renders inline under "Draft my dispute
// letter" (via ClaimDetail's anonymousDraftGate prop) instead of letting the
// click reach /api/disputes/generate's 403. The explainer sentence relocated
// here FROM the bottom card's footnote — the letter-specific justification
// lives at the letter button, the card keeps the save/act framing (one
// sentence, one home). "Email me my results" tries the stored contact first;
// the server answers email_required when none is on file and the input mode
// collects one.
function LetterAccountGate({
  onCreateAccount,
  sendResults,
}: {
  /** S316 round 3 — navigates to the ESTABLISHED signup flow with the typed
   *  contact prefilled (/auth/signup?email=…); the anonymous session upgrades
   *  INSIDE that flow via credential-linking, so the check carries over. */
  onCreateAccount: () => void;
  sendResults: (
    email?: string,
  ) => Promise<{ sentTo: string } | { needEmail: true } | { error: string }>;
}) {
  const [mode, setMode] = useState<"idle" | "input" | "sending" | "sent">("idle");
  const [inputEmail, setInputEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const doSend = async (email?: string) => {
    setMode("sending");
    setErrMsg(null);
    const res = await sendResults(email);
    if ("sentTo" in res) {
      setSentTo(res.sentTo);
      setMode("sent");
    } else if ("needEmail" in res) {
      setMode("input");
    } else {
      setErrMsg(res.error);
      setMode("idle");
    }
  };

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-left">
      <p className="text-[15px] font-semibold text-gray-900">
        A dispute letter is a demand for reimbursement or debt forgiveness
      </p>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-gray-500">
        In order to accurately draft this letter, you&apos;ll need to create a free account. We then organize all
        your data and give you the document to review and send. Everything from this check carries over
        automatically.
      </p>
      {/* S316 (#5) — the sent confirmation lives INSIDE the card, full width;
          the card and its join ask stay put, only the email action retires. */}
      {mode === "sent" && (
        <div className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-emerald-200 bg-emerald-50 px-3.5 py-2.5">
          <svg style={{ width: 16, height: 16 }} className="flex-shrink-0 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-[13px] leading-relaxed text-emerald-800">
            Sent to {sentTo}. Your results stay right here in this browser too.
          </p>
        </div>
      )}
      {mode === "input" ? (
        <div className="mt-3.5 flex items-center gap-2.5">
          <input
            type="email"
            value={inputEmail}
            onChange={(e) => setInputEmail(e.target.value)}
            placeholder="you@example.com"
            className={`${INPUT} flex-1`}
          />
          <button
            onClick={() => void doSend(inputEmail.trim())}
            disabled={!EMAIL_RE.test(inputEmail.trim())}
            className="rounded-xl bg-blue-600 px-[18px] py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
          <button
            onClick={onCreateAccount}
            className="rounded-xl bg-blue-600 px-[18px] py-2.5 text-[13.5px] font-semibold text-white transition hover:bg-blue-700"
          >
            Create your free account
          </button>
          {mode === "sent" ? (
            <button
              disabled
              className="rounded-xl border border-gray-200 bg-gray-100 px-[18px] py-2.5 text-[13.5px] font-semibold text-gray-400"
            >
              Sent ✓
            </button>
          ) : (
            <button
              onClick={() => void doSend()}
              disabled={mode === "sending"}
              className="rounded-xl border border-gray-300 bg-white px-[18px] py-2.5 text-[13.5px] font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
            >
              {mode === "sending" ? "Sending…" : "Email me my results"}
            </button>
          )}
        </div>
      )}
      {errMsg && <p className="mt-2 text-xs leading-relaxed text-red-600">{errMsg}</p>}
    </div>
  );
}

function StagedFileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-blue-50/60 px-4 py-3.5 ring-1 ring-inset ring-blue-100">
      <span className="flex min-w-0 items-center gap-2.5">
        <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-blue-500" fill="none" aria-hidden>
          <path d="M5 2.5h6.5L15 6v11.5H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M11.5 2.5V6H15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-gray-900">{file.name}</span>
          <span className="block text-xs text-gray-500">
            {(file.size / 1024 / 1024).toFixed(1)} MB · click to choose a different file
          </span>
        </span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="shrink-0 text-xs font-semibold text-gray-400 transition hover:text-red-500"
      >
        Remove
      </button>
    </div>
  );
}

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
  // email/consent; NOTHING uploads or parses until "Check my bill". Round 4:
  // the plan document stages the same way behind "Use this document".
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [sbcStaged, setSbcStaged] = useState<File | null>(null);
  // Which document the parse screen is driving: the bill (→ identity step) or
  // the plan doc (→ results, already adopted server-side by the activation
  // seam the status GET itself runs through).
  const [parseKind, setParseKind] = useState<"bill" | "sbc">("bill");
  const [parseDoc, setParseDoc] = useState<ParseDoc | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [claimDosYear, setClaimDosYear] = useState<number | null>(null);

  // S317 (Andrew) — a returning anonymous visitor's finished check. This page
  // mounted at "entry" unconditionally, so anyone who left and came back (the
  // signup escape link, the back button, a re-typed URL) met a blank upload box
  // while their parsed bill, picked plan and findings sat on the account
  // unsurfaced — the only way forward being to upload the same bill again.
  const [resumeClaimId, setResumeClaimId] = useState<string | null>(null);
  const [resumeDismissed, setResumeDismissed] = useState(false);
  const resumeProbedRef = useRef(false);

  // S317 (Andrew) — the plan this visitor already told us about. A second bill
  // in the same session used to re-ask for the insurer from an empty search box
  // even though the plan was active on the account. Held as identity only (name
  // + insurer); nothing is re-written when they keep it, because the plan is
  // already active — "Use this plan" is a navigation, not a save.
  const [knownPlan, setKnownPlan] = useState<{ name: string; insurer: string | null } | null>(null);
  const [changingPlan, setChangingPlan] = useState(false);

  // identity step
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [searching, setSearching] = useState(false);
  const [yearRelaxed, setYearRelaxed] = useState(false);
  const [identityDone, setIdentityDone] = useState<"picked" | "uploaded" | "skipped" | null>(null);
  const [missMode, setMissMode] = useState(false);
  /** S317 — showing the already-chosen plan instead of the search. Named once so
   *  the card's presence and the search's absence can never disagree, and so
   *  `missMode` (the no-match path) always wins: a visitor who reached it is
   *  telling us the known plan is not the answer. Declared after `missMode`
   *  deliberately — it reads it. */
  const keepingKnownPlan = !!knownPlan && !changingPlan && !missMode;

  // upgrade panel (A-4)
  // S316 — the screen's own recovery summary (ClaimDetail reports what it
  // renders); the results email sends THIS so it can never contradict the page.
  const [resultsSummary, setResultsSummary] = useState<{
    potentialRecovery: number;
    shouldOwe: number;
    /** S318 — the approved floor–ceiling share sentence's inputs (see
     *  ClaimDetail.onResultsSummary). */
    pricedFloor?: number | null;
    unpricedCount?: number;
    lines: { label: string; amount: number | null }[];
  } | null>(null);

  // ── Turnstile token plumbing: tokens are single-use (sync consumes one,
  // upload consumes another) — queue waiters across resets.
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  const tokenRef = useRef<string | null>(null);
  const tokenWaitersRef = useRef<Array<(t: string) => void>>([]);
  // S320 — re-mounts the (normally unmounted-once-established) widget when a
  // call answers turnstile_required, so the fallback retry can obtain a token.
  const [challengeRequested, setChallengeRequested] = useState(false);
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

  // S317 — does this anonymous visitor already have a check? Asks the SAME
  // endpoint the signed-in app uses (GET /api/claims: auth-gated, resolves the
  // user from the Firebase uid, and already returns S307 case-aware deduped
  // rows newest-first) — an anonymous token authenticates against it like any
  // other, so there is no new endpoint and no second notion of "your bills".
  //
  // Fail-soft by construction: any non-OK response, parse failure or throw
  // leaves `resumeClaimId` null and the ordinary entry screen renders. A
  // convenience lookup must never stand between someone and checking a bill.
  //
  // Fires once per mount (the ref), and only for an anonymous session — a full
  // account has already been redirected to /upload above. During a first-time
  // check the probe runs before any claim exists and correctly finds nothing;
  // the offer appears only on a LATER visit, which is exactly the trip that
  // used to dead-end.
  useEffect(() => {
    if (!settled || !enabled) return;
    if (!user?.isAnonymous || resumeProbedRef.current) return;
    resumeProbedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/claims?limit=1", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as { claims?: { id?: string }[] };
          const newest = data.claims?.[0]?.id;
          if (!cancelled && newest) setResumeClaimId(newest);
        }

        // S317 — the same hydration /onboarding already runs, for the same
        // reason: everything this visitor has told us once should not be asked
        // again. `contactEmail` is mig 229's typed results contact; the active
        // plan is the one they picked on their first bill.
        const pr = await fetch("/api/profile", { headers: { Authorization: `Bearer ${idToken}` } });
        if (!pr.ok) return;
        const pd = (await pr.json().catch(() => ({}))) as {
          contactEmail?: string | null;
          insurancePlan?: { plan_name?: string | null; insurer_name?: string | null } | null;
        };
        if (cancelled) return;
        // `prev ||` so a value typed while this was in flight always wins.
        if (pd.contactEmail) setEmail((prev) => prev || pd.contactEmail!);
        const planName = pd.insurancePlan?.plan_name;
        if (planName) {
          setKnownPlan({ name: planName, insurer: pd.insurancePlan?.insurer_name ?? null });
        }
      } catch {
        /* fail-soft — the entry screen renders exactly as before */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settled, enabled, user]);

  // ── upload one file through the existing pipeline ──
  // S320 one-check-per-session: an established session (server-stamped at the
  // Turnstile-verified anon start) uploads tokenless — no per-step challenge.
  // The server re-derives on every call and answers code "turnstile_required"
  // when it disagrees (config flipped off, TTL expired), so we challenge and
  // retry ONCE. Unestablished sessions keep the up-front token, avoiding a
  // wasted file POST.
  const uploadFile = useCallback(
    async (
      file: File,
      docType: "itemized_bill" | "sbc",
      asUser: {
        firebaseUser: { getIdToken: () => Promise<string> };
        turnstileSessionEstablished?: boolean;
      },
    ) => {
      const idToken = await asUser.firebaseUser.getIdToken();
      const attempt = async (token: string | null): Promise<Response> => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("docType", docType);
        if (token) formData.append("turnstileToken", token);
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
        // Reset only when a token was consumed — a reset re-runs the challenge,
        // which is exactly the per-step friction the tokenless path removes.
        if (token) turnstileRef.current?.reset();
        return res;
      };
      let res = await attempt(
        asUser.turnstileSessionEstablished ? null : await takeToken(),
      );
      if (res.status === 403) {
        const peek = (await res.clone().json().catch(() => ({}))) as { code?: string };
        if (peek.code === "turnstile_required") {
          // Re-mount the widget for this one retry (it unmounts once the
          // session is established), then let it retire again.
          setChallengeRequested(true);
          try {
            res = await attempt(await takeToken());
          } finally {
            setChallengeRequested(false);
          }
        }
      }
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
    [takeToken],
  );

  // ── the bill entry: staged file + consent → anonymous account → upload → parse ──
  const runCheck = useCallback(
    async (file: File) => {
      setBusy(true);
      setErrorMsg(null);
      setFileName(file.name);
      try {
        let session = user;
        if (!session) {
          const consents = (["tos", "privacy_policy", "health_data_upload"] as const).map((t) => {
            const doc = getConsentDocument(t);
            return { type: t, version: doc.version, hash: doc.hash };
          });
          const token = await takeToken();
          // Thread the RETURNED account — setUser hasn't re-rendered this
          // closure yet (the round-6 "no session" stale-closure bug).
          session = await startAnonymousCheck(email.trim(), consents, token);
          // S320 — the reset pre-stocks the NEXT per-call token, which is
          // load-bearing ONLY when the session-skip config is off (without it,
          // takeToken would starve and time out). Established sessions upload
          // tokenless, so resetting would just re-challenge for nothing — the
          // "captcha on the loading screen" report.
          if (!session.turnstileSessionEstablished) {
            turnstileRef.current?.reset();
          }
        }
        const up = await uploadFile(file, "itemized_bill", session);
        if (!up.documentId) throw new Error("Upload failed. Please try again.");
        setDocumentId(up.documentId);
        setParseKind("bill");
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
          smartSkipOutcome?: string | null; linkedInsurancePlanId?: string | null;
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
          if (parseKind === "sbc") {
            // The status GET we just polled ran the activation seam server-side:
            // plan active + unlinked claims adopted. Land on results linked.
            if (data.linkedInsurancePlanId) {
              setIdentityDone("uploaded");
              setPhase("results");
            } else {
              setErrorMsg(
                "We couldn't read a health plan out of that document. Try the SBC PDF from your insurer, or skip and check the bill alone.",
              );
              setPhase("error");
            }
            return;
          }
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
  }, [phase, documentId, user, parseKind]);

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
              ...(stateFilter ? { state: stateFilter } : {}),
              ...(withYear && claimDosYear ? { planYear: claimDosYear } : {}),
            }),
          });
          const body = (await res.json().catch(() => ({}))) as { plans?: SearchResult[]; total?: number };
          return { plans: body.plans ?? [], total: body.total ?? (body.plans ?? []).length };
        };
        let out = await doSearch(true);
        let relaxed = false;
        if (out.plans.length === 0 && claimDosYear) {
          out = await doSearch(false);
          relaxed = out.plans.length > 0;
        }
        setResults(out.plans);
        setTotalMatches(out.total);
        setYearRelaxed(relaxed);
      } finally {
        setSearching(false);
      }
    },
    [user, claimDosYear, stateFilter],
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
        // The profile write's activation seam adopted the claim server-side.
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
      // The step-2 uploading card renders the shared `fileName` state, which
      // until now only the bill path set — so the plan upload showed the
      // BILL's name while in flight (S320 mobile E2E finding). Stage this
      // upload's own identity before the request goes out.
      setFileName(file.name);
      try {
        if (!user) throw new Error("Session expired — reload the page and try again.");
        const up = await uploadFile(file, "sbc", user);
        if (!up.documentId) throw new Error("Upload failed. Please try again.");
        if (up.status === "error") {
          throw new Error(up.error || "We couldn't read that document. Please try again.");
        }
        if (up.status === "awaiting_user_confirmation") {
          setPhase("confirmGap");
          return;
        }
        // A-thin (S315, Andrew-approved): the plan doc runs through the SAME
        // parse screen as the bill — results only after it's parsed, active,
        // and the claim adopted (all server-side at the activation seam).
        setSbcStaged(null);
        setDocumentId(up.documentId);
        setParseKind("sbc");
        setParseDoc({
          id: up.documentId,
          label: "Your plan document",
          fileName: file.name,
          phase: "parsing",
          uploadProgress: 100,
          totalPages: typeof up.classification?.pageCount === "number" ? up.classification.pageCount : null,
          step: null,
          realCompletedPages: null,
        });
        setPhase("parsing");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Upload failed. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [uploadFile, user],
  );

  // ── A-4: account upgrade (linkWithCredential — uid unchanged, data follows) ──
  // S316 — POST the results email. Sends to the stored contact; the server
  // answers email_required when none is on file (the gate then collects one).
  const sendResultsEmail = useCallback(
    async (
      overrideEmail?: string,
    ): Promise<{ sentTo: string } | { needEmail: true } | { error: string }> => {
      if (!user || !claimId) return { error: "Something went wrong. Reload and try again." };
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/check/email-results", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            claimId,
            ...(overrideEmail ? { email: overrideEmail } : {}),
            ...(resultsSummary ? { summary: resultsSummary } : {}),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { sentTo?: string; error?: string };
        if (res.ok && body.sentTo) return { sentTo: body.sentTo };
        if (res.status === 400 && body.error === "email_required") return { needEmail: true };
        return { error: body.error || "Couldn't send the email right now." };
      } catch {
        return { error: "Couldn't send the email right now." };
      }
    },
    [user, claimId, resultsSummary],
  );

  // S316 — true from upgrade-submit until the /onboarding push lands (or the
  // attempt fails). Read by the full-account guard above so the mid-upgrade
  // context flip can't bounce the user to /upload first.
  // S316 round 3 (Andrew) — account creation is THE ESTABLISHED SIGNUP FLOW,
  // not a /check-local form: navigate with the typed results contact
  // prefilled. The anonymous session upgrades INSIDE that flow (signUpStart
  // links the credential to the same Firebase user), so the bill, plan, and
  // findings carry over with zero data movement — and phone OTP, Turnstile,
  // funnel telemetry, and the verification/welcome emails all apply to the
  // upgrade exactly as to any signup.
  const goToSignup = useCallback(() => {
    router.push(email ? `/auth/signup?email=${encodeURIComponent(email)}` : "/auth/signup");
  }, [router, email]);

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
      setErrorMsg(null);
      setSbcStaged(file);
    },
    [validateFile],
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
    <UploadFlowProvider>
    <DisputeDraftOverlayProvider>
    <main className="min-h-screen bg-gray-50">
      <div className={phase === "entry" ? "gradient-mesh" : undefined}>
        {/* S316 — the results phase widens to the authed /claim habitat
            (max-w-4xl): ClaimDetail's line-items grid is sized for that inner
            width, and the narrower entry column crushed its Service column
            into overlapping text (the S315 transplant lesson, again). */}
        <div className={`mx-auto ${phase === "results" ? "max-w-4xl" : "max-w-2xl"} px-4 pb-16 pt-7`}>
          {/* header row */}
          <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
            <Link href="/" className="text-[19px] font-bold tracking-tight text-blue-600">
              candid
            </Link>
            <div className="flex items-center gap-4">
              {/* S317 (Andrew) — the plan step was a one-way door: no way back to
                  the bill, on any step. Everything needed already lives in state
                  (stagedFile / documentId / claimId), so stepping back is a phase
                  change and loses nothing.
                  Deliberately ONLY on `identity`: the results phase already has
                  ClaimDetail's own "Change your plan" back control, and a second
                  header control doing the same thing is two derivations of one
                  action. `parsing`/`confirmGap` are transient — there is no
                  stable step behind them to return to. */}
              {phase === "identity" && (
                <button
                  type="button"
                  onClick={() => setPhase("entry")}
                  className="text-xs font-medium text-gray-400 transition hover:text-gray-600"
                >
                  ← Back
                </button>
              )}
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
              <h1 className="text-[28px] font-extrabold leading-[1.15] tracking-tight text-gray-900">
                Check your medical bill — <span className="text-blue-600">free, no account</span>
              </h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-gray-500">
                We check for duplicate charges, math errors, and charges your plan says you shouldn&apos;t owe.
              </p>
              <div className="mt-4 rounded-xl bg-emerald-50 px-3.5 py-2 text-sm font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
                We only flag what your documents prove.
              </div>

              {/* S317 — OFFER, never a silent jump (the S291 StrandedPlanBanner
                  idiom): reopening someone's own results is their choice, and
                  "Check a different bill" leaves the upload path below exactly
                  as it was. Resuming reuses the normal terminal state — same
                  claimId, same phase, same ClaimDetail — so nothing new exists
                  to render a finished check. */}
              {resumeClaimId && !resumeDismissed && (
                <div className="animate-fade-in mt-5 rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <h2 className="text-[15px] font-bold tracking-tight text-gray-900">
                    You already checked a bill
                  </h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-gray-600">
                    Pick up where you left off, or start a new check.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => {
                        setClaimId(resumeClaimId);
                        setPhase("results");
                      }}
                      className={BTN_PRIMARY}
                    >
                      See my results
                    </button>
                    <button
                      type="button"
                      onClick={() => setResumeDismissed(true)}
                      className={BTN_GHOST}
                    >
                      Check a different bill
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-6">
                {busy && fileName ? (
                  <DropUploading fileName={fileName} uploadProgress={uploadProgress} onCancel={() => {}} />
                ) : (
                  <div {...billDrop.getRootProps({ className: "cursor-pointer" })}>
                    <input {...billDrop.getInputProps()} />
                    {billDrop.isDragActive ? (
                      <DropHover />
                    ) : stagedFile ? (
                      <StagedFileChip file={stagedFile} onRemove={() => setStagedFile(null)} />
                    ) : (
                      <DropIdle kind="bill" onPickFile={billDrop.open} tipsOpen={false} onToggleTips={() => {}} />
                    )}
                  </div>
                )}
              </div>


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
                <p className="mt-1.5 text-xs text-gray-400">Only used for your results and deletion requests.</p>

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

            </div>
          )}

          {phase === "parsing" && parseDoc && (
            <div className="animate-fade-in">
              <UnifiedParseScreen
                docs={[parseDoc]}
                loaderVariant="stackV3"
                title={parseKind === "sbc" ? "Reading your plan document…" : "Reading your bill…"}
                subtitle={parseKind === "sbc" ? "Pulling in your coverage terms…" : "Checking the charges…"}
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
                Which health plan were you on?
              </h2>
              <p className="mt-1.5 text-sm text-gray-500">
                We compare your bill against your plan&apos;s own terms — never a look-alike.
              </p>

              {/* S317 (Andrew) — a second bill in the same session already has a
                  plan on the account; re-asking from an empty search box throws
                  away something they told us. Keeping it writes NOTHING: the plan
                  is already active, so this advances exactly as a fresh pick does
                  (identityDone "picked" → results). Changing it falls straight
                  through to the unchanged search below, so the miss path, the
                  upload path and the skip path all keep working untouched. */}
              {keepingKnownPlan && (
                <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <p className="text-[10.5px] font-bold tracking-[0.09em] text-blue-600">
                    THE PLAN YOU CHOSE
                  </p>
                  <p className="mt-1 text-[15px] font-semibold text-gray-900">{knownPlan.name}</p>
                  {knownPlan.insurer && (
                    <p className="text-[13px] text-gray-500">{knownPlan.insurer}</p>
                  )}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => {
                        setIdentityDone("picked");
                        setPhase("results");
                      }}
                      className={BTN_PRIMARY}
                    >
                      Use this plan
                    </button>
                    <button
                      type="button"
                      onClick={() => setChangingPlan(true)}
                      className={BTN_GHOST}
                    >
                      Choose a different plan
                    </button>
                  </div>
                </div>
              )}

              {keepingKnownPlan ? null : !missMode ? (
                <>
                  <div className="mt-5 flex gap-2.5">
                    <div className="relative min-w-0 flex-1">
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
                        placeholder="Insurer or plan name"
                        className={`${INPUT} pl-10`}
                      />
                    </div>
                    <select
                      value={stateFilter}
                      onChange={(e) => setStateFilter(e.target.value)}
                      aria-label="State"
                      className="w-[92px] shrink-0 rounded-xl border border-gray-300 bg-white px-2.5 py-2.5 text-sm text-gray-700 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    >
                      <option value="">State</option>
                      <option value="AL">AL</option>
                      <option value="AK">AK</option>
                      <option value="AZ">AZ</option>
                      <option value="AR">AR</option>
                      <option value="CA">CA</option>
                      <option value="CO">CO</option>
                      <option value="CT">CT</option>
                      <option value="DE">DE</option>
                      <option value="FL">FL</option>
                      <option value="GA">GA</option>
                      <option value="HI">HI</option>
                      <option value="ID">ID</option>
                      <option value="IL">IL</option>
                      <option value="IN">IN</option>
                      <option value="IA">IA</option>
                      <option value="KS">KS</option>
                      <option value="KY">KY</option>
                      <option value="LA">LA</option>
                      <option value="ME">ME</option>
                      <option value="MD">MD</option>
                      <option value="MA">MA</option>
                      <option value="MI">MI</option>
                      <option value="MN">MN</option>
                      <option value="MS">MS</option>
                      <option value="MO">MO</option>
                      <option value="MT">MT</option>
                      <option value="NE">NE</option>
                      <option value="NV">NV</option>
                      <option value="NH">NH</option>
                      <option value="NJ">NJ</option>
                      <option value="NM">NM</option>
                      <option value="NY">NY</option>
                      <option value="NC">NC</option>
                      <option value="ND">ND</option>
                      <option value="OH">OH</option>
                      <option value="OK">OK</option>
                      <option value="OR">OR</option>
                      <option value="PA">PA</option>
                      <option value="RI">RI</option>
                      <option value="SC">SC</option>
                      <option value="SD">SD</option>
                      <option value="TN">TN</option>
                      <option value="TX">TX</option>
                      <option value="UT">UT</option>
                      <option value="VT">VT</option>
                      <option value="VA">VA</option>
                      <option value="WA">WA</option>
                      <option value="WV">WV</option>
                      <option value="WI">WI</option>
                      <option value="WY">WY</option>
                      <option value="DC">DC</option>
                    </select>
                  </div>
                  {yearRelaxed && claimDosYear && (
                    <p className="mt-2.5 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 ring-1 ring-inset ring-amber-200">
                      We have your plan&apos;s current terms, but this care is from {claimDosYear}. We can cite the
                      current terms as a clearly-labeled reference, but we can&apos;t claim they applied in{" "}
                      {claimDosYear}.
                    </p>
                  )}
                  {(searching || results.length > 0 || query.trim().length >= 2) && (
                    <div className="mt-3 max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-xl ring-1 ring-gray-200">
                      <PlanSearchCountLine shown={results.length} total={totalMatches} />
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
                  <h3 className="mt-6 text-lg font-bold tracking-tight text-gray-900">Upload your plan document</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Drop the coverage PDF from your insurer or employer — usually called an SBC.
                  </p>
                  <div className={`mt-4 transition ${busy ? "opacity-40" : ""}`}>
                    {busy && fileName ? (
                      <DropUploading fileName={fileName} uploadProgress={uploadProgress} onCancel={() => {}} />
                    ) : (
                      <div {...sbcDrop.getRootProps({ className: "cursor-pointer" })}>
                        <input {...sbcDrop.getInputProps()} />
                        {sbcDrop.isDragActive ? (
                          <DropHover />
                        ) : sbcStaged ? (
                          <StagedFileChip file={sbcStaged} onRemove={() => setSbcStaged(null)} />
                        ) : (
                          <DropIdle kind="plan" onPickFile={sbcDrop.open} tipsOpen={false} onToggleTips={() => {}} />
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => sbcStaged && void handleSbcFile(sbcStaged)}
                    disabled={!sbcStaged || busy}
                    className={`${BTN_PRIMARY} mt-5 w-full disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none`}
                  >
                    {busy ? "Reading…" : "Use this document"}
                  </button>
                  <div className="mt-5 flex flex-wrap items-center gap-4">
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
                  <p className="mt-4 text-[11px] leading-relaxed text-gray-400">
                    Plan documents also improve Candid&apos;s coverage of that plan for everyone. Your name, ID
                    numbers, and personal details are never shared.
                  </p>
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
                <div className="mb-3 rounded-xl bg-emerald-50 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-800 ring-1 ring-inset ring-emerald-200">
                  Your plan is linked — the check below uses its terms.
                </div>
              )}
              <ClaimDetail
                claimId={claimId}
                onBack={() => setPhase("identity")}
                backLabel="Change your plan"
                onResultsSummary={setResultsSummary}
                anonymousDraftGate={
                  user?.firebaseUser?.isAnonymous ? (
                    <LetterAccountGate onCreateAccount={goToSignup} sendResults={sendResultsEmail} />
                  ) : undefined
                }
              />

              {/* S319 (unified rail) — the bottom signup card is ABSORBED into
                  the rail's locked step 4 ("Recover the money" carries the
                  account ask + the LetterAccountGate buttons). One ask, one
                  home — two competing CTAs was the drift. */}
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
          {/* S320 — one human-check per session: once the server has answered
              that this session is established, the widget UNMOUNTS (a mounted
              widget auto-refreshes its expiring token, which re-challenges
              visibly — the "captcha on every screen" report). It re-mounts
              on demand only when a call answers turnstile_required. */}
          {(!user?.turnstileSessionEstablished || challengeRequested) && (
            <div className="mt-10 flex justify-center pb-4">
              <TurnstileWidget ref={turnstileRef} onToken={onToken} action="anon_check" />
            </div>
          )}
        </div>
      </div>
    </main>
    </DisputeDraftOverlayProvider>
    </UploadFlowProvider>
  );
}

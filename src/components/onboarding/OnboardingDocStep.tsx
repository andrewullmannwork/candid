"use client";

import { PlanSearchCountLine } from "@/components/shared/PlanSearchCountLine";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useAuth } from "@/lib/auth/auth-context";
import { TurnstileWidget, type TurnstileWidgetHandle } from "@/components/security/TurnstileWidget";
import { getDocTypeClass, type DocType, type DocTypeConfirmation } from "@/lib/classifier/doc-type-vocabulary";
import {
  OB_DOC_COPY,
  chipsFromClaimSummary,
  chipsFromPlanAnalyze,
  type ClaimChipSource,
  type ObChip,
  type PlanAnalyzeChipSource,
} from "@/lib/onboarding/simplified";
import { UnifiedParseScreen, derivePhase, type ParseDoc } from "@/components/parsing/UnifiedParseScreen";
import type { InsurerMismatchData, YearRolloverData } from "@/components/parsing/ParseTerminalView";
import { HealthConsentModal } from "./HealthConsentModal";
import { validateUploadFile, effectiveClientMaxBytes } from "@/lib/upload/upload-policy";
import { uploadDocumentFile, getUploadLimits } from "@/lib/upload/client-upload";
import { useUploadLimits } from "@/lib/upload/use-upload-limits";

/** What step 2 stores in flow state. */
export interface DocSlotValue {
  kind: "plan" | "bill" | "background";
  fileName: string | null;
  chips: ObChip[];
  /** S288: this slot was filled by the plan-library search, not an upload
   *  (fileName then holds the "Plan name — Insurer" label). */
  via?: "search";
  /** S286: further coverage docs on file (names) — restore + session history. */
  extraFiles?: string[];
  /** S316 (approved mock B): the same docs with kind + parse state, rendered
   *  as labeled rows. Preferred over extraFiles when present; extraFiles
   *  stays for the in-step upload merge, which knows only filenames. */
  extraDocs?: { fileName: string; kindLabel: string | null; checked: boolean }[];
  /** S286: coverage docs beyond the displayed names. */
  moreCount?: number;
}

/**
 * Step 2 — plan document or bill. Single dropzone (design: quiet doc-type
 * explainer instead of an upfront type ask): we submit docType
 * "plan_document" and let the classifier resolve — Pattern P silently
 * overrides confident cases (`resolvedDocType`), and the S94 confirmation
 * prompt handles ambiguous ones in-step.
 *
 * Composes the same production pipeline as /upload (consent v1.6 gate,
 * Turnstile CF-34 mount-on-pick, XHR POST /api/documents/upload, 4s status
 * poll incl. needsTrigger re-fire), with two fixes over the v7 reference:
 *   1. `awaitingDocTypeConfirmation` is checked BEFORE `isLargeDoc` — a large
 *      doc halted for type confirmation must not be released to run in the
 *      background (it would park at awaiting_user_confirmation forever).
 *   2. Canonical-match confirm/reject sends the Authorization header the
 *      server requires for those actions (the v7 call silently never
 *      persisted).
 *
 * Design change vs v7: no mid-flow exit. A parsed plan doc renders coverage
 * chips in-step (POST /api/plan/analyze); a parsed bill renders its audit
 * result in-step (GET /api/claims?documentId=…). Finishing lands on the
 * dashboard, where the meter and the Claim card carry the same results.
 */
/** /api/plan/search result row (canonical library; S107 — id IS canonical). */
interface PlanSearchResult {
  canonicalPlanId: string;
  name: string;
  type: string | null;
  state: string | null;
  metalLevel: string | null;
  deductible: number | null;
  year: number | null;
  insurerName: string;
}

export function OnboardingDocStep({
  value,
  onDone,
  onReplace,
  hasConsented,
  grantConsent,
  searchSeed,
  emphasizeCurrent,
  onCardCleared,
  /* S317 — copy overrides for plan-change mode. Optional BY DESIGN: the default
     is the S289-approved signup copy, which is correct wherever it is omitted,
     so an absent prop is a right answer rather than a silent gap. The mode-aware
     parent decides; this component stays presentational (same shape as
     `searchSeed`). */
  explainerRows = OB_DOC_COPY.explainer,
  dropTitle = OB_DOC_COPY.dropTitle,
  searchToggleLabel = OB_DOC_COPY.searchToggle,
}: {
  value: DocSlotValue | null;
  onDone: (v: DocSlotValue) => void;
  onReplace: () => void;
  hasConsented: boolean;
  grantConsent: () => Promise<void>;
  /** S288 soft fill: pre-typed search text from the card step (scanned plan
   *  name > typed insurer). Plain editable text — never a locked filter. */
  searchSeed?: string | null;
  /** S288 plan-change mode: render the done-card as a PROMINENT current-plan
   *  card (eyebrow + full name + a real Replace button) so what's-on-file vs
   *  what-you're-changing is unmistakable. */
  emphasizeCurrent?: boolean;
  /** S288 (e3e): the server cleared the card IDs (cross-insurer switch) —
   *  the flow mirrors it by clearing its card slot. */
  onCardCleared?: () => void;
  explainerRows?: readonly { tag: string; items: string }[];
  dropTitle?: string;
  searchToggleLabel?: string;
}) {
  const { user } = useAuth();

  const [uploading, setUploading] = useState(false);
  // S322 — the drop-zone size hint derives from the live admin-tuned limit.
  const uploadLimits = useUploadLimits();
  const maxFileMb = Math.round(effectiveClientMaxBytes(uploadLimits) / 1024 / 1024);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progressPages, setProgressPages] = useState<{ done: number; total: number } | null>(null);
  const [parseStep, setParseStep] = useState<string | null>(null);
  const [parseSmartSkip, setParseSmartSkip] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<DocTypeConfirmation | null>(null);
  const [canonicalMatch, setCanonicalMatch] = useState<{
    canonicalPlanId: string;
    matchedPlanName: string;
    confidence: number;
    sourceCount: number;
    insurerName: string;
  } | null>(null);
  // S291 (Andrew E2E) — plan-identity divergence. process-plan.ts parks a
  // diverging parse at is_active=false and hands back insurerMismatch, EXPECTING
  // a Keep/Switch prompt (this is the same contract /upload honours via
  // ProcessingFlow → MismatchPrompt). Onboarding read only
  // `pending_canonical_match` off that payload and fell through to
  // settleProcessed, so a fully-parsed plan was silently stranded inactive while
  // /plan kept rendering the card-derived one ("your insurance card alone
  // doesn't reveal your specific coverage"). These two states restore the prompt.
  const [mismatch, setMismatch] = useState<InsurerMismatchData | null>(null);
  const [yearRollover, setYearRollover] = useState<YearRolloverData | null>(null);
  const [resolving, setResolving] = useState(false);
  const finalDocTypeRef = useRef<DocType>("plan_document");

  const [showConsent, setShowConsent] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  /* ── S288: plan-library search — upload's peer alternative ──────────────── */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlanSearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchSelecting, setSearchSelecting] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchReqRef = useRef(0);

  const runSearch = useCallback(
    async (q: string) => {
      if (!user || q.trim().length < 2) {
        setSearchResults([]);
        setSearchLoading(false);
        return;
      }
      const reqId = ++searchReqRef.current;
      setSearchLoading(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ query: q.trim(), canonicalOnly: true }),
        });
        const data = (await res.json().catch(() => ({}))) as { plans?: PlanSearchResult[]; total?: number };
        if (searchReqRef.current === reqId) {
          setSearchResults((data.plans ?? []).filter((p) => p.canonicalPlanId));
          setSearchTotal(typeof data.total === "number" ? data.total : (data.plans ?? []).length);
        }
      } catch {
        if (searchReqRef.current === reqId) setSearchResults([]);
      } finally {
        if (searchReqRef.current === reqId) setSearchLoading(false);
      }
    },
    [user],
  );

  // Debounced search-as-you-type (the seed auto-runs through this too).
  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => void runSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchOpen, searchQuery, runSearch]);

  const openSearch = useCallback(() => {
    setSearchError("");
    setSearchOpen(true);
    // Soft fill (S288): seed from the card step — scanned plan name > typed
    // insurer. Plain editable text; clear it and type anything.
    if (!searchQuery && searchSeed) setSearchQuery(searchSeed);
  }, [searchQuery, searchSeed]);

  const selectPlan = useCallback(
    async (p: PlanSearchResult) => {
      if (!user) return;
      setSearchSelecting(true);
      setSearchError("");
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/plan/set-active", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ canonicalPlanId: p.canonicalPlanId }),
        });
        if (!res.ok) throw new Error("set-active failed");
        const setActive = (await res.json().catch(() => ({}))) as { cardCleared?: boolean };
        if (setActive.cardCleared === true) onCardCleared?.();
        // Same in-step "it took" feedback as a successful doc parse: coverage
        // chips from the now canonical-linked active plan.
        let chips: ObChip[] = [];
        try {
          const ar = await fetch("/api/plan/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({}),
          });
          const ad = (await ar.json().catch(() => ({}))) as PlanAnalyzeChipSource;
          chips = chipsFromPlanAnalyze(ad);
        } catch {
          /* chips are decorative — the selection stands without them */
        }
        onDone({
          kind: "plan",
          via: "search",
          fileName: [p.name, p.insurerName].filter(Boolean).join(" — "),
          chips,
        });
        setSearchOpen(false);
      } catch {
        setSearchError(OB_DOC_COPY.searchError);
      } finally {
        setSearchSelecting(false);
      }
    },
    [user, onDone, onCardCleared],
  );

  const [userPickedFile, setUserPickedFile] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);
  useEffect(() => {
    turnstileTokenRef.current = turnstileToken;
  }, [turnstileToken]);

  /* ── In-step result summaries ───────────────────────────────────────────── */

  const summarizePlan = useCallback(async (file: string) => {
    if (!user) return;
    setSummarizing(true);
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/plan/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as PlanAnalyzeChipSource;
      // Shared shaping (chipsFromPlanAnalyze) unwraps display-state-decorated
      // values — a raw decorated object as a React child crashes the flow (S286).
      onDone({ kind: "plan", fileName: file, chips: chipsFromPlanAnalyze(data) });
    } catch {
      // Parse landed; the summary read is decorative — still mark done.
      onDone({ kind: "plan", fileName: file, chips: [] });
    } finally {
      setSummarizing(false);
    }
  }, [user, onDone]);

  const summarizeBill = useCallback(
    async (file: string, docId: string) => {
      if (!user) return;
      setSummarizing(true);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch(`/api/claims?documentId=${encodeURIComponent(docId)}&limit=1`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = (await res.json().catch(() => ({}))) as { claims?: ClaimChipSource[] };
        onDone({ kind: "bill", fileName: file, chips: chipsFromClaimSummary(data.claims?.[0]) });
      } catch {
        onDone({ kind: "bill", fileName: file, chips: [] });
      } finally {
        setSummarizing(false);
      }
    },
    [user, onDone],
  );

  const settleProcessed = useCallback(
    (file: string, docId: string | null) => {
      const kind = getDocTypeClass(finalDocTypeRef.current) === "bill" ? "bill" : "plan";
      if (kind === "bill" && docId) void summarizeBill(file, docId);
      else void summarizePlan(file);
    },
    [summarizeBill, summarizePlan],
  );

  /* ── Upload ─────────────────────────────────────────────────────────────── */

  const doUpload = useCallback(
    async (file: File) => {
      if (!user) return;
      setUploading(true);
      setError("");
      setFileName(file.name);
      try {
        const tokenWaitStart = Date.now();
        while (!turnstileTokenRef.current && Date.now() - tokenWaitStart < 12000) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const tokenForUpload = turnstileTokenRef.current;

        const idToken = await user.firebaseUser.getIdToken();

        // S322 — shared client helper (legacy body-POST or direct-to-storage
        // past the Vercel body cap); response contract unchanged.
        setUploadProgress(0);
        const res = await uploadDocumentFile({
          file,
          docType: "plan_document",
          idToken,
          turnstileToken: tokenForUpload ?? undefined,
          onProgress: setUploadProgress,
        });

        turnstileRef.current?.reset();

        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          if (res.status === 403 && errBody.error?.includes("Bot defense")) {
            setError("Bot defense check failed. Please reload the page and try again.");
          } else {
            setError(errBody.error || "Upload failed. Please try again.");
          }
          setUploading(false);
          return;
        }

        const uploadResult = (await res.json()) as {
          documentId?: string;
          resolvedDocType?: string;
          deduplicated?: boolean;
          status?: string;
          isLargeDoc?: boolean;
          awaitingDocTypeConfirmation?: boolean;
          confirmation?: DocTypeConfirmation;
          autoProcessed?: boolean;
          classification?: { pageCount?: number };
          message?: string;
        };
        if (uploadResult.documentId) setDocumentId(uploadResult.documentId);

        finalDocTypeRef.current =
          typeof uploadResult.resolvedDocType === "string"
            ? (uploadResult.resolvedDocType as DocType)
            : "plan_document";

        if (uploadResult.deduplicated === true && uploadResult.status === "processed") {
          setUploading(false);
          settleProcessed(file.name, uploadResult.documentId ?? null);
          return;
        }

        // BUG FIX vs the v7 reference: the doc-type confirmation halt MUST be
        // handled before the large-doc release — a doc can be both, and
        // releasing it un-confirmed parks it at awaiting_user_confirmation
        // with nothing ever queueing it.
        if (uploadResult.awaitingDocTypeConfirmation === true && uploadResult.confirmation) {
          setConfirmation(uploadResult.confirmation);
          setUploading(false);
          return;
        }

        if (uploadResult.isLargeDoc) {
          setUploading(false);
          onDone({ kind: "background", fileName: file.name, chips: [] });
          return;
        }

        if (uploadResult.autoProcessed) {
          setUploading(false);
          setProcessing(true);
          const pageCount = uploadResult.classification?.pageCount ?? 0;
          if (pageCount > 0) setProgressPages({ done: 0, total: pageCount });
        } else if (uploadResult.status === "pending_review") {
          setUploading(false);
          onDone({ kind: "background", fileName: file.name, chips: [] });
        } else if (uploadResult.status === "rejected") {
          setUploading(false);
          setError(
            uploadResult.message ||
              "This document could not be identified as a healthcare document. Try a plan document, bill, or EOB.",
          );
        } else {
          setUploading(false);
          setProcessing(true);
        }
      } catch (err) {
        console.error("[onboarding-upload] error:", err);
        setError("Upload failed. Please try again.");
        setUploading(false);
      }
    },
    [user, onDone, settleProcessed],
  );

  /* ── Status poll (4s + needsTrigger re-fire, same as /upload) ───────────── */

  useEffect(() => {
    if (!documentId || !processing) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/documents/status?id=${documentId}`);
        if (!res.ok || !active) return;
        const data = (await res.json()) as {
          status?: string;
          step?: string | null;
          totalPages?: number;
          completedPages?: number;
          isStuck?: boolean;
          needsTrigger?: boolean;
          smartSkipOutcome?: string | null;
          insurerMismatch?: InsurerMismatchData & {
            mismatch?: boolean;
            pending_canonical_match?: typeof canonicalMatch;
            year_rollover?: YearRolloverData;
          };
        };
        setParseStep(data.step ?? null);
        if (data.smartSkipOutcome) setParseSmartSkip(data.smartSkipOutcome);
        if (typeof data.totalPages === "number" && data.totalPages > 0) {
          setProgressPages({ done: data.completedPages ?? 0, total: data.totalPages });
        }
        if (data.status === "processed") {
          active = false;
          setProcessing(false);
          // Order mirrors ProcessingFlow's predicate precedence: an identity
          // divergence outranks a canonical suggestion, because the server has
          // ALREADY parked the plan inactive for it — falling through here is
          // what silently discarded the parse (S291).
          if (data.insurerMismatch?.mismatch === true) {
            setMismatch(data.insurerMismatch);
            return;
          }
          if (data.insurerMismatch?.year_rollover) {
            setYearRollover(data.insurerMismatch.year_rollover);
            return;
          }
          if (data.insurerMismatch?.pending_canonical_match) {
            setCanonicalMatch(data.insurerMismatch.pending_canonical_match);
            return;
          }
          settleProcessed(fileName, documentId);
          return;
        }
        if (data.status === "pending_review") {
          active = false;
          setProcessing(false);
          onDone({ kind: "background", fileName, chips: [] });
          return;
        }
        if (data.status === "error" || data.isStuck) {
          active = false;
          setProcessing(false);
          setError(
            "We couldn't read that document. Try a clearer copy — or skip for now and add one from your dashboard anytime.",
          );
          setDocumentId(null);
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
        /* retry next tick */
      }
    };
    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [documentId, processing, fileName, onDone, settleProcessed]);

  /* ── Doc-type confirmation ──────────────────────────────────────────────── */

  const confirmDocType = useCallback(
    async (confirmedDocType: DocType) => {
      if (!user || !documentId) return;
      const pageCountHint = confirmation?.page_count ?? null;
      finalDocTypeRef.current = confirmedDocType;
      setConfirmation(null);
      setProcessing(true);
      if (pageCountHint && pageCountHint > 0) setProgressPages({ done: 0, total: pageCountHint });
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/documents/confirm-doc-type", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ documentId, action: "confirm", confirmedDocType }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Confirmation failed");
        }
      } catch (err) {
        console.error("[onboarding-upload] doc-type confirmation failed:", err);
        setProcessing(false);
        setError(err instanceof Error ? err.message : "Couldn't confirm document type. Please try again.");
        setDocumentId(null);
      }
    },
    [user, documentId, confirmation],
  );

  /* ── Canonical-match resolve — WITH the required auth header ────────────── */

  const resolveCanonical = useCallback(
    async (action: "confirm_canonical_match" | "reject_canonical_match") => {
      try {
        if (!user || !documentId) throw new Error("missing context");
        const idToken = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ documentId, action }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          console.error("[onboarding-upload] canonical resolve failed:", body.error);
        }
      } catch (err) {
        console.error("[onboarding-upload] canonical resolve failed:", err);
      }
      setCanonicalMatch(null);
      settleProcessed(fileName, documentId);
    },
    [user, documentId, fileName, settleProcessed],
  );

  /* ── Plan-identity divergence resolve (S291) ────────────────────────────── */

  /**
   * Keep/Switch for a diverging plan doc — the onboarding peer of /upload's
   * onUseThisPlan / onKeepCurrentFromMismatch.
   *
   * "use": `activate_plan` is the single authoritative server action — it
   * deactivates the old plan, activates the parsed one, repoints
   * profiles.active_insurance_plan_id, clears the stale card-derived cost
   * fields, and backfills insurer/plan_name/deductible from the new plan. We
   * deliberately do NOT send /upload's preceding POST /api/profile: that write
   * sets plan_name/insurer only for activate_plan to clear and re-derive them
   * from the same plan row moments later. One write, one source of truth.
   *
   * "keep": logs the disambiguation (same telemetry /upload sends) and leaves
   * the parsed plan inactive — now an explicit user choice rather than silent
   * data loss. Either way the step settles and onboarding continues; the user
   * is never trapped behind this prompt.
   */
  const resolveMismatch = useCallback(
    async (choice: "use" | "keep") => {
      setResolving(true);
      try {
        if (!user || !documentId) throw new Error("missing context");
        const idToken = await user.firebaseUser.getIdToken();
        // Disambiguation telemetry (S91 Option B) — fire-and-forget on BOTH
        // branches. `choice` + `modalType` are required by the route; omitting
        // them 400s.
        void fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            documentId,
            action: "record_disambiguation",
            choice: choice === "use" ? "use_this_plan" : "keep_current",
            modalType: "insurer_mismatch",
          }),
        }).catch(() => {
          /* telemetry only — never blocks the user's choice */
        });

        if (choice === "use") {
          const res = await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ documentId, action: "activate_plan" }),
          });
          const activated = (await res.json().catch(() => ({}))) as {
            error?: string;
            needsCardRescan?: boolean;
          };
          if (!res.ok) throw new Error(activated.error || "activate_plan failed");
          // Cross-insurer switches clear the scanned card server-side; tell the
          // flow so step 1 re-opens empty instead of showing a stale card.
          if (activated.needsCardRescan === true) onCardCleared?.();
        }
      } catch (err) {
        console.error("[onboarding-upload] mismatch resolve failed:", err);
        setError("We couldn't update your plan. You can change it anytime from your dashboard.");
      } finally {
        setResolving(false);
        setMismatch(null);
        settleProcessed(fileName, documentId);
      }
    },
    [user, documentId, fileName, settleProcessed, onCardCleared],
  );

  /**
   * New-plan-year doc — the same stranding mechanism (process-plan parks the
   * row inactive), so it needs the same prompt or it silently strands too.
   */
  const resolveYearRollover = useCallback(
    async (choice: "switch" | "keep") => {
      setResolving(true);
      try {
        if (!user || !documentId) throw new Error("missing context");
        const idToken = await user.firebaseUser.getIdToken();
        void fetch("/api/documents/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            documentId,
            action: "record_disambiguation",
            choice: choice === "switch" ? "use_this_plan" : "keep_current",
            modalType: "year_rollover",
          }),
        }).catch(() => {
          /* telemetry only */
        });
        if (choice === "switch") {
          const res = await fetch("/api/documents/status", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ documentId, action: "activate_plan" }),
          });
          if (!res.ok) throw new Error("activate_plan failed");
        }
      } catch (err) {
        console.error("[onboarding-upload] year-rollover resolve failed:", err);
        setError("We couldn't update your plan. You can change it anytime from your dashboard.");
      } finally {
        setResolving(false);
        setYearRollover(null);
        settleProcessed(fileName, documentId);
      }
    },
    [user, documentId, fileName, settleProcessed],
  );

  /* ── File intake ────────────────────────────────────────────────────────── */

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!user || acceptedFiles.length === 0) return;
      const file = acceptedFiles[0];
      // S322 — ONE validation (type + live admin-tuned size limit) shared by
      // every upload surface; replaces the hardcoded 20MB check.
      const uploadValidationError = validateUploadFile(file, await getUploadLimits());
      if (uploadValidationError) {
        setError(uploadValidationError);
        return;
      }
      setError("");
      setUserPickedFile(true);
      if (hasConsented) {
        void doUpload(file);
      } else {
        setPendingFile(file);
        setShowConsent(true);
      }
    },
    [user, hasConsented, doUpload],
  );

  async function handleConsentAccept() {
    setConsentSubmitting(true);
    try {
      await grantConsent();
      setShowConsent(false);
      if (pendingFile) {
        void doUpload(pendingFile);
        setPendingFile(null);
      }
    } catch (err) {
      console.error("Consent grant failed:", err);
      setError("Failed to record consent. Please try again.");
    } finally {
      setConsentSubmitting(false);
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/heic": [".heic"],
      "image/heif": [".heif"],
    },
    maxFiles: 1,
    disabled:
      uploading || processing || summarizing || searchSelecting || !!confirmation || !!canonicalMatch || !!value,
  });

  /* ── Done state ─────────────────────────────────────────────────────────── */
  if (value) {
    const isBackground = value.kind === "background";
    const prominent = emphasizeCurrent === true && !isBackground;
    return (
      <div
        className={`rounded-[18px] border bg-white shadow-sm ${
          isBackground ? "border-blue-200" : "border-emerald-300"
        } ${prominent ? "border-2 p-6" : "p-5"}`}
      >
        {prominent && (
          <p className="mb-2.5 text-[10.5px] font-bold tracking-[0.12em] text-emerald-700">
            {OB_DOC_COPY.currentPlanEyebrow}
          </p>
        )}
        <div className="flex items-center gap-2.5">
          {isBackground ? (
            <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </span>
          ) : (
            <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </span>
          )}
          <div className="min-w-0">
            <p className={`font-semibold text-gray-900 ${prominent ? "text-[15px]" : "text-sm"}`}>
              {isBackground
                ? "This one will take a few minutes"
                : value.via === "search"
                  ? OB_DOC_COPY.searchDone
                  : value.kind === "bill"
                    ? OB_DOC_COPY.parsedBill
                    : OB_DOC_COPY.parsedPlan}
            </p>
            <p
              className={
                prominent
                  ? "mt-0.5 text-[13px] leading-snug text-gray-600"
                  : "truncate text-xs text-gray-400"
              }
            >
              {isBackground
                ? "We're reading it in the background — we'll let you know the moment it's ready."
                : value.fileName}
            </p>
          </div>
          {!isBackground && (
            <button
              onClick={onReplace}
              className={
                prominent
                  ? "ml-auto shrink-0 self-start rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2 text-[13px] font-bold text-blue-700 transition-colors hover:bg-blue-100"
                  : "ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              }
            >
              {prominent ? OB_DOC_COPY.replacePlan : "Replace"}
            </button>
          )}
        </div>
        {value.chips.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {value.chips.map((c, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                  c.verified
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-gray-200 bg-gray-50 text-gray-600"
                }`}
              >
                <span>{c.label}</span>
                <span className={c.mono ? "font-mono text-[11px]" : "font-bold"}>{c.value}</span>
                {c.verified && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                )}
              </span>
            ))}
          </div>
        )}
        {((value.extraDocs?.length ?? 0) > 0 || (value.extraFiles?.length ?? 0) > 0 || (value.moreCount ?? 0) > 0) && (
          /* S286: the rest of the user's coverage docs, so the card answers
             "which document(s)" — not just the latest upload. S316 (approved
             mock B): labeled rows with kind + parse state, so a bill AND an
             EOB both read as unmistakably already added. */
          <div className="mt-3 border-t border-gray-100 pt-2.5">
            <p className="text-[10.5px] font-bold tracking-[0.09em] text-blue-600">ALREADY ON YOUR ACCOUNT</p>
            {value.extraDocs?.length
              ? value.extraDocs.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 border-b border-gray-50 py-1.5 last:border-b-0">
                    <svg className="shrink-0 text-emerald-600" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    <p className="min-w-0 flex-1 truncate text-xs text-gray-700">
                      {d.kindLabel ? <span className="font-semibold">{d.kindLabel}</span> : null}
                      {d.kindLabel ? " · " : ""}
                      <span className="text-gray-500">{d.fileName}</span>
                    </p>
                    {d.checked && (
                      <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700">
                        Checked
                      </span>
                    )}
                  </div>
                ))
              : value.extraFiles?.map((f, i) => (
                  <p key={i} className="mt-1 truncate text-xs text-gray-500">
                    {f}
                  </p>
                ))}
            {(value.moreCount ?? 0) > 0 && (
              <p className="mt-1 text-xs text-gray-400">
                +{value.moreCount} more document{value.moreCount === 1 ? "" : "s"}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // Reuse the /upload parse animation (doc-stack chrome + rotating microcopy +
  // page counter) for the in-step processing state (S286, Andrew #1). Driven by
  // the same poll state; the existing settle logic unmounts it on `processed`.
  const parseDoc: ParseDoc = {
    id: documentId ?? "onboarding-doc",
    label: "Your document",
    fileName: fileName || "Your document",
    phase: derivePhase({
      uploadStatus: uploading ? "uploading" : "auto_processed",
      // Always "processing" — the settle branch below owns the summarizing
      // window, so the parse screen never renders for it (S286 flash fix).
      processingProgress: { status: "processing", totalPages: progressPages?.total ?? 0 },
      uploadProgress,
    }),
    uploadProgress,
    totalPages: progressPages?.total ?? null,
    step: parseStep,
    realCompletedPages: progressPages?.done ?? null,
    smartSkipOutcome: parseSmartSkip,
  };

  return (
    <>
      {/* Quiet doc-type explainer (design default: table style) */}
      <div className="mb-5 grid grid-cols-[auto_1fr] items-baseline gap-x-3.5 gap-y-1.5">
        {explainerRows.map((row) => (
          <div key={row.tag} className="contents">
            <div className="text-[10.5px] font-bold tracking-[0.09em] text-gray-400">{row.tag}</div>
            <div className="text-[13px] font-medium text-gray-700">{row.items}</div>
          </div>
        ))}
      </div>

      {confirmation ? (
        <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Quick check — what is this document?</p>
          <p className="text-xs leading-relaxed text-amber-700">
            This looks like it might be a different document type than expected. Results land in the
            right place when the type is right.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {confirmation.options.map((opt) => (
              <button
                key={opt}
                onClick={() => confirmDocType(opt)}
                className={`flex-1 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors ${
                  opt === confirmation.classifier_pick
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {getDocTypeClass(opt) === "bill" ? "It’s a bill / EOB" : "It’s a plan document"}
              </button>
            ))}
          </div>
        </div>
      ) : mismatch && mismatch.identity?.verdict === "uncertain" ? (
        /* S292 — resolver verdict `uncertain`: "we couldn't tell" is a
           different question from "these are different plans", so it gets its
           own two-button prompt instead of being dressed up as a mismatch the
           resolver never asserted. Copy is ParseTerminalView's
           IdentityUncertainPrompt verbatim (approved at S292) — /upload and
           onboarding must ask the same question the same way. Blue, not
           amber: a question, not a warning. */
        (() => {
          const onFile =
            mismatch.identity?.existingPlanName?.trim() || mismatch.existingPlanName?.trim();
          return (
            <div className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-semibold text-gray-900">
                Is this the same plan you already have on file?
              </p>
              <p className="text-xs leading-relaxed text-gray-600">
                {onFile ? (
                  <>
                    We couldn&apos;t tell from the document — <strong>{onFile}</strong> is
                    what&apos;s on file now.
                  </>
                ) : (
                  "We couldn't tell from the document which plan it belongs to."
                )}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void resolveMismatch("use")}
                  disabled={resolving}
                  className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  Yes, same plan
                </button>
                <button
                  onClick={() => void resolveMismatch("keep")}
                  disabled={resolving}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                >
                  No, it&apos;s different
                </button>
              </div>
            </div>
          );
        })()
      ) : mismatch ? (
        /* S291 — plan-identity divergence. Amber (a decision, not a
           suggestion): the parsed plan is sitting inactive until the user
           picks, so this must never be skippable-by-accident. */
        <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            {mismatch.type === "plan_name"
              ? "This document is for a different plan"
              : "This document is from a different insurer"}
          </p>
          <p className="text-xs leading-relaxed text-amber-800">
            We read your document, but it doesn’t match what’s on file. Pick the one that’s right
            and we’ll use it for your bills.
          </p>
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              On file now
            </p>
            <p className="mt-0.5 text-sm font-medium text-gray-900">
              {(mismatch.type === "plan_name"
                ? mismatch.existingPlanName
                : mismatch.existingInsurer) || "Your current plan"}
            </p>
          </div>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-500">
              In this document
            </p>
            <p className="mt-0.5 text-sm font-medium text-gray-900">
              {(mismatch.type === "plan_name"
                ? mismatch.parsedPlanName
                : mismatch.parsedInsurer) || "The plan you just uploaded"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void resolveMismatch("use")}
              disabled={resolving}
              className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              Use this plan
            </button>
            <button
              onClick={() => void resolveMismatch("keep")}
              disabled={resolving}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Keep my current plan
            </button>
          </div>
        </div>
      ) : yearRollover ? (
        <div className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-900">New plan year detected</p>
          <p className="text-xs leading-relaxed text-blue-700">
            This document is for your <strong>{yearRollover.newYear}</strong> plan. Your current
            plan is from <strong>{yearRollover.currentYear}</strong>. Switching activates your{" "}
            {yearRollover.newYear} benefits and resets your deductible progress.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void resolveYearRollover("switch")}
              disabled={resolving}
              className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              Switch to {yearRollover.newYear}
            </button>
            <button
              onClick={() => void resolveYearRollover("keep")}
              disabled={resolving}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Keep {yearRollover.currentYear}
            </button>
          </div>
        </div>
      ) : canonicalMatch ? (
        <div className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-900">We found a matching plan</p>
          <p className="text-xs leading-relaxed text-blue-700">
            Your document matches a plan already on Candid. Linking gives you community-verified
            benefit data from {canonicalMatch.sourceCount} other{" "}
            {canonicalMatch.sourceCount === 1 ? "member" : "members"}.
          </p>
          <div className="rounded-xl border border-blue-100 bg-white p-3">
            <p className="text-sm font-medium text-gray-900">{canonicalMatch.matchedPlanName}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {canonicalMatch.insurerName} · {Math.round(canonicalMatch.confidence * 100)}% match
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => resolveCanonical("confirm_canonical_match")}
              className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
            >
              Yes, this is my plan
            </button>
            <button
              onClick={() => resolveCanonical("reject_canonical_match")}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              Not my plan
            </button>
          </div>
        </div>
      ) : summarizing ? (
        /* Post-parse settle (S286 flash fix): the summary read after a parse or
           canonical-match resolve is sub-second — re-mounting the full parse
           screen for it flashed like a bug. Quiet done-card-chrome interim
           instead; transitions straight into the chips card. */
        <div className="rounded-[18px] border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </span>
            <p className="text-sm font-semibold text-gray-900">{OB_DOC_COPY.settling}</p>
          </div>
        </div>
      ) : uploading || processing ? (
        <UnifiedParseScreen docs={[parseDoc]} title="Reading your document" loaderVariant="stackV3" />
      ) : (
        <>
          <div
            {...getRootProps()}
            className={`flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-[18px] border-2 border-dashed p-6 text-center transition-all ${
              isDragActive
                ? "border-blue-400 bg-blue-50/60"
                : "border-gray-300 bg-gradient-to-b from-white to-gray-50 hover:border-blue-300 hover:bg-blue-50/40"
            }`}
          >
            <input {...getInputProps()} />
            <span className="inline-flex h-[46px] w-[46px] items-center justify-center rounded-full bg-blue-100 text-blue-600">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              </svg>
            </span>
            <div>
              <p className="text-[15px] font-semibold text-gray-900">{dropTitle}</p>
              <p className="mt-1 text-[13px] text-gray-400">
                or <span className="font-semibold text-blue-600">{OB_DOC_COPY.browse}</span> ·{" "}
                {OB_DOC_COPY.dropSub(maxFileMb)}
              </p>
            </div>
          </div>

          {/* S288 — the search is upload's PEER: either establishes the plan. */}
          {!searchOpen ? (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={openSearch}
                className="rounded-[10px] px-3 py-2 text-[13.5px] font-semibold text-blue-600 transition-colors hover:bg-blue-50"
              >
                {searchToggleLabel}
              </button>
            </div>
          ) : (
            <div className="mt-4 rounded-[18px] border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-2.5 flex items-center justify-between">
                <p className="text-[10.5px] font-bold tracking-[0.09em] text-gray-400">
                  FIND YOUR PLAN
                </p>
                <button
                  type="button"
                  onClick={() => setSearchOpen(false)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                >
                  {OB_DOC_COPY.searchBack}
                </button>
              </div>
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchError("");
                }}
                placeholder={OB_DOC_COPY.searchPlaceholder}
                disabled={searchSelecting}
                className="w-full rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
              />
              <p className="mt-2 text-xs leading-relaxed text-gray-400">{OB_DOC_COPY.searchHint}</p>

              {searchError && (
                <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3">
                  <p className="text-sm text-red-700">{searchError}</p>
                </div>
              )}

              {searchSelecting ? (
                <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-gray-100 bg-gray-50 px-3.5 py-3">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-blue-600">
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  </span>
                  <p className="text-sm font-medium text-gray-700">{OB_DOC_COPY.searchSelecting}</p>
                </div>
              ) : (
                <>
                  {searchResults.length > 0 && (
                    <div className="mt-3 max-h-[320px] divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200">
                      <PlanSearchCountLine shown={searchResults.length} total={searchTotal} />
                      {searchResults.map((p) => (
                        <button
                          key={p.canonicalPlanId}
                          type="button"
                          onClick={() => void selectPlan(p)}
                          className="block w-full px-3.5 py-2.5 text-left transition-colors hover:bg-blue-50/60"
                        >
                          <p className="text-[13.5px] font-medium leading-snug text-gray-900">
                            {[p.insurerName, p.name].filter(Boolean).join(": ")}
                          </p>
                          <p className="mt-0.5 text-xs text-gray-500">
                            {[
                              p.type,
                              p.metalLevel,
                              p.state,
                              p.deductible != null
                                ? `$${p.deductible.toLocaleString()} deductible`
                                : null,
                              p.year,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                  {searchLoading && (
                    <p className="mt-3 text-center text-xs text-gray-400">Searching…</p>
                  )}
                  {!searchLoading &&
                    searchQuery.trim().length >= 2 &&
                    searchResults.length === 0 && (
                      <p className="mt-3 text-center text-xs text-gray-400">
                        {OB_DOC_COPY.searchEmpty}
                      </p>
                    )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {userPickedFile && (
        <TurnstileWidget ref={turnstileRef} action="upload" onToken={setTurnstileToken} appearance="execute" />
      )}

      <HealthConsentModal
        open={showConsent}
        submitting={consentSubmitting}
        onAccept={handleConsentAccept}
        onCancel={() => {
          setShowConsent(false);
          setPendingFile(null);
        }}
      />
    </>
  );
}

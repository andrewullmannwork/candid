"use client";

/**
 * ParseTerminalView (S100 — replaces legacy /upload loader's nested
 * conditional prompts + action buttons).
 *
 * Discriminated-union variant prop renders ONE of 8 terminal states. Outer
 * shell + close button + header are consistent; inner content varies by
 * variant. All variants share the same max-w-lg card layout.
 *
 * Variants (8 total; collapsed from 10 in S100 v1 → 8 v2 via error+kind and
 * unusable+kind discriminators):
 *
 *   - unusable (kind: pending_review | rejected) — doc couldn't be parsed
 *   - dedup_processed — brief splash before redirect (already in library)
 *   - error (kind: error | stuck) — retry CTA + error message
 *   - mismatch — insurer or plan-name disagreement; 3-button prompt
 *   - year_rollover — different plan year detected; 2-button prompt
 *   - canonical_match — community-matched plan suggested; 2-button prompt
 *   - complete_plan — SBC/plan_doc success; premium prompt + supplement + View benefits
 *   - complete_bill — EOB/itemized_bill success; supplement + Run audit
 *
 * Extracted from src/app/(app)/upload/page.tsx:1149-1672 (S100 Stage 7c Phase 1).
 */
import Link from "next/link";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { PremiumPromptInline } from "@/components/parsing/PremiumPromptInline";

interface CommonProps {
  fileName: string;
  onUploadAnother: () => void;
}

interface UnusableVariantProps extends CommonProps {
  variant: "unusable";
  kind: "pending_review" | "rejected";
  errorMessage?: string;
}

interface DedupProcessedVariantProps extends CommonProps {
  variant: "dedup_processed";
}

interface ErrorVariantProps extends CommonProps {
  variant: "error";
  kind: "error" | "stuck";
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => Promise<void>;
}

export interface InsurerMismatchData {
  type?: "insurer" | "plan_name";
  existingInsurer?: string;
  parsedInsurer?: string;
  existingPlanName?: string;
  parsedPlanName?: string;
}

interface MismatchVariantProps extends CommonProps {
  variant: "mismatch";
  mismatch: InsurerMismatchData;
  submitting: boolean;
  onUseThisPlan: () => Promise<void>;
  onKeepCurrent: () => Promise<void>;
}

export interface YearRolloverData {
  currentYear: number;
  newYear: number;
}

interface YearRolloverVariantProps extends CommonProps {
  variant: "year_rollover";
  yearRollover: YearRolloverData;
  submitting: boolean;
  onSwitchYear: () => Promise<void>;
  onKeepCurrent: () => Promise<void>;
}

export interface CanonicalMatchData {
  canonicalPlanId: string;
  matchedPlanName: string;
  insurerName: string;
  confidence: number;
  sourceCount: number;
}

interface CanonicalMatchVariantProps extends CommonProps {
  variant: "canonical_match";
  canonicalMatch: CanonicalMatchData;
  submitting: boolean;
  onConfirmMatch: () => Promise<void>;
  onRejectMatch: () => Promise<void>;
}

interface CompletePlanVariantProps extends CommonProps {
  variant: "complete_plan";
  needsPremium: boolean;
  linkedInsurancePlanId: string | null;
  user: { firebaseUser: { getIdToken(): Promise<string> } } | null;
  premiumSaved: boolean;
  showSupplementPrompt: boolean;
  onPremiumSaved: (amount: number) => void;
  onPremiumSkipped: () => void;
}

interface CompleteBillVariantProps extends CommonProps {
  variant: "complete_bill";
  docType: "eob" | "itemized_bill";
  showSupplementPrompt: boolean;
}

export type ParseTerminalViewProps =
  | UnusableVariantProps
  | DedupProcessedVariantProps
  | ErrorVariantProps
  | MismatchVariantProps
  | YearRolloverVariantProps
  | CanonicalMatchVariantProps
  | CompletePlanVariantProps
  | CompleteBillVariantProps;

// ─── Header bits ────────────────────────────────────────────────────────────

function HeaderIcon({ variant, kind }: { variant: string; kind?: string }) {
  const isComplete = variant === "complete_plan" || variant === "complete_bill" || variant === "dedup_processed";
  const isErrorish = variant === "error" || (variant === "unusable" && (kind === "pending_review" || kind === "rejected"));
  if (isComplete) {
    return (
      <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
        <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (isErrorish) {
    const isHardError = variant === "error" && kind === "error";
    return (
      <div className={`w-16 h-16 rounded-full ${isHardError ? "bg-red-50" : "bg-amber-50"} flex items-center justify-center mx-auto mb-4`}>
        <svg className={`w-8 h-8 ${isHardError ? "text-red-500" : "text-amber-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
    );
  }
  // mismatch / year_rollover / canonical_match → blue spinner-like icon
  return (
    <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mx-auto mb-4 relative">
      <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
  );
}

function HeaderLabel({ variant, kind }: { variant: string; kind?: string }) {
  if (variant === "complete_plan" || variant === "complete_bill") return "All done!";
  if (variant === "dedup_processed") return "Already in your library";
  if (variant === "error" && kind === "stuck") return "Processing stalled";
  if (variant === "error") return "We had an issue with your upload";
  if (variant === "unusable" && kind === "pending_review") return "This one's stumping us";
  if (variant === "unusable" && kind === "rejected") return "Couldn't identify this document";
  if (variant === "mismatch") return "Review needed";
  if (variant === "year_rollover") return "New plan year detected";
  if (variant === "canonical_match") return "Plan match found";
  return "Processing complete";
}

// ─── Variant-specific prompt sections ───────────────────────────────────────

function PendingReviewPrompt({ onUploadAnother }: { onUploadAnother: () => void }) {
  return (
    <div className="mb-5 p-4 bg-amber-50 border border-amber-100 rounded-xl">
      <p className="text-sm font-medium text-amber-900">Couldn&apos;t recognize this document</p>
      <p className="text-sm text-amber-800 mt-1.5 leading-relaxed">
        We couldn&apos;t read this well enough to pull benefits. Want to try a different file?
      </p>
      <button
        onClick={onUploadAnother}
        className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}

function RejectedPrompt({ onUploadAnother, errorMessage }: { onUploadAnother: () => void; errorMessage?: string }) {
  return (
    <div className="mb-5 p-4 bg-amber-50 border border-amber-100 rounded-xl">
      <p className="text-sm font-medium text-amber-900">Couldn&apos;t identify this document</p>
      <p className="text-sm text-amber-800 mt-1.5 leading-relaxed">
        {errorMessage ?? "This document could not be identified as a healthcare document."}
      </p>
      <button
        onClick={onUploadAnother}
        className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
      >
        Try a different file
      </button>
    </div>
  );
}

function ErrorPrompt({ kind, canRetry, retrying, onRetry }: { kind: "error" | "stuck"; canRetry: boolean; retrying: boolean; onRetry: () => Promise<void> }) {
  const isStuck = kind === "stuck";
  return (
    <div className={`mb-5 p-4 ${isStuck ? "bg-amber-50 border-amber-100" : "bg-red-50 border-red-100"} border rounded-xl`}>
      <p className={`text-sm font-medium ${isStuck ? "text-amber-900" : "text-red-800"}`}>
        {isStuck ? "Processing seems stuck" : "Please try again, or upload a different document."}
      </p>
      {isStuck && (
        <p className="text-sm text-amber-800 mt-1">Your document has been processing for a while without progress.</p>
      )}
      {canRetry ? (
        <button
          onClick={() => void onRetry()}
          disabled={retrying}
          className="mt-3 w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {retrying ? "Retrying..." : isStuck ? "Retry processing" : "Try again"}
        </button>
      ) : (
        <p className={`text-xs ${isStuck ? "text-amber-700" : "text-red-600"} mt-1`}>
          {isStuck ? "Maximum retries reached. Please contact support." : "Please try uploading a different document, or contact support if this keeps happening."}
        </p>
      )}
    </div>
  );
}

function MismatchPrompt({ mismatch, submitting, onUseThisPlan, onKeepCurrent }: { mismatch: InsurerMismatchData; submitting: boolean; onUseThisPlan: () => Promise<void>; onKeepCurrent: () => Promise<void> }) {
  const isPlanMismatch = mismatch.type === "plan_name";
  const existingLabel = isPlanMismatch ? mismatch.existingPlanName : mismatch.existingInsurer;
  const newLabel = isPlanMismatch ? mismatch.parsedPlanName : mismatch.parsedInsurer;
  return (
    <div className="mb-5 p-5 bg-amber-50 border border-amber-200 rounded-2xl">
      <p className="text-sm font-semibold text-gray-900 mb-3">
        {isPlanMismatch ? "This document is for a different plan" : "This document is from a different insurer"}
      </p>
      <div className="p-3 bg-white border border-gray-200 rounded-xl mb-2">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">On your card</p>
        <p className="text-sm font-medium text-gray-900 mt-0.5">{existingLabel}</p>
      </div>
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl mb-4">
        <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">In this document</p>
        <p className="text-sm font-medium text-gray-900 mt-0.5">{newLabel}</p>
      </div>
      <div className="flex flex-col gap-2">
        <button
          onClick={() => void onUseThisPlan()}
          disabled={submitting}
          className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          Use this plan
        </button>
        <button
          onClick={() => void onKeepCurrent()}
          disabled={submitting}
          className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          Keep my current plan
        </button>
      </div>
    </div>
  );
}

function YearRolloverPrompt({ yearRollover, submitting, onSwitchYear, onKeepCurrent }: { yearRollover: YearRolloverData; submitting: boolean; onSwitchYear: () => Promise<void>; onKeepCurrent: () => Promise<void> }) {
  return (
    <div className="mb-5 p-5 bg-blue-50 border border-blue-200 rounded-2xl">
      <p className="text-sm font-semibold text-gray-900 mb-2">New plan year detected</p>
      <p className="text-xs text-gray-600 mb-4">
        This document is for your <strong>{yearRollover.newYear}</strong> plan. Your current plan is from{" "}
        <strong>{yearRollover.currentYear}</strong>. Switching will activate your {yearRollover.newYear} benefits and reset
        your deductible progress.
      </p>
      <div className="flex items-center gap-2 mb-4">
        <div className="flex-1 p-3 bg-white border border-gray-200 rounded-xl">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Current</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{yearRollover.currentYear} Plan</p>
        </div>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 p-3 bg-blue-100 border border-blue-200 rounded-xl">
          <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">New</p>
          <p className="text-sm font-medium text-gray-900 mt-0.5">{yearRollover.newYear} Plan</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <button
          onClick={() => void onSwitchYear()}
          disabled={submitting}
          className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          Switch to {yearRollover.newYear} plan
        </button>
        <button
          onClick={() => void onKeepCurrent()}
          disabled={submitting}
          className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          Keep {yearRollover.currentYear} plan
        </button>
      </div>
    </div>
  );
}

function CanonicalMatchPrompt({ canonicalMatch, submitting, onConfirmMatch, onRejectMatch }: { canonicalMatch: CanonicalMatchData; submitting: boolean; onConfirmMatch: () => Promise<void>; onRejectMatch: () => Promise<void> }) {
  return (
    <div className="mb-5 p-5 bg-indigo-50 border border-indigo-200 rounded-2xl">
      <p className="text-sm font-semibold text-gray-900 mb-3">We found a matching plan record</p>
      <div className="p-3 bg-white border border-indigo-200 rounded-xl mb-4">
        <p className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wide">Matched plan</p>
        <p className="text-sm font-medium text-gray-900 mt-0.5">{canonicalMatch.matchedPlanName}</p>
        <p className="text-xs text-gray-500 mt-0.5">{canonicalMatch.insurerName}</p>
        {canonicalMatch.sourceCount > 1 && (
          <p className="text-xs text-indigo-600 mt-1">
            {canonicalMatch.sourceCount} other member{canonicalMatch.sourceCount === 1 ? "" : "s"} uploaded this plan
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <button
          onClick={() => void onConfirmMatch()}
          disabled={submitting}
          className="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50"
        >
          Yes, this is my plan
        </button>
        <button
          onClick={() => void onRejectMatch()}
          disabled={submitting}
          className="w-full py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          No, different plan
        </button>
      </div>
    </div>
  );
}

function PlanSupplementCard() {
  return (
    <div className="mb-4 p-4 bg-blue-50 border border-blue-100 rounded-xl">
      <p className="text-sm font-medium text-blue-900">
        Good start — add your full plan document for the complete picture
      </p>
      <p className="text-sm text-blue-800 mt-1.5 leading-relaxed">
        We&apos;ve got the basics from your document — but for a complete benefits picture, add your Evidence of Coverage
        (EOC) or full plan certificate.
      </p>
    </div>
  );
}

function BillSupplementCard({ docType }: { docType: "eob" | "itemized_bill" }) {
  return (
    <div className="mb-4 p-4 bg-blue-50 border border-blue-100 rounded-xl">
      <p className="text-sm font-medium text-blue-900">Review before disputing</p>
      <p className="text-sm text-blue-800 mt-1.5 leading-relaxed">
        We processed this — for the most accurate audit, upload your matching{" "}
        {docType === "eob" ? "itemized bill" : "EOB"} and review line items before disputing.
      </p>
    </div>
  );
}

// ─── Variant body switch ────────────────────────────────────────────────────

function VariantBody(props: ParseTerminalViewProps) {
  switch (props.variant) {
    case "unusable":
      return props.kind === "pending_review" ? (
        <PendingReviewPrompt onUploadAnother={props.onUploadAnother} />
      ) : (
        <RejectedPrompt onUploadAnother={props.onUploadAnother} errorMessage={props.errorMessage} />
      );
    case "dedup_processed":
      return (
        <p className="mb-5 text-sm text-gray-600 text-center">
          This document is already in your library — redirecting you to your results.
        </p>
      );
    case "error":
      return (
        <ErrorPrompt
          kind={props.kind}
          canRetry={props.canRetry}
          retrying={props.retrying}
          onRetry={props.onRetry}
        />
      );
    case "mismatch":
      return (
        <MismatchPrompt
          mismatch={props.mismatch}
          submitting={props.submitting}
          onUseThisPlan={props.onUseThisPlan}
          onKeepCurrent={props.onKeepCurrent}
        />
      );
    case "year_rollover":
      return (
        <YearRolloverPrompt
          yearRollover={props.yearRollover}
          submitting={props.submitting}
          onSwitchYear={props.onSwitchYear}
          onKeepCurrent={props.onKeepCurrent}
        />
      );
    case "canonical_match":
      return (
        <CanonicalMatchPrompt
          canonicalMatch={props.canonicalMatch}
          submitting={props.submitting}
          onConfirmMatch={props.onConfirmMatch}
          onRejectMatch={props.onRejectMatch}
        />
      );
    case "complete_plan":
      return (
        <>
          {props.needsPremium && props.linkedInsurancePlanId && props.user && !props.premiumSaved && (
            <PremiumPromptInline
              planId={props.linkedInsurancePlanId}
              user={props.user}
              onSaved={props.onPremiumSaved}
              onSkip={props.onPremiumSkipped}
            />
          )}
          {props.showSupplementPrompt && <PlanSupplementCard />}
        </>
      );
    case "complete_bill":
      return props.showSupplementPrompt ? <BillSupplementCard docType={props.docType} /> : null;
  }
}

// ─── Action buttons (variant-aware) ─────────────────────────────────────────

function ActionButtons(props: ParseTerminalViewProps) {
  const showUploadAnother =
    props.variant === "unusable" ||
    props.variant === "error" ||
    props.variant === "complete_plan" ||
    props.variant === "complete_bill";

  return (
    <div className="flex flex-col gap-2">
      {props.variant === "complete_plan" && (
        <Link
          href="/plan"
          className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors text-center"
        >
          View your benefits
        </Link>
      )}
      {props.variant === "complete_bill" && (
        <Link
          href="/audit"
          className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors text-center"
        >
          Run audit
        </Link>
      )}
      {showUploadAnother && (
        <button
          onClick={props.onUploadAnother}
          className="w-full py-2.5 border border-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          Upload another document
        </button>
      )}
    </div>
  );
}

// ─── Top-level shell ────────────────────────────────────────────────────────

export function ParseTerminalView(props: ParseTerminalViewProps) {
  const showShareCard = props.variant === "complete_plan" || props.variant === "complete_bill";
  return (
    <div className="max-w-lg mx-auto">
      <div className="p-8 bg-white border border-gray-200 rounded-2xl glow-blue relative">
        {/* Close button */}
        <button
          onClick={props.onUploadAnother}
          className="absolute top-4 left-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {/* Header */}
        <div className="text-center mb-6">
          <HeaderIcon variant={props.variant} kind={"kind" in props ? props.kind : undefined} />
          <h3 className="text-xl font-semibold text-gray-900 animate-fade-in">
            <HeaderLabel variant={props.variant} kind={"kind" in props ? props.kind : undefined} />
          </h3>
          <p className="text-sm text-gray-500 mt-1">{props.fileName}</p>
        </div>
        <VariantBody {...props} />
        <ActionButtons {...props} />
      </div>
      {showShareCard && <ShareWithFriend surface="upload_complete" />}
    </div>
  );
}

function HeaderLabelHelper(...args: [string, string?]) {
  // Re-export helper used in HeaderLabel function above
  return args;
}
// Keep helper unused for tree-shake hygiene — referenced solely by HeaderLabel.
void HeaderLabelHelper;

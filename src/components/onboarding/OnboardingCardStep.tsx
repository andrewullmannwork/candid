"use client";

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { OB_CARD_COPY, type ObChip } from "@/lib/onboarding/simplified";
import { HealthConsentModal } from "./HealthConsentModal";
import type { InsuranceCardFields } from "@/types/insurance-card";

/** What step 1 stores in flow state once the card slot is done. */
export interface CardSlotValue {
  chips: ObChip[];
  manual: boolean;
  fileName: string | null;
  /** S288: seeds the step-2 plan search ("soft fill") — card-scanned plan name
   *  when a photo gave us one, else the typed insurer. Both optional. */
  insurer?: string | null;
  planName?: string | null;
}

interface PlanMismatchInfo {
  type: string;
  existingInsurer?: string;
  newInsurer?: string;
}

interface PendingCanonicalMatch {
  canonicalPlanId: string;
  matchedPlanName: string;
  confidence: number;
  sourceCount: number;
  insurerName: string;
}

const CARD_ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

function fieldsToChips(fields: InsuranceCardFields): ObChip[] {
  const chips: ObChip[] = [];
  if (fields.insurer) chips.push({ label: "Insurer", value: fields.insurer });
  if (fields.planType) chips.push({ label: "Plan type", value: fields.planType });
  if (fields.memberId) chips.push({ label: "Member ID", value: fields.memberId, mono: true });
  if (fields.groupNumber) chips.push({ label: "Group", value: fields.groupNumber, mono: true });
  const copays: string[] = [];
  if (fields.copayPrimary != null) copays.push(`PCP $${fields.copayPrimary}`);
  if (fields.copaySpecialist != null) copays.push(`Specialist $${fields.copaySpecialist}`);
  if (fields.copayEr != null) copays.push(`ER $${fields.copayEr}`);
  if (copays.length > 0) chips.push({ label: "Copays", value: copays.join(" · ") });
  return chips;
}

/** Scan fields → the exact POST /api/profile payload the legacy card step
 *  sends (same field names, plan_source:"insurance_card" triggers the
 *  mismatch pre-check + canonical matching server-side). */
function scanSavePayload(fields: InsuranceCardFields): Record<string, string> {
  const p: Record<string, string> = { plan_source: "insurance_card" };
  if (fields.insurer) p.insurer = fields.insurer;
  if (fields.planType) p.plan_type = fields.planType;
  if (fields.planName) p.plan_name = fields.planName;
  if (fields.groupNumber) p.group_number = fields.groupNumber;
  if (fields.memberId) p.member_id = fields.memberId;
  if (fields.deductibleIndividual != null) p.in_deductible_individual = String(fields.deductibleIndividual);
  if (fields.deductibleFamily != null) p.in_deductible_family = String(fields.deductibleFamily);
  if (fields.oopMaxIndividual != null) p.in_oop_max_individual = String(fields.oopMaxIndividual);
  if (fields.oopMaxFamily != null) p.in_oop_max_family = String(fields.oopMaxFamily);
  if (fields.copayPrimary != null) p.copay_primary = String(fields.copayPrimary);
  if (fields.copaySpecialist != null) p.copay_specialist = String(fields.copaySpecialist);
  if (fields.copayEr != null) p.copay_er = String(fields.copayEr);
  if (fields.copayUrgentCare != null) p.copay_urgent_care = String(fields.copayUrgentCare);
  if (fields.copayRx != null) p.copay_rx = String(fields.copayRx);
  if (fields.coinsurancePct != null) p.coinsurance_pct = String(fields.coinsurancePct);
  if (fields.zipCode) p.zip_code = fields.zipCode;
  return p;
}

/**
 * Step 1 — insurance card, type-first (design: manual grid + "Faster with a
 * photo?" drop strip; scan runs the card-OCR endpoint instead). Saves go
 * through POST /api/profile: typed entries as plan_source:"manual" (honest
 * provenance — the design marks them unverified), scans as "insurance_card"
 * (which arms the server-side plan-mismatch pre-check + canonical matching).
 * The consent gate fires BEFORE any photo leaves the browser.
 */
export function OnboardingCardStep({
  value,
  onSaved,
  onReplace,
  hasConsented,
  grantConsent,
  emphasizeCurrent,
}: {
  value: CardSlotValue | null;
  onSaved: (v: CardSlotValue) => void;
  onReplace: () => void;
  hasConsented: boolean;
  grantConsent: () => Promise<void>;
  /** S288 plan-change mode: render the saved card as a PROMINENT current-card
   *  card (eyebrow + a real Replace button) matching the plan card's chrome. */
  emphasizeCurrent?: boolean;
}) {
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [mIns, setMIns] = useState("");
  const [mId, setMId] = useState("");
  const [mGrp, setMGrp] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showConsent, setShowConsent] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [mismatch, setMismatch] = useState<
    (PlanMismatchInfo & { pendingData: Record<string, string>; pendingSlot: CardSlotValue }) | null
  >(null);
  // S288: "Keep current plan" on a divergent card writes NOTHING — this notice
  // is the receipt ("Nothing was changed…"). Cleared on the next save attempt.
  const [keptNotice, setKeptNotice] = useState(false);
  const [canonicalMatch, setCanonicalMatch] = useState<PendingCanonicalMatch | null>(null);

  const saveProfile = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!user) throw new Error("Not signed in");
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        planMismatch?: PlanMismatchInfo;
        pendingCanonicalMatch?: PendingCanonicalMatch;
      };
      if (!res.ok) throw new Error(body.error || "Save failed");
      return body;
    },
    [user],
  );

  const finishSave = useCallback(
    (
      slot: CardSlotValue,
      result: { planMismatch?: PlanMismatchInfo; pendingCanonicalMatch?: PendingCanonicalMatch },
      pendingData: Record<string, string>,
    ) => {
      if (result.planMismatch) {
        setMismatch({ ...result.planMismatch, pendingData, pendingSlot: slot });
        return;
      }
      if (result.pendingCanonicalMatch) {
        setCanonicalMatch(result.pendingCanonicalMatch);
      }
      onSaved(slot);
    },
    [onSaved],
  );

  const saveManual = useCallback(async () => {
    if (!mIns && !mId) return;
    setSaving(true);
    setError("");
    setKeptNotice(false);
    try {
      const payload: Record<string, string> = { plan_source: "manual" };
      if (mIns) payload.insurer = mIns;
      if (mId) payload.member_id = mId;
      if (mGrp) payload.group_number = mGrp;
      // S288 both-or-neither: typed saves opt into the server divergence
      // pre-check — a mismatched insurer gets Keep/Switch, never a silent write.
      const result = await saveProfile({ ...payload, divergence_check: true });
      const chips: ObChip[] = [
        ...(mIns ? [{ label: "Insurer", value: mIns }] : []),
        ...(mId ? [{ label: "Member ID", value: mId, mono: true }] : []),
        ...(mGrp ? [{ label: "Group", value: mGrp, mono: true }] : []),
      ];
      finishSave({ chips, manual: true, fileName: null, insurer: mIns || null }, result, payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [mIns, mId, mGrp, saveProfile, finishSave]);

  const doScan = useCallback(
    async (file: File) => {
      if (!user) return;
      setScanning(true);
      setError("");
      setKeptNotice(false);
      try {
        const idToken = await user.firebaseUser.getIdToken();
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/profile/scan-card", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}` },
          body: formData,
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          fields?: InsuranceCardFields;
        };
        if (!res.ok || !body.fields) {
          throw new Error(body.error || "Couldn't read the card. Try a clearer photo or type the details.");
        }
        const fields = body.fields;
        // Same quality gate as the legacy card step: ≥2 of insurer /
        // member-ID-with-a-digit / group #, else treat as a failed read.
        const keyFieldCount = [
          !!fields.insurer,
          !!fields.memberId && /\d/.test(fields.memberId),
          !!fields.groupNumber,
        ].filter(Boolean).length;
        if (keyFieldCount < 2) {
          throw new Error(
            "Could not read enough details from the card. Try a clearer photo or enter details manually.",
          );
        }
        const payload = scanSavePayload(fields);
        const result = await saveProfile({ ...payload, divergence_check: true });
        finishSave(
          {
            chips: fieldsToChips(fields),
            manual: false,
            fileName: file.name,
            insurer: fields.insurer || null,
            planName: fields.planName || null,
          },
          result,
          payload,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Scan failed. Please try again.");
      } finally {
        setScanning(false);
      }
    },
    [user, saveProfile, finishSave],
  );

  const intakeFile = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      const isHeic = /\.(heic|heif)$/i.test(file.name);
      if (!CARD_ALLOWED_TYPES.includes(file.type) && !isHeic) {
        setError("Accepted formats: PDF, JPEG, PNG, WebP, or HEIC (iPhone photos).");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("Card photo must be under 10MB.");
        return;
      }
      setError("");
      if (hasConsented) {
        void doScan(file);
      } else {
        setPendingFile(file);
        setShowConsent(true);
      }
    },
    [hasConsented, doScan],
  );

  async function handleConsentAccept() {
    setConsentSubmitting(true);
    try {
      await grantConsent();
      setShowConsent(false);
      if (pendingFile) {
        void doScan(pendingFile);
        setPendingFile(null);
      }
    } catch (err) {
      console.error("Consent grant failed:", err);
      setError("Failed to record consent. Please try again.");
    } finally {
      setConsentSubmitting(false);
    }
  }

  /* ── Done state ─────────────────────────────────────────────────────────── */
  if (value && !mismatch) {
    const prominent = emphasizeCurrent === true;
    return (
      <div
        className={`rounded-[18px] border border-emerald-300 bg-white shadow-sm ${
          prominent ? "border-2 p-6" : "p-5"
        }`}
      >
        {prominent && (
          <p className="mb-2.5 text-[10.5px] font-bold tracking-[0.12em] text-emerald-700">
            {OB_CARD_COPY.currentCardEyebrow}
          </p>
        )}
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
          </span>
          <div className="min-w-0">
            <p className={`font-semibold text-gray-900 ${prominent ? "text-[15px]" : "text-sm"}`}>
              {value.manual ? OB_CARD_COPY.manualSaved : OB_CARD_COPY.scanned}
            </p>
            <p
              className={
                prominent ? "mt-0.5 text-[13px] leading-snug text-gray-600" : "truncate text-xs text-gray-400"
              }
            >
              {value.manual ? OB_CARD_COPY.manualNote : value.fileName}
            </p>
          </div>
          <button
            onClick={() => {
              setMIns("");
              setMId("");
              setMGrp("");
              onReplace();
            }}
            className={
              prominent
                ? "ml-auto shrink-0 self-start rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2 text-[13px] font-bold text-blue-700 transition-colors hover:bg-blue-100"
                : "ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            }
          >
            {prominent ? OB_CARD_COPY.replaceCard : OB_CARD_COPY.replace}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {value.chips.map((c, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-600"
            >
              <span>{c.label}</span>
              <span className={c.mono ? "font-mono text-[11px] text-gray-900" : "font-bold text-gray-900"}>
                {c.value}
              </span>
            </span>
          ))}
        </div>

        {/* Canonical-match prompt (post-save) — the card step's correct
            authed pattern: POST /api/profile {action:"confirm_canonical_match"} */}
        {canonicalMatch && (
          <div className="mt-4 space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-sm font-semibold text-blue-900">We found a matching plan</p>
            <div className="rounded-xl border border-blue-100 bg-white p-3">
              <p className="text-sm font-medium text-gray-900">{canonicalMatch.matchedPlanName}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {canonicalMatch.insurerName} · {Math.round(canonicalMatch.confidence * 100)}% match ·{" "}
                {canonicalMatch.sourceCount} {canonicalMatch.sourceCount === 1 ? "member" : "members"}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  try {
                    await saveProfile({
                      action: "confirm_canonical_match",
                      canonicalPlanId: canonicalMatch.canonicalPlanId,
                    });
                  } catch (err) {
                    console.error("[onboarding] canonical confirm failed:", err);
                  }
                  setCanonicalMatch(null);
                }}
                className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
              >
                Yes, this is my plan
              </button>
              <button
                onClick={() => setCanonicalMatch(null)}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                Not my plan
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ── Plan-mismatch prompt (re-entry with an existing different plan) ───── */
  if (mismatch) {
    return (
      <div className="space-y-3 rounded-[18px] border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-semibold text-amber-900">
          You already have {mismatch.existingInsurer || "a plan"} on file
        </p>
        <p className="text-xs leading-relaxed text-amber-700">
          This card names {mismatch.newInsurer || "a different insurer"}. Switch your active plan to
          match the card — or keep your current plan, and we&apos;ll hold the numbers you typed so
          you can save them under it.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            onClick={async () => {
              try {
                const result = await saveProfile({ ...mismatch.pendingData, force_plan_switch: true });
                const slot = mismatch.pendingSlot;
                setMismatch(null);
                finishSave(slot, result, mismatch.pendingData);
              } catch (err) {
                setMismatch(null);
                setError(err instanceof Error ? err.message : "Save failed. Please try again.");
              }
            }}
            className="flex-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Switch to {mismatch.newInsurer || "the new plan"}
          </button>
          <button
            onClick={() => {
              // S288 both-or-neither still stands: NOTHING is written here.
              // S316 (Andrew) — but the dead-end blank form confused: Keep now
              // returns to the form with the CURRENT plan's insurer filled in
              // (never the card's divergent string) and the typed IDs
              // preserved, so the correction is one explicit save away — and
              // that save carries the plan's own insurer, so it cannot
              // recreate a mixed identity.
              setMIns(mismatch.existingInsurer || "");
              if (mismatch.pendingData.member_id) setMId(mismatch.pendingData.member_id);
              if (mismatch.pendingData.group_number) setMGrp(mismatch.pendingData.group_number);
              setMismatch(null);
              setKeptNotice(true);
            }}
            className="flex-1 rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100"
          >
            Keep current plan
          </button>
        </div>
      </div>
    );
  }

  /* ── Scanning state ─────────────────────────────────────────────────────── */
  if (scanning) {
    return (
      <div className="rounded-[18px] border-2 border-dashed border-gray-300 bg-gradient-to-b from-white to-gray-50 p-8 text-center">
        <div className="mx-auto mb-3 grid h-[46px] w-[46px] place-items-center rounded-full bg-blue-100 text-blue-600">
          <div className="h-[22px] w-[22px] animate-spin rounded-full border-[3px] border-current border-t-transparent opacity-70" />
        </div>
        <p className="text-[15px] font-semibold text-gray-900">Reading your card…</p>
        <div className="mx-auto mt-3.5 h-1 max-w-[280px] overflow-hidden rounded-full bg-gray-200">
          <div className="h-full w-2/5 animate-[obload_1.4s_ease-in-out_infinite] rounded-full bg-blue-500" />
        </div>
        <p className="mt-2.5 text-xs text-gray-400">{OB_CARD_COPY.scanNote}</p>
      </div>
    );
  }

  /* ── Type-first card (manual grid + photo drop strip) ───────────────────── */
  return (
    <>
      {keptNotice && (
        <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-[13px] text-gray-600">
          <svg className="shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4m0 4h.01" />
          </svg>
          {OB_CARD_COPY.keptNothing}
        </div>
      )}
      <div
        className={`rounded-[18px] border bg-white p-5 shadow-sm transition-colors ${
          dragOver ? "border-blue-400 bg-blue-50/50" : "border-gray-200"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          intakeFile(e.dataTransfer.files?.[0]);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-semibold text-gray-700" htmlFor="ob-insurer">
              Insurer
            </label>
            <input
              id="ob-insurer"
              className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100"
              placeholder="e.g., Aetna"
              value={mIns}
              onChange={(e) => setMIns(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-semibold text-gray-700" htmlFor="ob-member-id">
              Member ID
            </label>
            <input
              id="ob-member-id"
              className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100"
              placeholder='"Member ID" or "ID #" on the card'
              value={mId}
              onChange={(e) => setMId(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-semibold text-gray-700" htmlFor="ob-group">
              Group # <span className="text-[11.5px] font-medium text-gray-400">Optional</span>
            </label>
            <input
              id="ob-group"
              className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100"
              placeholder='"Group" or "Grp"'
              value={mGrp}
              onChange={(e) => setMGrp(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button
              disabled={(!mIns && !mId) || saving}
              onClick={saveManual}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-default disabled:opacity-45"
            >
              {saving ? "Saving…" : OB_CARD_COPY.save}
            </button>
          </div>
        </div>

        <button
          onClick={() => fileRef.current?.click()}
          className="mt-3.5 flex w-full items-center gap-3 rounded-xl border-[1.5px] border-dashed border-gray-300 bg-gray-50 px-3.5 py-3 text-left text-[12.5px] leading-relaxed text-gray-500 transition-colors hover:border-blue-400 hover:bg-blue-50"
        >
          <svg className="shrink-0 text-blue-600" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <circle cx="12" cy="13" r="3.2" />
          </svg>
          <span>
            <b className="font-semibold text-gray-900">{OB_CARD_COPY.dropline}</b>{" "}
            {OB_CARD_COPY.droplineSub}
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/*"
          hidden
          onChange={(e) => {
            intakeFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
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

"use client";

/**
 * PatientIdentityChoices — THE patient-identity question, shared.
 *
 * S294 (Andrew's prod E2E, bug 2). Two surfaces used to answer this question
 * with different semantics: the UnifiedTodo rail asked the full three-choice
 * question (me / my dependent / wrong name), while CaseNeedsPanel rendered a
 * one-click "This is me" that resolved the mismatch with NO choice and NO
 * name logic. On a dependent's bill the one-click path suppressed the rail's
 * question and later renders fell back to the ACCOUNT name — an outbound
 * appeal letter reading "Patient: <account holder>" for someone else's visit
 * (observed live on dispute ab8063ab: the bill's patient was a family member,
 * the letter named the account).
 *
 * One question, one form, everywhere — the same rule the S292 identity
 * prompts follow across /upload, onboarding and the parse terminal. Both
 * surfaces now render THIS component, and the caller's onResolve posts the
 * choice through confirm-patient-identity, where it is persisted
 * (metadata.patientIdentityChoice / patientCorrectedName) as flywheel data
 * rather than discarded at the click.
 *
 * Copy is the S291-approved rail wording, verbatim — moved, not reworded.
 */

import { useState } from "react";
import { cn } from "@/lib/utils/cn";

export type PatientIdentityChoice = "me" | "dependent" | "wrong";

function CheckIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ChoiceCard({
  selected,
  tone,
  title,
  desc,
  onSelect,
}: {
  selected: boolean;
  tone: "good" | "warn";
  title: string;
  desc: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
        selected
          ? tone === "good"
            ? "border-emerald-300 bg-emerald-50/60"
            : "border-amber-300 bg-amber-50/60"
          : "border-gray-200 bg-white hover:border-gray-300",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-[18px] w-[18px] flex-shrink-0 place-items-center rounded-full border-2",
          selected
            ? tone === "good"
              ? "border-emerald-500"
              : "border-amber-500"
            : "border-gray-300",
        )}
        aria-hidden
      >
        {selected && (
          <span
            className={cn(
              "h-[8px] w-[8px] rounded-full",
              tone === "good" ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-gray-900">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-gray-500">{desc}</span>
      </span>
    </button>
  );
}

export function PatientIdentityChoices({
  billName,
  profileName,
  onResolve,
  onCancel,
}: {
  billName: string;
  profileName: string;
  /** All three choices resolve through the real confirm-patient-identity flow. */
  onResolve: (choice: PatientIdentityChoice, correctedName?: string) => void;
  onCancel: () => void;
}) {
  const [who, setWho] = useState<PatientIdentityChoice>("me");
  const [correctedName, setCorrectedName] = useState("");

  return (
    <div className="animate-fade-in rounded-[14px] border border-blue-200 bg-white p-4 shadow-[0_14px_30px_-20px_rgba(37,99,235,0.35)]">
      <div className="mb-3 text-[13px] leading-relaxed text-gray-600">
        The bill lists <strong className="text-gray-900">&ldquo;{billName}&rdquo;</strong>;
        your account is <strong className="text-gray-900">{profileName}</strong>. Which is right?
      </div>
      <div className="space-y-2">
        <ChoiceCard
          selected={who === "me"}
          tone="good"
          title="That's me"
          desc={`The bill means you — the letter will use your account name, ${profileName}.`}
          onSelect={() => setWho("me")}
        />
        <ChoiceCard
          selected={who === "dependent"}
          tone="good"
          title="That's right — it's one of my dependents"
          desc={`The visit was for ${billName}, covered on your plan. The letter keeps their name.`}
          onSelect={() => setWho("dependent")}
        />
        <ChoiceCard
          selected={who === "wrong"}
          tone="warn"
          title="That name is wrong"
          desc="Type the patient's correct name and we'll fill the letter."
          onSelect={() => setWho("wrong")}
        />
      </div>
      {who === "wrong" && (
        <input
          type="text"
          value={correctedName}
          onChange={(e) => setCorrectedName(e.target.value)}
          placeholder="Patient's full name"
          autoFocus
          className="mt-2.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={who === "wrong" && correctedName.trim().length === 0}
          onClick={() => onResolve(who, who === "wrong" ? correctedName.trim() : undefined)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckIcon size={12} /> Confirm
        </button>
      </div>
    </div>
  );
}

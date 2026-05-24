"use client";

/**
 * Family/dependent row for /profile Family section (S121 B2.1).
 *
 * Per Phase 1 §1.B.2 Rec 12 — initial-avatar + name + relation+age + tag
 * ("You" / "On your plan" / "Off-plan"). Age special-cases <1 yr → "<1 yr"
 * for newborns.
 */

interface FamilyRowProps {
  name: string;
  relationship: string;
  dateOfBirth: string;
  onSamePlan: boolean;
  /** When true, renders a distinct "You" tag instead of plan-status tag. */
  isSelf?: boolean;
}

function computeAge(dateOfBirth: string): string | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  const ageYears =
    (now.getTime() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears < 0) return null;
  if (ageYears < 1) return "<1 yr";
  return `${Math.floor(ageYears)} yr`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function FamilyRow({
  name,
  relationship,
  dateOfBirth,
  onSamePlan,
  isSelf = false,
}: FamilyRowProps) {
  const initial = (name || "?").charAt(0).toUpperCase();
  const age = computeAge(dateOfBirth);
  const subtitle = [capitalize(relationship || ""), age]
    .filter(Boolean)
    .join(" · ");
  const tagLabel = isSelf
    ? "You"
    : onSamePlan
      ? "On your plan"
      : "Off-plan";
  const tagClass = isSelf
    ? "bg-blue-50 text-blue-700 border-blue-200"
    : onSamePlan
      ? "bg-green-50 text-green-700 border-green-200"
      : "bg-gray-50 text-gray-600 border-gray-200";

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <div className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white grid place-items-center text-sm font-bold">
        {initial}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900 truncate">
          {name || "Unnamed"}
        </div>
        {subtitle && (
          <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>
        )}
      </div>
      <span
        className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${tagClass}`}
      >
        {tagLabel}
      </span>
    </div>
  );
}

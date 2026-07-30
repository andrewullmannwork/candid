"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ShareWithFriend } from "@/components/share/share-with-friend";
import { getSignInMethod } from "@/lib/auth/sign-in-method";
import { computeProfileCompletion } from "@/lib/profile/completion";
import { Section } from "./Section";
import { PlanCard } from "./PlanCard";
import { CostStructureGrid } from "./CostStructureGrid";
import { FamilyRow } from "./FamilyRow";
import { InlineEditField } from "./InlineEditField";
import type { User as FirebaseUser } from "firebase/auth";

/**
 * Profile dashboard view (S121 B2.1) — single-page post-onboarding default per
 * Phase 1 §1.B.2 Rec 1 + Rec 2. Replaces the pre-S121 inline read-only view
 * (formerly at profile/page.tsx:653-820). Wizard mode is still mounted from
 * page.tsx and reachable via "Update insurance info" → wizard step=1 (per
 * D-§1.B.2-C). Privacy footer deep-links to /settings per D-§1.B.2-B (NOT
 * inline destructive actions per design literal).
 *
 * 7 design sections per Phase 1 §1.B.2 + Documents preserved from the
 * pre-S121 view (load-bearing user-visible content for upload status tracking).
 */

interface ProfileShape {
  insurer: string;
  plan_name: string;
  plan_type: string;
  state: string;
  group_number: string;
  member_id: string;
  in_deductible_individual: string;
  in_deductible_family: string;
  in_oop_max_individual: string;
  in_oop_max_family: string;
  out_deductible_individual: string;
  out_deductible_family: string;
  out_oop_max_individual: string;
  out_oop_max_family: string;
  copay_primary: string;
  copay_specialist: string;
  copay_er: string;
  coinsurance_er?: string;
  coinsurance_pct: string;
  primary_concern: string;
  date_of_birth: string;
  sex: string;
  phone: string;
  zip_code: string;
  county_name: string;
  city: string;
  address_line1: string;
  address_line2: string;
  dependents: string;
}

interface Dependent {
  name: string;
  relationship: string;
  date_of_birth: string;
  sex: string;
  on_same_plan: boolean;
}

interface UserDocSummary {
  id: string;
  file_name: string;
  doc_type: string;
  status: string;
  created_at: string;
}

interface ProfileDashboardProps {
  firebaseUser: FirebaseUser;
  /** ISO timestamp from Firebase Auth metadata.creationTime — Candid member-since. */
  memberSinceISO?: string | null;
  profile: ProfileShape;
  userDocs: UserDocSummary[];
  /** Card-rescan banner — set when ?rescan_card=1 query param or insurer-mismatch flow. */
  needsCardRescan: boolean;
  /** Called when user clicks "Update insurance info" — jumps to wizard step 1. */
  onUpdateInsurance: () => void;
  /** S288: About-you edits route into the onboarding flow (?mode=about). */
  onEditAbout?: () => void;
  /** Called when user clicks "Re-scan card" from member-id inline edit or banner. */
  onRescanCard: () => void;
  /** Save handler for member_id inline edit. Resolves on success; throws on failure. */
  onSaveMemberId: (value: string) => Promise<void>;
}

function KV({
  label,
  value,
  verified,
  emptyLabel,
  emptyAction,
}: {
  label: string;
  value: string;
  verified?: boolean;
  emptyLabel?: React.ReactNode;
  emptyAction?: React.ReactNode;
}) {
  const isEmpty = !value || value.trim().length === 0;
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
        {label}
      </div>
      {isEmpty && emptyAction ? (
        <div className="mt-1">{emptyAction}</div>
      ) : isEmpty ? (
        <div className="mt-1 text-sm text-gray-400">
          {emptyLabel ?? "Not set"}
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="text-sm font-medium text-gray-900">{value}</span>
          {verified && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-green-600 shrink-0"
              aria-hidden="true"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      )}
    </div>
  );
}

function formatMemberSince(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function formatSex(sex: string): string {
  if (!sex) return "";
  if (sex === "prefer_not_to_say") return "Prefer not to say";
  return sex.charAt(0).toUpperCase() + sex.slice(1);
}

function formatPhoneDisplay(value: string): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value;
}

function prettyDocType(t: string): string {
  switch (t) {
    case "eob":
      return "EOB";
    case "itemized_bill":
      return "Itemized Bill";
    case "sbc":
      return "SBC";
    case "plan_document":
      return "Plan Doc";
    case "eoc":
      return "EOC";
    default:
      return t;
  }
}

function prettyDocStatus(s: string): string {
  switch (s) {
    case "processed":
      return "Processed";
    case "processing":
      return "Processing";
    case "queued":
      return "Queued";
    case "pending_review":
      return "Under review";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
    default:
      return s;
  }
}

function docStatusClass(s: string): string {
  switch (s) {
    case "processed":
      return "bg-green-50 text-green-600";
    case "processing":
    case "queued":
      return "bg-blue-50 text-blue-600";
    case "pending_review":
      return "bg-amber-50 text-amber-600";
    case "cancelled":
      return "bg-gray-100 text-gray-500";
    case "error":
      return "bg-red-50 text-red-600";
    default:
      return "bg-gray-100 text-gray-500";
  }
}

export function ProfileDashboard({
  firebaseUser,
  memberSinceISO,
  profile,
  userDocs,
  needsCardRescan,
  onUpdateInsurance,
  onEditAbout,
  onRescanCard,
  onSaveMemberId,
}: ProfileDashboardProps) {
  const completion = useMemo(
    () =>
      computeProfileCompletion({
        insurer: profile.insurer,
        plan_name: profile.plan_name,
        plan_type: profile.plan_type,
        state: profile.state,
        date_of_birth: profile.date_of_birth,
        phone: profile.phone,
        zip_code: profile.zip_code,
      }),
    [profile],
  );
  const signIn = useMemo(() => getSignInMethod(firebaseUser), [firebaseUser]);

  const dependents = useMemo<Dependent[]>(() => {
    try {
      const parsed = JSON.parse(profile.dependents || "[]") as Dependent[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [profile.dependents]);

  const name =
    firebaseUser.displayName ||
    firebaseUser.email?.split("@")[0] ||
    "Member";
  const initial = (name || "?").charAt(0).toUpperCase();
  const memberSince = formatMemberSince(memberSinceISO);
  const addressLine =
    [profile.address_line1, profile.address_line2]
      .filter(Boolean)
      .join(", ") || "";
  const cityZip = [profile.city, profile.zip_code]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {/* Hero */}
      <section className="bg-white border border-gray-200 rounded-3xl px-7 py-6 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="shrink-0 w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white grid place-items-center text-xl font-bold">
            {initial}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900 tracking-tight m-0 truncate">
                {name}
              </h1>
              {completion.tier !== null && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                    completion.tier === 100
                      ? "bg-green-50 text-green-700 border border-green-200"
                      : "bg-blue-50 text-blue-700 border border-blue-200"
                  }`}
                >
                  {completion.tier === 100 && (
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {completion.tier === 100
                    ? "Profile complete"
                    : `Profile ${completion.tier}% complete`}
                </span>
              )}
            </div>
            {firebaseUser.email && (
              <div className="text-sm text-gray-500 mt-0.5 truncate">
                {firebaseUser.email}
              </div>
            )}
            {memberSince && (
              <div className="text-xs text-gray-400 mt-1">
                Candid member since {memberSince}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onUpdateInsurance}
          className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-200 rounded-xl hover:bg-blue-50 transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Update insurance info
        </button>
      </section>

      {/* Card-rescan banner (preserved from pre-S121 view) */}
      {needsCardRescan && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4 flex items-center gap-3">
          <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 grid place-items-center text-amber-700">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">
              Scan your new insurance card
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              You switched plans. Upload your new card so we can update your
              member ID and group number.
            </p>
          </div>
          <button
            type="button"
            onClick={onRescanCard}
            className="shrink-0 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-xl transition-colors"
          >
            Scan new card
          </button>
        </div>
      )}

      {/* Account */}
      <Section eyebrow="ACCOUNT" title="Account">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <KV
            label="Email"
            value={firebaseUser.email ?? ""}
            verified={firebaseUser.emailVerified}
          />
          <KV label="Name" value={firebaseUser.displayName ?? ""} />
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Sign-in method
            </div>
            <div className="mt-1">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold">
                {signIn.label}
              </span>
            </div>
          </div>
          <KV
            label="Phone"
            value={formatPhoneDisplay(profile.phone)}
            verified={!!firebaseUser.phoneNumber}
          />
        </div>
      </Section>

      {/* Insurance */}
      <Section
        eyebrow="INSURANCE"
        title="Plan on file"
        actionLabel="Update plan"
        onAction={onUpdateInsurance}
      >
        <PlanCard
          insurer={profile.insurer}
          planName={profile.plan_name}
          planType={profile.plan_type}
          state={profile.state}
          groupNumber={profile.group_number}
        />
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
          <KV label="Insurer" value={profile.insurer} verified />
          <KV label="Plan name" value={profile.plan_name} verified />
          <KV label="Plan type" value={profile.plan_type} verified />
          <KV label="State" value={profile.state} verified />
          <KV label="Group #" value={profile.group_number} verified />
          <KV
            label="Member ID"
            value={profile.member_id}
            verified={!!profile.member_id}
            emptyAction={
              <InlineEditField
                emptyLabel="Not set"
                placeholder="Member ID"
                onSave={onSaveMemberId}
                secondaryAction={{
                  label: "re-scan card",
                  onClick: onRescanCard,
                }}
              />
            }
          />
        </div>
      </Section>

      {/* Cost Structure */}
      <Section
        eyebrow="COST STRUCTURE"
        title="What you owe before insurance kicks in"
      >
        <CostStructureGrid
          inNetwork={{
            deductibleIndividual: profile.in_deductible_individual,
            deductibleFamily: profile.in_deductible_family,
            oopMaxIndividual: profile.in_oop_max_individual,
            oopMaxFamily: profile.in_oop_max_family,
            copayPrimary: profile.copay_primary,
            copaySpecialist: profile.copay_specialist,
            copayER: profile.copay_er,
            coinsuranceER: profile.coinsurance_er ?? "",
            coinsurancePct: profile.coinsurance_pct,
          }}
          outOfNetwork={{
            deductibleIndividual: profile.out_deductible_individual,
            deductibleFamily: profile.out_deductible_family,
            oopMaxIndividual: profile.out_oop_max_individual,
            oopMaxFamily: profile.out_oop_max_family,
          }}
        />
      </Section>

      {/* About You */}
      <Section
        eyebrow="ABOUT YOU"
        title="About you"
        actionLabel={onEditAbout ? "Edit" : undefined}
        onAction={onEditAbout}
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <KV label="Date of birth" value={profile.date_of_birth} />
          <KV label="Sex" value={formatSex(profile.sex)} />
          <KV label="Address" value={addressLine} />
          <KV label="City / Zip" value={cityZip} />
          <KV label="County" value={profile.county_name} />
        </div>
      </Section>

      {/* Family */}
      {dependents.length > 0 && (
        <Section eyebrow="FAMILY" title="Household">
          <div>
            {dependents.map((d, i) => (
              <FamilyRow
                key={i}
                name={d.name}
                relationship={d.relationship}
                dateOfBirth={d.date_of_birth}
                onSamePlan={d.on_same_plan}
              />
            ))}
          </div>
        </Section>
      )}

      {/* Your Situation — no CTA per S121 direction (primary_concern is free-text;
          long-term we'll route based on this data, but not in B2.1) */}
      {profile.primary_concern && (
        <Section
          eyebrow="YOUR SITUATION"
          title="What you came to Candid for"
        >
          <p className="text-sm text-gray-700 leading-relaxed">
            {profile.primary_concern}
          </p>
        </Section>
      )}

      {/* Documents (preserved from pre-S121 view) */}
      {userDocs.length > 0 && (
        <Section eyebrow="DOCUMENTS" title="Your uploads">
          <div className="space-y-2">
            {userDocs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {doc.file_name}
                  </p>
                  <p className="text-xs text-gray-400">
                    {prettyDocType(doc.doc_type)} ·{" "}
                    {new Date(doc.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span
                  className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded ${docStatusClass(doc.status)}`}
                >
                  {prettyDocStatus(doc.status)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ShareWithFriend embed (soft variant; Phase 1 §1.B.2 Rec 13 + §1.C.4 5-surface map) */}
      <ShareWithFriend surface="profile" variant="soft" />

      {/* Privacy footer — deep-links to /settings per D-§1.B.2-B */}
      <section className="bg-white border border-gray-200 rounded-3xl px-7 py-6">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
          PRIVACY
        </div>
        <h2 className="mt-1 text-lg font-bold text-gray-900 tracking-tight">
          Your data, your choice
        </h2>
        <p className="mt-1 text-sm text-gray-500 leading-relaxed">
          You can export everything we have or delete your account at any time.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/settings?action=export"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-gray-700 border border-gray-200 rounded-lg hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
          >
            Manage your data
          </Link>
          <Link
            href="/settings?action=delete"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-gray-700 border border-gray-200 rounded-lg hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
          >
            Privacy &amp; account settings
          </Link>
        </div>
      </section>

      {/* Trust line — Airgetlam Labs LLC brand + Candid_10k §5 hard rule */}
      <p className="text-xs text-gray-400 text-center leading-relaxed px-6 pt-2 pb-6">
        Candid is an Airgetlam Labs LLC company. We are not a law firm,
        insurer, or healthcare provider — we give you information and tools;
        you decide what to do with them.
      </p>
    </div>
  );
}

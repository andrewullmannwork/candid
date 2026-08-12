"use client";

import { useState } from "react";
import {
  OB_COPY,
  OB_HOUSEHOLD,
  OB_SEX,
  OB_SITUATIONS,
  obDobOk,
  obFmtDob,
  obZipOk,
  type HouseholdId,
  type SituationId,
} from "@/lib/onboarding/simplified";
import { validateUsAddress } from "@/lib/address/validate-us-address";

export interface AboutState {
  household: HouseholdId | null;
  sex: string | null;
  zip: string;
  /** Display format MM/DD/YYYY. */
  dob: string;
  /** DOB came from the signup record / an existing profile — render confirm-only. */
  dobFromProfile: boolean;
  situations: SituationId[];
  note: string;
  /** S311 (tree A4) — the mailing address, EDIT-MODE ONLY (`withAddress`).
   *  The simplified flow superseded the legacy wizard step that edited these,
   *  which silently made the address uneditable from /profile while the
   *  letters' sender block reads it. The signup funnel never renders or
   *  submits them — its 30-second scope is untouched. ZIP is the existing
   *  field above; profiles.state doubles as the DOI/AG state. */
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
}

function PersonGlyph({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="7.5" r="3.8" />
      <path d="M4.5 20.5c0-4 3.4-6.3 7.5-6.3s7.5 2.3 7.5 6.3" />
    </svg>
  );
}

/**
 * Step 3 — "Last thing — 30 seconds about you". Household tiles, optional sex
 * chips, required ZIP + DOB (DOB confirm-only when it came from signup),
 * optional situation chips + one-liner. Validation errors render only after a
 * failed Finish attempt (`tryFin`), except DOB which also errors live once 10
 * chars are typed (design spec).
 */
export function OnboardingAboutStep({
  value,
  onChange,
  tryFin,
  withAddress = false,
}: {
  value: AboutState;
  onChange: (patch: Partial<AboutState>) => void;
  tryFin: boolean;
  /** S311 — profile-edit mode renders the mailing-address fields; the signup
   *  funnel never passes this, keeping its 30-second scope byte-identical. */
  withAddress?: boolean;
}) {
  const [editingDob, setEditingDob] = useState(false);
  const dobConfirmOnly = value.dobFromProfile && !editingDob && obDobOk(value.dob);

  const dobBad =
    (tryFin && !obDobOk(value.dob)) ||
    (!dobConfirmOnly && value.dob.length >= 10 && !obDobOk(value.dob));
  const zipBad = tryFin && !obZipOk(value.zip);
  // S311 — the address is OPTIONAL (letters fail soft without it), but a
  // partial one is an error: validate through the ONE shared US-address rule
  // whenever any of the trio is set. ZIP has its own required check above;
  // profiles.state serves the DOI/AG clause, so its field errors surface here
  // too. Errors render only after a failed save attempt (the tryFin pattern).
  const addrTouched =
    withAddress && !!(value.addressLine1.trim() || value.city.trim() || value.state.trim());
  const addrErrors =
    withAddress && tryFin && addrTouched
      ? validateUsAddress({
          addressLine1: value.addressLine1,
          addressLine2: value.addressLine2,
          city: value.city,
          state: value.state,
          postalCode: value.zip,
        })
      : {};

  return (
    <div className="space-y-6">
      {/* Who's on this plan? */}
      <div>
        <div className="flex items-baseline gap-2 text-sm font-semibold text-gray-900">
          Who&apos;s on this plan?
        </div>
        <div className="mb-2.5 mt-0.5 text-[12.5px] text-gray-400">
          Family coverage changes your deductibles and which benefits apply.
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {OB_HOUSEHOLD.map((h) => {
            const on = value.household === h.id;
            return (
              <button
                key={h.id}
                onClick={() => onChange({ household: on ? null : h.id })}
                className={`relative flex flex-col items-center gap-2 rounded-[14px] border px-2 pb-3 pt-3.5 transition-all ${
                  on
                    ? "border-blue-600 bg-blue-50 shadow-[inset_0_0_0_1px_#2563eb]"
                    : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                <span className={`flex h-6 items-end gap-0.5 ${on ? "text-blue-600" : "text-gray-400"}`}>
                  <PersonGlyph s={22} />
                  {(h.id === "me_spouse" || h.id === "me_spouse_kids") && <PersonGlyph s={22} />}
                  {(h.id === "me_kids" || h.id === "me_spouse_kids") && <PersonGlyph s={14} />}
                </span>
                <span
                  className={`whitespace-nowrap text-[12.5px] font-semibold ${
                    on ? "text-blue-700" : "text-gray-700"
                  }`}
                >
                  {h.label}
                </span>
                {on && (
                  <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-blue-600 text-white">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sex assigned at birth */}
      <div>
        <div className="flex items-baseline gap-2 text-sm font-semibold text-gray-900">
          Sex assigned at birth <span className="text-[11.5px] font-medium text-gray-400">Optional</span>
        </div>
        <div className="mb-2.5 mt-0.5 text-[12.5px] text-gray-400">
          Surfaces sex-specific benefits your plan covers — like mammograms, prostate screenings, or
          maternity care.
        </div>
        <div className="flex flex-wrap gap-2">
          {OB_SEX.map((s) => {
            const on = value.sex === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onChange({ sex: on ? null : s.id })}
                className={`rounded-full border px-4 py-2 text-[13.5px] font-semibold transition-all ${
                  on
                    ? "border-blue-600 bg-blue-50 text-blue-700 shadow-[inset_0_0_0_1px_#2563eb]"
                    : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ZIP + DOB */}
      <div>
        <div className="text-sm font-semibold text-gray-900">Where you live &amp; when you were born</div>
        <div className="mb-2.5 mt-0.5 text-[12.5px] text-gray-400">
          ZIP sets local rates. Candid is for adults — your birth date confirms you&apos;re 18+. Both
          stay private.
        </div>
        {withAddress && (
          <div className="mb-3 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <div>
                <label
                  className="mb-1.5 block text-[12.5px] font-semibold text-gray-700"
                  htmlFor="ob-addr1"
                >
                  Street address
                </label>
                <input
                  id="ob-addr1"
                  value={value.addressLine1}
                  onChange={(e) => onChange({ addressLine1: e.target.value })}
                  className={`w-full rounded-xl border px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100 ${
                    addrErrors.addressLine1 ? "border-red-300 ring-[3px] ring-red-100" : "border-gray-300"
                  }`}
                />
              </div>
              <div>
                <label
                  className="mb-1.5 block text-[12.5px] font-semibold text-gray-700"
                  htmlFor="ob-addr2"
                >
                  Suite / unit
                </label>
                <input
                  id="ob-addr2"
                  value={value.addressLine2}
                  onChange={(e) => onChange({ addressLine2: e.target.value })}
                  className="w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_100px]">
              <div>
                <label
                  className="mb-1.5 block text-[12.5px] font-semibold text-gray-700"
                  htmlFor="ob-city"
                >
                  City
                </label>
                <input
                  id="ob-city"
                  value={value.city}
                  onChange={(e) => onChange({ city: e.target.value })}
                  className={`w-full rounded-xl border px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100 ${
                    addrErrors.city ? "border-red-300 ring-[3px] ring-red-100" : "border-gray-300"
                  }`}
                />
              </div>
              <div>
                <label
                  className="mb-1.5 block text-[12.5px] font-semibold text-gray-700"
                  htmlFor="ob-state"
                >
                  State
                </label>
                <input
                  id="ob-state"
                  maxLength={2}
                  placeholder="WA"
                  value={value.state}
                  onChange={(e) => onChange({ state: e.target.value.toUpperCase() })}
                  className={`w-full rounded-xl border px-3 py-2.5 text-sm uppercase text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100 ${
                    addrErrors.state ? "border-red-300 ring-[3px] ring-red-100" : "border-gray-300"
                  }`}
                />
              </div>
            </div>
            {(addrErrors.addressLine1 || addrErrors.city || addrErrors.state) && (
              <div className="text-xs font-medium text-red-600">
                {addrErrors.addressLine1 ?? addrErrors.city ?? addrErrors.state}
              </div>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[150px_200px]">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-semibold text-gray-700" htmlFor="ob-zip">
              ZIP code
            </label>
            <input
              id="ob-zip"
              inputMode="numeric"
              maxLength={5}
              placeholder="94107"
              value={value.zip}
              onChange={(e) => onChange({ zip: e.target.value.replace(/\D/g, "") })}
              className={`w-full rounded-xl border px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100 ${
                zipBad ? "border-red-300 ring-[3px] ring-red-100" : "border-gray-300"
              }`}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-semibold text-gray-700" htmlFor="ob-dob">
              Date of birth
            </label>
            {dobConfirmOnly ? (
              <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                <span className="text-sm font-medium text-gray-900">{value.dob}</span>
                <button
                  onClick={() => setEditingDob(true)}
                  className="text-[12.5px] font-semibold text-blue-600 hover:text-blue-700 hover:underline"
                >
                  Edit
                </button>
              </div>
            ) : (
              <input
                id="ob-dob"
                inputMode="numeric"
                maxLength={10}
                placeholder="MM/DD/YYYY"
                value={value.dob}
                onChange={(e) => onChange({ dob: obFmtDob(e.target.value, value.dob) })}
                className={`w-full rounded-xl border px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100 ${
                  dobBad ? "border-red-300 ring-[3px] ring-red-100" : "border-gray-300"
                }`}
              />
            )}
          </div>
        </div>
        {zipBad && <div className="mt-1.5 text-xs font-medium text-red-600">Enter your 5-digit ZIP code.</div>}
        {dobBad && (
          <div className="mt-1.5 text-xs font-medium text-red-600">
            Enter a valid date (MM/DD/YYYY) — you must be 18 or older to use Candid.
          </div>
        )}
      </div>

      {/* What brings you here? */}
      <div>
        <div className="flex items-baseline gap-2 text-sm font-semibold text-gray-900">
          {OB_COPY.situationLabel}{" "}
          <span className="text-[11.5px] font-medium text-gray-400">Optional</span>
        </div>
        <div className="mb-2.5 mt-0.5 text-[12.5px] text-gray-400">{OB_COPY.situationWhy}</div>
        <div className="flex flex-wrap gap-2">
          {OB_SITUATIONS.map((s) => {
            const on = value.situations.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() =>
                  onChange({
                    situations: on
                      ? value.situations.filter((x) => x !== s.id)
                      : [...value.situations, s.id],
                  })
                }
                className={`rounded-full border px-4 py-2 text-[13.5px] font-semibold transition-all ${
                  on
                    ? "border-blue-600 bg-blue-50 text-blue-700 shadow-[inset_0_0_0_1px_#2563eb]"
                    : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {value.situations.length > 0 && (
          <input
            className="mt-2.5 w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100"
            placeholder="Anything else we should know? (optional)"
            value={value.note}
            onChange={(e) => onChange({ note: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

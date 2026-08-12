"use client";

/**
 * AboutEditModal — the profile page's About-you editor (S311, §A round-4 —
 * Andrew's ruling: the About-you Edit opens "an address and date of birth
 * modal", NEVER the whole setup flow).
 *
 * One modal for exactly what the About-you card displays and a user can edit:
 * date of birth, sex, and the mailing address. Every piece reuses what exists —
 * the onboarding flow's own DOB mask/validators (obFmtDob/obDobOk/obDobToIso),
 * its OB_SEX chips, and the ONE shared validateUsAddress rule — and the PARENT
 * saves through the ONE existing POST /api/profile writer (this component owns
 * no fetch). The signup/About flow itself is untouched; the profile page simply
 * stops routing edits into it.
 *
 * Address is OPTIONAL (letters fail soft without a sender block): all-empty is
 * a valid save (clears it), partial → field-level errors. ZIP here writes the
 * same profiles.zip_code the flow's ZIP writes — one column, one fact.
 */

import { useState } from "react";
import { ModalShell } from "@/components/modal/modal-shell";
import {
  OB_SEX,
  obDobOk,
  obFmtDob,
} from "@/lib/onboarding/simplified";
import {
  validateUsAddress,
  type UsAddressErrors,
} from "@/lib/address/validate-us-address";

export interface AboutModalValue {
  /** Display format MM/DD/YYYY (the flow's own format). */
  dob: string;
  sex: string | null;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export function AboutEditModal({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: AboutModalValue;
  onClose: () => void;
  /** Parent persists (POST /api/profile) and refreshes its own state. */
  onSave: (value: AboutModalValue) => Promise<void>;
}) {
  const [value, setValue] = useState<AboutModalValue>(initial);
  const [errors, setErrors] = useState<UsAddressErrors>({});
  const [dobBad, setDobBad] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  const set = (patch: Partial<AboutModalValue>) => {
    setValue((p) => ({ ...p, ...patch }));
    if (Object.keys(errors).length > 0) setErrors({});
    if (dobBad) setDobBad(false);
    if (status === "error") setStatus("idle");
  };

  const save = async () => {
    // DOB: always prefilled in practice; when present it must be valid. An
    // empty field leaves the stored value untouched (the parent skips the key).
    if (value.dob.trim() && !obDobOk(value.dob)) {
      setDobBad(true);
      return;
    }
    const anyAddr = !!(
      value.line1.trim() ||
      value.city.trim() ||
      value.state.trim()
    );
    if (anyAddr) {
      const errs = validateUsAddress({
        addressLine1: value.line1,
        addressLine2: value.line2,
        city: value.city,
        state: value.state,
        postalCode: value.zip,
      });
      if (Object.keys(errs).length > 0) {
        setErrors(errs);
        return;
      }
    }
    setStatus("saving");
    try {
      await onSave({
        dob: value.dob.trim(),
        sex: value.sex,
        line1: value.line1.trim(),
        line2: value.line2.trim(),
        city: value.city.trim(),
        state: value.state.trim().toUpperCase(),
        zip: value.zip.trim(),
      });
      onClose();
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  const inputCls = (bad: boolean) =>
    `w-full rounded-xl border px-3 py-2.5 text-sm text-gray-900 outline-none transition-shadow placeholder:text-gray-300 focus:border-blue-500 focus:ring-[3px] focus:ring-blue-100 ${
      bad ? "border-red-300 ring-[3px] ring-red-100" : "border-gray-300"
    }`;
  const labelCls = "mb-1.5 block text-[12.5px] font-semibold text-gray-700";
  const firstError =
    errors.addressLine1 ?? errors.city ?? errors.state ?? errors.postalCode;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="md"
      title="About you"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13px] font-semibold text-gray-700 hover:border-gray-300 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={status === "saving"}
            onClick={save}
            className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {status === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
          <div>
            <label className={labelCls} htmlFor="about-dob">
              Date of birth
            </label>
            <input
              id="about-dob"
              inputMode="numeric"
              maxLength={10}
              placeholder="MM/DD/YYYY"
              value={value.dob}
              onChange={(e) => set({ dob: obFmtDob(e.target.value, value.dob) })}
              className={inputCls(dobBad)}
            />
          </div>
          <div>
            <label className={labelCls}>Sex assigned at birth</label>
            <div className="flex flex-wrap gap-2">
              {OB_SEX.map((s) => {
                const on = value.sex === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => set({ sex: on ? null : s.id })}
                    className={`rounded-full border px-3.5 py-2 text-[13px] font-semibold transition-all ${
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
        </div>

        <div className="space-y-3">
          <div className="text-[12.5px] font-semibold text-gray-900">
            Your mailing address
          </div>
          <div>
            <label className={labelCls} htmlFor="about-line1">
              Street address
            </label>
            <input
              id="about-line1"
              value={value.line1}
              onChange={(e) => set({ line1: e.target.value })}
              className={inputCls(!!errors.addressLine1)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="about-line2">
              Suite / unit
            </label>
            <input
              id="about-line2"
              value={value.line2}
              onChange={(e) => set({ line2: e.target.value })}
              className={inputCls(false)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_90px_110px]">
            <div>
              <label className={labelCls} htmlFor="about-city">
                City
              </label>
              <input
                id="about-city"
                value={value.city}
                onChange={(e) => set({ city: e.target.value })}
                className={inputCls(!!errors.city)}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="about-state">
                State
              </label>
              <input
                id="about-state"
                maxLength={2}
                placeholder="WA"
                value={value.state}
                onChange={(e) => set({ state: e.target.value.toUpperCase() })}
                className={`${inputCls(!!errors.state)} uppercase`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="about-zip">
                ZIP code
              </label>
              <input
                id="about-zip"
                inputMode="numeric"
                maxLength={10}
                placeholder="94107"
                value={value.zip}
                onChange={(e) => set({ zip: e.target.value })}
                className={inputCls(!!errors.postalCode)}
              />
            </div>
          </div>
        </div>

        {dobBad ? (
          <div className="text-xs font-medium text-red-600">
            Enter your birth date as MM/DD/YYYY.
          </div>
        ) : firstError ? (
          <div className="text-xs font-medium text-red-600">{firstError}</div>
        ) : status === "error" ? (
          <div className="text-xs font-medium text-red-600">
            Couldn&apos;t save — try again.
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}

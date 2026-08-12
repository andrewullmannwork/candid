"use client";

/**
 * AddressEditModal — the profile page's mailing-address editor (S311, tree §A
 * round-2 — Andrew's ruling: "when they go to edit their address on the
 * profile page it should load an address modal, NOT the whole setup").
 *
 * A thin ModalShell over the FIVE address fields, validated by the ONE shared
 * validateUsAddress rule (the same validator the claim-details row and the
 * provider/insurer address forms use) and saved by the PARENT through the ONE
 * existing POST /api/profile writer — this component owns no fetch. The
 * signup/About flow is untouched: onboarding keeps its 30-second ZIP+DOB scope.
 *
 * All-empty is a valid save (clears the address; letters fail soft without a
 * sender block). Partial → field-level errors. ZIP edits here write the same
 * profiles.zip_code the About step's ZIP writes — one column, one fact.
 */

import { useState } from "react";
import { ModalShell } from "@/components/modal/modal-shell";
import {
  validateUsAddress,
  type UsAddressErrors,
} from "@/lib/address/validate-us-address";

export interface AddressModalValue {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export function AddressEditModal({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: AddressModalValue;
  onClose: () => void;
  /** Parent persists (POST /api/profile) and refreshes its own state. */
  onSave: (value: AddressModalValue) => Promise<void>;
}) {
  const [value, setValue] = useState<AddressModalValue>(initial);
  const [errors, setErrors] = useState<UsAddressErrors>({});
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  const set = (patch: Partial<AddressModalValue>) => {
    setValue((p) => ({ ...p, ...patch }));
    if (Object.keys(errors).length > 0) setErrors({});
    if (status === "error") setStatus("idle");
  };

  const save = async () => {
    const anySet = !!(
      value.line1.trim() ||
      value.city.trim() ||
      value.state.trim() ||
      value.zip.trim()
    );
    if (anySet) {
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
      title="Your mailing address"
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
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="addr-line1">
            Street address
          </label>
          <input
            id="addr-line1"
            value={value.line1}
            onChange={(e) => set({ line1: e.target.value })}
            autoFocus
            className={inputCls(!!errors.addressLine1)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="addr-line2">
            Suite / unit
          </label>
          <input
            id="addr-line2"
            value={value.line2}
            onChange={(e) => set({ line2: e.target.value })}
            className={inputCls(false)}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_90px_110px]">
          <div>
            <label className={labelCls} htmlFor="addr-city">
              City
            </label>
            <input
              id="addr-city"
              value={value.city}
              onChange={(e) => set({ city: e.target.value })}
              className={inputCls(!!errors.city)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="addr-state">
              State
            </label>
            <input
              id="addr-state"
              maxLength={2}
              placeholder="WA"
              value={value.state}
              onChange={(e) => set({ state: e.target.value.toUpperCase() })}
              className={`${inputCls(!!errors.state)} uppercase`}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="addr-zip">
              ZIP code
            </label>
            <input
              id="addr-zip"
              inputMode="numeric"
              maxLength={10}
              placeholder="94107"
              value={value.zip}
              onChange={(e) => set({ zip: e.target.value })}
              className={inputCls(!!errors.postalCode)}
            />
          </div>
        </div>
        {firstError ? (
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

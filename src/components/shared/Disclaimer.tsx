"use client";

import { DISCLAIMERS, type DisclaimerVariant } from "@/lib/legal/disclaimers";

interface DisclaimerProps {
  variant: DisclaimerVariant;
  className?: string;
}

export function Disclaimer({ variant, className }: DisclaimerProps) {
  const text = DISCLAIMERS[variant];
  if (!text) return null;

  // S138 — chrome aligned to design .disclaimer (styles.css lines 336-341):
  // padding 14px 18px, border-radius 12px, font-size 11px, line-height 1.5,
  // bg-50 grey, border-100 grey, text-500 grey.
  return (
    <div
      className={`mt-7 rounded-xl border border-gray-100 bg-gray-50 px-[18px] py-3.5 text-[11px] leading-[1.5] text-gray-500 ${className ?? ""}`}
    >
      <p className="m-0">{text}</p>
    </div>
  );
}

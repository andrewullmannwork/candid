"use client";

import { DISCLAIMERS, type DisclaimerVariant } from "@/lib/legal/disclaimers";

interface DisclaimerProps {
  variant: DisclaimerVariant;
  className?: string;
}

export function Disclaimer({ variant, className }: DisclaimerProps) {
  const text = DISCLAIMERS[variant];
  if (!text) return null;

  return (
    <div
      className={`mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500 ${className ?? ""}`}
    >
      <p>{text}</p>
    </div>
  );
}

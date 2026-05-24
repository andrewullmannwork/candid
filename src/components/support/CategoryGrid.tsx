"use client";

import { cn } from "@/lib/utils/cn";

export type SupportCategoryId = "bill" | "plan" | "benefits" | "billing" | "other";

interface CategoryDef {
  id: SupportCategoryId;
  title: string;
  tint: string;
  ink: string;
  iconD: string;
}

const CATEGORIES: CategoryDef[] = [
  { id: "bill",     title: "Bill",     tint: "#fef2f2", ink: "#dc2626",
    iconD: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
  { id: "plan",     title: "Plan",     tint: "#eff6ff", ink: "#2563eb",
    iconD: "M9 6V5a2 2 0 012-2h2a2 2 0 012 2v1m-9 0h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zm0 0v3a2 2 0 002 2h10a2 2 0 002-2V6" },
  { id: "benefits", title: "Benefits", tint: "#ecfdf5", ink: "#059669",
    iconD: "M9 12l2 2 4-4m5.6-4A11.9 11.9 0 0112 2.9 11.9 11.9 0 013.4 6 12 12 0 003 9c0 5.6 3.8 10.3 9 11.6 5.2-1.3 9-6 9-11.6 0-1-.1-2-.4-3z" },
  { id: "billing",  title: "Billing",  tint: "#faf5ff", ink: "#7e22ce",
    iconD: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
  { id: "other",    title: "Other",    tint: "#f3f4f6", ink: "#374151",
    iconD: "M8.2 9a3.8 3.8 0 017.6 0c0 2.4-3.8 3-3.8 6m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
];

function CategoryIcon({ d }: { d: string }) {
  return (
    <svg width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

interface Props {
  value: SupportCategoryId | null;
  onChange: (value: SupportCategoryId) => void;
}

export default function CategoryGrid({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {CATEGORIES.map((c) => {
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={cn(
              "relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-sm font-medium",
              selected
                ? "border-blue-600 bg-blue-50/40 shadow-sm"
                : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50",
            )}
          >
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{ background: c.tint, color: c.ink }}
            >
              <CategoryIcon d={c.iconD} />
            </div>
            <div className="text-gray-900">{c.title}</div>
            {selected && (
              <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center">
                <svg width={10} height={10} fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Free bill check — no account needed",
  description:
    "Upload a medical bill and get a free error check — duplicate charges, billing math, and what your plan says you owe. No account required.",
};

export default function CheckLayout({ children }: { children: ReactNode }) {
  return children;
}

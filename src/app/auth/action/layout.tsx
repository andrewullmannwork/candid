import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account Action — Candid",
  description: "Confirm an action on your Candid account.",
  alternates: { canonical: "/auth/action" },
  robots: { index: false, follow: false },
};

export default function ActionLayout({ children }: { children: React.ReactNode }) {
  return children;
}

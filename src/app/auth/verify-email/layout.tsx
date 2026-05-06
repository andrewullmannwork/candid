import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Verify Email — Candid",
  description: "Confirm your Candid email address to finish setting up your account.",
  alternates: { canonical: "/auth/verify-email" },
  robots: { index: false, follow: false },
};

export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}

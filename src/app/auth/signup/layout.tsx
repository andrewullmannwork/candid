import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign Up — Free Medical Bill Audit",
  description:
    "Create your Candid Claim account. Audit medical bills for free, discover unused insurance benefits, and draft dispute letters. No credit card required.",
  alternates: { canonical: "/auth/signup" },
};

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return children;
}

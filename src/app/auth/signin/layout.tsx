import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign In",
  description:
    "Sign in to your Candid account to audit medical bills, review insurance benefits, and manage dispute letters.",
  alternates: { canonical: "/auth/signin" },
};

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign Up — Join the Waitlist",
  description:
    "Create your Candid account. Audit medical bills for free, discover unused insurance benefits, and fight overcharges with auto-generated dispute letters.",
  alternates: { canonical: "/auth/signup" },
};

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return children;
}

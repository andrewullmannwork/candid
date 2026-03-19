"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">
        Welcome{user?.firebaseUser.displayName ? `, ${user.firebaseUser.displayName}` : ""}
      </h1>
      <p className="mt-2 text-gray-600">
        Get started by uploading a medical bill or EOB for a free audit.
      </p>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
        <DashCard
          title="Upload a Bill"
          description="Upload your EOB or itemized bill for analysis."
          href="/upload"
          cta="Upload Document"
        />
        <DashCard
          title="Your Profile"
          description="Add your insurance details for more accurate audits."
          href="/profile"
          cta="Complete Profile"
        />
      </div>

      <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <h3 className="font-medium text-blue-900">Coming Soon</h3>
        <p className="mt-1 text-sm text-blue-700">
          Bill audit engine, dispute letter generation, and Mestimate price comparison are under
          development. Upload your bills now so they&apos;re ready when we launch.
        </p>
      </div>
    </div>
  );
}

function DashCard({
  title,
  description,
  href,
  cta,
}: {
  title: string;
  description: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="p-6 bg-white border rounded-xl">
      <h3 className="font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 text-sm text-gray-600">{description}</p>
      <Link
        href={href}
        className="inline-block mt-4 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
      >
        {cta}
      </Link>
    </div>
  );
}

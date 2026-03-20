"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { getConsentDocument } from "@/lib/consent/consent-documents";

export default function SignUpPage() {
  const router = useRouter();
  const { signUpWithEmail, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const tosDoc = getConsentDocument("tos");
  const privacyDoc = getConsentDocument("privacy_policy");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tosAccepted || !privacyAccepted) {
      setError("You must accept both the Terms of Service and Privacy Policy to create an account.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await signUpWithEmail(email, password);
      router.push("/dashboard");
    } catch {
      setError("Failed to create account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    if (!tosAccepted || !privacyAccepted) {
      setError("You must accept both the Terms of Service and Privacy Policy to create an account.");
      return;
    }
    try {
      await signInWithGoogle();
      router.push("/dashboard");
    } catch {
      setError("Google sign-up failed");
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="text-2xl font-bold text-blue-600">
            Candid
          </Link>
          <h1 className="mt-4 text-xl font-semibold">Create your account</h1>
          <p className="mt-1 text-sm text-gray-500">You must be 18 or older to use Candid.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          {/* Explicit consent checkboxes — NOT passive acceptance */}
          <div className="space-y-3 p-4 bg-gray-50 rounded-lg">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">
                I have read and agree to the{" "}
                <Link href="/terms" target="_blank" className="text-blue-600 hover:underline">
                  Terms of Service
                </Link>{" "}
                (v{tosDoc.version})
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={privacyAccepted}
                onChange={(e) => setPrivacyAccepted(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">
                I have read and agree to the{" "}
                <Link href="/privacy" target="_blank" className="text-blue-600 hover:underline">
                  Privacy Policy
                </Link>{" "}
                (v{privacyDoc.version})
              </span>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || !tosAccepted || !privacyAccepted}
            className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white text-gray-500">or</span>
          </div>
        </div>

        <button
          onClick={handleGoogle}
          disabled={!tosAccepted || !privacyAccepted}
          className="w-full py-3 border rounded-lg hover:bg-gray-50 disabled:opacity-50 font-medium"
        >
          Continue with Google
        </button>

        {error && <p className="text-red-600 text-sm text-center">{error}</p>}

        <p className="text-center text-sm text-gray-500">
          Already have an account?{" "}
          <Link href="/auth/signin" className="text-blue-600 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

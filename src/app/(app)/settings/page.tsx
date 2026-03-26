"use client";

// Settings / Privacy & Data page
// Fulfills legal promises: consent revocation UI, account deletion, data export request

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { useConsent } from "@/lib/consent/use-consent";
import type { ConsentType } from "@/lib/supabase/types";

// ─── Consent row component ──────────────────────────────────────────────────

interface ConsentRowProps {
  label: string;
  description: string;
  type: ConsentType;
  revocable: boolean;
  revokeWarning?: string;
}

function ConsentRow({ label, description, type, revocable, revokeWarning }: ConsentRowProps) {
  const { hasConsented, loading, currentVersion, revokeConsent } = useConsent(type);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");

  async function handleRevoke() {
    setRevoking(true);
    setError("");
    try {
      await revokeConsent();
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke consent.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-gray-100 last:border-b-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="mt-0.5 text-xs text-gray-500">{description}</p>
        <p className="mt-1 text-xs text-gray-400">
          {loading ? (
            "Checking..."
          ) : hasConsented ? (
            <span className="text-green-600">Granted &middot; v{currentVersion}</span>
          ) : (
            <span className="text-gray-400">Not granted</span>
          )}
        </p>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>

      {revocable && hasConsented && !loading && (
        <div className="flex-shrink-0">
          {confirming ? (
            <div className="flex flex-col items-end gap-1.5">
              {revokeWarning && (
                <p className="text-xs text-red-600 text-right max-w-[220px]">{revokeWarning}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirming(false)}
                  disabled={revoking}
                  className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRevoke}
                  disabled={revoking}
                  className="px-3 py-1.5 text-xs text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {revoking ? "Revoking..." : "Confirm Revoke"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
            >
              Revoke
            </button>
          )}
        </div>
      )}

      {!revocable && (
        <span className="flex-shrink-0 px-2.5 py-1 text-xs text-gray-400 bg-gray-50 rounded-lg">
          Required
        </span>
      )}
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user } = useAuth();

  // Data export state
  const [exportRequesting, setExportRequesting] = useState(false);
  const [exportRequested, setExportRequested] = useState(false);
  const [exportError, setExportError] = useState("");

  // Account deletion state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function handleExportRequest() {
    if (!user) return;
    setExportRequesting(true);
    setExportError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/account/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to request data export");
      }
      setExportRequested(true);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setExportRequesting(false);
    }
  }

  async function handleDeleteAccount() {
    if (!user || deleteConfirmText !== "DELETE") return;
    setDeleting(true);
    setDeleteError("");
    try {
      const idToken = await user.firebaseUser.getIdToken();
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete account");
      }
      // Account deleted — redirect to home or sign-out will happen automatically
      window.location.href = "/";
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Privacy &amp; Data</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          Manage your consents, request a data export, or delete your account.
        </p>
      </div>

      {/* ── Section 1: Consents ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Your Consents</h2>
        <p className="text-xs text-gray-500 mb-4">
          You can revoke optional consents at any time. Required consents cannot be revoked while
          your account is active.
        </p>

        <ConsentRow
          label="Terms of Service"
          description="Required to use Candid."
          type="tos"
          revocable={false}
        />
        <ConsentRow
          label="Privacy Policy"
          description="Required to use Candid."
          type="privacy_policy"
          revocable={false}
        />
        <ConsentRow
          label="Health Data Upload"
          description="Allows you to upload insurance documents for auditing."
          type="health_data_upload"
          revocable={true}
          revokeWarning="Revoking this consent will permanently delete all uploaded documents."
        />
        <ConsentRow
          label="Marketplace Data Sharing"
          description="Lets us share anonymized data with marketplace partners."
          type="marketplace_data_sharing"
          revocable={true}
        />
        <ConsentRow
          label="Aggregate Data Monetization"
          description="Allows aggregated, de-identified data use for research insights."
          type="aggregate_data_monetization"
          revocable={true}
        />
      </div>

      {/* ── Section 2: Data Export ──────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Data Export</h2>
        <p className="text-xs text-gray-500 mb-4">
          We&apos;ll email you a JSON export of all your data within 30 days, as required by
          CCPA/CPRA.
        </p>

        {exportRequested ? (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center">
            <p className="text-sm font-medium text-green-800">Export Requested</p>
            <p className="mt-1 text-xs text-green-700">
              You&apos;ll receive an email with your data export.
            </p>
          </div>
        ) : (
          <>
            <button
              onClick={handleExportRequest}
              disabled={exportRequesting}
              className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-50"
            >
              {exportRequesting ? "Requesting..." : "Request Data Export"}
            </button>
            {exportError && (
              <p className="mt-2 text-xs text-red-600">{exportError}</p>
            )}
          </>
        )}
      </div>

      {/* ── Section 3: Delete Account ──────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-red-200 p-5 mb-8">
        <h2 className="text-base font-semibold text-red-700 mb-1">Danger Zone</h2>
        <p className="text-xs text-gray-500 mb-4">
          This permanently deletes your account, all uploaded documents, and all personal data
          within 30 days. This cannot be undone.
        </p>

        {!showDeleteDialog ? (
          <button
            onClick={() => setShowDeleteDialog(true)}
            className="w-full px-4 py-2.5 text-sm font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
          >
            Delete My Account
          </button>
        ) : (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-800 font-medium mb-3">
              Type <span className="font-mono font-bold">DELETE</span> to confirm account deletion.
            </p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Type DELETE"
              className="w-full px-3 py-2 text-sm border border-red-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400 mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowDeleteDialog(false);
                  setDeleteConfirmText("");
                  setDeleteError("");
                }}
                className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmText !== "DELETE" || deleting}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting..." : "Permanently Delete"}
              </button>
            </div>
            {deleteError && (
              <p className="mt-2 text-xs text-red-600">{deleteError}</p>
            )}
          </div>
        )}
      </div>

      {/* Back link */}
      <div className="text-center mb-8">
        <Link href="/profile" className="text-sm text-blue-600 hover:underline">
          &larr; Back to Profile
        </Link>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { getConsentDocument } from "./consent-documents";
import type { ConsentType } from "@/lib/supabase/types";

interface UseConsentReturn {
  /** User has granted the current version of this consent */
  hasConsented: boolean;
  /** User has a prior version but needs to re-consent to current version */
  needsReconsent: boolean;
  /** Loading state while checking consent status */
  loading: boolean;
  /** The current consent document version */
  currentVersion: string;
  /** Grant consent for the current version */
  grantConsent: () => Promise<void>;
  /** Revoke consent (records granted=false event) */
  revokeConsent: () => Promise<void>;
}

export function useConsent(type: ConsentType): UseConsentReturn {
  const { user } = useAuth();
  const [hasConsented, setHasConsented] = useState(false);
  const [needsReconsent, setNeedsReconsent] = useState(false);
  const [loading, setLoading] = useState(true);

  const consentDoc = getConsentDocument(type);
  const currentVersion = consentDoc.version;

  // Check if user has consented to the current version (via API)
  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    async function checkConsent() {
      try {
        const idToken = await user!.firebaseUser.getIdToken();
        const res = await fetch("/api/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            action: "check",
            consentType: type,
            consentVersion: currentVersion,
            consentTextHash: consentDoc.hash,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          setHasConsented(data.hasConsented);
          setNeedsReconsent(data.needsReconsent);
        } else {
          // If check fails, assume no consent
          setHasConsented(false);
          setNeedsReconsent(false);
        }
      } catch (err) {
        console.error("Consent check failed:", err);
        setHasConsented(false);
        setNeedsReconsent(false);
      }
      setLoading(false);
    }

    checkConsent();
  }, [user, type, currentVersion, consentDoc.hash]);

  const grantConsent = useCallback(async () => {
    if (!user) throw new Error("Must be authenticated to grant consent");

    const idToken = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action: "grant",
        consentType: type,
        consentVersion: currentVersion,
        consentTextHash: consentDoc.hash,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to record consent");
    }

    setHasConsented(true);
    setNeedsReconsent(false);
  }, [user, type, currentVersion, consentDoc.hash]);

  const revokeConsent = useCallback(async () => {
    if (!user) throw new Error("Must be authenticated to revoke consent");

    const idToken = await user.firebaseUser.getIdToken();
    const res = await fetch("/api/consent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action: "revoke",
        consentType: type,
        consentVersion: currentVersion,
        consentTextHash: consentDoc.hash,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to record revocation");
    }

    // If revoking health data consent, trigger document deletion
    if (type === "health_data_upload") {
      await fetch("/api/consent/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ consentType: type }),
      });
    }

    setHasConsented(false);
    setNeedsReconsent(false);
  }, [user, type, currentVersion, consentDoc.hash]);

  return { hasConsented, needsReconsent, loading, currentVersion, grantConsent, revokeConsent };
}

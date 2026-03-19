"use client";

import { useState, useEffect, useCallback } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
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

  // Check if user has consented to the current version
  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    const supabase = createBrowserClient();

    async function checkConsent() {
      // Get the most recent consent event for this type
      const { data } = await supabase
        .from("consent_events")
        .select("consent_version, granted")
        .eq("user_id", user!.userId)
        .eq("consent_type", type)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!data) {
        // Never consented
        setHasConsented(false);
        setNeedsReconsent(false);
      } else if (!data.granted) {
        // Most recent event is a revocation
        setHasConsented(false);
        setNeedsReconsent(false);
      } else if (data.consent_version !== currentVersion) {
        // Consented to a prior version — need re-consent
        setHasConsented(false);
        setNeedsReconsent(true);
      } else {
        setHasConsented(true);
        setNeedsReconsent(false);
      }
      setLoading(false);
    }

    checkConsent();
  }, [user, type, currentVersion]);

  const grantConsent = useCallback(async () => {
    if (!user) throw new Error("Must be authenticated to grant consent");

    const supabase = createBrowserClient();
    const { error } = await supabase.from("consent_events").insert({
      user_id: user.userId,
      consent_type: type,
      consent_version: currentVersion,
      consent_text_hash: consentDoc.hash,
      granted: true,
    });

    if (error) throw new Error(`Failed to record consent: ${error.message}`);

    setHasConsented(true);
    setNeedsReconsent(false);
  }, [user, type, currentVersion, consentDoc.hash]);

  const revokeConsent = useCallback(async () => {
    if (!user) throw new Error("Must be authenticated to revoke consent");

    // Record revocation event
    const supabase = createBrowserClient();
    const { error } = await supabase.from("consent_events").insert({
      user_id: user.userId,
      consent_type: type,
      consent_version: currentVersion,
      consent_text_hash: consentDoc.hash,
      granted: false,
    });

    if (error) throw new Error(`Failed to record revocation: ${error.message}`);

    // If revoking health data consent, trigger document deletion via API
    if (type === "health_data_upload") {
      await fetch("/api/consent/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consentType: type }),
      });
    }

    setHasConsented(false);
    setNeedsReconsent(false);
  }, [user, type, currentVersion, consentDoc.hash]);

  return { hasConsented, needsReconsent, loading, currentVersion, grantConsent, revokeConsent };
}

"use client";

/**
 * useSubscribeTrigger — shared hook + render helper for the three paywalled
 * surfaces (/claim, /case, /care, + /disputes legacy). Hides the
 * embedded-vs-redirect branch from callers:
 *
 *   - embedded_subscribe flag ON  → opens <EmbeddedSubscribeFlow> inline
 *   - flag OFF                    → redirects to Stripe Checkout (legacy)
 *
 * Callers do:
 *   const { trigger, render } = useSubscribeTrigger();
 *   <button onClick={() => trigger({ surface: "dispute", ribbon: {...} })}>Upgrade</button>
 *   {render()}
 */

import { useCallback, useEffect, useState } from "react";
import {
  EmbeddedSubscribeFlow,
  type TriggerSurface,
} from "@/components/billing/EmbeddedSubscribeFlow";
import { useAuth } from "@/lib/auth/auth-context";
import { useSubscription } from "@/lib/subscription/use-subscription";

interface TriggerArgs {
  surface: TriggerSurface;
  ribbon?: { headline: string; subline: string };
  /** Optional callback after the subscription activates. Fires only on
   *  embedded-flow success — redirect path reloads the page entirely. */
  onSuccess?: () => void | Promise<void>;
}

export function useSubscribeTrigger() {
  const { user } = useAuth();
  const { refresh } = useSubscription();
  const [embeddedEnabled, setEmbeddedEnabled] = useState<boolean | null>(null);
  const [state, setState] = useState<{
    open: boolean;
    args: TriggerArgs | null;
  }>({ open: false, args: null });
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/feature-flags/embedded_subscribe", {
          // Unauthenticated is fine — flag answer isn't user-specific at this
          // read point. If the route 404s we fall back to legacy redirect.
          method: "GET",
        });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setEmbeddedEnabled(!!data.enabled);
        } else {
          setEmbeddedEnabled(false);
        }
      } catch {
        if (!cancelled) setEmbeddedEnabled(false);
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  const trigger = useCallback(
    async (args: TriggerArgs) => {
      if (!user || redirecting) return;
      if (embeddedEnabled) {
        setState({ open: true, args });
        return;
      }
      // Legacy redirect path.
      setRedirecting(true);
      try {
        const token = await user.firebaseUser.getIdToken();
        const res = await fetch("/api/stripe/create-checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ returnUrl: window.location.href }),
        });
        if (res.ok) {
          const { url } = await res.json();
          if (url) window.location.href = url;
        }
      } catch (err) {
        console.error("Stripe checkout failed:", err);
      }
      setRedirecting(false);
    },
    [user, redirecting, embeddedEnabled]
  );

  const render = useCallback(
    () =>
      state.args ? (
        <EmbeddedSubscribeFlow
          isOpen={state.open}
          triggerSurface={state.args.surface}
          contextRibbon={state.args.ribbon}
          onSuccess={async () => {
            // Let the caller await webhook-driven tier flip before we
            // dismiss the modal. Falls back to a single refresh if no
            // onSuccess was passed.
            if (state.args?.onSuccess) {
              await state.args.onSuccess();
            } else {
              await refresh();
            }
            setState({ open: false, args: null });
          }}
          onCancel={() => setState({ open: false, args: null })}
        />
      ) : null,
    [state, refresh]
  );

  return { trigger, render, redirecting };
}

"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef } from "react";

/**
 * Cloudflare Turnstile React wrapper.
 *
 * Renders an explicit Turnstile widget in Managed mode (Cloudflare auto-decides
 * invisible vs interactive challenge based on traffic risk). Loads the
 * Cloudflare API script once globally and tracks token state via the parent's
 * onToken callback.
 *
 * Site key resolution:
 *   - Production: NEXT_PUBLIC_TURNSTILE_SITE_KEY (must be set; render fails open
 *     by rendering nothing if unset, so we don't block signup if env vars are
 *     misconfigured at deploy time — server-side verification is the actual gate
 *     and will 403 if the flag is on but the secret isn't set).
 *   - Dev / Vercel preview: Cloudflare's published always-pass test site key
 *     (1x00000000000000000000AA), safe to commit.
 *
 * Server-side companion: src/lib/security/turnstile.ts verifyTurnstileToken().
 */

// Cloudflare's published always-pass test site key. Safe to commit; documented
// at https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const ALWAYS_PASS_TEST_SITE_KEY = "1x00000000000000000000AA";
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "flexible" | "compact";
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __candidTurnstileScriptLoading?: Promise<void>;
  }
}

function isProductionClient(): boolean {
  // Mirrors src/lib/security/turnstile.ts isProduction() for client-side
  // decisioning. NEXT_PUBLIC_VERCEL_ENV is exposed by Vercel automatically.
  if (typeof window === "undefined") return false;
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
  if (vercelEnv) return vercelEnv === "production";
  return process.env.NODE_ENV === "production";
}

function getSiteKey(): string {
  const real = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (real) return real;
  if (isProductionClient()) {
    // Misconfiguration — render nothing rather than show a test widget on prod.
    // Server will 403 if the flag is on, surfacing the bad config to the user
    // as a generic error.
    return "";
  }
  return ALWAYS_PASS_TEST_SITE_KEY;
}

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (window.__candidTurnstileScriptLoading) return window.__candidTurnstileScriptLoading;

  window.__candidTurnstileScriptLoading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="https://challenges.cloudflare.com/turnstile/"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Turnstile script failed to load")));
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(script);
  });

  return window.__candidTurnstileScriptLoading;
}

export interface TurnstileWidgetProps {
  /** Called with the token whenever the widget produces one (initial + after expiry refresh). */
  onToken: (token: string | null) => void;
  /** Free-form action label for telemetry inside Cloudflare's dashboard. */
  action?: string;
  className?: string;
}

/**
 * Imperative handle exposed via ref. Use `reset()` after a token is consumed
 * server-side (e.g., after a successful upload) so the widget issues a fresh
 * token for the next action — Cloudflare tokens are single-use.
 */
export interface TurnstileWidgetHandle {
  reset: () => void;
}

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ onToken, action, className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    const onTokenRef = useRef(onToken);
    const id = useId();

    // Keep latest onToken without re-rendering the widget
    useEffect(() => {
      onTokenRef.current = onToken;
    }, [onToken]);

    useImperativeHandle(
      ref,
      () => ({
        reset: () => {
          const widgetId = widgetIdRef.current;
          if (widgetId && window.turnstile) {
            try {
              window.turnstile.reset(widgetId);
              onTokenRef.current(null);
            } catch (err) {
              console.error("[Turnstile] reset failed:", err);
            }
          }
        },
      }),
      [],
    );

    useEffect(() => {
      let cancelled = false;
      const siteKey = getSiteKey();
      if (!siteKey) {
        // Misconfigured prod — render nothing; server-side gate will 403 if flag
        // is enforced, surfacing the bad config as an error message in the form.
        return;
      }

      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            action,
            callback: (token: string) => onTokenRef.current(token),
            "expired-callback": () => onTokenRef.current(null),
            "error-callback": () => onTokenRef.current(null),
            theme: "light",
            size: "flexible",
          });
        })
        .catch((err) => {
          console.error("[Turnstile] failed to load widget:", err);
          // Surface as null token; form submit will be blocked client-side, and
          // the user can retry. A common cause is ad blockers; we display a
          // generic error message at the form level rather than diagnosing here.
        });

      return () => {
        cancelled = true;
        const widgetId = widgetIdRef.current;
        if (widgetId && window.turnstile) {
          try {
            window.turnstile.remove(widgetId);
          } catch {
            // Widget may already be gone
          }
        }
      };
    }, [action]);

    return <div ref={containerRef} id={`turnstile-${id}`} className={className} />;
  },
);

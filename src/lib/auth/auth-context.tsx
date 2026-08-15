"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInAnonymously,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  updateProfile,
  linkWithPhoneNumber,
  RecaptchaVerifier,
  type User as FirebaseUser,
  type ConfirmationResult,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { readFirstTouch } from "@/lib/attribution/first-touch";

export interface CandidUser {
  firebaseUser: FirebaseUser;
  userId: string;
  email: string;
  stripeCustomerId: string;
  emailVerified: boolean;
  phoneE164: string | null;
  phoneVerified: boolean;
  // S315 — Firebase anonymous-provider account (no-account bill check). The
  // (app) layout keeps anonymous users on /check; upgrade = linkWithCredential.
  isAnonymous: boolean;
}

interface ConsentPayload {
  type: string;
  version: string;
  hash: string;
}

// User-initiated auth actions that require Turnstile verification (S68).
// Passive resyncs from onAuthStateChanged omit this and skip the gate.
// "anon_check_start" (S315): creation of an anonymous bill-check account —
// Turnstile-gated exactly like signup; the server additionally requires it
// before any NEW anonymous row is created (passive resyncs can't mint one).
type UserAuthAction = "signup" | "signin" | "anon_check_start";

interface AuthContextValue {
  user: CandidUser | null;
  loading: boolean;

  // Two-phase signup flow (S69) — phone OTP step happens between start + finish:
  //   1. signUpStart / signUpStartGoogle creates Firebase user; returns FirebaseUser
  //   2. caller drives phone OTP step via startPhoneVerification + ConfirmationResult.confirm
  //   3. signUpFinish syncs to Supabase with userAction="signup" + consents + Turnstile
  signUpStart: (
    email: string,
    password: string,
    displayName?: string,
  ) => Promise<FirebaseUser>;
  signUpStartGoogle: () => Promise<FirebaseUser>;
  // declaredTestPhone (S288): set ONLY by the test-phone-exemption signup path
  // (src/lib/auth/test-phone-exempt.ts) when the OTP link was skipped for the
  // allowlisted test number; the server validates + stamps it.
  signUpFinish: (
    firebaseUser: FirebaseUser,
    consents: ConsentPayload[],
    turnstileToken: string,
    declaredTestPhone?: string,
  ) => Promise<CandidUser>;

  // Phone OTP primitive (S69). Confirmation is via the returned
  // ConfirmationResult.confirm(code) method directly.
  startPhoneVerification: (
    firebaseUser: FirebaseUser,
    phoneE164: string,
  ) => Promise<ConfirmationResult>;

  // R8 orphan recovery (S69) — re-signup with same email when Firebase user
  // exists but Supabase row doesn't (user abandoned mid-OTP). Returns Firebase
  // user without syncing so caller can check phoneNumber + resume OTP step.
  recoverOrphanSignup: (email: string, password: string) => Promise<FirebaseUser>;

  // Signin paths (single-call; no OTP step per Q-S69-5):
  signInWithEmail: (
    email: string,
    password: string,
    turnstileToken?: string,
  ) => Promise<void>;
  signInWithGoogle: (turnstileToken?: string) => Promise<void>;

  // S315 A-1 — anonymous bill-check entry (/check Screen 1). Creates a Firebase
  // anonymous account, then syncs with userAction="anon_check_start" carrying
  // the consents + the typed results contact. Flag-gated server-side
  // (anonymous_bill_check_v1); the sync 403s when the flag is OFF.
  startAnonymousCheck: (
    contactEmail: string,
    consents: ConsentPayload[],
    turnstileToken: string,
  ) => Promise<CandidUser>;

  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function syncWithBackend(
  firebaseUser: FirebaseUser,
  consents?: ConsentPayload[],
  userAction?: UserAuthAction,
  turnstileToken?: string,
  declaredTestPhone?: string,
  anonContactEmail?: string,
): Promise<CandidUser> {
  let idToken: string;
  try {
    idToken = await firebaseUser.getIdToken();
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "auth/network-request-failed") {
      throw Object.assign(new Error("Network unavailable — will retry"), { code });
    }
    throw err;
  }

  const res = await fetch("/api/auth/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // firstTouch: channel-attribution snapshot (mig 203). Sent on every sync;
    // the server persists it only on the new-user INSERT (first touch wins).
    body: JSON.stringify({
      idToken,
      consents,
      userAction,
      turnstileToken,
      firstTouch: readFirstTouch(),
      // S288 test-phone exemption — undefined (and JSON-omitted) on every
      // normal sync; the server ignores it unless it matches the allowlisted
      // constant AND the kill switch is ON.
      declaredTestPhone,
      // S315 anonymous check — the typed results/deletion contact. Server
      // stores it as users.contact_email on the anonymous path only.
      anonContactEmail,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    if (res.status === 403) {
      const msg: string = (errBody as { error?: string })?.error ?? "";
      // Phone OTP gate (S69) returns 403 with a message about phone verification.
      // Distinguish it from Turnstile 403 so caller surfaces the right UX.
      if (msg.toLowerCase().includes("phone verification")) {
        // S290 — EXPECTED state during signup: the auth-state listener syncs
        // before the OTP step completes, the gate answers 403, and the caller
        // routes the user into OTP. Not an error; log quietly.
        console.info("Auth sync: phone verification pending (expected pre-OTP).");
        throw Object.assign(
          new Error("Phone verification required. Please complete the OTP step."),
          { code: "auth/phone-verification-required" },
        );
      }
      console.error("Auth sync failed:", res.status, errBody);
      throw Object.assign(new Error("Bot defense check failed. Please reload and try again."), {
        code: "auth/turnstile-failed",
      });
    }
    console.error("Auth sync failed:", res.status, errBody);
    throw new Error("Failed to sync auth");
  }

  const data = (await res.json()) as {
    userId: string;
    email: string;
    stripeCustomerId: string;
    emailVerified?: boolean;
    phoneE164?: string | null;
    phoneVerified?: boolean;
    isAnonymous?: boolean;
  };
  return {
    firebaseUser,
    userId: data.userId,
    email: data.email,
    stripeCustomerId: data.stripeCustomerId,
    emailVerified: data.emailVerified ?? firebaseUser.emailVerified,
    phoneE164: data.phoneE164 ?? firebaseUser.phoneNumber ?? null,
    phoneVerified: data.phoneVerified ?? firebaseUser.phoneNumber !== null,
    isAnonymous: data.isAnonymous ?? firebaseUser.isAnonymous,
  };
}

// Reusable invisible RecaptchaVerifier for Firebase Phone Auth. Firebase
// requires a visible (or invisible) reCAPTCHA before any signInWithPhoneNumber
// or linkWithPhoneNumber call. We mount the container once on demand and reuse
// the verifier across resends within a single page session.
const RECAPTCHA_CONTAINER_ID = "candid-firebase-recaptcha-container";

function getOrCreateRecaptchaVerifier(): RecaptchaVerifier {
  if (typeof window === "undefined") {
    throw new Error("RecaptchaVerifier requires a browser environment");
  }

  // Reuse existing verifier on the window if present (Firebase caches it
  // internally, but we want a stable reference across renders).
  const existing = (window as unknown as { __candidRecaptchaVerifier?: RecaptchaVerifier })
    .__candidRecaptchaVerifier;
  if (existing) return existing;

  // Ensure the container DIV exists in the DOM.
  let container = document.getElementById(RECAPTCHA_CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = RECAPTCHA_CONTAINER_ID;
    container.style.display = "none";
    document.body.appendChild(container);
  }

  const verifier = new RecaptchaVerifier(getFirebaseAuth(), RECAPTCHA_CONTAINER_ID, {
    size: "invisible",
  });

  (window as unknown as { __candidRecaptchaVerifier?: RecaptchaVerifier })
    .__candidRecaptchaVerifier = verifier;
  return verifier;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CandidUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Tracks Firebase users mid-signup (signUpStart called, signUpFinish not yet).
  // The onAuthStateChanged listener checks this set and skips auto-sync to
  // avoid 403 noise from the phone-OTP gate during the OTP window.
  const pendingSignupUidsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (firebaseUser) => {
      if (firebaseUser) {
        try {
          if (!user || user.firebaseUser.uid !== firebaseUser.uid) {
            if (pendingSignupUidsRef.current.has(firebaseUser.uid)) {
              // Signup is in flight; signUpFinish will sync after OTP confirm.
              return;
            }
            const candidUser = await syncWithBackend(firebaseUser);
            setUser(candidUser);
          }
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === "auth/network-request-failed") {
            console.warn("Network issue during auth sync — will retry on next state change");
          } else if (code === "auth/phone-verification-required") {
            // Brand-new account without phone (likely a /auth/signin Google
            // attempt for an account that doesn't exist). Caller should
            // route through phone OTP via /auth/signup. Surface gracefully.
            console.warn("Auth sync requires phone verification — sign up via /auth/signup");
            setUser(null);
          } else {
            console.error("Auth sync failed:", err);
            setUser(null);
          }
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signUpStart = useCallback(
    async (email: string, password: string, displayName?: string): Promise<FirebaseUser> => {
      const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
      if (displayName) {
        await updateProfile(cred.user, { displayName });
      }
      // Mark this UID as mid-signup so the listener doesn't try to sync before
      // the OTP step completes.
      pendingSignupUidsRef.current.add(cred.user.uid);
      return cred.user;
    },
    [],
  );

  const signUpStartGoogle = useCallback(async (): Promise<FirebaseUser> => {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(getFirebaseAuth(), provider);
    // For Google signup we always defer sync until phone OTP confirms (or is
    // skipped if Google user already has a linked phone). Caller checks
    // cred.user.phoneNumber to decide whether to enter OTP step.
    pendingSignupUidsRef.current.add(cred.user.uid);
    return cred.user;
  }, []);

  const signUpFinish = useCallback(
    async (
      firebaseUser: FirebaseUser,
      consents: ConsentPayload[],
      turnstileToken: string,
      declaredTestPhone?: string,
    ): Promise<CandidUser> => {
      // Force a token refresh so the latest decoded.phone_number claim makes
      // it to the server (Firebase doesn't auto-refresh after linkWithPhoneNumber).
      // On the S288 test-phone-exemption path there's no new claim (link was
      // skipped) — the refresh is a harmless no-op there.
      await firebaseUser.getIdToken(true);
      const candidUser = await syncWithBackend(firebaseUser, consents, "signup", turnstileToken, declaredTestPhone);
      pendingSignupUidsRef.current.delete(firebaseUser.uid);
      setUser(candidUser);
      return candidUser;
    },
    [],
  );

  const startPhoneVerification = useCallback(
    async (firebaseUser: FirebaseUser, phoneE164: string): Promise<ConfirmationResult> => {
      const verifier = getOrCreateRecaptchaVerifier();
      return await linkWithPhoneNumber(firebaseUser, phoneE164, verifier);
    },
    [],
  );

  const recoverOrphanSignup = useCallback(
    async (email: string, password: string): Promise<FirebaseUser> => {
      // Sign in via Firebase native (no syncWithBackend) so caller can inspect
      // phoneNumber and decide whether to enter OTP step or push to dashboard.
      const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
      pendingSignupUidsRef.current.add(cred.user.uid);
      return cred.user;
    },
    [],
  );

  const signInWithEmail = useCallback(
    async (email: string, password: string, turnstileToken?: string) => {
      const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
      const candidUser = await syncWithBackend(cred.user, undefined, "signin", turnstileToken);
      setUser(candidUser);
    },
    [],
  );

  const signInWithGoogle = useCallback(
    async (turnstileToken?: string) => {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(getFirebaseAuth(), provider);
      const candidUser = await syncWithBackend(cred.user, undefined, "signin", turnstileToken);
      setUser(candidUser);
    },
    [],
  );

  // S315 A-1 — anonymous bill-check entry. Mirrors the signUpStart idiom: the
  // uid goes into pendingSignupUidsRef BEFORE the account exists so the
  // auth-state listener's passive sync (no Turnstile, no consents) never races
  // the explicit "anon_check_start" sync that actually creates the row.
  const startAnonymousCheck = useCallback(
    async (
      contactEmail: string,
      consents: ConsentPayload[],
      turnstileToken: string,
    ): Promise<CandidUser> => {
      const cred = await signInAnonymously(getFirebaseAuth());
      pendingSignupUidsRef.current.add(cred.user.uid);
      try {
        const candidUser = await syncWithBackend(
          cred.user,
          consents,
          "anon_check_start",
          turnstileToken,
          undefined,
          contactEmail,
        );
        setUser(candidUser);
        return candidUser;
      } catch (err) {
        // Row creation refused (flag OFF, Turnstile, rate cap, …) — don't
        // leave an orphaned anonymous Firebase session behind; it would just
        // generate passive-sync 403 noise on every future page load.
        await firebaseSignOut(getFirebaseAuth()).catch(() => {});
        throw err;
      } finally {
        pendingSignupUidsRef.current.delete(cred.user.uid);
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    await firebaseSignOut(getFirebaseAuth());
    document.cookie = "candid_session=; path=/; max-age=0";
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signUpStart,
        signUpStartGoogle,
        signUpFinish,
        startPhoneVerification,
        recoverOrphanSignup,
        signInWithEmail,
        signInWithGoogle,
        startAnonymousCheck,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

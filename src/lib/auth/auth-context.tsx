"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  updateProfile,
  type User as FirebaseUser,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/client";

export interface CandidUser {
  firebaseUser: FirebaseUser;
  userId: string;
  email: string;
  stripeCustomerId: string;
}

interface ConsentPayload {
  type: string;
  version: string;
  hash: string;
}

// User-initiated auth actions that require Turnstile verification (S68).
// Passive resyncs from onAuthStateChanged omit this and skip the gate.
type UserAuthAction = "signup" | "signin";

interface AuthContextValue {
  user: CandidUser | null;
  loading: boolean;
  signUpWithEmail: (
    email: string,
    password: string,
    consents?: ConsentPayload[],
    displayName?: string,
    turnstileToken?: string,
  ) => Promise<CandidUser>;
  signInWithEmail: (
    email: string,
    password: string,
    turnstileToken?: string,
  ) => Promise<void>;
  signInWithGoogle: (
    consents?: ConsentPayload[],
    turnstileToken?: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function syncWithBackend(
  firebaseUser: FirebaseUser,
  consents?: ConsentPayload[],
  userAction?: UserAuthAction,
  turnstileToken?: string,
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
    body: JSON.stringify({ idToken, consents, userAction, turnstileToken }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    console.error("Auth sync failed:", res.status, errBody);
    if (res.status === 403) {
      throw Object.assign(new Error("Bot defense check failed. Please reload and try again."), {
        code: "auth/turnstile-failed",
      });
    }
    throw new Error("Failed to sync auth");
  }

  const data = await res.json();
  return {
    firebaseUser,
    userId: data.userId,
    email: data.email,
    stripeCustomerId: data.stripeCustomerId,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CandidUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), async (firebaseUser) => {
      if (firebaseUser) {
        try {
          // Only sync if we don't already have a user set (avoids double sync after signup)
          if (!user || user.firebaseUser.uid !== firebaseUser.uid) {
            const candidUser = await syncWithBackend(firebaseUser);
            setUser(candidUser);
          }
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === "auth/network-request-failed") {
            // Transient network issue — keep existing user state if available, retry silently
            console.warn("Network issue during auth sync — will retry on next state change");
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

  const signUpWithEmail = useCallback(
    async (
      email: string,
      password: string,
      consents?: ConsentPayload[],
      displayName?: string,
      turnstileToken?: string,
    ): Promise<CandidUser> => {
      const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
      if (displayName) {
        await updateProfile(cred.user, { displayName });
      }
      // Sync immediately with consent + Turnstile token so the gate runs on
      // the user-initiated signup action (passive resyncs skip).
      const candidUser = await syncWithBackend(cred.user, consents, "signup", turnstileToken);
      setUser(candidUser);
      return candidUser;
    },
    []
  );

  const signInWithEmail = useCallback(
    async (email: string, password: string, turnstileToken?: string) => {
      const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
      // Explicitly sync here (instead of letting onAuthStateChanged do it)
      // so the Turnstile token threads into the same /api/auth/sync request
      // that's gated as a "signin" user action. Setting user immediately
      // makes the listener's guard skip its own sync.
      const candidUser = await syncWithBackend(cred.user, undefined, "signin", turnstileToken);
      setUser(candidUser);
    },
    [],
  );

  const signInWithGoogle = useCallback(
    async (consents?: ConsentPayload[], turnstileToken?: string) => {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(getFirebaseAuth(), provider);
      // Google flow covers both signup (consents passed) and signin (consents
      // undefined). Server treats both the same for Turnstile; we pass
      // "signin" uniformly since the gate doesn't distinguish.
      const candidUser = await syncWithBackend(cred.user, consents, "signin", turnstileToken);
      setUser(candidUser);
    },
    [],
  );

  const signOut = useCallback(async () => {
    await firebaseSignOut(getFirebaseAuth());
    // Clear the session cookie
    document.cookie = "candid_session=; path=/; max-age=0";
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, signUpWithEmail, signInWithEmail, signInWithGoogle, signOut }}
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

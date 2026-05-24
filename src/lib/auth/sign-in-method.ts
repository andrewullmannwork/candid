/**
 * Sign-in method label resolver (S121 B2.1).
 *
 * Maps Firebase Auth `providerData[0].providerId` to a user-facing label for
 * the /profile Account section sign-in pill. Per Phase 1 §1.B.2 Rec 7.
 * Defensive default for missing/unknown providers — should not happen in
 * production given the signup flow but worth guarding.
 */

import type { User as FirebaseUser } from "firebase/auth";

export type SignInBrand = "google" | "apple" | "email" | "phone" | "unknown";

export interface SignInMethod {
  label: string;
  brand: SignInBrand;
}

export function getSignInMethod(firebaseUser: FirebaseUser): SignInMethod {
  const providerId = firebaseUser.providerData?.[0]?.providerId;
  switch (providerId) {
    case "google.com":
      return { label: "Google", brand: "google" };
    case "apple.com":
      return { label: "Apple", brand: "apple" };
    case "password":
      return { label: "Email", brand: "email" };
    case "phone":
      return { label: "Phone", brand: "phone" };
    default:
      return { label: "Account", brand: "unknown" };
  }
}

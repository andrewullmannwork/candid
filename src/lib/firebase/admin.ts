import { initializeApp, getApps, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function getFirebaseAdmin() {
  if (getApps().length) {
    return getAuth();
  }

  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT!, "base64").toString()
  ) as ServiceAccount;

  initializeApp({ credential: cert(serviceAccount) });
  return getAuth();
}

/** Lazily initialized — avoids build-time errors when env vars are absent. */
export function getAdminAuth() {
  return getFirebaseAdmin();
}

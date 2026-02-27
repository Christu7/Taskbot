import * as admin from "firebase-admin";
import { Credentials } from "google-auth-library";

// Shape of what we persist in Firestore under users/{uid}/tokens/google
export interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expiry_date: number | null;
  scope: string | null;
  token_type: string | null;
  updated_at: FirebaseFirestore.Timestamp;
}

// Centralise the document path so it's never spelled two different ways
function tokenDocRef(uid: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection("users")
    .doc(uid)
    .collection("tokens")
    .doc("google");
}

/**
 * Persists (or updates) a user's Google OAuth tokens in Firestore.
 * Uses merge:true so a partial refresh (no new refresh_token) doesn't
 * accidentally wipe the existing refresh_token.
 */
export async function saveTokens(uid: string, tokens: Credentials): Promise<void> {
  await tokenDocRef(uid).set(
    {
      access_token: tokens.access_token ?? null,
      // Only overwrite refresh_token if Google returned a new one.
      // Google only sends a refresh_token on the very first consent grant
      // (or when prompt:'consent' forces a new one).
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expiry_date: tokens.expiry_date ?? null,
      scope: tokens.scope ?? null,
      token_type: tokens.token_type ?? null,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Retrieves stored tokens for a user.
 * Returns null if the user has never completed the OAuth consent flow.
 */
export async function getTokens(uid: string): Promise<StoredTokens | null> {
  const snap = await tokenDocRef(uid).get();
  if (!snap.exists) return null;
  return snap.data() as StoredTokens;
}

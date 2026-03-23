import * as admin from "firebase-admin";
import { Credentials } from "google-auth-library";
import { logger } from "firebase-functions";
import { encrypt, decrypt } from "../services/kms";

// Shape of what we persist in Firestore under users/{uid}/tokens/google.
// After the encryption migration, updated_at is no longer part of the
// encrypted payload (Firestore Timestamps aren't JSON-serialisable).
export interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expiry_date: number | null;
  scope: string | null;
  token_type: string | null;
  updated_at?: FirebaseFirestore.Timestamp; // absent in encrypted format
}

// Shape of the Firestore document in the new encrypted format
interface EncryptedTokenDoc {
  data: string; // base64 KMS ciphertext of the JSON token payload
  encryptedAt: FirebaseFirestore.Timestamp;
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
 * Persists a user's Google OAuth tokens in Firestore as a KMS-encrypted blob.
 *
 * If the incoming tokens do not include a refresh_token (Google only returns
 * one on the very first consent grant or when prompt:'consent' forces it),
 * the existing stored refresh_token is read and preserved.
 */
export async function saveTokens(uid: string, tokens: Credentials): Promise<void> {
  // Preserve the existing refresh_token if Google didn't return a new one
  let refreshToken = tokens.refresh_token ?? null;
  if (!refreshToken) {
    const existing = await getTokens(uid);
    refreshToken = existing?.refresh_token ?? null;
  }

  const payload = {
    access_token: tokens.access_token ?? null,
    refresh_token: refreshToken,
    expiry_date: tokens.expiry_date ?? null,
    scope: tokens.scope ?? null,
    token_type: tokens.token_type ?? null,
  };

  const encrypted = await encrypt(JSON.stringify(payload));
  await tokenDocRef(uid).set({
    data: encrypted,
    encryptedAt: admin.firestore.FieldValue.serverTimestamp(),
  } as EncryptedTokenDoc);
}

/**
 * Retrieves stored tokens for a user, decrypting the KMS ciphertext.
 *
 * Handles lazy migration: if the stored document is in the old plaintext
 * format (top-level access_token / refresh_token fields), it is re-encrypted
 * in place before returning so subsequent reads use the encrypted format.
 *
 * Returns null if the user has never completed the OAuth consent flow.
 */
export async function getTokens(uid: string): Promise<StoredTokens | null> {
  const snap = await tokenDocRef(uid).get();
  if (!snap.exists) return null;

  const raw = snap.data()!;

  // New encrypted format: document has a single "data" ciphertext string
  if (typeof raw.data === "string") {
    const decrypted = await decrypt(raw.data as string);
    return JSON.parse(decrypted) as StoredTokens;
  }

  // Old plaintext format — migrate in place before returning
  const oldTokens = raw as StoredTokens;
  logger.info("tokenStore: migrating plaintext Google tokens to KMS-encrypted format", { uid });

  const payload = {
    access_token: oldTokens.access_token ?? null,
    refresh_token: oldTokens.refresh_token ?? null,
    expiry_date: oldTokens.expiry_date ?? null,
    scope: oldTokens.scope ?? null,
    token_type: oldTokens.token_type ?? null,
  };

  try {
    const encrypted = await encrypt(JSON.stringify(payload));
    await tokenDocRef(uid).set({
      data: encrypted,
      encryptedAt: admin.firestore.FieldValue.serverTimestamp(),
    } as EncryptedTokenDoc);
    logger.info("tokenStore: Google token migration complete", { uid });
  } catch (err) {
    logger.warn("tokenStore: lazy migration failed — tokens remain plaintext", {
      uid,
      error: (err as Error).message,
    });
  }

  return oldTokens;
}

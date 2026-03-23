// ─── Asana OAuth 2.0 Setup ────────────────────────────────────────────────────
//
// 1. Go to https://app.asana.com/0/developer-console and create a new app.
// 2. Under "OAuth", add this Redirect URL:
//      https://taskbot-fb10d.web.app/api/auth/asana/callback
//    (and http://localhost:5001/taskbot-fb10d/us-central1/api/auth/asana/callback for local dev)
// 3. Copy the Client ID and Client Secret from the app page.
// 4. Add to functions/.env:
//      ASANA_CLIENT_ID=<your-client-id>
//      ASANA_CLIENT_SECRET=<your-client-secret>
//      ASANA_REDIRECT_URI=https://taskbot-fb10d.web.app/api/auth/asana/callback
//    For production, also set via Firebase Secret Manager:
//      npx firebase functions:secrets:set ASANA_CLIENT_ID
//      npx firebase functions:secrets:set ASANA_CLIENT_SECRET
//      npx firebase functions:secrets:set ASANA_REDIRECT_URI
// ─────────────────────────────────────────────────────────────────────────────

import * as admin from "firebase-admin";
import { logger } from "firebase-functions";
import { getSecret } from "../secrets";
import { encrypt, decrypt } from "../kms";
import { fetchWithTimeout } from "../../utils/fetchWithTimeout";

const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface AsanaStoredTokens {
  access_token: string;
  refresh_token: string | null;
  /** Unix timestamp (ms) when the access token expires. */
  expires_at: number | null;
  token_type: string;
  updated_at?: FirebaseFirestore.Timestamp; // absent in encrypted format
}

// Shape of the Firestore document in the new encrypted format
interface EncryptedTokenDoc {
  data: string; // base64 KMS ciphertext of the JSON token payload
  encryptedAt: FirebaseFirestore.Timestamp;
}

function tokenDocRef(uid: string): FirebaseFirestore.DocumentReference {
  return admin
    .firestore()
    .collection("users")
    .doc(uid)
    .collection("tokens")
    .doc("asana");
}

interface AsanaTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * Persists a user's Asana OAuth tokens in Firestore as a KMS-encrypted blob.
 *
 * If the incoming tokens do not include a refresh_token, the existing stored
 * refresh_token is read and preserved.
 */
export async function saveAsanaTokens(
  uid: string,
  tokens: AsanaTokenResponse
): Promise<void> {
  const expires_at = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : null;

  // Preserve the existing refresh_token if not returned by Asana
  let refreshToken = tokens.refresh_token ?? null;
  if (!refreshToken) {
    const existing = await getAsanaTokens(uid);
    refreshToken = existing?.refresh_token ?? null;
  }

  const payload = {
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    expires_at,
    token_type: tokens.token_type ?? "Bearer",
  };

  const encrypted = await encrypt(JSON.stringify(payload));
  await tokenDocRef(uid).set({
    data: encrypted,
    encryptedAt: admin.firestore.FieldValue.serverTimestamp(),
  } as EncryptedTokenDoc);
}

/**
 * Retrieves stored Asana tokens for a user, decrypting the KMS ciphertext.
 *
 * Handles lazy migration: if the stored document is in the old plaintext
 * format, it is re-encrypted in place before returning.
 *
 * Returns null if the user has never connected Asana.
 */
export async function getAsanaTokens(uid: string): Promise<AsanaStoredTokens | null> {
  const snap = await tokenDocRef(uid).get();
  if (!snap.exists) return null;

  const raw = snap.data()!;

  // New encrypted format: document has a single "data" ciphertext string
  if (typeof raw.data === "string") {
    const decrypted = await decrypt(raw.data as string);
    return JSON.parse(decrypted) as AsanaStoredTokens;
  }

  // Old plaintext format — migrate in place before returning
  const oldTokens = raw as AsanaStoredTokens;
  logger.info("asanaAuth: migrating plaintext Asana tokens to KMS-encrypted format", { uid });

  const payload = {
    access_token: oldTokens.access_token ?? null,
    refresh_token: oldTokens.refresh_token ?? null,
    expires_at: oldTokens.expires_at ?? null,
    token_type: oldTokens.token_type ?? "Bearer",
  };

  try {
    const encrypted = await encrypt(JSON.stringify(payload));
    await tokenDocRef(uid).set({
      data: encrypted,
      encryptedAt: admin.firestore.FieldValue.serverTimestamp(),
    } as EncryptedTokenDoc);
    logger.info("asanaAuth: Asana token migration complete", { uid });
  } catch (err) {
    logger.warn("asanaAuth: lazy migration failed — tokens remain plaintext", {
      uid,
      error: (err as Error).message,
    });
  }

  return oldTokens;
}

export async function deleteAsanaTokens(uid: string): Promise<void> {
  await tokenDocRef(uid).delete();
}

export async function isAsanaConnected(uid: string): Promise<boolean> {
  const tokens = await getAsanaTokens(uid);
  return Boolean(tokens?.access_token);
}

/**
 * Returns a valid (non-expired) Asana access token for the given user.
 * Automatically refreshes if the stored token is about to expire.
 */
export async function getValidAsanaAccessToken(uid: string): Promise<string> {
  const stored = await getAsanaTokens(uid);

  if (!stored?.access_token) {
    throw new Error(
      `No Asana tokens found for user ${uid}. User must connect their Asana account in Settings.`
    );
  }

  const isExpired =
    stored.expires_at == null ||
    Date.now() >= stored.expires_at - EXPIRY_BUFFER_MS;

  if (!isExpired) return stored.access_token;

  if (!stored.refresh_token) {
    throw new Error(
      `Asana access token expired and no refresh token stored for user ${uid}. User must reconnect Asana.`
    );
  }

  logger.info(`asanaAuth: refreshing token for user ${uid}`);

  const clientId = await getSecret("asana.clientId");
  const clientSecret = await getSecret("asana.clientSecret");

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: stored.refresh_token,
  });

  const res = await fetchWithTimeout(ASANA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana token refresh failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json() as AsanaTokenResponse;
  await saveAsanaTokens(uid, data);
  logger.info(`asanaAuth: token refreshed for user ${uid}`);
  return data.access_token;
}

/** Builds the Asana authorization URL to redirect the user to. */
export async function buildAsanaAuthUrl(state: string): Promise<string> {
  const clientId = await getSecret("asana.clientId");
  const redirectUri = process.env.ASANA_REDIRECT_URI;

  if (!redirectUri) {
    throw new Error("Missing ASANA_REDIRECT_URI environment variable.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "tasks:read tasks:write tasks:delete projects:read workspaces:read users:read",
    state,
  });

  return `https://app.asana.com/-/oauth_authorize?${params.toString()}`;
}

/** Exchanges an authorization code for tokens. */
export async function exchangeAsanaCode(code: string): Promise<AsanaTokenResponse> {
  const clientId = await getSecret("asana.clientId");
  const clientSecret = await getSecret("asana.clientSecret");
  const redirectUri = process.env.ASANA_REDIRECT_URI;

  if (!redirectUri) {
    throw new Error("Missing ASANA_REDIRECT_URI environment variable.");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetchWithTimeout(ASANA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana code exchange failed (HTTP ${res.status}): ${body}`);
  }

  return res.json() as Promise<AsanaTokenResponse>;
}

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

const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface AsanaStoredTokens {
  access_token: string;
  refresh_token: string | null;
  /** Unix timestamp (ms) when the access token expires. */
  expires_at: number | null;
  token_type: string;
  updated_at: FirebaseFirestore.Timestamp;
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

export async function saveAsanaTokens(
  uid: string,
  tokens: AsanaTokenResponse
): Promise<void> {
  const expires_at = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : null;

  await tokenDocRef(uid).set(
    {
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expires_at,
      token_type: tokens.token_type ?? "Bearer",
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function getAsanaTokens(uid: string): Promise<AsanaStoredTokens | null> {
  const snap = await tokenDocRef(uid).get();
  if (!snap.exists) return null;
  return snap.data() as AsanaStoredTokens;
}

export async function deleteAsanaTokens(uid: string): Promise<void> {
  await tokenDocRef(uid).delete();
}

export async function isAsanaConnected(uid: string): Promise<boolean> {
  const snap = await tokenDocRef(uid).get();
  return snap.exists && Boolean((snap.data() as AsanaStoredTokens | undefined)?.access_token);
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

  const res = await fetch(ASANA_TOKEN_URL, {
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

  const res = await fetch(ASANA_TOKEN_URL, {
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

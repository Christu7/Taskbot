import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { createOAuthClient } from "./oauthClient";
import { getTokens, saveTokens } from "./tokenStore";

// Refresh 5 minutes before actual expiry to avoid edge cases where
// the token expires between the check and the API call.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns a valid (non-expired) access token for the given user.
 *
 * Usage — call this before every Google API request:
 *   const accessToken = await getValidAccessToken(uid);
 *   const auth = createOAuthClient();
 *   auth.setCredentials({ access_token: accessToken });
 *   const drive = google.drive({ version: "v3", auth });
 */
export async function getValidAccessToken(uid: string): Promise<string> {
  const stored = await getTokens(uid);

  if (!stored || !stored.access_token) {
    throw new HttpsError(
      "not-found",
      `No OAuth tokens found for user ${uid}. ` +
      "The user must complete the Google consent flow first."
    );
  }

  const isExpired =
    stored.expiry_date == null ||
    Date.now() >= stored.expiry_date - EXPIRY_BUFFER_MS;

  // Token is still valid — return it immediately
  if (!isExpired) {
    return stored.access_token;
  }

  // Token expired — attempt refresh
  if (!stored.refresh_token) {
    throw new HttpsError(
      "failed-precondition",
      "Access token is expired and no refresh_token is stored. " +
      "The user must re-authorize the app."
    );
  }

  logger.info(`Refreshing OAuth access token for user ${uid}`);

  const client = createOAuthClient();
  client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date ?? undefined,
  });

  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token) {
    throw new Error("Token refresh succeeded but response is missing access_token.");
  }

  // Persist the new token data (expiry_date, possibly new access_token)
  await saveTokens(uid, credentials);

  return credentials.access_token;
}

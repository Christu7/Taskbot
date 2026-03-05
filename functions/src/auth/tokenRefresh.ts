import { logger } from "firebase-functions";
import { createOAuthClient } from "./oauthClient";
import { getTokens, saveTokens } from "./tokenStore";
import { TokenExpiredError } from "../utils/errors";

// Refresh 5 minutes before actual expiry to avoid edge cases where
// the token expires between the check and the API call.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns a valid (non-expired) access token for the given user.
 *
 * Throws TokenExpiredError when:
 *   - No tokens are stored (user has never completed OAuth)
 *   - The access token is expired and no refresh token is stored
 *   - The refresh token has been revoked (invalid_grant from Google)
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
    throw new TokenExpiredError(
      uid,
      "No OAuth tokens found. The user must complete the Google consent flow."
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
    throw new TokenExpiredError(
      uid,
      "Access token is expired and no refresh_token is stored. User must re-authorize."
    );
  }

  logger.info(`tokenRefresh: refreshing OAuth access token for user ${uid}`);

  const client = createOAuthClient();
  client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date ?? undefined,
  });

  try {
    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error("Token refresh succeeded but response is missing access_token.");
    }

    // Persist the new token data (expiry_date, possibly new access_token)
    await saveTokens(uid, credentials);
    logger.info(`tokenRefresh: token refreshed and stored for user ${uid}`);

    return credentials.access_token;
  } catch (err) {
    const message = (err as Error).message ?? "";
    // Google returns "invalid_grant" when the refresh token has been revoked
    const isRevoked =
      message.toLowerCase().includes("invalid_grant") ||
      message.toLowerCase().includes("token has been expired") ||
      message.toLowerCase().includes("revoked") ||
      message.toLowerCase().includes("invalid token");

    if (isRevoked) {
      throw new TokenExpiredError(uid, `Refresh token revoked: ${message}`);
    }

    // Re-throw other errors (network, server errors) without wrapping
    throw err;
  }
}

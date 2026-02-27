// ─── Google Cloud Console Setup ───────────────────────────────────────────────
//
// Before this module works you must configure an OAuth 2.0 client in GCP.
// Follow these steps EXACTLY:
//
// STEP 1 — OAuth Consent Screen
//   1. Go to: console.cloud.google.com → select project "taskbot-fb10d"
//   2. Navigate to: APIs & Services → OAuth consent screen
//   3. User Type: choose "Internal"  ← critical for Workspace-only access
//   4. Fill in App name ("TaskBot"), User support email, Developer contact email
//   5. Click "Save and Continue"
//   6. On the Scopes page, click "Add or Remove Scopes" and add:
//        https://www.googleapis.com/auth/drive.readonly
//        https://www.googleapis.com/auth/tasks
//        https://www.googleapis.com/auth/calendar.events.readonly
//   7. Click "Save and Continue" through the rest, then "Back to Dashboard"
//
// STEP 2 — Create OAuth 2.0 Credentials
//   1. Navigate to: APIs & Services → Credentials
//   2. Click "+ Create Credentials" → "OAuth client ID"
//   3. Application type: "Web application"
//   4. Name: "TaskBot Web Client"
//   5. Under "Authorized redirect URIs", add:
//        https://us-central1-taskbot-fb10d.cloudfunctions.net/oauthCallback
//      (also add http://localhost:5001/taskbot-fb10d/us-central1/oauthCallback for local dev)
//   6. Click "Create"
//   7. Copy the Client ID and Client Secret — you'll need them below
//
// STEP 3 — Enable Required APIs
//   1. Navigate to: APIs & Services → Library
//   2. Search for and enable each of these:
//        Google Drive API
//        Google Tasks API
//        Google Calendar API
//
// STEP 4 — Store credentials (never hardcode them)
//   For local development: create functions/.env (already gitignored) with:
//     GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
//     GOOGLE_CLIENT_SECRET=<your-client-secret>
//     OAUTH_REDIRECT_URI=http://localhost:5001/taskbot-fb10d/us-central1/oauthCallback
//     OAUTH_SUCCESS_REDIRECT=http://localhost:5000
//
//   For production deployment, use Firebase Secret Manager:
//     npx firebase functions:secrets:set GOOGLE_CLIENT_ID
//     npx firebase functions:secrets:set GOOGLE_CLIENT_SECRET
//     npx firebase functions:secrets:set OAUTH_REDIRECT_URI
//     npx firebase functions:secrets:set OAUTH_SUCCESS_REDIRECT
//   Then re-deploy functions.
// ──────────────────────────────────────────────────────────────────────────────

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

/**
 * Creates a configured Google OAuth2 client.
 * Reads credentials from environment variables — never hardcoded.
 */
export function createOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing OAuth environment variables. " +
      "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and OAUTH_REDIRECT_URI " +
      "in functions/.env (local) or via Firebase Secret Manager (production)."
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

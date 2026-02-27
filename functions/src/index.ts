import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { OAUTH_SCOPES, STATE_TTL_MS, createOAuthClient, saveTokens } from "./auth";

admin.initializeApp();

// ─── Health Check ─────────────────────────────────────────────────────────────
// GET https://us-central1-taskbot-fb10d.cloudfunctions.net/healthCheck
export const healthCheck = onRequest({ region: "us-central1" }, (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "TaskBot functions are running",
    timestamp: new Date().toISOString(),
  });
});

// ─── Task Created Trigger ─────────────────────────────────────────────────────
// Fires whenever a new document appears in the "tasks" collection
export const onTaskCreated = onDocumentCreated(
  { document: "tasks/{taskId}", region: "us-central1" },
  (event) => {
    const snap = event.data;
    if (!snap) return null;
    const task = snap.data();
    const taskId = event.params.taskId;
    logger.info(`New task created: ${taskId}`, { task });
    // TODO: Add business logic (notifications, assignment, etc.)
    return null;
  }
);

// ─── OAuth: Initiate Consent Flow ─────────────────────────────────────────────
// GET /oauthInit?token=<firebase-id-token>
//
// Flow:
//   1. Client signs in with Firebase Auth (Google provider) → gets an ID token
//   2. Client calls this endpoint with that ID token
//   3. We verify the token, generate a CSRF state, then redirect the user to
//      Google's consent screen to grant the additional API scopes
export const oauthInit = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    try {
      // 1. Verify the caller is a signed-in Firebase user
      const idToken = req.query.token as string | undefined;
      if (!idToken) {
        res.status(400).json({ error: "Missing required query parameter: token" });
        return;
      }

      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;

      // 2. Generate a one-time CSRF state token and store it in Firestore.
      //    The callback will verify this to ensure the request wasn't forged.
      const state = randomBytes(32).toString("hex");
      await admin.firestore().collection("oauthStates").doc(state).set({
        uid,
        expiresAt: Date.now() + STATE_TTL_MS,
      });

      // 3. Build the Google consent URL and redirect
      const client = createOAuthClient();
      const authUrl = client.generateAuthUrl({
        access_type: "offline",  // request a refresh_token
        prompt: "consent",       // always show consent so we always get refresh_token
        scope: OAUTH_SCOPES,
        state,
      });

      res.redirect(authUrl);
    } catch (err) {
      logger.error("oauthInit failed", err);
      res.status(500).json({ error: "Failed to initiate OAuth flow. Check function logs." });
    }
  }
);

// ─── OAuth: Callback Handler ──────────────────────────────────────────────────
// GET /oauthCallback?code=<auth-code>&state=<state>
//
// Google redirects here after the user accepts or denies the consent screen.
// This URL must be registered in Google Cloud Console → Credentials → Authorized redirect URIs.
//
// Production URI: https://us-central1-taskbot-fb10d.cloudfunctions.net/oauthCallback
// Local dev URI:  http://localhost:5001/taskbot-fb10d/us-central1/oauthCallback
export const oauthCallback = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    const db = admin.firestore();

    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const oauthError = req.query.error as string | undefined;

      // User clicked "Deny" on the consent screen
      if (oauthError) {
        logger.warn("User denied OAuth consent", { error: oauthError });
        res.status(403).send(
          "Permission denied. Please try again and grant all requested permissions."
        );
        return;
      }

      if (!code || !state) {
        res.status(400).json({ error: "Missing code or state parameter" });
        return;
      }

      // 1. Validate the CSRF state token
      const stateRef = db.collection("oauthStates").doc(state);
      const stateSnap = await stateRef.get();

      if (!stateSnap.exists) {
        res.status(400).json({ error: "Invalid state token. Please restart sign-in." });
        return;
      }

      const { uid, expiresAt } = stateSnap.data() as { uid: string; expiresAt: number };

      if (Date.now() > expiresAt) {
        await stateRef.delete();
        res.status(400).json({
          error: "State token expired (>10 min). Please restart the sign-in flow.",
        });
        return;
      }

      // 2. Consume the state token — it's single-use
      await stateRef.delete();

      // 3. Exchange the authorization code for access + refresh tokens
      const client = createOAuthClient();
      const { tokens } = await client.getToken(code);

      if (!tokens.access_token) {
        throw new Error("Token exchange completed but response is missing access_token");
      }

      // 4. Persist tokens to Firestore under users/{uid}/tokens/google
      await saveTokens(uid, tokens);
      logger.info(`OAuth tokens stored successfully for user ${uid}`);

      // 5. Redirect the user back to the web app
      const successUrl = process.env.OAUTH_SUCCESS_REDIRECT ?? "/";
      res.redirect(successUrl);
    } catch (err) {
      logger.error("oauthCallback failed", err);
      res.status(500).send("An error occurred during sign-in. Please try again.");
    }
  }
);

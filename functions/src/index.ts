import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { auth as functionsAuth } from "firebase-functions/v1";
import { logger } from "firebase-functions";
import { OAUTH_SCOPES, STATE_TTL_MS, createOAuthClient, saveTokens } from "./auth";
import { createUser, getUser, updateUser, isFirstUser } from "./services/firestore";
import { UserPreferences } from "./models/user";
export { driveWatcher } from "./functions/driveWatcher";
export { processTranscript } from "./functions/processTranscript";
export { notifyUsers } from "./functions/notifyUsers";
export { taskCreator } from "./functions/taskCreator";
export { expireProposals } from "./functions/expireProposals";
export { api } from "./functions/api";
export { healthCheck } from "./functions/healthCheck";
export { slackInteraction } from "./functions/slackInteraction";
export { syncEngine } from "./functions/syncEngine";

admin.initializeApp();

// ─── Environment Variable Validation ──────────────────────────────────────────
// Log a clear error at startup if required variables are missing so issues
// are caught immediately after deployment rather than at runtime.
{
  // Only Google OAuth vars must be in the environment — they are needed before
  // any user can sign in, so they cannot come from Firestore/KMS at runtime.
  // All other credentials (AI keys, Slack, Asana) are managed via Admin > Settings.
  const required: Record<string, string> = {
    GOOGLE_CLIENT_ID: "Google OAuth Client ID",
    GOOGLE_CLIENT_SECRET: "Google OAuth Client Secret",
    OAUTH_REDIRECT_URI: "OAuth callback URI (must match GCP Console)",
    OAUTH_SUCCESS_REDIRECT: "Post-OAuth redirect URL",
    ASANA_REDIRECT_URI: "Asana OAuth callback URI (not a secret)",
  };

  const missing = Object.entries(required)
    .filter(([key]) => !process.env[key])
    .map(([key, desc]) => `${key} — ${desc}`);

  if (missing.length > 0) {
    logger.error(
      "TaskBot: missing required environment variables — some functions will fail:\n" +
      missing.map((v) => `  • ${v}`).join("\n") +
      "\nSee functions/.env for configuration."
    );
  }

  // Warn if KMS is not configured — secrets won't decrypt without it
  if (!process.env.KMS_KEY_NAME) {
    logger.warn(
      "TaskBot: KMS_KEY_NAME not set — credentials stored in Admin > Settings will not decrypt. " +
      "Set up KMS and configure KMS_KEY_NAME, or provide credentials as env vars for fallback."
    );
  }
}

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

// ─── Auth Trigger: New User Created ───────────────────────────────────────────
// Fires automatically when a new user authenticates via Firebase Auth for the
// first time. Creates their Firestore user document with default settings.
export const onUserCreated = functionsAuth.user().onCreate(async (user) => {
  const { uid, email, displayName } = user;

  logger.info(`New user signed up: ${uid} (${email ?? "no email"})`);

  // The very first user to sign up is automatically promoted to admin.
  const first = await isFirstUser();
  const role = first ? "admin" : "user";

  await createUser(uid, {
    email: email ?? "",
    displayName: displayName ?? email ?? uid,
  }, role);

  logger.info(`Firestore user document created for ${uid} (role: ${role})`);

  // Check if this email has a pending invite — mark it accepted
  if (email) {
    try {
      const inviteRef = admin.firestore().collection("invites").doc(email);
      const invite = await inviteRef.get();
      if (invite.exists && !invite.data()?.accepted) {
        await inviteRef.update({ accepted: true, acceptedAt: admin.firestore.FieldValue.serverTimestamp() });
        logger.info(`Invite accepted for ${email}`);
      }
    } catch (err) {
      logger.warn("onUserCreated: invite check failed", { error: (err as Error).message });
    }
  }
});

// ─── HTTP: Update User Settings ───────────────────────────────────────────────
// POST /updateUserSettings
// Body (JSON): { isActive?: boolean, preferences?: Partial<UserPreferences> }
//
// Protected by Firebase Auth — caller must supply a valid ID token in the
// Authorization header: "Bearer <id-token>"
export const updateUserSettings = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    // Only allow POST
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed. Use POST." });
      return;
    }

    // 1. Extract and verify the Firebase ID token
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or malformed Authorization header. Expected: Bearer <id-token>" });
      return;
    }

    let uid: string;
    try {
      const idToken = authHeader.slice(7); // strip "Bearer "
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (err) {
      logger.warn("updateUserSettings: invalid ID token", err);
      res.status(401).json({ error: "Invalid or expired ID token." });
      return;
    }

    // 2. Ensure the user document exists
    const existing = await getUser(uid);
    if (!existing) {
      res.status(404).json({ error: `No user document found for uid: ${uid}` });
      return;
    }

    // 3. Parse and validate the request body
    const { isActive, preferences } = req.body as {
      isActive?: unknown;
      preferences?: Partial<UserPreferences>;
    };

    const update: Record<string, unknown> = {};

    if (isActive !== undefined) {
      if (typeof isActive !== "boolean") {
        res.status(400).json({ error: "isActive must be a boolean." });
        return;
      }
      update.isActive = isActive;
    }

    if (preferences !== undefined) {
      const allowed: (keyof UserPreferences)[] = ["notifyVia", "autoApprove", "proposalExpiryHours"];
      for (const key of Object.keys(preferences) as (keyof UserPreferences)[]) {
        if (!allowed.includes(key)) {
          res.status(400).json({ error: `Unknown preference key: "${key}"` });
          return;
        }
      }

      // Validate individual preference values
      if (preferences.autoApprove !== undefined && typeof preferences.autoApprove !== "boolean") {
        res.status(400).json({ error: "preferences.autoApprove must be a boolean." });
        return;
      }
      if (preferences.proposalExpiryHours !== undefined) {
        const hours = preferences.proposalExpiryHours;
        if (typeof hours !== "number" || hours <= 0 || !Number.isInteger(hours)) {
          res.status(400).json({ error: "preferences.proposalExpiryHours must be a positive integer." });
          return;
        }
      }

      // Merge into existing preferences using dot-notation keys so we only
      // overwrite the fields the caller specified.
      for (const [key, value] of Object.entries(preferences)) {
        update[`preferences.${key}`] = value;
      }
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Request body must include at least one of: isActive, preferences." });
      return;
    }

    // 4. Persist the changes
    await updateUser(uid, update as Parameters<typeof updateUser>[1]);

    logger.info(`User settings updated for ${uid}`, { update });
    res.status(200).json({ success: true, updated: Object.keys(update) });
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

      // 4b. Mark the user's tokens as valid so the dashboard banner clears
      await updateUser(uid, { hasValidTokens: true });

      // 5. Redirect the user back to the web app
      const successUrl = process.env.OAUTH_SUCCESS_REDIRECT ?? "/";
      res.redirect(successUrl);
    } catch (err) {
      logger.error("oauthCallback failed", err);
      res.status(500).send("An error occurred during sign-in. Please try again.");
    }
  }
);

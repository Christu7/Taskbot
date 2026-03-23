import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import express, { Request, Response, NextFunction } from "express";
import { validateAndConsumeToken, generateApprovalToken } from "../services/approvalTokens";
import { getUser, updateUser } from "../services/firestore";
import { ProposalDocument } from "../models/proposal";
import { UserPreferences, UserDocument, normalizeNotifyVia, normalizeTaskDestination } from "../models/user";
import { routeNotification } from "../services/notifications/notificationRouter";
import { requireAuth as authenticate, requireAdmin, requireProjectManager, AuthRequest } from "../middleware/auth";
import { adminRateLimit } from "../middleware/adminRateLimit";
import { adminRouter, adminPmRouter } from "./adminApi";

const APP_URL = () => process.env.APP_URL ?? "https://taskbot-fb10d.web.app";

/** Confidence → sort order (high first). */
const CONFIDENCE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
import {
  buildAsanaAuthUrl,
  exchangeAsanaCode,
  saveAsanaTokens,
  deleteAsanaTokens,
  isAsanaConnected,
  getValidAsanaAccessToken,
} from "../services/asana/asanaAuth";
import { getWorkspaces, getProjects } from "../services/asana/asanaApi";
import { lookupUserByEmail } from "../services/slack/slackClient";
import { getValidAccessToken } from "../auth";
import { completeExternalRefs, updateExternalRefs } from "../services/taskDestinations/taskRouter";
import { syncUserNow } from "./syncEngine";
import { getSecret, isIntegrationConfigured } from "../services/secrets";

const db = () => admin.firestore();

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Normalize path: strip /api prefix when request arrives via Firebase Hosting
// rewrite (which preserves the full path, unlike direct function invocation).
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/") || req.path === "/api") {
    req.url = req.url.replace(/^\/api/, "") || "/";
  }
  next();
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
// `authenticate`, `requireAdmin`, and `AuthRequest` are imported from
// ../middleware/auth and re-used throughout this module.

// ─── POST /auth/validate-token ────────────────────────────────────────────────
// Validates an email approval token (single-use, time-limited) and returns:
//   - A Firebase custom auth token so the client can sign in without a Google popup
//   - All proposals for the meeting assigned to this user
// Designed for email click-through flows where the user is not yet signed in.

app.post("/auth/validate-token", async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ error: "Missing token in request body" });
    return;
  }

  try {
    // Atomically validate and consume the token in a single Firestore transaction.
    // Any concurrent request with the same token will fail after this point.
    const { uid, meetingId } = await validateAndConsumeToken(token);

    const [userSnap, transcriptSnap] = await Promise.all([
      db().collection("users").doc(uid).get(),
      db().collection("processedTranscripts").doc(meetingId).get(),
    ]);

    const userEmail = userSnap.data()?.email as string | undefined;
    const attendeeEmails: string[] = transcriptSnap.data()?.attendeeEmails ?? [];
    const isAttendee = !!userEmail && attendeeEmails.includes(userEmail);

    const proposalsSnap = isAttendee
      ? await db().collection("proposals").doc(meetingId).collection("tasks").get()
      : await db().collection("proposals").doc(meetingId).collection("tasks")
          .where("assigneeUid", "==", uid).get();

    const proposals = proposalsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as ProposalDocument), isOwner: d.data().assigneeUid === uid }))
      .sort((a, b) =>
        (CONFIDENCE_ORDER[a.confidence ?? "medium"] ?? 1) -
        (CONFIDENCE_ORDER[b.confidence ?? "medium"] ?? 1)
      );
    const meetingTitle = transcriptSnap.data()?.meetingTitle ?? meetingId;
    const driveFileLink = transcriptSnap.data()?.driveFileLink ?? null;

    // Create a short-lived custom Firebase token for the client to sign in with.
    // The approval token is already consumed above — concurrent requests will fail
    // the transaction even if they arrive before this custom token is issued.
    const customToken = await admin.auth().createCustomToken(uid);

    res.json({ customToken, meetingId, meetingTitle, driveFileLink, proposals });
  } catch (err) {
    logger.warn("validate-token failed", { error: (err as Error).message });
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── GET /proposals/pending ───────────────────────────────────────────────────
// Returns all pending proposals for the authenticated user, grouped by meeting.
// Used by the dashboard to show the list of meetings awaiting review.

app.get("/proposals/pending", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const userDoc = await getUser(uid);
  const isPrivileged = userDoc?.role === "admin" || userDoc?.role === "project_manager";

  // PM/admin can see all pending proposals; users see only their own
  let snap;
  if (isPrivileged) {
    snap = await db().collectionGroup("tasks")
      .where("status", "==", "pending")
      .orderBy("createdAt", "desc")
      .get();
  } else {
    snap = await db().collectionGroup("tasks")
      .where("assigneeUid", "==", uid)
      .where("status", "==", "pending")
      .orderBy("createdAt", "desc")
      .get();
  }

  // Group by meetingId
  const grouped: Record<string, {
    meetingId: string;
    meetingTitle: string;
    driveFileLink: string;
    proposals: object[];
  }> = {};

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as ProposalDocument;
    if (!grouped[data.meetingId]) {
      grouped[data.meetingId] = {
        meetingId: data.meetingId,
        meetingTitle: "",
        driveFileLink: "",
        proposals: [],
      };
    }
    grouped[data.meetingId].proposals.push({ id: docSnap.id, ...data, isOwner: data.assigneeUid === uid });
  }

  // Enrich with meeting titles and Drive links from processedTranscripts
  await Promise.all(
    Object.keys(grouped).map(async (meetingId) => {
      const transcriptSnap = await db()
        .collection("processedTranscripts").doc(meetingId).get();
      grouped[meetingId].meetingTitle =
        transcriptSnap.data()?.meetingTitle ?? meetingId;
      grouped[meetingId].driveFileLink =
        transcriptSnap.data()?.driveFileLink ?? "";
    })
  );

  res.json({ meetings: Object.values(grouped) });
});

// ─── GET /proposals ───────────────────────────────────────────────────────────
// Returns all proposals for a specific meeting for the authenticated user.
// Used by the review page when navigating from the dashboard (already signed in).

app.get("/proposals", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const meetingId = req.query.meetingId as string;

  if (!meetingId) {
    res.status(400).json({ error: "Missing meetingId query parameter" });
    return;
  }

  const [userSnap, transcriptSnap] = await Promise.all([
    db().collection("users").doc(uid).get(),
    db().collection("processedTranscripts").doc(meetingId).get(),
  ]);

  const userEmail = userSnap.data()?.email as string | undefined;
  const attendeeEmails: string[] = transcriptSnap.data()?.attendeeEmails ?? [];
  const isAttendee = !!userEmail && attendeeEmails.includes(userEmail);

  const proposalsSnap = isAttendee
    ? await db().collection("proposals").doc(meetingId).collection("tasks").get()
    : await db().collection("proposals").doc(meetingId).collection("tasks")
        .where("assigneeUid", "==", uid).get();

  const proposals = proposalsSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as ProposalDocument), isOwner: d.data().assigneeUid === uid }))
    .sort((a, b) =>
      (CONFIDENCE_ORDER[a.confidence ?? "medium"] ?? 1) -
      (CONFIDENCE_ORDER[b.confidence ?? "medium"] ?? 1)
    );
  const meetingTitle = transcriptSnap.data()?.meetingTitle ?? meetingId;
  const driveFileLink = transcriptSnap.data()?.driveFileLink ?? "";

  res.json({ meetingId, meetingTitle, driveFileLink, proposals });
});

// ─── GET /proposals/:meetingId/:taskId ───────────────────────────────────────
// Returns a single proposal by ID.
// Used by the review page to poll for status changes after the user approves
// a task (the taskCreator function runs asynchronously in the background).

app.get(
  "/proposals/:meetingId/:taskId",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;

    const docRef = db()
      .collection("proposals")
      .doc(meetingId)
      .collection("tasks")
      .doc(taskId);

    const snap = await docRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const callerDoc = await getUser(uid);
    const isPrivileged = callerDoc?.role === "admin" || callerDoc?.role === "project_manager";
    if (!isPrivileged && snap.data()?.assigneeUid !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.json({ id: snap.id, ...snap.data() });
  }
);

// ─── PATCH /proposals/:meetingId/bulk ────────────────────────────────────────
// Bulk-approves or bulk-rejects all pending proposals for a meeting.
// Defined before /:taskId to prevent "bulk" being matched as a taskId.

app.patch(
  "/proposals/:meetingId/bulk",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId } = req.params;
    const { action, taskOverrides } = req.body as {
      action?: "approve" | "reject";
      taskOverrides?: Record<string, { asanaProjectId?: string }>;
    };

    if (action !== "approve" && action !== "reject") {
      res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      return;
    }

    const status = action === "approve" ? "approved" : "rejected";

    const snap = await db()
      .collection("proposals").doc(meetingId).collection("tasks")
      .where("assigneeUid", "==", uid)
      .where("status", "==", "pending")
      .get();

    if (snap.empty) {
      res.json({ updated: 0 });
      return;
    }

    const batch = db().batch();
    snap.docs.forEach((d) => {
      const update: Record<string, unknown> = { status, reviewedAt: FieldValue.serverTimestamp() };
      const override = taskOverrides?.[d.id];
      if (override?.asanaProjectId !== undefined) update.asanaProjectId = override.asanaProjectId;
      batch.update(d.ref, update);
    });
    await batch.commit();

    logger.info(
      `bulk ${action}: ${snap.size} proposal(s) for meeting ${meetingId} by user ${uid}`
    );
    res.json({ updated: snap.size });
  }
);

// ─── PATCH /proposals/:meetingId/:taskId ─────────────────────────────────────
// Approves, rejects, or edits (then approves) a single proposal.
// When status is "edited", the server saves editedTitle/editedDescription and
// marks the proposal as "approved" (editing implies acceptance).

app.patch(
  "/proposals/:meetingId/:taskId",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;
    const { status, title, description, dueDate, asanaProjectId } = req.body as {
      status?: string;
      title?: string;
      description?: string;
      dueDate?: string | null;
      asanaProjectId?: string;
    };

    const validStatuses = ["approved", "rejected", "edited"];
    if (!status || !validStatuses.includes(status)) {
      res
        .status(400)
        .json({ error: `status must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    const docRef = db()
      .collection("proposals")
      .doc(meetingId)
      .collection("tasks")
      .doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const callerDoc = await getUser(uid);
    const isPrivileged = callerDoc?.role === "admin" || callerDoc?.role === "project_manager";
    if (!isPrivileged && snap.data()?.assigneeUid !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const update: Record<string, unknown> = {
      reviewedAt: FieldValue.serverTimestamp(),
    };

    if (status === "edited") {
      // Editing implies approval — store edited fields, mark as approved
      update.status = "approved";
      if (title !== undefined) update.editedTitle = title;
      if (description !== undefined) update.editedDescription = description;
    } else {
      update.status = status;
    }

    // Store user-edited due date if provided (null clears any previously set value)
    if (dueDate !== undefined) update.editedDueDate = dueDate;

    // Store per-task Asana project override if provided
    if (asanaProjectId !== undefined) update.asanaProjectId = asanaProjectId;

    // Use a transaction to guard against the expiry race condition:
    // expireProposals could mark this "expired" between our .get() and the write.
    const conflictStatus = await db().runTransaction(async (txn) => {
      const latest = await txn.get(docRef);
      const latestStatus = latest.data()?.status as string | undefined;
      if (latestStatus !== "pending") return latestStatus ?? "unknown";
      txn.update(docRef, update);
      return null;
    });

    if (conflictStatus !== null) {
      res.status(409).json({
        error: `Proposal is already "${conflictStatus}" and can no longer be updated.`,
      });
      return;
    }

    logger.info(
      `proposal ${status}: ${taskId} in meeting ${meetingId} by user ${uid}`
    );
    res.json({ success: true });
  }
);

// ─── GET /settings ────────────────────────────────────────────────────────────

app.get("/settings", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const user = await getUser(uid);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Include integration availability so the frontend can show/hide connection buttons
  const [slackAvailable, asanaAvailable] = await Promise.all([
    isIntegrationConfigured("slack"),
    isIntegrationConfigured("asana"),
  ]);

  res.json({
    ...user,
    availableIntegrations: {
      slack: slackAvailable,
      asana: asanaAvailable,
    },
  });
});

// ─── PATCH /settings ──────────────────────────────────────────────────────────

app.patch("/settings", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const { isActive, preferences } = req.body as {
    isActive?: boolean;
    preferences?: Partial<UserPreferences>;
  };

  const update: Record<string, unknown> = {};

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    update.isActive = isActive;
  }

  if (preferences !== undefined) {
    const allowed: (keyof UserPreferences)[] = [
      "notifyVia",
      "autoApprove",
      "proposalExpiryHours",
      "taskDestination",
      "asanaWorkspaceId",
      "asanaProjectId",
      "slackUserId",
    ];
    for (const key of Object.keys(preferences) as (keyof UserPreferences)[]) {
      if (!allowed.includes(key)) {
        res.status(400).json({ error: `Unknown preference: ${key}` });
        return;
      }
      update[`preferences.${key}`] = preferences[key as keyof UserPreferences];
    }
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  await updateUser(uid, update as Parameters<typeof updateUser>[1]);
  res.json({ success: true });
});

// ─── GET /settings/api-keys ───────────────────────────────────────────────────
// Returns the masked API keys and active provider for the authenticated user.

app.get("/settings/api-keys", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const user = await getUser(uid);
  const activeProvider = user?.aiProvider ?? null;

  const providers = ["anthropic", "openai"] as const;
  const result: Record<string, { configured: boolean; masked: string | null }> = {};

  await Promise.all(
    providers.map(async (p) => {
      const snap = await db().collection("users").doc(uid).collection("apiKeys").doc(p).get();
      if (snap.exists) {
        result[p] = { configured: true, masked: (snap.data()?.masked as string) ?? null };
      } else {
        result[p] = { configured: false, masked: null };
      }
    })
  );

  res.json({ activeProvider, providers: result });
});

// ─── PATCH /settings/api-keys/active ─────────────────────────────────────────
// Sets the active AI provider for the authenticated user.
// Defined BEFORE POST/DELETE /settings/api-keys/:provider to avoid "active"
// matching the :provider wildcard on other methods.

app.patch("/settings/api-keys/active", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const { provider } = req.body as { provider?: string };

  const valid = ["anthropic", "openai"];
  if (!provider || !valid.includes(provider)) {
    res.status(400).json({ error: `provider must be one of: ${valid.join(", ")}` });
    return;
  }

  const keySnap = await db()
    .collection("users").doc(uid)
    .collection("apiKeys").doc(provider)
    .get();

  if (!keySnap.exists) {
    res.status(400).json({ error: `No key saved for provider "${provider}". Add a key first.` });
    return;
  }

  await updateUser(uid, { aiProvider: provider } as Parameters<typeof updateUser>[1]);
  res.json({ success: true });
});

// ─── POST /settings/api-keys/:provider ───────────────────────────────────────
// Saves an API key for the given provider. Returns the masked version.

app.post("/settings/api-keys/:provider", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const { provider } = req.params;
  const { key } = req.body as { key?: string };

  const valid = ["anthropic", "openai"];
  if (!valid.includes(provider)) {
    res.status(400).json({ error: `provider must be one of: ${valid.join(", ")}` });
    return;
  }
  if (typeof key !== "string" || !key.trim()) {
    res.status(400).json({ error: "key must be a non-empty string" });
    return;
  }

  const masked = key.slice(0, 16) + "****";
  await db()
    .collection("users").doc(uid)
    .collection("apiKeys").doc(provider)
    .set({ key, masked, createdAt: FieldValue.serverTimestamp() });

  logger.info(`api-keys: stored ${provider} key for user ${uid}`);
  res.json({ masked });
});

// ─── DELETE /settings/api-keys/:provider ─────────────────────────────────────
// Removes the API key for the given provider.
// If the deleted provider is the active one, clears aiProvider on the user doc.

app.delete("/settings/api-keys/:provider", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const { provider } = req.params;

  const valid = ["anthropic", "openai"];
  if (!valid.includes(provider)) {
    res.status(400).json({ error: `provider must be one of: ${valid.join(", ")}` });
    return;
  }

  await db()
    .collection("users").doc(uid)
    .collection("apiKeys").doc(provider)
    .delete();

  const user = await getUser(uid);
  if (user?.aiProvider === provider) {
    await updateUser(uid, { aiProvider: FieldValue.delete() } as unknown as Parameters<typeof updateUser>[1]);
  }

  logger.info(`api-keys: deleted ${provider} key for user ${uid}`);
  res.json({ success: true });
});

// ─── GET /auth/asana ──────────────────────────────────────────────────────────
// Initiates the Asana OAuth flow.
// The caller passes their Firebase ID token as ?token= so we can tie the
// state cookie to the correct uid without requiring a session cookie.

app.get("/auth/asana", async (req: Request, res: Response) => {
  try {
    const idToken = req.query.token as string | undefined;
    if (!idToken) {
      res.status(400).json({ error: "Missing required query parameter: token" });
      return;
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Generate a CSRF state token, store it in Firestore (same pattern as Google OAuth)
    const state = randomBytes(32).toString("hex");
    await admin.firestore().collection("asanaOAuthStates").doc(state).set({
      uid,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    });

    res.redirect(await buildAsanaAuthUrl(state));
  } catch (err) {
    const msg = (err as Error).message;
    logger.error("asana oauthInit failed", { error: msg });
    if (msg.includes("Secret") && msg.includes("not found")) {
      res.status(503).json({
        error: "Asana integration is not configured for this organisation. Contact your admin.",
      });
    } else {
      res.status(500).json({ error: "Failed to initiate Asana OAuth flow." });
    }
  }
});

// ─── GET /auth/asana/callback ─────────────────────────────────────────────────
// Asana redirects here after the user accepts the consent screen.
// This URL must be registered in the Asana Developer Console.

app.get("/auth/asana/callback", async (req: Request, res: Response) => {
  const db = admin.firestore();

  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const oauthError = req.query.error as string | undefined;

    if (oauthError) {
      logger.warn("User denied Asana OAuth consent", { error: oauthError });
      res.status(403).send("Asana permission denied. Please try again.");
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state parameter." });
      return;
    }

    // Validate and consume state token
    const stateRef = db.collection("asanaOAuthStates").doc(state);
    const stateSnap = await stateRef.get();

    if (!stateSnap.exists) {
      res.status(400).json({ error: "Invalid state token. Please restart the flow." });
      return;
    }

    const { uid, expiresAt } = stateSnap.data() as { uid: string; expiresAt: number };
    await stateRef.delete();

    if (Date.now() > expiresAt) {
      res.status(400).json({ error: "State token expired. Please restart the flow." });
      return;
    }

    // Exchange code for tokens
    const tokens = await exchangeAsanaCode(code);
    await saveAsanaTokens(uid, tokens);

    logger.info(`asana oauthCallback: tokens stored for user ${uid}`);

    const successUrl = process.env.OAUTH_SUCCESS_REDIRECT ?? "/";
    res.redirect(`${successUrl}/settings?asana=connected`);
  } catch (err) {
    logger.error("asana oauthCallback failed", err);
    res.status(500).send("An error occurred during Asana sign-in. Please try again.");
  }
});

// ─── GET /settings/asana ──────────────────────────────────────────────────────
// Returns the user's Asana connection status and saved workspace/project.

app.get("/settings/asana", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;

  const connected = await isAsanaConnected(uid);
  const user = await getUser(uid);
  const prefs = user?.preferences ?? {};

  res.json({
    connected,
    asanaWorkspaceId: (prefs as UserPreferences).asanaWorkspaceId ?? null,
    asanaProjectId: (prefs as UserPreferences).asanaProjectId ?? null,
    taskDestination: (prefs as UserPreferences).taskDestination ?? null,
  });
});

// ─── GET /settings/asana/workspaces ───────────────────────────────────────────
// Returns the workspaces available for the authenticated user's Asana account.

app.get("/settings/asana/workspaces", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;

  try {
    const accessToken = await getValidAsanaAccessToken(uid);
    const workspaces = await getWorkspaces(accessToken);
    res.json({ workspaces });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn(`asana workspaces failed for user ${uid}`, { error: msg });
    res.status(400).json({ error: msg });
  }
});

// ─── GET /settings/asana/projects ─────────────────────────────────────────────
// Returns projects in a given workspace.

app.get("/settings/asana/projects", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const workspaceId = req.query.workspaceId as string | undefined;

  if (!workspaceId) {
    res.status(400).json({ error: "Missing workspaceId query parameter." });
    return;
  }

  try {
    const accessToken = await getValidAsanaAccessToken(uid);
    const projects = await getProjects(accessToken, workspaceId);
    res.json({ projects });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn(`asana projects failed for user ${uid}`, { error: msg });
    res.status(400).json({ error: msg });
  }
});

// ─── DELETE /settings/asana ───────────────────────────────────────────────────
// Disconnects the user's Asana account.

app.delete("/settings/asana", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  await deleteAsanaTokens(uid);
  // Clear asana preferences and fall back to google_tasks
  await updateUser(uid, {
    "preferences.asanaWorkspaceId": FieldValue.delete(),
    "preferences.asanaProjectId": FieldValue.delete(),
  } as unknown as Parameters<typeof updateUser>[1]);
  logger.info(`asana disconnected for user ${uid}`);
  res.json({ success: true });
});

// ─── POST /settings/slack/connect ────────────────────────────────────────────
// Looks up the user's Slack account by email using the bot token and stores
// their Slack member ID (slackUserId) in their preferences.

app.post("/settings/slack/connect", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;

  let botToken: string;
  try {
    botToken = await getSecret("slack.botToken");
  } catch {
    res.status(503).json({ error: "Slack integration is not configured. Contact your admin." });
    return;
  }

  const { slackEmail } = req.body as { slackEmail?: string };

  const user = await getUser(uid);
  if (!user?.email) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const emailToLookup = slackEmail?.trim() || user.email;

  try {
    const slackUser = await lookupUserByEmail(botToken, emailToLookup);
    if (!slackUser) {
      res.status(404).json({ error: "No Slack account found for your email address. Make sure you are in the workspace." });
      return;
    }

    await updateUser(uid, {
      "preferences.slackUserId": slackUser.id,
    } as unknown as Parameters<typeof updateUser>[1]);

    logger.info(`slack: connected user ${uid} → Slack member ${slackUser.id}`);
    res.json({ slackUserId: slackUser.id, displayName: slackUser.displayName });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn(`slack connect failed for user ${uid}`, { error: msg });
    res.status(400).json({ error: msg });
  }
});

// ─── DELETE /settings/slack ───────────────────────────────────────────────────
// Disconnects the user's Slack account.

app.delete("/settings/slack", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  await updateUser(uid, {
    "preferences.slackUserId": FieldValue.delete(),
  } as unknown as Parameters<typeof updateUser>[1]);
  logger.info(`slack disconnected for user ${uid}`);
  res.json({ success: true });
});

// ─── GET /settings/slack ──────────────────────────────────────────────────────
// Returns the user's Slack connection status.

app.get("/settings/slack", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const user = await getUser(uid);
  const slackUserId = (user?.preferences as UserPreferences | undefined)?.slackUserId ?? null;
  const notifyVia = (user?.preferences as UserPreferences | undefined)?.notifyVia ?? "email";
  res.json({ connected: slackUserId !== null, slackUserId, notifyVia });
});

// ─── GET /tasks ───────────────────────────────────────────────────────────────
// Returns all active tasks (created, in_progress, completed) for the user.
// Enriched with meetingTitle and driveFileLink from processedTranscripts.
// For admins/project_managers: returns ALL tasks across all users.
//   Optional ?userId= filters to a specific user's tasks.
//   Optional ?viewAll=true returns all tasks (default for PM/admin when no userId provided).

app.get("/tasks", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const userDoc = await getUser(uid);
  const isPrivileged = userDoc?.role === "admin" || userDoc?.role === "project_manager";

  const userIdFilter = req.query.userId as string | undefined;
  const viewAll = req.query.viewAll === "true";

  let snap;
  if (isPrivileged && (viewAll || userIdFilter)) {
    // PM/admin viewing all tasks or filtering by a specific user
    let q = db().collectionGroup("tasks")
      .where("status", "in", ["created", "in_progress", "completed"]);
    if (userIdFilter) {
      q = q.where("assigneeUid", "==", userIdFilter);
    }
    snap = await q.orderBy("createdAt", "desc").get();
  } else {
    // Regular user (or PM/admin viewing their own tasks)
    snap = await db().collectionGroup("tasks")
      .where("assigneeUid", "==", uid)
      .where("status", "in", ["created", "in_progress", "completed"])
      .orderBy("createdAt", "desc")
      .get();
  }

  // Collect unique meetingIds and fetch titles in one batch
  const meetingIds = [...new Set(snap.docs.map((d) => d.data().meetingId as string))];
  const meetingMeta: Record<string, { meetingTitle: string; driveFileLink: string }> = {};

  await Promise.all(
    meetingIds.map(async (meetingId) => {
      const tSnap = await db().collection("processedTranscripts").doc(meetingId).get();
      meetingMeta[meetingId] = {
        meetingTitle: tSnap.data()?.meetingTitle ?? meetingId,
        driveFileLink: tSnap.data()?.driveFileLink ?? "",
      };
    })
  );

  const tasks = snap.docs.map((d) => {
    const data = d.data() as ProposalDocument;
    return {
      id: d.id,
      ...data,
      meetingTitle: meetingMeta[data.meetingId]?.meetingTitle ?? data.meetingId,
      driveFileLink: meetingMeta[data.meetingId]?.driveFileLink ?? "",
    };
  });

  res.json({ tasks, isPrivileged });
});

// ─── PATCH /tasks/:meetingId/:taskId ──────────────────────────────────────────
// Updates a task's title, description, dueDate, status, or assigneeUid.
// Title/description/dueDate changes are propagated to external systems.
// Status → "completed" marks the task complete externally.

app.patch(
  "/tasks/:meetingId/:taskId",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;
    const { title, description, dueDate, status, assigneeUid: newAssignee } = req.body as {
      title?: string;
      description?: string;
      dueDate?: string | null;
      status?: string;
      assigneeUid?: string;
    };

    const validStatuses = ["created", "in_progress", "completed"];
    if (status !== undefined && !validStatuses.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    const docRef = db().collection("proposals").doc(meetingId).collection("tasks").doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const callerDoc = await getUser(uid);
    const isPrivileged = callerDoc?.role === "admin" || callerDoc?.role === "project_manager";
    if (!isPrivileged && snap.data()?.assigneeUid !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const task = snap.data() as ProposalDocument;
    const update: Record<string, unknown> = {
      localUpdatedAt: FieldValue.serverTimestamp(),
      syncStatus: "pending_sync",
    };

    if (title !== undefined) update.editedTitle = title;
    if (description !== undefined) update.editedDescription = description;
    if (dueDate !== undefined) update.editedDueDate = dueDate;
    if (status !== undefined) update.status = status;
    if (newAssignee !== undefined) update.assigneeUid = newAssignee;
    if (status === "completed") update.completedAt = FieldValue.serverTimestamp();

    await docRef.update(update);

    // Use the task owner's tokens for external updates, not the caller's.
    // An admin/PM editing another user's task must still act via the owner's account.
    const taskOwnerUid = (task.assigneeUid as string | undefined) ?? uid;
    let syncWarning: string | undefined;

    // Propagate title/description/dueDate to external systems
    if (task.externalRefs?.length && (title !== undefined || description !== undefined || dueDate !== undefined)) {
      try {
        const accessToken = await getValidAccessToken(taskOwnerUid);
        await updateExternalRefs(taskOwnerUid, task.externalRefs, accessToken, {
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(dueDate !== undefined && { dueDate: dueDate ?? undefined }),
        });
      } catch (err) {
        const msg = (err as Error).message;
        const isTokenUnavailable = /no .* tokens found|expired and no refresh/i.test(msg);
        logger.warn(`tasks PATCH: external update failed for ${taskId}`, err);
        await docRef.update({ syncStatus: "sync_error", syncError: msg });
        syncWarning = isTokenUnavailable
          ? "External update skipped — task owner's Google account is disconnected"
          : "External update failed — will retry on next sync cycle";
      }
    }

    // Mark complete in external systems
    if (status === "completed" && task.externalRefs?.length) {
      try {
        const accessToken = await getValidAccessToken(taskOwnerUid);
        await completeExternalRefs(taskOwnerUid, task.externalRefs, accessToken);
      } catch (err) {
        const msg = (err as Error).message;
        const isTokenUnavailable = /no .* tokens found|expired and no refresh/i.test(msg);
        logger.warn(`tasks PATCH: external complete failed for ${taskId}`, err);
        await docRef.update({ syncStatus: "sync_error", syncError: msg });
        syncWarning = syncWarning ?? (isTokenUnavailable
          ? "External update skipped — task owner's Google account is disconnected"
          : "External update failed — will retry on next sync cycle");
      }
    }

    res.json(syncWarning ? { success: true, syncWarning } : { success: true });
  }
);

// ─── POST /tasks/:meetingId/:taskId/complete ──────────────────────────────────
// Convenience endpoint — marks the task completed in Firestore and externally.

app.post(
  "/tasks/:meetingId/:taskId/complete",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;

    const docRef = db().collection("proposals").doc(meetingId).collection("tasks").doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) { res.status(404).json({ error: "Task not found" }); return; }

    const callerDoc = await getUser(uid);
    const isPrivileged = callerDoc?.role === "admin" || callerDoc?.role === "project_manager";
    if (!isPrivileged && snap.data()?.assigneeUid !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const task = snap.data() as ProposalDocument;
    await docRef.update({
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      localUpdatedAt: FieldValue.serverTimestamp(),
      syncStatus: "pending_sync",
    });

    if (task.externalRefs?.length) {
      try {
        const taskOwnerUid = task.assigneeUid ?? uid;
        const accessToken = await getValidAccessToken(taskOwnerUid);
        await completeExternalRefs(taskOwnerUid, task.externalRefs, accessToken);
      } catch (err) {
        logger.warn(`tasks complete: external complete failed for ${taskId}`, err);
      }
    }

    res.json({ success: true });
  }
);

// ─── POST /tasks/:meetingId/:taskId/reopen ────────────────────────────────────
// Moves a completed task back to in_progress.

app.post(
  "/tasks/:meetingId/:taskId/reopen",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;

    const docRef = db().collection("proposals").doc(meetingId).collection("tasks").doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) { res.status(404).json({ error: "Task not found" }); return; }
    if (snap.data()?.assigneeUid !== uid) { res.status(403).json({ error: "Forbidden" }); return; }

    await docRef.update({
      status: "in_progress",
      completedAt: FieldValue.delete(),
      localUpdatedAt: FieldValue.serverTimestamp(),
      syncStatus: "pending_sync",
    });
    res.json({ success: true });
  }
);

// ─── POST /tasks/:meetingId/:taskId/recreate ──────────────────────────────────
// Recreates a task in its external system(s) after it was deleted there.
// Calls createTask on each destination and updates the externalRefs.

app.post(
  "/tasks/:meetingId/:taskId/recreate",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;

    const docRef = db().collection("proposals").doc(meetingId).collection("tasks").doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) { res.status(404).json({ error: "Task not found" }); return; }
    if (snap.data()?.assigneeUid !== uid) { res.status(403).json({ error: "Forbidden" }); return; }

    const task = snap.data() as ProposalDocument;
    if (task.syncStatus !== "external_deleted") {
      res.status(400).json({ error: "Task is not marked as externally deleted" });
      return;
    }

    try {
      const transcriptSnap = await db().collection("processedTranscripts").doc(meetingId).get();
      const meetingTitle = transcriptSnap.data()?.meetingTitle ?? meetingId;
      const driveFileLink = transcriptSnap.data()?.driveFileLink ?? "";
      const detectedAt = transcriptSnap.data()?.detectedAt;
      const meetingDate = detectedAt
        ? new Date(detectedAt.seconds * 1000).toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
          })
        : "";

      const accessToken = await getValidAccessToken(uid);
      const { routeTask } = await import("../services/taskDestinations/taskRouter");

      const taskData = {
        title: task.editedTitle ?? task.title,
        description: task.editedDescription ?? task.description,
        ...(task.editedDueDate !== undefined
          ? (task.editedDueDate ? { dueDate: task.editedDueDate } : {})
          : (task.suggestedDueDate ? { dueDate: task.suggestedDueDate } : {})),
        sourceLink: driveFileLink,
        meetingTitle,
        meetingDate,
      };

      const tokens = { accessToken, uid };
      const newRefs = await routeTask(uid, taskData, tokens);

      await docRef.update({
        externalRefs: newRefs,
        syncStatus: "synced",
        localUpdatedAt: FieldValue.serverTimestamp(),
        lastSyncedAt: FieldValue.serverTimestamp(),
      });

      logger.info(`recreate: task ${taskId} recreated in external system(s) by user ${uid}`);
      res.json({ success: true, externalRefs: newRefs });
    } catch (err) {
      logger.error(`recreate: failed for task ${taskId}`, { error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

// ─── POST /sync/now ───────────────────────────────────────────────────────────
// Triggers an immediate sync for the requesting user.
// Returns { synced, errors, deleted } counts.

app.post("/sync/now", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  try {
    const result = await syncUserNow(uid);
    res.json(result);
  } catch (err) {
    logger.error(`sync/now: failed for user ${uid}`, { error: (err as Error).message });
    res.status(500).json({ error: "Sync failed" });
  }
});

// ─── GET /users/active ────────────────────────────────────────────────────────
// Returns all users with isActive=true. Used for the task reassign dropdown.

app.get("/users/active", authenticate, async (_req: Request, res: Response) => {
  const snap = await db().collection("users").where("isActive", "==", true).get();
  const users = snap.docs.map((d) => ({
    uid: d.id,
    email: d.data().email ?? "",
    displayName: d.data().displayName ?? d.data().email ?? "",
  }));
  res.json({ users });
});

// ─── POST /proposals/:meetingId/:taskId/reassign ──────────────────────────────
// Reassigns a pending proposal to another active TaskBot user.
// Only the current assignee may reassign. Sends a notification to the new assignee.

app.post(
  "/proposals/:meetingId/:taskId/reassign",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;
    const { newAssigneeUid } = req.body as { newAssigneeUid?: string };

    if (!newAssigneeUid) {
      res.status(400).json({ error: "Missing newAssigneeUid" });
      return;
    }

    if (newAssigneeUid === uid) {
      res.status(400).json({ error: "New assignee must be different from the current assignee" });
      return;
    }

    const docRef = db().collection("proposals").doc(meetingId).collection("tasks").doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) { res.status(404).json({ error: "Proposal not found" }); return; }

    const proposal = snap.data() as ProposalDocument;
    const callerDoc = await getUser(uid);
    const isPrivileged = callerDoc?.role === "admin" || callerDoc?.role === "project_manager";
    if (!isPrivileged && proposal.assigneeUid !== uid) { res.status(403).json({ error: "Forbidden" }); return; }
    if (proposal.status !== "pending") {
      res.status(409).json({ error: "Only pending proposals can be reassigned" });
      return;
    }

    // Look up the new assignee
    const [newUserSnap, currentUserSnap, transcriptSnap] = await Promise.all([
      db().collection("users").doc(newAssigneeUid).get(),
      db().collection("users").doc(uid).get(),
      db().collection("processedTranscripts").doc(meetingId).get(),
    ]);

    if (!newUserSnap.exists || !(newUserSnap.data() as UserDocument).isActive) {
      res.status(404).json({ error: "New assignee not found or inactive" });
      return;
    }

    const newUser = newUserSnap.data() as UserDocument;
    const currentUser = currentUserSnap.data() as UserDocument;
    const meetingTitle = transcriptSnap.data()?.meetingTitle ?? meetingId;

    await docRef.update({
      assigneeUid: newAssigneeUid,
      assigneeEmail: newUser.email,
      assigneeName: newUser.displayName || newUser.email,
      reassignedFrom: uid,
      reassignedFromName: currentUser.displayName || currentUser.email,
      reassignedAt: FieldValue.serverTimestamp(),
    });

    logger.info(
      `reassign: proposal ${taskId} in meeting ${meetingId} ` +
      `reassigned from ${uid} to ${newAssigneeUid}`
    );

    // Notify new assignee — non-fatal if it fails
    try {
      const senderAccessToken = await getValidAccessToken(uid);
      const expiryHours = newUser.preferences?.proposalExpiryHours ?? 48;
      const token = await generateApprovalToken(newAssigneeUid, meetingId, expiryHours);
      const reviewLink = `${APP_URL()}/review?token=${token}`;

      // Use updated proposal data for the notification
      const updatedProposal = {
        id: taskId,
        ...proposal,
        assigneeUid: newAssigneeUid,
        assigneeEmail: newUser.email,
        assigneeName: newUser.displayName || newUser.email,
        reassignedFrom: uid,
        reassignedFromName: currentUser.displayName || currentUser.email,
      };

      await routeNotification({
        uid: newAssigneeUid,
        user: newUser,
        proposals: [updatedProposal as ProposalDocument & { id: string }],
        meetingTitle,
        meetingId,
        reviewLink,
        approveAllLink: reviewLink,
        expiryHours,
        senderAccessToken,
        senderEmail: currentUser.email,
      });
    } catch (err) {
      logger.warn(`reassign: notification failed for ${taskId}`, { error: (err as Error).message });
    }

    res.json({ success: true });
  }
);

// ─── GET /config/org-defaults ─────────────────────────────────────────────────
// Returns the organisation-wide default notification channel and task destination.
// Admin-only.

app.get("/config/org-defaults", authenticate, requireAdmin, async (req: Request, res: Response) => {

  const snap = await db().collection("config").doc("orgDefaults").get();
  const data = snap.data() ?? {};
  res.json({
    notifyVia: normalizeNotifyVia(data.notifyVia ?? ["email"]),
    taskDestination: normalizeTaskDestination(data.taskDestination ?? ["google_tasks"]),
    proposalExpiryHours: typeof data.proposalExpiryHours === "number" ? data.proposalExpiryHours : 48,
    autoApprove: data.autoApprove === true,
  });
});

// ─── PATCH /config/org-defaults ───────────────────────────────────────────────
// Updates the organisation-wide defaults. Admin-only.

app.patch("/config/org-defaults", authenticate, requireAdmin, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;

  const { notifyVia, taskDestination, proposalExpiryHours, autoApprove } = req.body as {
    notifyVia?: unknown;
    taskDestination?: unknown;
    proposalExpiryHours?: unknown;
    autoApprove?: unknown;
  };

  const update: Record<string, unknown> = {};
  if (notifyVia !== undefined) update.notifyVia = normalizeNotifyVia(notifyVia);
  if (taskDestination !== undefined) update.taskDestination = normalizeTaskDestination(taskDestination);
  if (proposalExpiryHours !== undefined) {
    const hours = Number(proposalExpiryHours);
    if ([24, 48, 72].includes(hours)) update.proposalExpiryHours = hours;
  }
  if (autoApprove !== undefined) update.autoApprove = autoApprove === true;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  await db().collection("config").doc("orgDefaults").set(update, { merge: true });
  logger.info(`org-defaults: updated by admin ${uid}`, update);
  res.json({ success: true });
});

// ─── GET /transcripts/awaiting ────────────────────────────────────────────────
// Returns whether any transcripts relevant to the current user are stuck in
// "awaiting_configuration" state. Used by the dashboard to show a banner.

app.get("/transcripts/awaiting", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const user = await getUser(uid);
  if (!user) {
    res.json({ count: 0 });
    return;
  }

  const [byUidSnap, byEmailSnap] = await Promise.all([
    db().collection("processedTranscripts")
      .where("status", "==", "awaiting_configuration")
      .where("detectedByUid", "==", uid)
      .limit(5)
      .get(),
    user.email
      ? db().collection("processedTranscripts")
          .where("status", "==", "awaiting_configuration")
          .where("attendeeEmails", "array-contains", user.email)
          .limit(5)
          .get()
      : Promise.resolve(null),
  ]);

  // Deduplicate by meeting ID
  const ids = new Set<string>();
  for (const d of byUidSnap.docs) ids.add(d.id);
  if (byEmailSnap) for (const d of byEmailSnap.docs) ids.add(d.id);

  res.json({ count: ids.size });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
// PM-accessible routes (project_manager OR admin): read-only data + reprocess.
app.use("/admin", authenticate, requireProjectManager, adminRateLimit, adminPmRouter);

// Admin-only routes (credentials, user roles, org settings, export).
app.use("/admin", authenticate, requireAdmin, adminRateLimit, adminRouter);

// ─── Export ───────────────────────────────────────────────────────────────────

// Restrict CORS to the hosting domain. During local dev, also allow localhost.
// Direct calls to the function URL from other origins are rejected.
const ALLOWED_ORIGINS = [
  process.env.APP_URL ?? "https://taskbot-fb10d.web.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export const api = onRequest({ region: "us-central1", cors: ALLOWED_ORIGINS }, app);

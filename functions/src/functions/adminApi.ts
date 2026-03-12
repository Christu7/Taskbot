import { Router, Request, Response } from "express";
import { logger } from "firebase-functions";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getUser, updateUser } from "../services/firestore";
import { UserDocument } from "../models/user";
import { AuthRequest } from "../middleware/auth";
import { getMaskedSecrets, setSecrets, getSecret } from "../services/secrets";
import { getValidAccessToken } from "../auth";
import { sendInviteEmail } from "../services/emailSender";
import { logActivity } from "../services/activityLogger";

// pmRouter: routes accessible to project_manager OR admin
const pmRouter = Router();
// router: admin-only routes
const router = Router();
const db = () => admin.firestore();

const APP_URL = process.env.APP_URL ?? "https://taskbot-fb10d.web.app";

// ─── GET /admin/users ─────────────────────────────────────────────────────────
// Returns an enriched summary list of all registered users. Admin + PM.
// Accepts query params: ?search=, ?role=admin|project_manager|user, ?status=active|inactive

pmRouter.get("/users", async (req: Request, res: Response) => {
  const { search, role, status } = req.query as Record<string, string | undefined>;

  try {
  const snap = await db().collection("users").orderBy("createdAt", "asc").get();

  // Fetch asana token existence for all users in parallel
  const asanaChecks = await Promise.all(
    snap.docs.map((d) =>
      db().doc(`users/${d.id}/tokens/asana`).get().then((t) => ({ uid: d.id, exists: t.exists }))
    )
  );
  const asanaMap = new Map(asanaChecks.map((c) => [c.uid, c.exists]));

  // Get task counts via a single collectionGroup query, grouped by uid in memory
  const tasksSnap = await db()
    .collectionGroup("tasks")
    .where("status", "==", "created")
    .get();
  const taskCountMap = new Map<string, number>();
  for (const taskDoc of tasksSnap.docs) {
    const assigneeUid = taskDoc.data().assigneeUid as string | undefined;
    if (assigneeUid) {
      taskCountMap.set(assigneeUid, (taskCountMap.get(assigneeUid) ?? 0) + 1);
    }
  }

  let users = snap.docs.map((d) => {
    const u = d.data() as UserDocument;
    return {
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      isActive: u.isActive,
      role: u.role,
      hasValidTokens: u.hasValidTokens,
      createdAt: u.createdAt,
      asanaConnected: asanaMap.get(u.uid) ?? false,
      slackConnected: !!u.preferences?.slackUserId,
      taskCount: taskCountMap.get(u.uid) ?? 0,
      lastActiveAt: u.updatedAt ?? null,
    };
  });

  // Apply filters
  if (search) {
    const q = search.toLowerCase();
    users = users.filter(
      (u) =>
        (u.displayName ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)
    );
  }
  if (role === "admin" || role === "project_manager" || role === "user") {
    users = users.filter((u) => u.role === role);
  }
  if (status === "active") {
    users = users.filter((u) => u.isActive);
  } else if (status === "inactive") {
    users = users.filter((u) => !u.isActive);
  }

  res.json({ users });
  } catch (err) {
    logger.error("adminApi GET /users failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /admin/users/stats ───────────────────────────────────────────────────
// Returns aggregate user statistics. Must be registered BEFORE /:uid routes.

pmRouter.get("/users/stats", async (_req: Request, res: Response) => {
  const snap = await db().collection("users").get();
  const users = snap.docs.map((d) => d.data() as UserDocument);

  const total = users.length;
  const active = users.filter((u) => u.isActive).length;
  const admins = users.filter((u) => u.role === "admin").length;

  // Count asana connections in parallel
  const asanaChecks = await Promise.all(
    snap.docs.map((d) =>
      db().doc(`users/${d.id}/tokens/asana`).get().then((t) => t.exists)
    )
  );
  const connectedAsana = asanaChecks.filter(Boolean).length;

  const connectedSlack = users.filter(
    (u) => !!u.preferences?.slackUserId
  ).length;

  res.json({ total, active, admins, connectedAsana, connectedSlack });
});

// ─── PATCH /admin/users/:uid/role ─────────────────────────────────────────────
// Promote or demote a user. Admins cannot change their own role.
// Demoting the last admin is also blocked.

router.patch("/users/:uid/role", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { uid } = req.params;
  const { role } = req.body as { role?: unknown };

  if (uid === adminUid) {
    res.status(400).json({ error: "You cannot change your own role" });
    return;
  }

  if (role !== "admin" && role !== "project_manager" && role !== "user") {
    res.status(400).json({ error: "role must be \"admin\", \"project_manager\", or \"user\"" });
    return;
  }

  const target = await getUser(uid);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Prevent demoting the last admin
  if ((role === "user" || role === "project_manager") && target.role === "admin") {
    const adminsSnap = await db().collection("users").where("role", "==", "admin").get();
    if (adminsSnap.size <= 1) {
      res.status(400).json({ error: "Cannot demote the last admin. Promote another user first." });
      return;
    }
  }

  await db().collection("users").doc(uid).update({
    role,
    promotedBy: adminUid,
    promotedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info(`adminApi: user ${uid} role set to "${role}" by admin ${adminUid}`);
  res.json({ success: true });
});

// ─── PATCH /admin/users/:uid/status ──────────────────────────────────────────
// Activate or deactivate a user account.

router.patch("/users/:uid/status", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { uid } = req.params;
  const { isActive } = req.body as { isActive?: unknown };

  if (typeof isActive !== "boolean") {
    res.status(400).json({ error: "isActive must be a boolean" });
    return;
  }

  const target = await getUser(uid);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await updateUser(uid, { isActive });
  logger.info(`adminApi: user ${uid} isActive → ${isActive} by admin ${adminUid}`);
  res.json({ success: true });
});

// ─── PATCH /admin/users/bulk-status ──────────────────────────────────────────
// Activate or deactivate multiple users at once.

router.patch("/users/bulk-status", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { uids, isActive } = req.body as { uids?: unknown; isActive?: unknown };

  if (!Array.isArray(uids) || uids.length === 0) {
    res.status(400).json({ error: "uids must be a non-empty array" });
    return;
  }
  if (typeof isActive !== "boolean") {
    res.status(400).json({ error: "isActive must be a boolean" });
    return;
  }

  const safeUids = (uids as unknown[])
    .filter((uid): uid is string => typeof uid === "string" && uid !== adminUid);

  await Promise.all(safeUids.map((uid) => updateUser(uid, { isActive })));

  logger.info(`adminApi: bulk status (isActive=${isActive}) for ${safeUids.length} user(s) by admin ${adminUid}`);
  res.json({ success: true, updated: safeUids.length });
});

// ─── DELETE /admin/users/:uid ─────────────────────────────────────────────────
// Remove a user's Firestore document and Firebase Auth account.
// Also cleans up token subcollections before deleting the main doc.

router.delete("/users/:uid", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { uid } = req.params;

  if (uid === adminUid) {
    res.status(400).json({ error: "You cannot delete your own account via the admin panel" });
    return;
  }

  const target = await getUser(uid);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Delete token subcollections before deleting the main doc
  await Promise.all([
    db().doc(`users/${uid}/tokens/google`).delete(),
    db().doc(`users/${uid}/tokens/asana`).delete(),
  ]);

  await db().collection("users").doc(uid).delete();

  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    logger.warn(`adminApi: Auth record deletion failed for ${uid}`, {
      error: (err as Error).message,
    });
  }

  logger.info(`adminApi: user ${uid} deleted by admin ${adminUid}`);
  res.json({ success: true });
});

// ─── POST /admin/invite ───────────────────────────────────────────────────────
// Stores an invite record and sends an email invite to the specified address.

router.post("/invite", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { email } = req.body as { email?: unknown };

  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  // Store the invite record
  await db().collection("invites").doc(email).set({
    invitedBy: adminUid,
    invitedAt: FieldValue.serverTimestamp(),
    accepted: false,
  });

  // Attempt to send the invite email
  try {
    const accessToken = await getValidAccessToken(adminUid);
    const adminDoc = await db().collection("users").doc(adminUid).get();
    const adminEmail = (adminDoc.data() as UserDocument | undefined)?.email ?? "";
    await sendInviteEmail(accessToken, adminEmail, email, APP_URL);
    logger.info(`adminApi: invite sent to ${email} by admin ${adminUid}`);
    res.json({ success: true });
  } catch (err) {
    logger.warn(`adminApi: invite stored but email not sent to ${email}`, {
      error: (err as Error).message,
    });
    res.json({ success: true, emailSent: false, error: (err as Error).message });
  }
});

// ─── GET /admin/secrets ───────────────────────────────────────────────────────
// Returns masked credential status. NEVER returns actual secret values.

router.get("/secrets", async (_req: Request, res: Response) => {
  const masked = await getMaskedSecrets();
  res.json(masked);
});

// ─── PUT /admin/secrets ───────────────────────────────────────────────────────
// Saves (or updates) credentials. Only provided fields are written.

router.put("/secrets", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const body = req.body as Record<string, unknown>;

  // Validate ai.provider if provided
  const aiProvider = (body.ai as Record<string, unknown> | undefined)?.provider;
  if (aiProvider !== undefined && !["anthropic", "openai", "gemini"].includes(aiProvider as string)) {
    res.status(400).json({ error: "ai.provider must be \"anthropic\", \"openai\", or \"gemini\"" });
    return;
  }

  // Validate that apiKey isn't an empty string if provided
  const aiApiKey = (body.ai as Record<string, unknown> | undefined)?.apiKey;
  if (aiApiKey !== undefined && (typeof aiApiKey !== "string" || aiApiKey.trim() === "")) {
    res.status(400).json({ error: "ai.apiKey must be a non-empty string" });
    return;
  }

  await setSecrets(body as Parameters<typeof setSecrets>[0], adminUid);

  const masked = await getMaskedSecrets();
  logger.info(`adminApi: secrets updated by admin ${adminUid}`);
  res.json({ success: true, configuredAt: (masked as { configuredAt?: unknown }).configuredAt });
});

// ─── POST /admin/secrets/test ─────────────────────────────────────────────────
// Tests each configured credential and returns health status per integration.

router.post("/secrets/test", async (_req: Request, res: Response) => {
  type Status = "ok" | "error" | "not_configured" | "configured";
  interface TestResult { status: Status; message?: string; team?: string }

  const results: {
    ai: TestResult;
    slack: TestResult;
    asana: TestResult;
  } = {
    ai: { status: "not_configured" },
    slack: { status: "not_configured" },
    asana: { status: "not_configured" },
  };

  // ── AI test ────────────────────────────────────────────────────────────────
  try {
    const apiKey = await getSecret("ai.apiKey");
    let provider: string;
    try { provider = await getSecret("ai.provider"); }
    catch { provider = process.env.AI_PROVIDER ?? "anthropic"; }

    if (provider === "anthropic") {
      const client = new Anthropic({ apiKey });
      await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say 'ok'" }],
      });
      results.ai = { status: "ok", message: `anthropic (${provider})` };
    } else if (provider === "openai") {
      const client = new OpenAI({ apiKey });
      await client.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say ok" }],
      });
      results.ai = { status: "ok", message: "openai" };
    } else {
      results.ai = { status: "error", message: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Secret") && msg.includes("not found")) {
      results.ai = { status: "not_configured" };
    } else {
      results.ai = { status: "error", message: msg };
    }
  }

  // ── Slack test ─────────────────────────────────────────────────────────────
  try {
    const botToken = await getSecret("slack.botToken");
    const resp = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await resp.json() as { ok: boolean; team?: string; error?: string };
    if (data.ok) {
      results.slack = { status: "ok", team: data.team };
    } else {
      results.slack = { status: "error", message: data.error ?? "Slack auth.test returned ok=false" };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Secret") && msg.includes("not found")) {
      results.slack = { status: "not_configured" };
    } else {
      results.slack = { status: "error", message: msg };
    }
  }

  // ── Asana test ─────────────────────────────────────────────────────────────
  try {
    await getSecret("asana.clientId");
    await getSecret("asana.clientSecret");

    // Try a live Asana API call if any user has tokens
    const usersSnap = await admin.firestore()
      .collection("users")
      .where("isActive", "==", true)
      .limit(5)
      .get();

    let testedLive = false;
    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const tokenSnap = await admin.firestore()
        .doc(`users/${uid}/tokens/asana`)
        .get();
      if (!tokenSnap.exists) continue;
      const accessToken = (tokenSnap.data() as { access_token?: string })?.access_token;
      if (!accessToken) continue;

      const resp = await fetch("https://app.asana.com/api/1.0/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (resp.ok) {
        results.asana = { status: "ok", message: "Asana API reachable" };
      } else {
        results.asana = { status: "configured", message: "Credentials configured; live call failed (token may be expired)" };
      }
      testedLive = true;
      break;
    }

    if (!testedLive) {
      results.asana = { status: "configured", message: "Credentials configured; no connected users to test with" };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Secret") && msg.includes("not found")) {
      results.asana = { status: "not_configured" };
    } else {
      results.asana = { status: "error", message: msg };
    }
  }

  res.json(results);
});

// ─── GET /admin/dashboard ─────────────────────────────────────────────────────

pmRouter.get("/dashboard", async (_req: Request, res: Response) => {
  try {
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const weekAgoTs = Timestamp.fromDate(weekAgo);
  const monthAgoTs = Timestamp.fromDate(monthAgo);

  // Users
  const usersSnap = await db().collection("users").get();
  const users = usersSnap.docs.map((d) => d.data());
  const totalUsers = users.length;
  const activeUsers = users.filter((u) => u.isActive).length;
  const adminUsers = users.filter((u) => u.role === "admin").length;

  // Meetings
  const [allMeetingsSnap, weekMeetingsSnap] = await Promise.all([
    db().collection("processedTranscripts").count().get(),
    db().collection("processedTranscripts")
      .where("detectedAt", ">=", weekAgoTs)
      .count().get(),
  ]);
  const totalMeetings = allMeetingsSnap.data().count;
  const weekMeetings = weekMeetingsSnap.data().count;

  // Tasks (collectionGroup)
  const [allTasksSnap, weekTasksSnap] = await Promise.all([
    db().collectionGroup("tasks").count().get(),
    db().collectionGroup("tasks")
      .where("createdAt", ">=", weekAgoTs)
      .count().get(),
  ]);
  const totalTasks = allTasksSnap.data().count;
  const weekTasks = weekTasksSnap.data().count;

  // AI usage — sum tokensUsed from processedTranscripts this week/month.
  // Filter by detectedAt only (single inequality field); skip docs without tokensUsed in memory.
  const [weekTranscriptsSnap, monthTranscriptsSnap] = await Promise.all([
    db().collection("processedTranscripts")
      .where("detectedAt", ">=", weekAgoTs)
      .get(),
    db().collection("processedTranscripts")
      .where("detectedAt", ">=", monthAgoTs)
      .get(),
  ]);

  let weekInput = 0, weekOutput = 0;
  for (const d of weekTranscriptsSnap.docs) {
    const t = d.data().tokensUsed as { input: number; output: number } | undefined;
    if (t) { weekInput += t.input; weekOutput += t.output; }
  }
  let monthInput = 0, monthOutput = 0;
  for (const d of monthTranscriptsSnap.docs) {
    const t = d.data().tokensUsed as { input: number; output: number } | undefined;
    if (t) { monthInput += t.input; monthOutput += t.output; }
  }

  // Cost estimation (Anthropic Sonnet rates: $3/M input, $15/M output)
  const weekCost = (weekInput / 1_000_000) * 3 + (weekOutput / 1_000_000) * 15;
  const monthCost = (monthInput / 1_000_000) * 3 + (monthOutput / 1_000_000) * 15;

  // Integration health
  const integrations: Record<string, { status: string; message?: string }> = {};
  try {
    try { await getSecret("ai.apiKey"); integrations.ai = { status: "configured" }; }
    catch { integrations.ai = { status: "not_configured" }; }
    try { await getSecret("slack.botToken"); integrations.slack = { status: "configured" }; }
    catch { integrations.slack = { status: "not_configured" }; }
    try { await getSecret("asana.clientId"); integrations.asana = { status: "configured" }; }
    catch { integrations.asana = { status: "not_configured" }; }
  } catch { /* ignore */ }

  res.json({
    users: { total: totalUsers, active: activeUsers, admins: adminUsers },
    meetings: { total: totalMeetings, thisWeek: weekMeetings },
    tasks: { total: totalTasks, thisWeek: weekTasks },
    aiUsage: {
      tokensThisWeek: { input: weekInput, output: weekOutput },
      estimatedCostThisWeek: Math.round(weekCost * 100) / 100,
      estimatedCostThisMonth: Math.round(monthCost * 100) / 100,
    },
    integrations,
  });
  } catch (err) {
    logger.error("adminApi GET /dashboard failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /admin/activity ──────────────────────────────────────────────────────

pmRouter.get("/activity", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 100);

  const snap = await db().collection("activityLog")
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();

  const entries = snap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
    timestamp: d.data().timestamp,
  }));

  res.json({ entries });
});

// ─── GET /admin/meetings ──────────────────────────────────────────────────────

pmRouter.get("/meetings", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
  const status = req.query.status as string | undefined;
  const cursor = req.query.cursor as string | undefined;

  let query = db().collection("processedTranscripts")
    .orderBy("detectedAt", "desc") as admin.firestore.Query;

  if (status) query = query.where("status", "==", status);
  if (cursor) {
    const cursorDoc = await db().collection("processedTranscripts").doc(cursor).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }

  query = query.limit(limit);
  const snap = await query.get();

  // For each meeting, get task/proposal counts
  const meetings = await Promise.all(snap.docs.map(async (d) => {
    const data = d.data();
    const proposalsSnap = await db()
      .collection("proposals").doc(d.id)
      .collection("tasks").count().get();

    // Get detectedBy user display name
    let detectedByName = data.detectedByUid;
    try {
      const userSnap = await db().collection("users").doc(data.detectedByUid).get();
      if (userSnap.exists) {
        detectedByName = (userSnap.data() as { displayName?: string; email?: string }).displayName
          || (userSnap.data() as { displayName?: string; email?: string }).email
          || data.detectedByUid;
      }
    } catch { /* ignore */ }

    return {
      id: d.id,
      meetingTitle: data.meetingTitle,
      detectedAt: data.detectedAt,
      detectedByUid: data.detectedByUid,
      detectedByName,
      attendeeEmails: data.attendeeEmails ?? [],
      status: data.status,
      transcriptFormat: data.transcriptFormat,
      hasNotes: data.hasNotes ?? false,
      error: data.error,
      taskCount: proposalsSnap.data().count,
      tokensUsed: data.tokensUsed ?? null,
      driveFileLink: data.driveFileLink,
    };
  }));

  const nextCursor = snap.docs.length === limit ? snap.docs[snap.docs.length - 1].id : null;
  res.json({ meetings, nextCursor });
});

// ─── GET /admin/meetings/:meetingId/proposals ─────────────────────────────────

pmRouter.get("/meetings/:meetingId/proposals", async (req: Request, res: Response) => {
  const { meetingId } = req.params;
  const snap = await db()
    .collection("proposals").doc(meetingId)
    .collection("tasks")
    .orderBy("createdAt", "desc")
    .get();

  const tasks = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      title: data.title,
      editedTitle: data.editedTitle,
      description: data.description,
      assigneeEmail: data.assigneeEmail,
      assigneeName: data.assigneeName,
      status: data.status,
      confidence: data.confidence,
      createdAt: data.createdAt,
    };
  });

  res.json({ tasks });
});

// ─── POST /admin/meetings/:meetingId/reprocess ────────────────────────────────

pmRouter.post("/meetings/:meetingId/reprocess", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { meetingId } = req.params;

  const docRef = db().collection("processedTranscripts").doc(meetingId);
  const snap = await docRef.get();

  if (!snap.exists) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }

  const data = snap.data() as Record<string, unknown>;
  if (!["failed", "awaiting_configuration"].includes(data.status as string)) {
    res.status(400).json({ error: "Only failed or awaiting_configuration meetings can be reprocessed" });
    return;
  }

  // Delete existing proposals for this meeting
  const proposalsSnap = await db()
    .collection("proposals").doc(meetingId)
    .collection("tasks").get();
  if (!proposalsSnap.empty) {
    const batch = db().batch();
    proposalsSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // Delete and re-create the processedTranscripts doc to trigger the Cloud Function
  const preserved = {
    driveFileId: data.driveFileId,
    driveFileLink: data.driveFileLink,
    detectedByUid: data.detectedByUid,
    meetingTitle: data.meetingTitle,
    detectedAt: data.detectedAt,
    attendeeEmails: data.attendeeEmails ?? [],
    status: "pending",
  };

  await docRef.delete();
  await docRef.set(preserved);

  await logActivity("reprocess_triggered",
    `Meeting "${data.meetingTitle}" queued for reprocessing`,
    { meetingId, userId: adminUid }
  );

  logger.info(`adminApi: meeting ${meetingId} requeued for processing by admin ${adminUid}`);
  res.json({ success: true });
});

// ─── GET /admin/setup-status ──────────────────────────────────────────────────
// Returns the current onboarding setup state.
// Used by the admin panel to show/hide the setup wizard.

pmRouter.get("/setup-status", async (_req: Request, res: Response) => {
  const [setupSnap, secretsSnap] = await Promise.all([
    db().doc("config/setup").get(),
    db().doc("config/secrets").get(),
  ]);

  const setupData = setupSnap.data() ?? {};
  const secretsData = secretsSnap.data() ?? {};

  // Determine which steps are done independently of the setup wizard
  const aiConfigured = !!(secretsData.ai?.apiKey);
  const slackConfigured = !!(secretsData.slack?.botToken);
  const asanaConfigured = !!(secretsData.asana?.clientId);

  const orgSnap = await db().doc("config/orgDefaults").get();
  const orgConfigured = orgSnap.exists;

  res.json({
    completed: setupData.completed === true,
    completedAt: setupData.completedAt ?? null,
    completedBy: setupData.completedBy ?? null,
    steps: {
      ai: aiConfigured,
      notifications: slackConfigured || asanaConfigured,
      orgDefaults: orgConfigured,
    },
  });
});

// ─── POST /admin/setup-complete ───────────────────────────────────────────────
// Marks the setup wizard as completed.

router.post("/setup-complete", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;

  await db().doc("config/setup").set({
    completed: true,
    completedAt: FieldValue.serverTimestamp(),
    completedBy: adminUid,
  }, { merge: true });

  logger.info(`adminApi: setup wizard completed by admin ${adminUid}`);
  res.json({ success: true });
});

// ─── POST /admin/export ───────────────────────────────────────────────────────
// Exports all Firestore data (users, meetings, proposals) as JSON.
// Encrypted secrets are NEVER included. Tokens subcollections are excluded.
// Useful for migrating between projects or disaster recovery.

router.post("/export", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  logger.info(`adminApi: export requested by admin ${adminUid}`);

  const exportData: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    exportedBy: adminUid,
  };

  // Users — exclude tokens and apiKeys subcollections
  const usersSnap = await db().collection("users").get();
  exportData.users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Org defaults (plaintext — safe to export)
  const orgSnap = await db().doc("config/orgDefaults").get();
  exportData.orgDefaults = orgSnap.exists ? orgSnap.data() : null;

  // Setup state
  const setupSnap = await db().doc("config/setup").get();
  exportData.setup = setupSnap.exists ? setupSnap.data() : null;

  // Processed transcripts (meetings)
  const transcriptsSnap = await db().collection("processedTranscripts").orderBy("detectedAt", "desc").limit(500).get();
  exportData.meetings = transcriptsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Proposals (tasks) — iterate per meeting to avoid collectionGroup limits
  const proposalsData: Record<string, unknown[]> = {};
  await Promise.all(
    transcriptsSnap.docs.map(async (meetingDoc) => {
      const tasksSnap = await db()
        .collection("proposals").doc(meetingDoc.id).collection("tasks")
        .get();
      if (!tasksSnap.empty) {
        proposalsData[meetingDoc.id] = tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }
    })
  );
  exportData.proposals = proposalsData;

  // Activity log (last 200 entries)
  const activitySnap = await db().collection("activityLog")
    .orderBy("timestamp", "desc").limit(200).get();
  exportData.activityLog = activitySnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Set filename-friendly timestamp
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="taskbot-export-${ts}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.json(exportData);
});

export { router as adminRouter, pmRouter as adminPmRouter };

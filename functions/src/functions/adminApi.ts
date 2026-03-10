import { Router, Request, Response } from "express";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getUser, updateUser } from "../services/firestore";
import { UserDocument } from "../models/user";
import { AuthRequest } from "../middleware/auth";
import { getMaskedSecrets, setSecrets, getSecret } from "../services/secrets";
import { getValidAccessToken } from "../auth";
import { sendInviteEmail } from "../services/emailSender";

const router = Router();
const db = () => admin.firestore();

const APP_URL = process.env.APP_URL ?? "https://taskbot-fb10d.web.app";

// ─── GET /admin/users ─────────────────────────────────────────────────────────
// Returns an enriched summary list of all registered users. Admin only.
// Accepts query params: ?search=, ?role=admin|user, ?status=active|inactive

router.get("/users", async (req: Request, res: Response) => {
  const { search, role, status } = req.query as Record<string, string | undefined>;

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
  if (role === "admin" || role === "user") {
    users = users.filter((u) => u.role === role);
  }
  if (status === "active") {
    users = users.filter((u) => u.isActive);
  } else if (status === "inactive") {
    users = users.filter((u) => !u.isActive);
  }

  res.json({ users });
});

// ─── GET /admin/users/stats ───────────────────────────────────────────────────
// Returns aggregate user statistics. Must be registered BEFORE /:uid routes.

router.get("/users/stats", async (_req: Request, res: Response) => {
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

router.patch("/users/:uid/role", async (req: Request, res: Response) => {
  const adminUid = (req as AuthRequest).uid;
  const { uid } = req.params;
  const { role } = req.body as { role?: unknown };

  if (uid === adminUid) {
    res.status(400).json({ error: "You cannot change your own role" });
    return;
  }

  if (role !== "admin" && role !== "user") {
    res.status(400).json({ error: "role must be \"admin\" or \"user\"" });
    return;
  }

  const target = await getUser(uid);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
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

export { router as adminRouter };

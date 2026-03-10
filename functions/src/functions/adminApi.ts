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

const router = Router();
const db = () => admin.firestore();

// ─── GET /admin/users ─────────────────────────────────────────────────────────
// Returns a summary list of all registered users. Admin only.

router.get("/users", async (_req: Request, res: Response) => {
  const snap = await db().collection("users").orderBy("createdAt", "asc").get();
  const users = snap.docs.map((d) => {
    const u = d.data() as UserDocument;
    return {
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      isActive: u.isActive,
      role: u.role,
      hasValidTokens: u.hasValidTokens,
      createdAt: u.createdAt,
    };
  });
  res.json({ users });
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

// ─── DELETE /admin/users/:uid ─────────────────────────────────────────────────
// Remove a user's Firestore document and Firebase Auth account.
// Admins cannot delete their own account via this endpoint.

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

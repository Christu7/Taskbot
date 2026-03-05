import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import Anthropic from "@anthropic-ai/sdk";

type ServiceStatus = { status: "ok" | "warn" | "error"; detail?: string };

/**
 * GET /healthCheck
 *
 * Returns the operational status of every TaskBot dependency.
 * Useful for verifying a fresh deployment or debugging production issues.
 *
 * Response shape:
 *   {
 *     status: "ok" | "degraded",
 *     timestamp: ISO string,
 *     services: {
 *       auth:       { status, detail? },
 *       firestore:  { status, detail? },
 *       aiProvider: { status, detail? },
 *       googleApis: { status, detail? },
 *       envVars:    { status, detail? },
 *     }
 *   }
 *
 * Pass ?ai=true to include a live Anthropic API test call (costs ~1 token).
 */
export const healthCheck = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    const includeAiCall = req.query.ai === "true";
    const services: Record<string, ServiceStatus> = {};

    // ── Firebase Auth ──────────────────────────────────────────────────────
    try {
      await admin.auth().listUsers(1);
      services.auth = { status: "ok" };
    } catch (err) {
      services.auth = { status: "error", detail: (err as Error).message };
    }

    // ── Firestore ──────────────────────────────────────────────────────────
    try {
      await admin.firestore()
        .collection("_healthcheck")
        .doc("ping")
        .set({ ts: Date.now() }, { merge: true });
      services.firestore = { status: "ok" };
    } catch (err) {
      services.firestore = { status: "error", detail: (err as Error).message };
    }

    // ── AI Provider ────────────────────────────────────────────────────────
    const aiProvider = process.env.AI_PROVIDER ?? "anthropic";
    if (aiProvider === "anthropic") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        services.aiProvider = { status: "warn", detail: "ANTHROPIC_API_KEY not set" };
      } else if (includeAiCall) {
        try {
          const client = new Anthropic({ apiKey });
          const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
          await client.messages.create({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          });
          services.aiProvider = { status: "ok", detail: `anthropic / ${model}` };
        } catch (err) {
          services.aiProvider = { status: "error", detail: (err as Error).message };
        }
      } else {
        services.aiProvider = {
          status: "ok",
          detail: "anthropic (key set; pass ?ai=true to test live call)",
        };
      }
    } else if (aiProvider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY;
      services.aiProvider = apiKey
        ? { status: "ok", detail: "openai (key set)" }
        : { status: "warn", detail: "OPENAI_API_KEY not set" };
    } else {
      services.aiProvider = {
        status: "warn",
        detail: `Unknown AI_PROVIDER: "${aiProvider}"`,
      };
    }

    // ── Google APIs (connectivity) ─────────────────────────────────────────
    try {
      const resp = await fetch("https://www.googleapis.com/", { method: "HEAD" });
      // googleapis returns 404 for the root — that still means we can reach it
      services.googleApis = resp.ok || resp.status === 404
        ? { status: "ok" }
        : { status: "warn", detail: `Unexpected HTTP ${resp.status}` };
    } catch (err) {
      services.googleApis = { status: "error", detail: (err as Error).message };
    }

    // ── Required environment variables ─────────────────────────────────────
    const requiredEnvVars = [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OAUTH_REDIRECT_URI",
      "OAUTH_SUCCESS_REDIRECT",
    ];
    const missing = requiredEnvVars.filter((k) => !process.env[k]);
    if (missing.length === 0) {
      services.envVars = { status: "ok" };
    } else {
      services.envVars = {
        status: "error",
        detail: `Missing: ${missing.join(", ")}`,
      };
    }

    const allOk = Object.values(services).every(
      (s) => s.status === "ok" || s.status === "warn"
    );
    const overallStatus = allOk ? "ok" : "degraded";

    logger.info("healthCheck", { overallStatus, services });

    res.status(allOk ? 200 : 503).json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services,
    });
  }
);

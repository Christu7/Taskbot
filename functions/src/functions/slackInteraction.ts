import * as admin from "firebase-admin";
import { createHmac, timingSafeEqual } from "crypto";
import { onRequest } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { ProposalDocument } from "../models/proposal";
import { postToResponseUrl, SlackBlock, SectionBlock, ContextBlock } from "../services/slack/slackClient";
import { getSecret } from "../services/secrets";

const db = () => admin.firestore();

// ─── Slack payload types ──────────────────────────────────────────────────────

interface SlackActionValue {
  m: string; // meetingId
  t: string; // taskId
}

interface SlackAction {
  action_id: string;
  block_id: string;
  value: string;
}

interface SlackInteractionPayload {
  type: string;
  actions: SlackAction[];
  response_url: string;
  channel: { id: string };
  user: { id: string; username: string };
  message: {
    ts: string;
    blocks: SlackBlock[];
    text?: string;
  };
}

// ─── Signing secret verification ──────────────────────────────────────────────

function verifySlackRequest(
  signingSecret: string,
  requestTimestamp: string,
  rawBody: Buffer,
  slackSignature: string
): boolean {
  // Reject requests older than 5 minutes to prevent replay attacks
  const ts = parseInt(requestTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const baseStr = `v0:${requestTimestamp}:${rawBody.toString("utf-8")}`;
  const mySignature =
    "v0=" + createHmac("sha256", signingSecret).update(baseStr).digest("hex");

  const a = Buffer.from(mySignature, "utf-8");
  const b = Buffer.from(slackSignature, "utf-8");
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

// ─── Block update helpers ─────────────────────────────────────────────────────

/**
 * Replaces the actions block for a specific task with a status line.
 * Leaves all other blocks untouched.
 */
function markTaskInBlocks(
  blocks: SlackBlock[],
  taskId: string,
  status: "approved" | "rejected"
): SlackBlock[] {
  const icon = status === "approved" ? "✓" : "✗";
  const label = status === "approved" ? "Approved" : "Rejected";
  const actionsBlockId = `tb_actions_${taskId}`;

  return blocks.map((block) => {
    if (block.type === "actions" && block.block_id === actionsBlockId) {
      const replacement: ContextBlock = {
        type: "context",
        block_id: `tb_status_${taskId}`,
        elements: [
          {
            type: "mrkdwn",
            text: `${icon} *${label}*`,
          },
        ],
      };
      return replacement;
    }
    return block;
  });
}

// ─── Cloud Function ───────────────────────────────────────────────────────────

/**
 * Receives and handles Slack button interaction payloads.
 *
 * Register this URL in your Slack App → Interactivity & Shortcuts:
 *   https://us-central1-taskbot-fb10d.cloudfunctions.net/slackInteraction
 *
 * Security: every request is verified using the Slack signing secret before
 * any business logic runs.
 */
export const slackInteraction = onRequest(
  {
    region: "us-central1",
    // Slack requires a 200 ack within 3 s; we send it immediately after
    // signature verification. The remaining async work (Firestore + response_url)
    // completes before this 30 s limit. The default (60 s) is more than enough
    // but 30 s is a tighter, more intentional bound.
    timeoutSeconds: 30,
  },
  async (req, res) => {
    // ── Security: verify Slack signing secret ───────────────────────────────
    // Fetches from cache (fast) or Firestore/env (first call only).
    let signingSecret: string;
    try {
      signingSecret = await getSecret("slack.signingSecret");
    } catch {
      logger.error("slackInteraction: slack.signingSecret not configured");
      res.status(500).send("Server configuration error");
      return;
    }

    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    const rawBody = req.rawBody as Buffer | undefined;

    if (!timestamp || !signature || !rawBody) {
      res.status(400).send("Missing Slack verification headers");
      return;
    }

    if (!verifySlackRequest(signingSecret, timestamp, rawBody, signature)) {
      logger.warn("slackInteraction: failed signature verification");
      res.status(401).send("Unauthorized");
      return;
    }

    // ── Parse Slack payload (application/x-www-form-urlencoded) ────────────
    // Still synchronous — rawBody is already in memory.
    const bodyStr = rawBody.toString("utf-8");
    const payloadStr = new URLSearchParams(bodyStr).get("payload");

    if (!payloadStr) {
      res.status(400).send("Missing payload");
      return;
    }

    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(payloadStr) as SlackInteractionPayload;
    } catch {
      res.status(400).send("Invalid payload JSON");
      return;
    }

    if (payload.type !== "block_actions" || !payload.actions?.length) {
      res.status(200).send(); // Acknowledge unknown event types
      return;
    }

    const action = payload.actions[0];
    const { action_id: actionId, value } = action;

    let parsed: SlackActionValue;
    try {
      parsed = JSON.parse(value) as SlackActionValue;
    } catch {
      res.status(400).send("Invalid action value");
      return;
    }

    const { m: meetingId, t: taskId } = parsed;
    const responseUrl = payload.response_url;
    const slackUserId = payload.user.id;

    logger.info(`slackInteraction: ${actionId} on task ${taskId} in meeting ${meetingId} by ${slackUserId}`);

    // ── ACK IMMEDIATELY ─────────────────────────────────────────────────────
    // Slack requires a 200 response within 3 seconds. Sending it here — after
    // sync validation but before any I/O — ensures we always beat that deadline.
    // Firebase Functions v2 keeps the handler alive until this async function's
    // returned Promise resolves, so all work below still completes.
    res.status(200).send();

    // ── Handle "View Details" ───────────────────────────────────────────────
    if (actionId === "tb_view") {
      try {
        const snap = await db()
          .collection("proposals")
          .doc(meetingId)
          .collection("tasks")
          .doc(taskId)
          .get();

        if (!snap.exists) {
          await postToResponseUrl(responseUrl, {
            response_type: "ephemeral",
            replace_original: false,
            text: "Task not found.",
          });
          return;
        }

        const proposal = snap.data() as ProposalDocument;

        const blocks: SlackBlock[] = [];

        const titleSection: SectionBlock = {
          type: "section",
          text: { type: "mrkdwn", text: `*${proposal.title}*` },
        };
        blocks.push(titleSection);

        if (proposal.description) {
          const descSection: SectionBlock = {
            type: "section",
            text: { type: "mrkdwn", text: proposal.description },
          };
          blocks.push(descSection);
        }

        if (proposal.transcriptExcerpt) {
          const excerptSection: SectionBlock = {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Transcript excerpt:*\n> ${proposal.transcriptExcerpt}`,
            },
          };
          blocks.push(excerptSection);
        }

        await postToResponseUrl(responseUrl, {
          response_type: "ephemeral",
          replace_original: false,
          text: proposal.title,
          blocks,
        });
      } catch (err) {
        logger.error("slackInteraction: view_details failed", { error: (err as Error).message });
      }
      return;
    }

    // ── Handle Approve / Reject ─────────────────────────────────────────────
    if (actionId !== "tb_approve" && actionId !== "tb_reject") {
      return;
    }

    const newStatus = actionId === "tb_approve" ? "approved" : "rejected";

    try {
      const docRef = db()
        .collection("proposals")
        .doc(meetingId)
        .collection("tasks")
        .doc(taskId);

      // Only update if still pending (idempotency guard)
      const currentSnap = await docRef.get();
      const currentStatus = currentSnap.data()?.status as string | undefined;

      if (currentStatus === "pending") {
        await docRef.update({
          status: newStatus,
          reviewedAt: FieldValue.serverTimestamp(),
          localUpdatedAt: FieldValue.serverTimestamp(),
        });
        logger.info(`slackInteraction: proposal ${taskId} marked ${newStatus}`);
      } else {
        logger.info(`slackInteraction: proposal ${taskId} already "${currentStatus}" — skipping update`);
      }

      // Update the Slack message to show the result in-place
      const updatedBlocks = markTaskInBlocks(
        payload.message.blocks,
        taskId,
        newStatus
      );

      await postToResponseUrl(responseUrl, {
        replace_original: true,
        text: payload.message.text ?? "Tasks updated",
        blocks: updatedBlocks,
      });
    } catch (err) {
      logger.error("slackInteraction: approve/reject failed", {
        error: (err as Error).message,
        taskId,
        meetingId,
      });
    }
  }
);

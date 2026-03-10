import * as admin from "firebase-admin";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { ProposalDocument } from "../models/proposal";
import { UserDocument } from "../models/user";
import { getValidAccessToken } from "../auth";
import { generateApprovalToken } from "../services/approvalTokens";
import { routeNotification } from "../services/notifications/notificationRouter";

const db = () => admin.firestore();
const APP_URL = () => process.env.APP_URL ?? "https://taskbot-fb10d.web.app";

/**
 * Firestore-triggered Cloud Function: notifyUsers
 *
 * Fires whenever a processedTranscripts document is updated.
 * Only acts when the status transitions to "proposed" — the moment
 * processTranscript has finished writing all proposals to Firestore.
 *
 * Uses the detectedByUid user's stored OAuth tokens to send notification
 * emails via the Gmail API. No SMTP credentials required.
 *
 * For each unique assignee who has pending proposals for this meeting:
 *   1. Generates a secure, single-use approval token (48 h TTL)
 *   2. Builds a review link: APP_URL/review?token=<token>
 *   3. Sends a notification email via the organizer's Gmail
 *
 * Failures for individual assignees are logged but do not fail the function
 * or block other assignees from being notified.
 */
export const notifyUsers = onDocumentUpdated(
  {
    document: "processedTranscripts/{meetingId}",
    region: "us-central1",
    // Gmail API sends + Slack + org-defaults Firestore read per attendee.
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (event) => {
    const before = event.data?.before.data() as ProcessedTranscriptDocument | undefined;
    const after = event.data?.after.data() as ProcessedTranscriptDocument | undefined;

    if (!before || !after) return;

    // ── Guard: only act on the transition to "proposed" ─────────────────────
    if (before.status === after.status || after.status !== "proposed") {
      return;
    }

    const meetingId = event.params.meetingId;

    logger.info(
      `notifyUsers: status → "proposed" for meeting "${after.meetingTitle}" (${meetingId})`
    );

    // ── Get sender credentials (the user who detected the transcript) ────────
    // Their OAuth tokens are used to call the Gmail API on behalf of the organizer.
    let senderAccessToken: string;
    let senderEmail: string;

    try {
      senderAccessToken = await getValidAccessToken(after.detectedByUid);

      const senderSnap = await db().collection("users").doc(after.detectedByUid).get();
      if (!senderSnap.exists) {
        throw new Error(`No user document for detectedByUid ${after.detectedByUid}`);
      }
      senderEmail = (senderSnap.data() as UserDocument).email;
    } catch (err) {
      logger.error("notifyUsers: cannot get sender credentials — aborting", {
        error: (err as Error).message,
        detectedByUid: after.detectedByUid,
      });
      return;
    }

    // ── Fetch all pending proposals for this meeting ─────────────────────────
    const proposalsSnap = await db()
      .collection("proposals")
      .doc(meetingId)
      .collection("tasks")
      .where("status", "==", "pending")
      .get();

    if (proposalsSnap.empty) {
      logger.info(`notifyUsers: no pending proposals for ${meetingId} — nothing to notify`);
      return;
    }

    // ── Group proposals by assignee ──────────────────────────────────────────
    const byAssignee = new Map<string, Array<ProposalDocument & { id: string }>>();
    for (const doc of proposalsSnap.docs) {
      const proposal = { id: doc.id, ...(doc.data() as ProposalDocument) };
      const group = byAssignee.get(proposal.assigneeUid) ?? [];
      group.push(proposal);
      byAssignee.set(proposal.assigneeUid, group);
    }

    logger.info(
      `notifyUsers: ${proposalsSnap.size} proposal(s) across ${byAssignee.size} assignee(s) — ` +
      `sending via ${senderEmail}`
    );

    // ── Notify each assignee independently ──────────────────────────────────
    const results = await Promise.allSettled(
      Array.from(byAssignee.entries()).map(async ([uid, proposals]) => {
        const userSnap = await db().collection("users").doc(uid).get();

        if (!userSnap.exists) {
          logger.warn(`notifyUsers: no user document for uid ${uid} — skipping`);
          return;
        }

        const user = userSnap.data() as UserDocument;

        if (!user.isActive) {
          logger.info(`notifyUsers: user ${uid} is inactive — skipping`);
          return;
        }

        const expiryHours = user.preferences?.proposalExpiryHours ?? 48;

        const token = await generateApprovalToken(uid, meetingId, expiryHours);
        const reviewLink = `${APP_URL()}/review?token=${token}`;
        const approveAllLink = `${APP_URL()}/review?token=${token}&action=approve_all`;

        await routeNotification({
          uid,
          user,
          proposals,
          meetingTitle: after.meetingTitle,
          meetingId,
          reviewLink,
          approveAllLink,
          expiryHours,
          senderAccessToken,
          senderEmail,
        });

        logger.info(
          `notifyUsers: notified ${user.email} — ` +
          `${proposals.length} proposal(s) for meeting ${meetingId}`
        );
      })
    );

    // Log per-assignee failures without failing the whole function
    const failures = results.filter((r) => r.status === "rejected");
    for (const result of failures) {
      logger.error("notifyUsers: failed to notify one assignee", {
        error: (result as PromiseRejectedResult).reason?.message ?? "unknown error",
      });
    }

    logger.info(
      `notifyUsers: done — ${results.length - failures.length} sent, ${failures.length} failed`
    );
  }
);

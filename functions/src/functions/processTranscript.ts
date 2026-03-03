import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { ProposalDocument } from "../models/proposal";
import { MeetingContext } from "../models/aiExtraction";
import { UserDocument } from "../models/user";
import { getValidAccessToken } from "../auth";
import { getTranscriptContent } from "../services/drive";
import { getUserByEmail } from "../services/firestore";
import { extractTasksFromTranscript } from "../services/aiExtractor";

const db = () => admin.firestore();

/**
 * Firestore-triggered Cloud Function: processTranscript
 *
 * Fires whenever a new document is created in processedTranscripts/.
 * Runs the full AI extraction pipeline and fans out proposals to assignees.
 *
 * Pipeline stages (reflected in processedTranscripts.status):
 *   pending     → [this function claims it]
 *   processing  → Fetching transcript content from Drive
 *   extracting  → Calling the AI extraction engine
 *   proposed    → Proposals written to proposals/{meetingId}/tasks/
 *   completed   → Zero tasks found (valid — not every meeting has action items)
 *   failed      → Unrecoverable error; error field contains the message
 *
 * Idempotency: a Firestore transaction atomically checks and updates the
 * status from "pending" → "processing". If the function fires twice for the
 * same document, the second invocation exits immediately.
 */
export const processTranscript = onDocumentCreated(
  { document: "processedTranscripts/{meetingId}", region: "us-central1" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const meetingId = event.params.meetingId;
    const docRef = snap.ref;
    const transcriptDoc = snap.data() as ProcessedTranscriptDocument;

    // ── Guard: skip non-pending documents ─────────────────────────────────
    if (transcriptDoc.status !== "pending") {
      logger.info(
        `processTranscript: skipping ${meetingId} — status is "${transcriptDoc.status}"`
      );
      return;
    }

    // ── Atomically claim the document ──────────────────────────────────────
    // Prevents double-processing if the trigger fires more than once.
    const claimed = await db().runTransaction(async (txn) => {
      const current = await txn.get(docRef);
      if (current.data()?.status !== "pending") return false;
      txn.update(docRef, { status: "processing" });
      return true;
    });

    if (!claimed) {
      logger.info(`processTranscript: ${meetingId} already claimed by another invocation`);
      return;
    }

    logger.info(`processTranscript: starting pipeline for meeting "${transcriptDoc.meetingTitle}" (${meetingId})`);

    try {
      // ── Step 1: Fetch transcript text from Drive ───────────────────────
      logger.info(`processTranscript: fetching transcript from Drive (file ${meetingId})`);

      let accessToken: string;
      try {
        accessToken = await getValidAccessToken(transcriptDoc.detectedByUid);
      } catch (err) {
        throw new Error(
          `Could not get access token for detecting user ${transcriptDoc.detectedByUid}: ` +
          (err as Error).message
        );
      }

      const transcriptText = await getTranscriptContent(accessToken, transcriptDoc.driveFileId);

      if (!transcriptText.trim()) {
        throw new Error("Transcript file is empty or could not be read.");
      }

      // ── Step 2: Build MeetingContext from stored attendee data ─────────
      await docRef.update({ status: "extracting" });

      // Resolve attendee emails to display names using the users collection
      const attendeeUserDocs = (
        await Promise.all(
          transcriptDoc.attendeeEmails.map((email) => getUserByEmail(email))
        )
      ).filter((u): u is UserDocument => u !== null);

      const attendeeNames = attendeeUserDocs.length > 0
        ? attendeeUserDocs.map((u) => u.displayName || u.email)
        : transcriptDoc.attendeeEmails; // fall back to raw emails if no user docs found

      // Derive the meeting date from detectedAt (best approximation without Calendar data)
      const meetingDate = transcriptDoc.detectedAt.toDate().toISOString().split("T")[0];

      const context: MeetingContext = {
        meetingTitle: transcriptDoc.meetingTitle,
        attendeeNames,
        meetingDate,
      };

      // ── Step 3: Run AI extraction ──────────────────────────────────────
      logger.info(
        `processTranscript: running AI extraction for "${transcriptDoc.meetingTitle}" ` +
        `(${attendeeNames.length} known attendee(s), ${transcriptText.length} chars)`
      );

      const extractedTasks = await extractTasksFromTranscript(transcriptText, context);

      logger.info(`processTranscript: AI returned ${extractedTasks.length} task(s)`);

      // ── Step 4: Handle zero-task result ───────────────────────────────
      if (extractedTasks.length === 0) {
        await docRef.update({
          status: "completed",
          error: "No action items found in this transcript.",
        });
        logger.info(`processTranscript: no tasks found for ${meetingId} — marking completed`);
        return;
      }

      // ── Step 5: Fan out proposals to matched, active users ─────────────
      const proposalsBase = db().collection("proposals").doc(meetingId).collection("tasks");
      const batch = db().batch();
      let proposalCount = 0;
      let skippedCount = 0;

      for (const task of extractedTasks) {
        // Skip tasks with no assignee email
        if (!task.assigneeEmail) {
          logger.info(
            `processTranscript: task "${task.title}" has no assignee email — skipping`
          );
          skippedCount++;
          continue;
        }

        // Look up the assignee in our users collection
        const assigneeUser = await getUserByEmail(task.assigneeEmail);

        if (!assigneeUser) {
          logger.info(
            `processTranscript: no registered user found for "${task.assigneeEmail}" ` +
            `(task: "${task.title}") — skipping`
          );
          skippedCount++;
          continue;
        }

        if (!assigneeUser.isActive) {
          logger.info(
            `processTranscript: user "${task.assigneeEmail}" is inactive — skipping task "${task.title}"`
          );
          skippedCount++;
          continue;
        }

        // Calculate expiry from the assignee's preferences
        const expiryHours = assigneeUser.preferences?.proposalExpiryHours ?? 48;
        const now = Timestamp.now();
        const expiresAt = Timestamp.fromMillis(now.toMillis() + expiryHours * 60 * 60 * 1000);

        const proposal: ProposalDocument = {
          // From ExtractedTask
          title: task.title,
          description: task.description,
          assigneeEmail: task.assigneeEmail,
          assigneeName: task.assigneeName,
          confidence: task.confidence,
          transcriptExcerpt: task.transcriptExcerpt,
          isSensitive: task.isSensitive,
          suggestedDueDate: task.suggestedDueDate,
          rawAssigneeText: task.rawAssigneeText,
          // Proposal-specific
          meetingId,
          assigneeUid: assigneeUser.uid,
          status: "pending",
          createdAt: now,
          expiresAt,
        };

        // Use the extractor-generated UUID as the document ID
        batch.set(proposalsBase.doc(task.id), proposal);
        proposalCount++;

        logger.info(
          `processTranscript: queued proposal "${task.title}" ` +
          `for ${task.assigneeEmail} (confidence: ${task.confidence})`
        );
      }

      await batch.commit();

      await docRef.update({
        status: "proposed",
        // Store count for observability — add field to doc even though it's not in the model
        // (extra fields are allowed in Firestore)
      } as Partial<ProcessedTranscriptDocument> & Record<string, unknown>);

      logger.info(
        `processTranscript: pipeline complete for ${meetingId} — ` +
        `${proposalCount} proposal(s) created, ${skippedCount} task(s) skipped`
      );

    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      logger.error(`processTranscript: pipeline failed for ${meetingId}`, { error: message });

      // Mark as failed without throwing — throwing would cause the function to retry
      await docRef.update({
        status: "failed",
        error: message,
        // FieldValue.serverTimestamp() for updatedAt is applied by Firestore rules implicitly;
        // we use the Admin SDK here so we set it explicitly if needed
      } as unknown as Partial<ProcessedTranscriptDocument>);
    }
  }
);

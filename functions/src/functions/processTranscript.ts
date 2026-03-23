import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { ProposalDocument } from "../models/proposal";
import { MeetingContext, ExtractedTask } from "../models/aiExtraction";
import { UserDocument } from "../models/user";
import { getValidAccessToken } from "../auth";
import { getTranscriptContent, TranscriptContent } from "../services/drive";
import { getUserByEmail } from "../services/firestore";
import { extractTasksFromTranscript } from "../services/aiExtractor";
import { AIExtractionError, TranscriptNotFoundError } from "../utils/errors";
import { logActivity } from "../services/activityLogger";

const AI_RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  {
    document: "processedTranscripts/{meetingId}",
    region: "us-central1",
    // AI extraction + 30 s retry sleep can easily exceed the 60 s default.
    timeoutSeconds: 300,
    // Large transcripts + Anthropic SDK in memory; 512 MiB is the minimum safe value.
    memory: "1GiB",
  },
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
      txn.update(docRef, { status: "processing", processingStartedAt: FieldValue.serverTimestamp() });
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

      let transcriptContent: TranscriptContent;
      try {
        transcriptContent = await getTranscriptContent(accessToken, transcriptDoc.driveFileId);
      } catch (err) {
        if (err instanceof TranscriptNotFoundError) {
          throw new Error(
            `Transcript file not found in Drive (may have been deleted): ${transcriptDoc.driveFileId}`
          );
        }
        throw err;
      }

      if (!transcriptContent.transcript.trim()) {
        throw new Error("Transcript file is empty or could not be read.");
      }

      logger.info(
        `processTranscript: detected format "${transcriptContent.format}" for ${meetingId}` +
        (transcriptContent.notes ? " (Gemini Notes tab found)" : "")
      );

      // ── Step 2: Build MeetingContext from stored attendee data ─────────
      await docRef.update({ status: "extracting" });

      // Resolve attendee emails to display names using the users collection
      const attendeeUserDocs = (
        await Promise.all(
          transcriptDoc.attendeeEmails.map((email) => getUserByEmail(email))
        )
      ).filter((u): u is UserDocument => u !== null);

      // Format as "Name <email>" so the AI has the email address available
      // and can populate assigneeEmail in the extracted tasks.
      const attendeeNames = attendeeUserDocs.length > 0
        ? attendeeUserDocs.map((u) => `${u.displayName || u.email} <${u.email}>`)
        : transcriptDoc.attendeeEmails; // fall back to raw emails if no user docs found

      // Derive the meeting date from detectedAt (best approximation without Calendar data)
      const meetingDate = transcriptDoc.detectedAt.toDate().toISOString().split("T")[0];

      const context: MeetingContext = {
        meetingTitle: transcriptDoc.meetingTitle,
        attendeeNames,
        meetingDate,
        // Pass Gemini Notes to the AI when present — the extraction prompt uses
        // them as supplementary context while keeping the transcript authoritative.
        ...(transcriptContent.notes ? { geminiNotes: transcriptContent.notes } : {}),
      };

      // ── Step 3: Run AI extraction ──────────────────────────────────────
      logger.info(
        `processTranscript: running AI extraction for "${transcriptDoc.meetingTitle}" ` +
        `(${attendeeNames.length} known attendee(s), ${transcriptContent.transcript.length} chars, ` +
        `format: ${transcriptContent.format})`
      );

      // ── AI extraction with one automatic retry after 30 s ──────────────
      let extractedTasks: ExtractedTask[];
      let tokensUsed: { input: number; output: number } = { input: 0, output: 0 };
      try {
        const firstResult = await extractTasksFromTranscript(
          transcriptContent.transcript, context, transcriptDoc.detectedByUid
        );
        extractedTasks = firstResult.tasks;
        tokensUsed = firstResult.tokensUsed;
      } catch (firstErr) {
        if (firstErr instanceof AIExtractionError) {
          logger.warn(
            `processTranscript: AI extraction failed for ${meetingId} — retrying in 30s`,
            { error: (firstErr as Error).message }
          );
          await sleep(AI_RETRY_DELAY_MS);
          // Let this throw to the outer catch if it fails again
          const retryResult = await extractTasksFromTranscript(
            transcriptContent.transcript, context, transcriptDoc.detectedByUid
          );
          extractedTasks = retryResult.tasks;
          tokensUsed = retryResult.tokensUsed;
        } else {
          throw firstErr;
        }
      }

      logger.info(`processTranscript: AI returned ${extractedTasks.length} task(s)`);

      // ── Step 4: Handle zero-task result ───────────────────────────────
      if (extractedTasks.length === 0) {
        await docRef.update({
          status: "completed",
          error: "No action items found in this transcript.",
        });
        logger.info(`processTranscript: no tasks found for ${meetingId} — marking completed`);
        await logActivity("meeting_processed",
          `Meeting "${transcriptDoc.meetingTitle}" processed — no action items found`,
          { meetingId, userId: transcriptDoc.detectedByUid, taskCount: 0 }
        );
        return;
      }

      // ── Step 5: Fan out proposals to matched, active users ─────────────
      const proposalsBase = db().collection("proposals").doc(meetingId).collection("tasks");

      // Clear any existing proposals before writing — makes the pipeline
      // idempotent if the same transcript is reprocessed (e.g. during testing).
      const existingProposals = await proposalsBase.get();
      if (!existingProposals.empty) {
        const clearBatch = db().batch();
        existingProposals.docs.forEach((d) => clearBatch.delete(d.ref));
        await clearBatch.commit();
        logger.info(
          `processTranscript: cleared ${existingProposals.size} existing proposal(s) for ${meetingId}`
        );
      }

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
          sharedWith: task.sharedWith ?? [],
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
        transcriptFormat: transcriptContent.format,
        hasNotes: !!transcriptContent.notes,
        tokensUsed,
      } as Partial<ProcessedTranscriptDocument> & Record<string, unknown>);

      logger.info(
        `processTranscript: pipeline complete for ${meetingId} — ` +
        `${proposalCount} proposal(s) created, ${skippedCount} task(s) skipped`
      );

      await logActivity("meeting_processed",
        `Meeting "${transcriptDoc.meetingTitle}" processed — ${proposalCount} task${proposalCount !== 1 ? "s" : ""} extracted`,
        { meetingId, userId: transcriptDoc.detectedByUid, taskCount: proposalCount }
      );

    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      logger.error(`processTranscript: pipeline failed for ${meetingId}`, { error: message });

      // If the error is "Secret not found" (AI credentials not yet configured),
      // use a specific status so the admin can see why the transcript is stuck.
      const isUnconfigured = message.includes("Secret") && message.includes("not found");
      const newStatus = isUnconfigured ? "awaiting_configuration" : "failed";

      // Mark as failed/awaiting without throwing — throwing causes retries
      await docRef.update({
        status: newStatus,
        error: isUnconfigured
          ? "AI provider not configured. An admin needs to set up AI credentials in Admin > Settings."
          : message,
      } as unknown as Partial<ProcessedTranscriptDocument>);
    }
  }
);

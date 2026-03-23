import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { MeetingContext, ExtractedTask } from "../models/aiExtraction";
import { getValidAccessToken } from "../auth";
import { getTranscriptContent, TranscriptContent } from "../services/drive";
import { getUserByEmail } from "../services/firestore";
import { UserDocument } from "../models/user";
import { extractTasksFromTranscript } from "../services/aiExtractor";
import { AIExtractionError, TranscriptNotFoundError } from "../utils/errors";
import { logActivity } from "../services/activityLogger";
import { fanOutProposals } from "../services/proposalWriter";

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
      let needsDedup = false;
      try {
        const firstResult = await extractTasksFromTranscript(
          transcriptContent.transcript, context, transcriptDoc.detectedByUid
        );
        extractedTasks = firstResult.tasks;
        tokensUsed = firstResult.tokensUsed;
        needsDedup = firstResult.needsDedup;
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
          needsDedup = retryResult.needsDedup;
        } else {
          throw firstErr;
        }
      }

      logger.info(`processTranscript: AI returned ${extractedTasks.length} task(s)`);

      // ── Step 4a: Defer dedup to scheduler (multi-chunk transcripts) ────
      // Saves raw tasks to Firestore and exits. The dedupTranscripts scheduler
      // will pick this up after dedupAfter and complete the pipeline.
      if (needsDedup) {
        const dedupAfter = Timestamp.fromMillis(Date.now() + 60_000);
        await docRef.update({
          status: "dedup_pending",
          rawTasks: extractedTasks,
          dedupAfter,
          tokensUsed,
          transcriptFormat: transcriptContent.format,
          hasNotes: !!transcriptContent.notes,
        } as Partial<ProcessedTranscriptDocument> & Record<string, unknown>);
        logger.info(
          `processTranscript: ${extractedTasks.length} raw task(s) saved for ${meetingId} — ` +
          `dedup deferred until ${dedupAfter.toDate().toISOString()}`
        );
        return;
      }

      // ── Step 4b: Handle zero-task result ──────────────────────────────
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
      const { proposalCount, skippedCount } = await fanOutProposals(
        meetingId, transcriptDoc, extractedTasks, docRef, tokensUsed,
        { transcriptFormat: transcriptContent.format, hasNotes: !!transcriptContent.notes }
      );

      logger.info(
        `processTranscript: pipeline complete for ${meetingId} — ` +
        `${proposalCount} proposal(s) created, ${skippedCount} task(s) skipped`
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

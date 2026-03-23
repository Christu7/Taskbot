import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { ExtractedTask } from "../models/aiExtraction";
import { getAIProviderForUser, getAIProvider } from "../services/aiProvider";
import { validateAndNormaliseTasks } from "../services/aiExtractor";
import { fanOutProposals } from "../services/proposalWriter";
import { logActivity } from "../services/activityLogger";

const db = () => admin.firestore();

/**
 * Scheduled Cloud Function: dedupTranscripts
 *
 * Runs every 2 minutes. Picks up processedTranscripts documents with
 * status "dedup_pending" where dedupAfter < now, runs the AI dedup call,
 * and fans out proposals — completing the pipeline for chunked transcripts.
 *
 * The 60-second gap between chunk processing and dedup is enforced via
 * dedupAfter rather than a sleep(), preventing Cloud Run instance recycling
 * from killing the wait.
 */
export const dedupTranscripts = onSchedule(
  {
    schedule: "every 2 minutes",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const now = Timestamp.now();

    const snap = await db()
      .collection("processedTranscripts")
      .where("status", "==", "dedup_pending")
      .where("dedupAfter", "<=", now)
      .get();

    if (snap.empty) {
      logger.debug("dedupTranscripts: no documents ready for dedup");
      return;
    }

    logger.info(`dedupTranscripts: ${snap.docs.length} document(s) ready for dedup`);

    // Process sequentially to avoid hammering the AI API concurrently
    for (const doc of snap.docs) {
      await processDedupDoc(doc);
    }
  }
);

async function processDedupDoc(
  doc: admin.firestore.QueryDocumentSnapshot
): Promise<void> {
  const meetingId = doc.id;
  const docRef = doc.ref;

  // ── Atomically claim the document ──────────────────────────────────────────
  const claimed = await db().runTransaction(async (txn) => {
    const current = await txn.get(docRef);
    if (current.data()?.status !== "dedup_pending") return false;
    txn.update(docRef, {
      status: "deduplicating",
      processingStartedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (!claimed) {
    logger.info(`dedupTranscripts: ${meetingId} already claimed — skipping`);
    return;
  }

  const transcriptDoc = doc.data() as ProcessedTranscriptDocument;

  logger.info(
    `dedupTranscripts: running dedup for "${transcriptDoc.meetingTitle}" ` +
    `(${meetingId}, ${(transcriptDoc.rawTasks ?? []).length} raw task(s))`
  );

  try {
    const rawTasks = (transcriptDoc.rawTasks ?? []) as ExtractedTask[];
    const chunkTokensUsed = transcriptDoc.tokensUsed ?? { input: 0, output: 0 };

    // ── Run dedup ────────────────────────────────────────────────────────────
    const provider = transcriptDoc.detectedByUid
      ? await getAIProviderForUser(transcriptDoc.detectedByUid)
      : await getAIProvider();

    const dedupResult = await provider.deduplicateTasks(rawTasks);

    const totalTokensUsed = {
      input: chunkTokensUsed.input + dedupResult.tokensUsed.input,
      output: chunkTokensUsed.output + dedupResult.tokensUsed.output,
    };

    const finalTasks = validateAndNormaliseTasks(dedupResult.tasks as unknown[]);

    logger.info(
      `dedupTranscripts: dedup complete for ${meetingId} — ` +
      `${rawTasks.length} → ${finalTasks.length} task(s)`
    );

    // ── Zero-task result ─────────────────────────────────────────────────────
    if (finalTasks.length === 0) {
      await docRef.update({
        status: "completed",
        error: "No action items found in this transcript.",
        rawTasks: FieldValue.delete(),
        dedupAfter: FieldValue.delete(),
        tokensUsed: totalTokensUsed,
      } as Record<string, unknown>);
      logger.info(`dedupTranscripts: no tasks after dedup for ${meetingId} — marking completed`);
      await logActivity("meeting_processed",
        `Meeting "${transcriptDoc.meetingTitle}" processed — no action items found`,
        { meetingId, userId: transcriptDoc.detectedByUid, taskCount: 0 }
      );
      return;
    }

    // ── Fan out proposals ────────────────────────────────────────────────────
    const { proposalCount, skippedCount } = await fanOutProposals(
      meetingId, transcriptDoc, finalTasks, docRef, totalTokensUsed,
      {
        transcriptFormat: transcriptDoc.transcriptFormat,
        hasNotes: transcriptDoc.hasNotes,
      }
    );

    logger.info(
      `dedupTranscripts: pipeline complete for ${meetingId} — ` +
      `${proposalCount} proposal(s) created, ${skippedCount} task(s) skipped`
    );
  } catch (err) {
    const message = (err as Error).message ?? "Unknown error";
    logger.error(`dedupTranscripts: failed for ${meetingId}`, { error: message });

    const isUnconfigured = message.includes("Secret") && message.includes("not found");
    await docRef.update({
      status: isUnconfigured ? "awaiting_configuration" : "failed",
      error: isUnconfigured
        ? "AI provider not configured. An admin needs to set up AI credentials in Admin > Settings."
        : message,
    } as Record<string, unknown>);
  }
}

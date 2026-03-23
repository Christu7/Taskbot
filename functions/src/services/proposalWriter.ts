import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { ExtractedTask } from "../models/aiExtraction";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { ProposalDocument } from "../models/proposal";
import { getUserByEmail } from "./firestore";
import { logActivity } from "./activityLogger";

const db = () => admin.firestore();

/**
 * Fans out proposal documents for a set of extracted tasks and marks the
 * processedTranscripts document as "proposed".
 *
 * Used by both processTranscript (single-chunk path) and dedupTranscripts
 * (multi-chunk path, after dedup completes).
 *
 * @param meetingId     - processedTranscripts document ID (= Drive file ID)
 * @param transcriptDoc - Full contents of the processedTranscripts document
 * @param tasks         - Final validated + deduplicated task list
 * @param docRef        - Reference to the processedTranscripts document
 * @param tokensUsed    - Cumulative token counts across all AI calls
 * @param metadata      - Optional transcript format fields written to the doc
 * @returns Counts of proposals created and tasks skipped (for caller logging)
 */
export async function fanOutProposals(
  meetingId: string,
  transcriptDoc: ProcessedTranscriptDocument,
  tasks: ExtractedTask[],
  docRef: admin.firestore.DocumentReference,
  tokensUsed: { input: number; output: number },
  metadata: {
    transcriptFormat?: "plain_transcript" | "gemini_notes";
    hasNotes?: boolean;
  } = {}
): Promise<{ proposalCount: number; skippedCount: number }> {
  const proposalsBase = db().collection("proposals").doc(meetingId).collection("tasks");

  // Clear any existing proposals — makes the pipeline idempotent on reprocessing
  const existingProposals = await proposalsBase.get();
  if (!existingProposals.empty) {
    const clearBatch = db().batch();
    existingProposals.docs.forEach((d) => clearBatch.delete(d.ref));
    await clearBatch.commit();
    logger.info(`proposalWriter: cleared ${existingProposals.size} existing proposal(s) for ${meetingId}`);
  }

  const batch = db().batch();
  let proposalCount = 0;
  let skippedCount = 0;

  for (const task of tasks) {
    if (!task.assigneeEmail) {
      logger.info(`proposalWriter: task "${task.title}" has no assignee email — skipping`);
      skippedCount++;
      continue;
    }

    const assigneeUser = await getUserByEmail(task.assigneeEmail);

    if (!assigneeUser) {
      logger.info(
        `proposalWriter: no registered user found for "${task.assigneeEmail}" ` +
        `(task: "${task.title}") — skipping`
      );
      skippedCount++;
      continue;
    }

    if (!assigneeUser.isActive) {
      logger.info(`proposalWriter: user "${task.assigneeEmail}" is inactive — skipping task "${task.title}"`);
      skippedCount++;
      continue;
    }

    const expiryHours = assigneeUser.preferences?.proposalExpiryHours ?? 48;
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(now.toMillis() + expiryHours * 60 * 60 * 1000);

    const proposal: ProposalDocument = {
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
      meetingId,
      assigneeUid: assigneeUser.uid,
      status: "pending",
      createdAt: now,
      expiresAt,
    };

    batch.set(proposalsBase.doc(task.id), proposal);
    proposalCount++;

    logger.info(
      `proposalWriter: queued proposal "${task.title}" ` +
      `for ${task.assigneeEmail} (confidence: ${task.confidence})`
    );
  }

  await batch.commit();

  await docRef.update({
    status: "proposed",
    tokensUsed,
    ...(metadata.transcriptFormat !== undefined && { transcriptFormat: metadata.transcriptFormat }),
    ...(metadata.hasNotes !== undefined && { hasNotes: metadata.hasNotes }),
    rawTasks: admin.firestore.FieldValue.delete(),
    dedupAfter: admin.firestore.FieldValue.delete(),
  } as Record<string, unknown>);

  await logActivity(
    "meeting_processed",
    `Meeting "${transcriptDoc.meetingTitle}" processed — ${proposalCount} task${proposalCount !== 1 ? "s" : ""} extracted`,
    { meetingId, userId: transcriptDoc.detectedByUid, taskCount: proposalCount }
  );

  return { proposalCount, skippedCount };
}

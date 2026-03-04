import * as admin from "firebase-admin";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { getValidAccessToken } from "../auth";
import { ensureTaskList, createGoogleTask } from "../services/googleTasks";
import { ProposalDocument } from "../models/proposal";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";

const db = () => admin.firestore();

/**
 * Firestore-triggered Cloud Function: taskCreator
 *
 * Fires when a proposal document is updated. Only acts on transitions
 * into "approved" status (i.e. the user just approved or edited+approved
 * a proposal from the review page).
 *
 * Steps:
 *   1. Guard: skip unless this is a non-approved → approved transition
 *   2. Fetch meeting metadata from the parent processedTranscripts document
 *   3. Get a valid access token for the assignee
 *   4. Ensure the "TaskBot" task list exists in the assignee's Google Tasks
 *   5. Create the task via Google Tasks API
 *   6. Update the proposal: status → "created", googleTaskId set
 *
 * On any failure: sets status → "failed" and stores the error message so
 * the user can retry from the web app.
 */
export const taskCreator = onDocumentUpdated(
  { document: "proposals/{meetingId}/tasks/{taskId}", region: "us-central1" },
  async (event) => {
    const before = event.data?.before.data() as ProposalDocument | undefined;
    const after  = event.data?.after.data()  as ProposalDocument | undefined;
    if (!before || !after) return;

    // Only act on the transition into "approved"
    if (before.status === "approved" || after.status !== "approved") return;

    // Idempotency guard: skip if already created
    if (after.googleTaskId) return;

    const { meetingId, taskId } = event.params;
    const {
      assigneeUid,
      title,
      description,
      editedTitle,
      editedDescription,
      suggestedDueDate,
      editedDueDate,
    } = after;

    const docRef = db()
      .collection("proposals")
      .doc(meetingId)
      .collection("tasks")
      .doc(taskId);

    try {
      // ── Step 1: Fetch meeting metadata ────────────────────────────────────
      const transcriptSnap = await db()
        .collection("processedTranscripts")
        .doc(meetingId)
        .get();

      const transcript = transcriptSnap.data() as ProcessedTranscriptDocument | undefined;
      const meetingTitle = transcript?.meetingTitle ?? meetingId;
      const driveFileLink = transcript?.driveFileLink ?? "";

      const detectedAt = transcript?.detectedAt;
      const meetingDate = detectedAt
        ? new Date(detectedAt.seconds * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";

      // ── Step 2: Get a valid access token for the assignee ─────────────────
      const accessToken = await getValidAccessToken(assigneeUid);

      // ── Step 3: Ensure the "TaskBot" task list exists ─────────────────────
      const listId = await ensureTaskList(accessToken, assigneeUid);

      // ── Step 4: Build task content ────────────────────────────────────────
      const finalTitle = editedTitle || title;
      const finalDesc  = editedDescription || description;

      const sourceLines: string[] = [];
      if (driveFileLink) sourceLines.push(`Source: ${driveFileLink}`);
      sourceLines.push(
        `Extracted by TaskBot from: ${meetingTitle}${meetingDate ? ` (${meetingDate})` : ""}`
      );

      const notes = [finalDesc, "", "---", ...sourceLines].join("\n");

      // ── Step 5: Create the task in Google Tasks ───────────────────────────
      const googleTaskId = await createGoogleTask(accessToken, listId, {
        title: finalTitle,
        notes,
        // editedDueDate (user override) takes precedence over the AI-suggested date
        due: editedDueDate !== undefined ? (editedDueDate ?? null) : (suggestedDueDate ?? null),
      });

      // ── Step 6: Update proposal to "created" ──────────────────────────────
      await docRef.update({
        status: "created",
        googleTaskId,
        failureReason: FieldValue.delete(),
      });

      logger.info(
        `taskCreator: created Google Task ${googleTaskId} for proposal ${taskId} ` +
        `in meeting ${meetingId} (assignee ${assigneeUid})`
      );
    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      logger.error(
        `taskCreator: failed for proposal ${taskId} in meeting ${meetingId}`,
        { error: message, assigneeUid }
      );
      await docRef.update({ status: "failed", failureReason: message });
    }
  }
);

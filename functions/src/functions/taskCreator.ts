import * as admin from "firebase-admin";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { getValidAccessToken } from "../auth";
import { routeTask } from "../services/taskDestinations/taskRouter";
import { ProposalDocument } from "../models/proposal";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { logActivity } from "../services/activityLogger";

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
 *   4. Route the task to all configured destinations via taskRouter
 *   5. Update the proposal: status → "created", externalRefs set
 *
 * On any failure: sets status → "failed" and stores the error message so
 * the user can retry from the web app.
 */
export const taskCreator = onDocumentUpdated(
  {
    document: "proposals/{meetingId}/tasks/{taskId}",
    region: "us-central1",
    // Google Tasks + Asana API calls; Asana fallback warning email adds a Gmail send.
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (event) => {
    const before = event.data?.before.data() as ProposalDocument | undefined;
    const after  = event.data?.after.data()  as ProposalDocument | undefined;
    if (!before || !after) return;

    // Only act on the transition into "approved"
    if (before.status === "approved" || after.status !== "approved") return;

    // Idempotency guard: skip if already created
    if (after.externalRefs?.length || after.googleTaskId) return;

    const { meetingId, taskId } = event.params;
    const {
      assigneeUid,
      title,
      description,
      editedTitle,
      editedDescription,
      suggestedDueDate,
      editedDueDate,
      asanaProjectId,
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

      // ── Step 3: Build canonical TaskData ─────────────────────────────────
      const finalTitle = editedTitle || title;
      const finalDesc  = editedDescription || description;
      const dueDate    = editedDueDate !== undefined
        ? (editedDueDate ?? undefined)
        : (suggestedDueDate ?? undefined);

      const taskData = {
        title: finalTitle,
        description: finalDesc,
        ...(dueDate ? { dueDate } : {}),
        sourceLink: driveFileLink,
        meetingTitle,
        meetingDate,
        ...(asanaProjectId ? { asanaProjectId } : {}),
      };

      // ── Step 4: Route to all configured destinations ──────────────────────
      const tokens = { accessToken, uid: assigneeUid };
      const externalRefs = await routeTask(assigneeUid, taskData, tokens);

      // ── Step 5: Update proposal to "created" ──────────────────────────────
      await docRef.update({
        status: "created",
        externalRefs,
        failureReason: FieldValue.delete(),
        localUpdatedAt: FieldValue.serverTimestamp(),
        syncStatus: "synced",
        lastSyncedAt: FieldValue.serverTimestamp(),
      });

      await logActivity("task_approved",
        `Task "${finalTitle}" approved for meeting "${meetingTitle}"`,
        { meetingId, userId: assigneeUid }
      );

      logger.info(
        `taskCreator: created tasks for proposal ${taskId} in meeting ${meetingId} ` +
        `(assignee ${assigneeUid}) → ${externalRefs.map((r) => `${r.destination}:${r.externalId}`).join(", ")}`
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

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

// Initialize Firebase Admin SDK
admin.initializeApp();

// ─── Health Check ─────────────────────────────────────────────────────────────
// GET https://<region>-<project>.cloudfunctions.net/healthCheck
export const healthCheck = functions
  .region("us-central1")
  .https.onRequest((req, res) => {
    res.status(200).json({
      status: "ok",
      message: "TaskBot functions are running",
      timestamp: new Date().toISOString(),
    });
  });

// ─── Example: Task Created Trigger ────────────────────────────────────────────
// Fires whenever a new task document is created in Firestore
export const onTaskCreated = functions
  .region("us-central1")
  .firestore.document("tasks/{taskId}")
  .onCreate(async (snap, context) => {
    const task = snap.data();
    const taskId = context.params.taskId;

    functions.logger.info(`New task created: ${taskId}`, { task });

    // TODO: Add business logic here (e.g. send notifications, assign owners)
    return null;
  });

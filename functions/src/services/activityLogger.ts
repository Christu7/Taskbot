import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

export type ActivityType =
  | "meeting_processed"
  | "tasks_created"
  | "notifications_sent"
  | "user_joined"
  | "sync_complete"
  | "reprocess_triggered"
  | "task_approved";

export interface ActivityMetadata {
  userId?: string;
  meetingId?: string;
  [key: string]: unknown;
}

/**
 * Logs an activity entry to the activityLog collection.
 * Non-fatal — errors are logged but never rethrown so callers are never blocked.
 * Probabilistically prunes entries older than 1000 (10% chance per call).
 */
export async function logActivity(
  type: ActivityType,
  message: string,
  metadata: ActivityMetadata = {}
): Promise<void> {
  const db = admin.firestore();
  try {
    const { userId, meetingId, ...rest } = metadata;
    const entry: Record<string, unknown> = {
      type,
      message,
      timestamp: FieldValue.serverTimestamp(),
    };
    if (userId) entry.userId = userId;
    if (meetingId) entry.meetingId = meetingId;
    if (Object.keys(rest).length) entry.metadata = rest;

    await db.collection("activityLog").add(entry);

    // 10% chance: prune to last 1000 entries
    if (Math.random() < 0.1) {
      const snap = await db.collection("activityLog")
        .orderBy("timestamp", "asc")
        .limit(200)
        .get();
      if (snap.size === 200) {
        // Check approximate total — if we got 200 oldest, delete them conditionally
        const countSnap = await db.collection("activityLog").count().get();
        const total = countSnap.data().count;
        if (total > 1000) {
          const toDelete = Math.min(total - 1000, snap.size);
          const batch = db.batch();
          snap.docs.slice(0, toDelete).forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
    }
  } catch (err) {
    logger.warn("activityLogger: failed to write activity log", {
      type,
      message,
      error: (err as Error).message,
    });
  }
}

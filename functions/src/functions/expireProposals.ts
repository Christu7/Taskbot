import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

const db = () => admin.firestore();

/** Maximum documents per Firestore batch write. */
const BATCH_SIZE = 500;

/**
 * Scheduled Cloud Function: expireProposals
 *
 * Runs every hour. Queries all pending proposals whose expiresAt timestamp
 * is in the past and transitions them to "expired" status.
 *
 * Expired proposals are a historical record only — they are never sent to
 * Google Tasks. Users who want to act on an expired proposal must ask the
 * meeting organiser to re-run the pipeline.
 */
export const expireProposals = onSchedule(
  { schedule: "every 60 minutes", region: "us-central1" },
  async () => {
    const now = Timestamp.now();

    const snap = await db()
      .collectionGroup("tasks")
      .where("status", "==", "pending")
      .where("expiresAt", "<", now)
      .get();

    if (snap.empty) {
      logger.info("expireProposals: no proposals to expire");
      return;
    }

    // Commit in batches to stay within the 500-document Firestore limit
    let expired = 0;
    for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
      const batch = db().batch();
      snap.docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
        batch.update(doc.ref, { status: "expired" });
      });
      await batch.commit();
      expired += snap.docs.slice(i, i + BATCH_SIZE).length;
    }

    logger.info(`expireProposals: expired ${expired} proposal(s)`);
  }
);

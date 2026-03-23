import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

const db = () => admin.firestore();

/** Maximum documents per Firestore batch write. */
const BATCH_SIZE = 500;

/** Terminal proposal statuses eligible for 30-day archival. */
const ARCHIVABLE_STATUSES = new Set(["rejected", "created", "expired", "failed"]);

/**
 * Scheduled Cloud Function: expireProposals
 *
 * Runs every hour. Performs four cleanup tasks:
 *
 * 1. Expire pending proposals whose expiresAt timestamp is in the past.
 * 2. Delete expired approval tokens (single-use email links past their TTL).
 * 3. Archive resolved proposals older than 30 days (status → "archived")
 *    so the active queries stay fast.
 * 4. Reset transcripts stuck in "processing" for more than 15 minutes.
 *    These indicate a function crash mid-pipeline; they are marked "failed"
 *    so admins can reprocess them from the Meetings tab.
 */
export const expireProposals = onSchedule(
  {
    schedule: "every 60 minutes",
    region: "us-central1",
    // Batched Firestore reads + writes across potentially large collections.
    timeoutSeconds: 300,
  },
  async () => {
    const now = Timestamp.now();

    await Promise.allSettled([
      expirePendingProposals(now),
      deleteExpiredTokens(now),
      archiveOldProposals(),
      resetStuckTranscripts(now),
    ]);
  }
);

// ─── Task 1: Expire pending proposals ────────────────────────────────────────

async function expirePendingProposals(now: Timestamp): Promise<void> {
  const snap = await db()
    .collectionGroup("tasks")
    .where("status", "==", "pending")
    .where("expiresAt", "<", now)
    .get();

  if (snap.empty) {
    logger.info("expireProposals: no proposals to expire");
    return;
  }

  let expired = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = db().batch();
    snap.docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
      batch.update(doc.ref, { status: "expired" });
    });
    await batch.commit();
    expired += Math.min(BATCH_SIZE, snap.docs.length - i);
  }

  logger.info(`expireProposals: expired ${expired} proposal(s)`);
}

// ─── Task 2: Delete expired approval tokens ───────────────────────────────────

async function deleteExpiredTokens(now: Timestamp): Promise<void> {
  const snap = await db()
    .collection("approvalTokens")
    .where("expiresAt", "<", now)
    .get();

  if (snap.empty) {
    logger.info("expireProposals: no expired approval tokens to delete");
    return;
  }

  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = db().batch();
    snap.docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    deleted += Math.min(BATCH_SIZE, snap.docs.length - i);
  }

  logger.info(`expireProposals: deleted ${deleted} expired approval token(s)`);
}

// ─── Task 4: Reset transcripts stuck in "processing" ─────────────────────────

/**
 * Finds processedTranscripts documents that have been in "processing" for more
 * than 15 minutes and marks them "failed". This recovers from Cloud Function
 * crashes that leave the status permanently stuck, preventing admin visibility
 * and blocking reprocessing.
 *
 * Stuck transcripts will appear in the Meetings tab with status "failed" and
 * a descriptive error message, allowing admins to reprocess them.
 */
async function resetStuckTranscripts(now: Timestamp): Promise<void> {
  const stuckThreshold = Timestamp.fromMillis(now.toMillis() - 15 * 60 * 1000);

  const snap = await admin
    .firestore()
    .collection("processedTranscripts")
    .where("status", "==", "processing")
    .where("processingStartedAt", "<", stuckThreshold)
    .get();

  if (snap.empty) {
    logger.info("expireProposals: no stuck transcripts to reset");
    return;
  }

  let reset = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = admin.firestore().batch();
    snap.docs.slice(i, i + BATCH_SIZE).forEach((doc) => {
      batch.update(doc.ref, {
        status: "failed",
        error: "Processing timed out — function may have crashed. Use the admin panel to reprocess.",
      });
    });
    await batch.commit();
    reset += Math.min(BATCH_SIZE, snap.docs.length - i);
  }

  logger.info(`expireProposals: reset ${reset} stuck transcript(s) from "processing" to "failed"`);
}

// ─── Task 3: Archive resolved proposals older than 30 days ───────────────────

async function archiveOldProposals(): Promise<void> {
  const thirtyDaysAgo = Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Query only by createdAt (single-field inequality — no composite index needed).
  // Filter by status in memory to stay within Firestore query limits.
  const snap = await db()
    .collectionGroup("tasks")
    .where("createdAt", "<", thirtyDaysAgo)
    .get();

  const toArchive = snap.docs.filter((doc) =>
    ARCHIVABLE_STATUSES.has(doc.data().status as string)
  );

  if (toArchive.length === 0) {
    logger.info("expireProposals: no old proposals to archive");
    return;
  }

  let archived = 0;
  for (let i = 0; i < toArchive.length; i += BATCH_SIZE) {
    const batch = db().batch();
    toArchive.slice(i, i + BATCH_SIZE).forEach((doc) => {
      batch.update(doc.ref, { status: "archived" });
    });
    await batch.commit();
    archived += Math.min(BATCH_SIZE, toArchive.length - i);
  }

  logger.info(`expireProposals: archived ${archived} proposal(s) older than 30 days`);
}

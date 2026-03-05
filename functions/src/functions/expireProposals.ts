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
 * Runs every hour. Performs three cleanup tasks:
 *
 * 1. Expire pending proposals whose expiresAt timestamp is in the past.
 * 2. Delete expired approval tokens (single-use email links past their TTL).
 * 3. Archive resolved proposals older than 30 days (status → "archived")
 *    so the active queries stay fast.
 */
export const expireProposals = onSchedule(
  { schedule: "every 60 minutes", region: "us-central1" },
  async () => {
    const now = Timestamp.now();

    await Promise.allSettled([
      expirePendingProposals(now),
      deleteExpiredTokens(now),
      archiveOldProposals(),
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

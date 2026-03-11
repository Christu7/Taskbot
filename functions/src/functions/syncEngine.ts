import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { updateUser } from "../services/firestore";
import { getValidAccessToken } from "../auth";
import { logActivity } from "../services/activityLogger";
import { ProposalDocument } from "../models/proposal";
import { UserDocument } from "../models/user";
import { TokenExpiredError } from "../utils/errors";
import { GoogleTasksDestination } from "../services/taskDestinations/googleTasksDestination";
import { AsanaDestination } from "../services/taskDestinations/asanaDestination";
import { TaskDestination, DestinationTokens, ExternalTaskStatus } from "../services/taskDestinations/taskDestination";

/** Maximum users to process simultaneously — same as driveWatcher. */
const CONCURRENCY_LIMIT = 5;
/** Delay between user chunks to spread API load. */
const INTER_CHUNK_DELAY_MS = 1_000;
/** Only sync tasks created within the last 30 days. */
const MAX_TASK_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Skip tasks synced within the last 5 minutes (avoid hammering APIs on manual re-runs). */
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const db = () => admin.firestore();

// ─── syncUpdateProposal ───────────────────────────────────────────────────────
/**
 * Writes sync-engine updates to a proposal document WITHOUT bumping localUpdatedAt.
 * This is critical: sync writes must not look like "local changes" in the next
 * cycle, or the sync engine would override user edits indefinitely.
 */
async function syncUpdateProposal(
  meetingId: string,
  taskId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const ref = db()
    .collection("proposals")
    .doc(meetingId)
    .collection("tasks")
    .doc(taskId);

  // Explicitly ensure localUpdatedAt is never set by sync writes
  const safeUpdates = { ...updates };
  delete safeUpdates.localUpdatedAt;

  await ref.update(safeUpdates);
}

// ─── STEP 1: Get users to sync ────────────────────────────────────────────────

async function getUsersToSync(): Promise<UserDocument[]> {
  const snap = await db()
    .collection("users")
    .where("isActive", "==", true)
    .where("hasValidTokens", "==", true)
    .get();
  return snap.docs.map((d) => d.data() as UserDocument);
}

// ─── STEP 2: Get tasks to sync for a user ────────────────────────────────────

interface SyncableTask extends ProposalDocument {
  id: string;
  ref: admin.firestore.DocumentReference;
}

async function getTasksToSync(uid: string): Promise<SyncableTask[]> {
  const thirtyDaysAgo = Timestamp.fromMillis(Date.now() - MAX_TASK_AGE_MS);
  const fiveMinutesAgo = Timestamp.fromMillis(Date.now() - MIN_SYNC_INTERVAL_MS);

  // Run two equality queries using the composite index [assigneeUid, status, createdAt]
  const [createdSnap, inProgressSnap] = await Promise.all([
    db()
      .collectionGroup("tasks")
      .where("assigneeUid", "==", uid)
      .where("status", "==", "created")
      .get(),
    db()
      .collectionGroup("tasks")
      .where("assigneeUid", "==", uid)
      .where("status", "==", "in_progress")
      .get(),
  ]);

  const allDocs = [...createdSnap.docs, ...inProgressSnap.docs];

  return allDocs
    .filter((d) => {
      const data = d.data() as ProposalDocument;
      // Skip tasks older than 30 days
      if (data.createdAt && data.createdAt.toMillis() < thirtyDaysAgo.toMillis()) return false;
      // Skip if no externalRefs — nothing to sync against
      if (!data.externalRefs?.length) return false;
      // Skip if synced very recently (within 5 min)
      const last = data.lastSyncedAt;
      if (last && last.toMillis() > fiveMinutesAgo.toMillis()) return false;
      // Skip if the user has in-flight dashboard edits not yet pushed to external.
      // The PATCH /tasks endpoint sets syncStatus="pending_sync" on every edit.
      // Overwriting those edits with external data would silently discard changes.
      if (data.syncStatus === "pending_sync") return false;
      return true;
    })
    .map((d) => ({
      id: d.id,
      ref: d.ref,
      ...(d.data() as ProposalDocument),
    }));
}

// ─── STEP 3: Sync a single task ───────────────────────────────────────────────

interface RefState {
  destination: string;
  externalId: string;
  dest: TaskDestination;
  state: ExternalTaskStatus | null;
  fetchError: Error | null;
}

async function syncSingleTask(
  task: SyncableTask,
  tokens: { uid: string; accessToken: string }
): Promise<"synced" | "error" | "deleted"> {
  const refs = task.externalRefs ?? [];
  const currentTitle = task.editedTitle ?? task.title;
  const localUpdatedAt = task.localUpdatedAt?.toDate() ?? new Date(0);
  const destTokens: DestinationTokens = { accessToken: tokens.accessToken, uid: tokens.uid };

  // ── Step 1: Fetch all external states in parallel ──────────────────────────
  const refStates: RefState[] = await Promise.all(
    refs.map(async (ref) => {
      const dest: TaskDestination =
        ref.destination === "asana" ? new AsanaDestination() : new GoogleTasksDestination();
      try {
        const state = await dest.getTask(destTokens, ref.externalId);
        return { destination: ref.destination, externalId: ref.externalId, dest, state, fetchError: null };
      } catch (err) {
        if (err instanceof TokenExpiredError) throw err;
        return { destination: ref.destination, externalId: ref.externalId, dest, state: null, fetchError: err as Error };
      }
    })
  );

  // ── Step 2: Handle any fetch errors ───────────────────────────────────────
  let result: "synced" | "error" | "deleted" = "synced";
  for (const rs of refStates) {
    if (rs.fetchError) {
      logger.error(`syncEngine: failed to fetch ${rs.destination}/${rs.externalId} for task ${task.id}`, {
        error: rs.fetchError.message,
      });
      await syncUpdateProposal(task.meetingId, task.id, {
        syncStatus: "sync_error",
        syncError: rs.fetchError.message,
        lastSyncedAt: FieldValue.serverTimestamp(),
      });
      result = "error";
    }
  }

  // ── Step 3: Check for external deletion ───────────────────────────────────
  for (const rs of refStates) {
    if (rs.state && !rs.state.exists) {
      await syncUpdateProposal(task.meetingId, task.id, {
        syncStatus: "external_deleted",
        lastSyncedAt: FieldValue.serverTimestamp(),
      });
      logger.info(`syncEngine: task ${task.id} deleted externally in ${rs.destination}`);
      return "deleted";
    }
  }

  // ── Step 4: Find the winning external state (most recently updated) ────────
  const liveStates = refStates.filter((rs) => rs.state?.exists);
  if (!liveStates.length) return result;

  const winner = liveStates.reduce((best, rs) =>
    rs.state!.externalUpdatedAt > best.state!.externalUpdatedAt ? rs : best
  );

  const winnerIsNewerThanLocal = winner.state!.externalUpdatedAt > localUpdatedAt;

  // ── Step 5: Update Firestore if the winner is newer than local edits ───────
  const firestoreUpdate: Record<string, unknown> = {
    syncStatus: "synced",
    lastSyncedAt: FieldValue.serverTimestamp(),
    externalUpdatedAt: Timestamp.fromDate(winner.state!.externalUpdatedAt),
  };

  let completionChanged = false;
  let titleChanged = false;

  if (winnerIsNewerThanLocal) {
    if (winner.state!.isCompleted && task.status !== "completed") {
      firestoreUpdate.status = "completed";
      completionChanged = true;
      logger.info(`syncEngine: task ${task.id} marked completed from ${winner.destination}`);
    } else if (!winner.state!.isCompleted && task.status === "completed") {
      firestoreUpdate.status = "in_progress";
      completionChanged = true;
      logger.info(`syncEngine: task ${task.id} reopened from ${winner.destination}`);
    } else if (winner.state!.title && winner.state!.title !== currentTitle) {
      firestoreUpdate.editedTitle = winner.state!.title;
      titleChanged = true;
      logger.info(`syncEngine: task ${task.id} title updated from ${winner.destination}`);
    }
  }

  await syncUpdateProposal(task.meetingId, task.id, firestoreUpdate);

  // ── Step 6: Push winner's state to any other refs that are out of sync ─────
  if (winnerIsNewerThanLocal && (completionChanged || titleChanged)) {
    for (const rs of liveStates) {
      if (rs.externalId === winner.externalId) continue; // skip the source

      try {
        if (completionChanged && winner.state!.isCompleted && !rs.state!.isCompleted) {
          await rs.dest.completeTask(destTokens, rs.externalId);
          logger.info(`syncEngine: cross-synced completion to ${rs.destination} for task ${task.id}`);
        }
        if (titleChanged && winner.state!.title && winner.state!.title !== rs.state!.title) {
          await rs.dest.updateTask(destTokens, rs.externalId, { title: winner.state!.title });
          logger.info(`syncEngine: cross-synced title to ${rs.destination} for task ${task.id}`);
        }
      } catch (err) {
        logger.warn(`syncEngine: cross-sync push failed for ${rs.destination}/${rs.externalId}`, {
          error: (err as Error).message,
        });
      }
    }
  }

  return result;
}

// ─── Per-user sync ────────────────────────────────────────────────────────────

interface SyncUserResult {
  synced: number;
  errors: number;
  deleted: number;
}

/**
 * Runs the full sync cycle for a single user.
 * Exported so it can be called from the /api/sync/now endpoint.
 */
export async function syncUserNow(uid: string): Promise<SyncUserResult> {
  const result: SyncUserResult = { synced: 0, errors: 0, deleted: 0 };

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(uid);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      logger.warn(`syncEngine: tokens expired for user ${uid} — marking hasValidTokens=false`);
      await updateUser(uid, { hasValidTokens: false });
    } else {
      logger.warn(`syncEngine: token retrieval failed for user ${uid}`, {
        error: (err as Error).message,
      });
    }
    return result;
  }

  const tasks = await getTasksToSync(uid);
  if (!tasks.length) {
    logger.debug(`syncEngine: no syncable tasks for user ${uid}`);
    return result;
  }

  logger.info(`syncEngine: syncing ${tasks.length} task(s) for user ${uid}`);

  const tokens = { uid, accessToken };

  for (const task of tasks) {
    try {
      const outcome = await syncSingleTask(task, tokens);
      if (outcome === "error") result.errors++;
      else if (outcome === "deleted") result.deleted++;
      else result.synced++;
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        logger.warn(
          `syncEngine: token expired mid-sync for user ${uid} — stopping user sync`
        );
        await updateUser(uid, { hasValidTokens: false });
        break;
      }
      // Unexpected error on a single task — log and continue
      logger.error(`syncEngine: unexpected error for task ${task.id}`, {
        error: (err as Error).message,
      });
      result.errors++;
    }
  }

  return result;
}

// ─── Scheduled Cloud Function ─────────────────────────────────────────────────

/**
 * Scheduled Cloud Function: syncEngine
 *
 * Runs every 10 minutes. Pulls the current state of all active tasks from
 * Google Tasks and Asana, then updates Firestore to match external changes.
 *
 * Conflict resolution: external change wins only if externalUpdatedAt > localUpdatedAt.
 * This prevents the sync from overwriting dashboard edits that haven't been
 * pushed to the external system yet.
 */
export const syncEngine = onSchedule(
  {
    schedule: "every 10 minutes",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    logger.info("syncEngine: starting sync cycle");

    const users = await getUsersToSync();
    logger.info(`syncEngine: ${users.length} eligible user(s) to sync`);

    let totalSynced = 0;
    let totalErrors = 0;
    let totalDeleted = 0;
    let totalUserErrors = 0;

    for (let i = 0; i < users.length; i += CONCURRENCY_LIMIT) {
      const chunk = users.slice(i, i + CONCURRENCY_LIMIT);
      const chunkResults = await Promise.allSettled(
        chunk.map((user) => syncUserNow(user.uid))
      );

      chunkResults.forEach((res, idx) => {
        if (res.status === "fulfilled") {
          totalSynced += res.value.synced;
          totalErrors += res.value.errors;
          totalDeleted += res.value.deleted;
        } else {
          totalUserErrors++;
          logger.error(
            `syncEngine: unhandled error for user ${chunk[idx].uid}`,
            res.reason
          );
        }
      });

      if (i + CONCURRENCY_LIMIT < users.length) {
        await sleep(INTER_CHUNK_DELAY_MS);
      }
    }

    logger.info(
      `syncEngine: cycle complete — ${totalSynced} synced, ` +
      `${totalDeleted} deleted externally, ${totalErrors} task error(s), ` +
      `${totalUserErrors} user-level error(s)`
    );

    if (totalSynced > 0 || totalDeleted > 0) {
      await logActivity("sync_complete",
        `Sync complete — ${totalSynced} task${totalSynced !== 1 ? "s" : ""} synced, ${totalDeleted} deleted externally`,
        { synced: totalSynced, deleted: totalDeleted, errors: totalErrors }
      );
    }
  }
);

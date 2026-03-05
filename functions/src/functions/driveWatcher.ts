import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { getActiveUsers, updateUser } from "../services/firestore";
import { findNewTranscripts } from "../services/drive";
import { parseTranscriptFilename, findMeetingEvent } from "../services/calendar";
import { getValidAccessToken } from "../auth";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { TokenExpiredError, APIQuotaError } from "../utils/errors";

/** Maximum number of users to process simultaneously. */
const CONCURRENCY_LIMIT = 5;
/** Delay between user-processing chunks to avoid hammering Google APIs. */
const INTER_CHUNK_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How far back to look for new transcripts on each poll cycle.
 * Set to 15 minutes — slightly longer than the 10-minute schedule interval —
 * to avoid missing files when the function starts a few seconds late.
 */
const LOOKBACK_MINUTES = 15;

const db = () => admin.firestore();

/**
 * Scheduled Cloud Function: driveWatcher
 *
 * Runs every 10 minutes. For each active user with valid OAuth tokens:
 * 1. Searches their Google Drive for new Google Meet transcripts.
 * 2. Parses the transcript filename to extract meeting name and date.
 * 3. Queries Google Calendar to identify attendees for that meeting.
 * 4. Filters attendees to only those who are signed-up, active TaskBot users.
 * 5. Creates a `processedTranscripts/{driveFileId}` Firestore document.
 *
 * Key behaviours:
 * - Deduplication: driveFileId is the document ID. If two users detect the
 *   same transcript, the second `.create()` call fails silently — no double-processing.
 * - Per-user isolation: token or API failures for one user never abort others.
 * - Token invalidation: auth errors set hasValidTokens=false on the user doc,
 *   prompting re-authorization from the frontend.
 * - Calendar failures are non-fatal: the transcript is still recorded with an
 *   empty attendeeEmails list rather than dropped entirely.
 */
export const driveWatcher = onSchedule(
  { schedule: "every 10 minutes", region: "us-central1" },
  async () => {
    logger.info("driveWatcher: starting poll cycle");

    const sinceTimestamp = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);

    // 1. Fetch all active users and build a quick-lookup email set for filtering
    const activeUsers = await getActiveUsers();
    const activeUserEmails = new Set(activeUsers.map((u) => u.email).filter(Boolean));

    logger.info(
      `driveWatcher: processing ${activeUsers.length} active user(s), ` +
      `${activeUserEmails.size} registered email(s) for attendee filtering`
    );

    // 2. Process users in chunks of CONCURRENCY_LIMIT to avoid rate-limiting.
    //    One user's failure must never abort others.
    const results: PromiseSettledResult<number>[] = [];
    for (let i = 0; i < activeUsers.length; i += CONCURRENCY_LIMIT) {
      const chunk = activeUsers.slice(i, i + CONCURRENCY_LIMIT);
      const chunkResults = await Promise.allSettled(
        chunk.map((user) =>
          processUserDrive(user.uid, user.email, sinceTimestamp, activeUserEmails)
        )
      );
      results.push(...chunkResults);
      // Pause between chunks to spread API load
      if (i + CONCURRENCY_LIMIT < activeUsers.length) {
        await sleep(INTER_CHUNK_DELAY_MS);
      }
    }

    // 3. Log a cycle summary
    let totalNew = 0;
    let totalErrors = 0;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        totalNew += result.value;
      } else {
        totalErrors++;
        logger.error(
          `driveWatcher: unhandled error for user ${activeUsers[i].uid}`,
          result.reason
        );
      }
    });

    logger.info(
      `driveWatcher: cycle complete — ${totalNew} new transcript(s) queued, ` +
      `${totalErrors} user(s) with unhandled errors`
    );
  }
);

// ─── Per-user processing ──────────────────────────────────────────────────────

/**
 * Processes a single user's Google Drive for new transcripts, then enriches
 * each discovery with Calendar attendee data before writing to Firestore.
 *
 * @param uid              - Firebase Auth UID
 * @param sinceTimestamp   - Lower bound for Drive file modification time
 * @param activeUserEmails - Set of emails for all signed-up, active TaskBot users
 * @returns Number of new transcript documents created in this cycle
 */
async function processUserDrive(
  uid: string,
  detectorEmail: string,
  sinceTimestamp: Date,
  activeUserEmails: Set<string>
): Promise<number> {
  // ── Step 1: Get a valid access token ──────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(uid);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      logger.warn(
        `driveWatcher: tokens expired/revoked for user ${uid} — marking hasValidTokens=false`,
        { error: (err as Error).message }
      );
    } else {
      logger.warn(
        `driveWatcher: token retrieval failed for user ${uid} — marking hasValidTokens=false`,
        { error: (err as Error).message }
      );
    }
    await updateUser(uid, { hasValidTokens: false });
    return 0;
  }

  // Tokens are healthy — self-heal the flag in case a previous cycle set it false.
  await updateUser(uid, { hasValidTokens: true });

  // ── Step 2: Search Drive for new transcripts ──────────────────────────────
  let transcripts;
  try {
    transcripts = await findNewTranscripts(accessToken, sinceTimestamp);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      logger.warn(
        `driveWatcher: Drive auth error for user ${uid} — marking hasValidTokens=false`,
        { error: (err as Error).message }
      );
      await updateUser(uid, { hasValidTokens: false });
    } else if (err instanceof APIQuotaError) {
      logger.warn(
        `driveWatcher: Drive quota exceeded for user ${uid} — skipping this cycle`,
        { error: (err as Error).message }
      );
    } else {
      logger.error(`driveWatcher: Drive API error for user ${uid}`, {
        error: (err as Error).message,
      });
    }
    return 0;
  }

  if (transcripts.length === 0) {
    logger.debug(`driveWatcher: no new transcripts found for user ${uid}`);
    return 0;
  }

  logger.info(
    `driveWatcher: found ${transcripts.length} candidate transcript(s) for user ${uid}`
  );

  // ── Step 3: Enrich and record each transcript ─────────────────────────────
  let newCount = 0;

  await Promise.all(
    transcripts.map(async (transcript) => {
      const docRef = db().collection("processedTranscripts").doc(transcript.fileId);

      // Fast existence check — skip without touching Calendar API if already recorded
      const existing = await docRef.get();
      if (existing.exists) {
        logger.debug(
          `driveWatcher: skipping already-recorded transcript ${transcript.fileId}`
        );
        return;
      }

      // ── Step 3a: Parse filename for Calendar lookup ──────────────────────
      const parsed = parseTranscriptFilename(transcript.fileName);
      let attendeeEmails: string[] = [];
      let meetingTitle = transcript.fileName; // fall back to raw filename

      if (!parsed) {
        logger.warn(
          `driveWatcher: could not parse filename "${transcript.fileName}" — ` +
          "storing transcript without attendees"
        );
      } else {
        meetingTitle = parsed.meetingName;

        // ── Step 3b: Look up the Calendar event to get attendees ───────────
        try {
          const event = await findMeetingEvent(accessToken, parsed.meetingName, parsed.date);

          if (!event) {
            logger.warn(
              `driveWatcher: no Calendar event found for "${parsed.meetingName}" ` +
              `on ${parsed.date} (user ${uid}) — storing without attendees`
            );
          } else {
            // ── Step 3c: Filter to registered, active TaskBot users only ───
            const allEmails = new Set([...event.attendees, event.organizer].filter(Boolean));
            attendeeEmails = [...allEmails].filter((email) => activeUserEmails.has(email));

            logger.info(
              `driveWatcher: Calendar event found for "${parsed.meetingName}" — ` +
              `${event.attendees.length} total attendee(s), ` +
              `${attendeeEmails.length} registered TaskBot user(s)`
            );
          }
        } catch (err) {
          const message = (err as Error).message ?? "";
          const isPermissionError =
            message.includes("403") ||
            message.toLowerCase().includes("forbidden") ||
            message.toLowerCase().includes("insufficient");

          if (isPermissionError) {
            // User hasn't granted Calendar scope — skip gracefully
            logger.warn(
              `driveWatcher: Calendar access denied for user ${uid} — ` +
              "storing transcript without attendees"
            );
          } else {
            logger.error(
              `driveWatcher: Calendar API error for user ${uid}`,
              { error: message, transcript: transcript.fileId }
            );
          }
          // Either way, continue — don't drop the transcript because Calendar failed
        }
      }

      // ── Step 3d: Ensure the detecting user is always an attendee ─────────
      // Calendar lookup may return no results for short/solo meetings.
      // The person whose Drive detected this transcript was in the meeting,
      // so always include them as a fallback.
      if (detectorEmail && !attendeeEmails.includes(detectorEmail)) {
        attendeeEmails = [detectorEmail, ...attendeeEmails];
      }

      // ── Dedup: skip if the same meeting was already processed recently ────
      // Each meeting participant gets their own Drive copy with a different fileId.
      // Without this check the same meeting generates multiple processedTranscripts
      // docs — and multiple email notifications. A 4-hour window is wide enough to
      // cover delayed uploads while still allowing back-to-back same-title meetings.
      const fourHoursAgo = Timestamp.fromMillis(Date.now() - 4 * 60 * 60 * 1000);
      const dedupSnap = await db()
        .collection("processedTranscripts")
        .where("meetingTitle", "==", meetingTitle)
        .where("detectedAt", ">=", fourHoursAgo)
        .limit(1)
        .get();
      if (!dedupSnap.empty && dedupSnap.docs[0].data().status !== "failed") {
        logger.info(
          `driveWatcher: skipping duplicate transcript for "${meetingTitle}" (already processed from a different Drive copy)`
        );
        return;
      }

      // ── Step 4: Write the Firestore document ──────────────────────────────
      // Use .create() semantics so a concurrent write from another user for
      // the same transcript fails silently rather than overwriting.
      const doc: ProcessedTranscriptDocument = {
        driveFileId: transcript.fileId,
        driveFileLink: transcript.webViewLink,
        detectedByUid: uid,
        meetingTitle,
        detectedAt: FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp,
        status: "pending",
        attendeeEmails,
      };

      try {
        await docRef.create(doc);
        newCount++;
        logger.info(
          `driveWatcher: queued transcript "${meetingTitle}" (${transcript.fileId}) ` +
          `with ${attendeeEmails.length} attendee(s), detected by user ${uid}`
        );
      } catch (err) {
        // Another user wrote this document between our .get() and .create() — harmless
        if ((err as { code?: string }).code === "already-exists") {
          logger.debug(
            `driveWatcher: concurrent write for ${transcript.fileId} — skipping`
          );
        } else {
          throw err;
        }
      }
    })
  );

  return newCount;
}

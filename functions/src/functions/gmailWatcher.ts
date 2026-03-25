import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { getActiveUsers, updateUser } from "../services/firestore";
import { findGeminiNotesEmails, extractGeminiNotesDocId, parseGeminiNotesSubject } from "../services/gmail";
import { getTranscriptContent } from "../services/drive";
import { findMeetingEvent } from "../services/calendar";
import { getValidAccessToken } from "../auth";
import { ProcessedTranscriptDocument } from "../models/processedTranscript";
import { TokenExpiredError } from "../utils/errors";

/** Maximum number of users to process simultaneously. */
const CONCURRENCY_LIMIT = 5;
/** Delay between user-processing chunks to avoid hammering Google APIs. */
const INTER_CHUNK_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const db = () => admin.firestore();

/**
 * Scheduled Cloud Function: gmailWatcher
 *
 * Runs every 10 minutes. For each active user with valid OAuth tokens:
 * 1. Searches their Gmail for new "Notes by Gemini" emails.
 * 2. Extracts the Google Docs ID from each email body.
 * 3. Pre-fetches the transcript text via the Docs API and caches it.
 * 4. Queries Google Calendar to identify attendees for that meeting.
 * 5. Creates a `processedTranscripts/{docId}` Firestore document.
 *
 * Key behaviours:
 * - Per-user `lastGmailCheck` timestamp: no historical backfill on first run.
 * - Deduplication: docId is the Firestore document ID. `.create()` for concurrent safety.
 * - Calendar failures are non-fatal: transcript is recorded with empty attendees.
 * - cachedTranscriptText: processTranscript skips the Drive fetch when this is set.
 * - Does NOT modify driveWatcher — both watchers write to processedTranscripts independently.
 */
export const gmailWatcher = onSchedule(
  {
    schedule: "every 10 minutes",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    logger.info("gmailWatcher: starting poll cycle");

    const activeUsers = await getActiveUsers();
    const activeUserEmails = new Set(activeUsers.map((u) => u.email).filter(Boolean));

    logger.info(
      `gmailWatcher: processing ${activeUsers.length} active user(s), ` +
      `${activeUserEmails.size} registered email(s) for attendee filtering`
    );

    const results: PromiseSettledResult<number>[] = [];
    for (let i = 0; i < activeUsers.length; i += CONCURRENCY_LIMIT) {
      const chunk = activeUsers.slice(i, i + CONCURRENCY_LIMIT);
      const chunkResults = await Promise.allSettled(
        chunk.map((user) =>
          processUserGmail(user.uid, user.email, activeUserEmails)
        )
      );
      results.push(...chunkResults);
      if (i + CONCURRENCY_LIMIT < activeUsers.length) {
        await sleep(INTER_CHUNK_DELAY_MS);
      }
    }

    let totalNew = 0;
    let totalErrors = 0;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        totalNew += result.value;
      } else {
        totalErrors++;
        logger.error(
          `gmailWatcher: unhandled error for user ${activeUsers[i].uid}`,
          result.reason
        );
      }
    });

    logger.info(
      `gmailWatcher: cycle complete — ${totalNew} new transcript(s) queued, ` +
      `${totalErrors} user(s) with unhandled errors`
    );
  }
);

// ─── Per-user processing ──────────────────────────────────────────────────────

/**
 * Processes a single user's Gmail for new Gemini Notes emails, then enriches
 * each discovery with Docs content and Calendar attendee data before writing
 * to Firestore.
 *
 * @param uid               - Firebase Auth UID
 * @param detectorEmail     - Email address of the detecting user
 * @param activeUserEmails  - Set of emails for all signed-up, active TaskBot users
 * @returns Number of new transcript documents created in this cycle
 */
async function processUserGmail(
  uid: string,
  detectorEmail: string,
  activeUserEmails: Set<string>
): Promise<number> {
  // ── Step 1: Get a valid access token ──────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(uid);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      logger.warn(
        `gmailWatcher: tokens expired/revoked for user ${uid} — marking hasValidTokens=false`,
        { error: (err as Error).message }
      );
    } else {
      logger.warn(
        `gmailWatcher: token retrieval failed for user ${uid}`,
        { error: (err as Error).message }
      );
    }
    await updateUser(uid, { hasValidTokens: false });
    return 0;
  }

  await updateUser(uid, { hasValidTokens: true });

  // ── Step 2: Determine the look-back window ────────────────────────────────
  // Track per-user lastGmailCheck so we use a precise window rather than a
  // fixed LOOKBACK_MINUTES. On the very first run, initialise to now and return
  // without backfilling — we only want emails going forward.
  const userRef = db().collection("users").doc(uid);
  const userSnap = await userRef.get();
  const lastGmailCheck = userSnap.data()?.lastGmailCheck as Timestamp | undefined;
  const now = Timestamp.now();

  if (!lastGmailCheck) {
    logger.info(
      `gmailWatcher: first run for user ${uid} — setting lastGmailCheck to now, no backfill`
    );
    await userRef.update({ lastGmailCheck: now });
    return 0;
  }

  const sinceTimestamp = lastGmailCheck.toDate();

  // ── Step 3: Search Gmail for Gemini Notes emails ──────────────────────────
  let emailRefs;
  try {
    emailRefs = await findGeminiNotesEmails(accessToken, sinceTimestamp);
  } catch (err) {
    logger.error(
      `gmailWatcher: Gmail API error for user ${uid}`,
      { error: (err as Error).message }
    );
    // Don't update lastGmailCheck so we retry this window next cycle
    return 0;
  }

  // Advance the checkpoint regardless of how many emails matched
  await userRef.update({ lastGmailCheck: now });

  if (emailRefs.length === 0) {
    logger.debug(`gmailWatcher: no Gemini Notes emails found for user ${uid}`);
    return 0;
  }

  logger.info(
    `gmailWatcher: found ${emailRefs.length} candidate email(s) for user ${uid}`
  );

  // ── Step 4: Enrich and record each transcript ─────────────────────────────
  let newCount = 0;

  await Promise.all(
    emailRefs.map(async (emailRef) => {
      // ── Step 4a: Parse subject ──────────────────────────────────────────
      const parsed = parseGeminiNotesSubject(emailRef.subject);
      if (!parsed) {
        logger.warn(
          `gmailWatcher: subject did not match expected pattern: "${emailRef.subject}" — skipping`
        );
        return;
      }

      const { meetingTitle, meetingDate } = parsed;

      // ── Step 4b: Extract Docs ID from email body ────────────────────────
      let docInfo: { docId: string; docUrl: string } | null;
      try {
        docInfo = await extractGeminiNotesDocId(accessToken, emailRef.messageId);
      } catch (err) {
        logger.error(
          `gmailWatcher: failed to extract Doc ID from email ${emailRef.messageId}`,
          { error: (err as Error).message, meetingTitle }
        );
        return;
      }

      if (!docInfo) {
        logger.warn(
          `gmailWatcher: no Google Docs URL found in email for "${meetingTitle}" — skipping`
        );
        return;
      }

      const { docId, docUrl } = docInfo;

      // ── Step 4c: Deduplicate ────────────────────────────────────────────
      // driveFileId is the Firestore document ID, so a single .get() is enough.
      const existing = await db().collection("processedTranscripts").doc(docId).get();
      if (existing.exists) {
        logger.debug(
          `gmailWatcher: doc ${docId} already in processedTranscripts — skipping`
        );
        return;
      }

      // ── Step 4d: Pre-fetch transcript text ──────────────────────────────
      // The detecting user received this doc via email — they have Docs access.
      // Caching the text here lets processTranscript skip the Drive API call entirely.
      let cachedTranscriptText: string | undefined;
      let extractionMethod: "tab" | "full_doc" | undefined;

      try {
        const content = await getTranscriptContent(accessToken, docId);
        cachedTranscriptText = content.transcript;
        extractionMethod = content.format === "gemini_notes" ? "tab" : "full_doc";
        logger.info(
          `gmailWatcher: pre-fetched transcript for doc ${docId} ` +
          `(${cachedTranscriptText.length} chars, method: ${extractionMethod})`
        );
      } catch (err) {
        // Non-fatal: processTranscript will attempt the Drive fetch itself
        logger.warn(
          `gmailWatcher: could not pre-fetch transcript for doc ${docId} — ` +
          "processTranscript will fall back to Drive API",
          { error: (err as Error).message }
        );
      }

      // ── Step 4e: Calendar lookup for attendees ──────────────────────────
      let attendeeEmails: string[] = [];
      try {
        const event = await findMeetingEvent(accessToken, meetingTitle, meetingDate);
        if (!event) {
          logger.warn(
            `gmailWatcher: no Calendar event found for "${meetingTitle}" on ${meetingDate} ` +
            `(user ${uid}) — storing without attendees`
          );
        } else {
          const allEmails = new Set([...event.attendees, event.organizer].filter(Boolean));
          attendeeEmails = [...allEmails].filter((email) => activeUserEmails.has(email));
          logger.info(
            `gmailWatcher: Calendar event found for "${meetingTitle}" — ` +
            `${event.attendees.length} total attendee(s), ` +
            `${attendeeEmails.length} registered TaskBot user(s)`
          );
        }
      } catch (err) {
        // Calendar failure is non-fatal — still record the transcript
        logger.warn(
          `gmailWatcher: Calendar API error for user ${uid}`,
          { error: (err as Error).message, meetingTitle }
        );
      }

      // Always include the detecting user as an attendee
      if (detectorEmail && !attendeeEmails.includes(detectorEmail)) {
        attendeeEmails = [detectorEmail, ...attendeeEmails];
      }

      // ── Step 4f: Write the Firestore document ───────────────────────────
      const docRef = db().collection("processedTranscripts").doc(docId);

      const doc: Partial<ProcessedTranscriptDocument> & Record<string, unknown> = {
        driveFileId: docId,
        driveFileLink: docUrl,
        detectedByUid: uid,
        meetingTitle,
        detectedAt: FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp,
        status: "pending",
        attendeeEmails,
        sourceType: "gmail_gemini_notes",
        ...(cachedTranscriptText !== undefined
          ? { cachedTranscriptText, extractionMethod }
          : {}),
      };

      try {
        await docRef.create(doc);
        newCount++;
        logger.info(
          `gmailWatcher: queued transcript "${meetingTitle}" (${docId}) ` +
          `with ${attendeeEmails.length} attendee(s), detected by user ${uid}`
        );
      } catch (err) {
        // Another user wrote this doc between our .get() and .create() — harmless
        if ((err as { code?: string }).code === "already-exists") {
          logger.debug(`gmailWatcher: concurrent write for ${docId} — skipping`);
        } else {
          throw err;
        }
      }
    })
  );

  return newCount;
}

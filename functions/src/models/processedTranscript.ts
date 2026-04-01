import { Timestamp } from "firebase-admin/firestore";

/**
 * Lifecycle states for a transcript as it moves through the TaskBot pipeline.
 *
 * pending     → Detected in Drive; waiting to be picked up by the processor.
 * processing  → Processor has claimed the doc and begun work.
 * extracting  → Transcript text is being fetched from Drive / Calendar data fetched.
 * proposed    → Tasks have been extracted and proposals sent to attendees.
 * completed   → All proposals resolved (approved or rejected).
 * failed      → An unrecoverable error occurred; see the `error` field for details.
 */
export type ProcessedTranscriptStatus =
  | "pending"
  | "processing"
  | "extracting"
  | "dedup_pending"     // Chunks processed; waiting 60 s before dedup to avoid rate limit
  | "deduplicating"    // Dedup scheduler has claimed the doc and is calling the AI
  | "proposed"
  | "completed"
  | "failed"
  | "awaiting_configuration";

/**
 * Shape of the document stored at processedTranscripts/{driveFileId} in Firestore.
 *
 * The document ID is the Drive file ID, making deduplication a simple .get()
 * instead of a collection query.
 *
 * @example
 * const doc: ProcessedTranscriptDocument = {
 *   driveFileId: "1BxiMVs0XRA...",
 *   driveFileLink: "https://docs.google.com/document/d/1BxiMVs0XRA.../edit",
 *   detectedByUid: "uid_of_organizer",
 *   meetingTitle: "Weekly Sync - 2026-03-02",
 *   detectedAt: Timestamp.now(),
 *   status: "pending",
 *   attendeeEmails: [],
 * };
 */
export interface ProcessedTranscriptDocument {
  /** Google Drive file ID — also the Firestore document ID. */
  driveFileId: string;
  /** URL to open the transcript doc in Google Docs. */
  driveFileLink: string;
  /**
   * UID of the user in whose Drive this transcript was first detected.
   * Typically the meeting organizer, but any signed-up attendee can be first.
   */
  detectedByUid: string;
  /** Human-readable meeting title extracted from the Drive file name. */
  meetingTitle: string;
  /** Server timestamp of when the driveWatcher first created this document. */
  detectedAt: Timestamp;
  /** Current pipeline stage. */
  status: ProcessedTranscriptStatus;
  /**
   * Email addresses of all meeting attendees.
   * Populated after the Calendar API lookup — empty until then.
   */
  attendeeEmails: string[];
  /**
   * Human-readable error message.
   * Only present when status === "failed".
   */
  error?: string;
  /**
   * Which Google Meet document format this transcript came from.
   *
   * plain_transcript — The classic "Meeting transcript - Name - Date" Google Doc.
   *   Content was exported as plain text from Drive.
   *
   * gemini_notes — A Gemini Notes document (no "transcript" in the filename).
   *   The doc has two tabs: "Notes" (AI summary) and "Transcript" (raw).
   *   Both were extracted and passed to the AI extractor.
   */
  transcriptFormat?: "plain_transcript" | "gemini_notes";
  /**
   * How the transcript reached TaskBot.
   *
   * "drive"               — Detected in the user's Google Drive by driveWatcher.
   * "gmail_gemini_notes"  — Detected in Gmail by gmailWatcher (Gemini Notes email).
   * "manual_submission"   — Submitted directly by a user via the dashboard.
   */
  sourceType?: "drive" | "gmail_gemini_notes" | "manual_submission";
  /**
   * True when this document was created by a user pasting transcript text directly
   * (not detected from Drive or Gmail). When true, attendeeEmails is empty and
   * proposals are created only for the submitting user.
   */
  isManual?: boolean;
  /**
   * UID of the user who submitted this transcript manually.
   * Only present when isManual === true.
   */
  submittedByUid?: string;
  /**
   * ISO date (YYYY-MM-DD) of the meeting, supplied by the user on manual submission.
   * Used as the meetingDate in the AI extraction context instead of deriving it
   * from detectedAt, which would be the submission time rather than the meeting date.
   */
  meetingDate?: string;
  /**
   * Pre-fetched transcript text.  Set by gmailWatcher so processTranscript
   * can skip the Drive API fetch entirely for Gmail-sourced documents.
   */
  cachedTranscriptText?: string;
  /**
   * How the transcript text was extracted from the source document.
   * "tab"      — Extracted from the "Transcript" tab via the Docs API.
   * "full_doc" — Exported as plain text via the Drive API (fallback).
   */
  extractionMethod?: "tab" | "full_doc";
  /**
   * True when a Gemini Notes "Notes" tab was found and passed to the AI.
   * Useful for debugging and analytics.
   */
  hasNotes?: boolean;
  /** Token usage from the AI extraction call. */
  tokensUsed?: { input: number; output: number };
  /**
   * Validated tasks collected from all transcript chunks, stored while
   * waiting for the dedup call (status === "dedup_pending").
   * Cleared after the dedup scheduler promotes the doc to "proposed".
   */
  rawTasks?: unknown[];
  /**
   * Earliest time the dedup call may be made.
   * The scheduler skips this document until now > dedupAfter.
   */
  dedupAfter?: Timestamp;
  /**
   * Server timestamp set when the processor claims the document (status → "processing").
   * Used to detect stuck transcripts: if "processing" for more than 15 minutes, the
   * function likely crashed and the document can be safely requeued.
   */
  processingStartedAt?: Timestamp;
}

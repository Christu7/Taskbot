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
  | "proposed"
  | "completed"
  | "failed";

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
}

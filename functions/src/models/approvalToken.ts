import { Timestamp } from "firebase-admin/firestore";

/**
 * Shape of the document stored at approvalTokens/{token} in Firestore.
 *
 * Tokens are single-use, time-limited, and scoped to one user × meeting.
 * They are generated when a notification email is sent and consumed when the
 * user opens the review page or clicks "Approve All".
 *
 * Cloud Functions (Admin SDK) create and validate these exclusively.
 * Firestore rules deny all client-side access.
 */
export interface ApprovalTokenDocument {
  /** Firebase Auth UID of the assignee this token was issued for. */
  uid: string;
  /** Document ID of the processedTranscripts record (= Drive file ID). */
  meetingId: string;
  /** When this token stops being valid. */
  expiresAt: Timestamp;
  /**
   * True once the token has been consumed.
   * Prevents replay attacks — a token is valid exactly once.
   */
  used: boolean;
  /** When the token was created (= when the notification email was sent). */
  createdAt: Timestamp;
}

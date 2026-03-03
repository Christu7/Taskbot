import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { ApprovalTokenDocument } from "../models/approvalToken";

const db = () => admin.firestore();

/**
 * Creates a secure, single-use approval token for a given user × meeting pair.
 *
 * The token is a 64-character hex string (32 random bytes) stored in
 * approvalTokens/{token}. It expires after `expiryHours` hours.
 *
 * @param uid        - Firebase Auth UID of the assignee
 * @param meetingId  - processedTranscripts document ID (Drive file ID)
 * @param expiryHours - How long the token remains valid (default: 48 h)
 * @returns The raw token string to embed in the review URL
 */
export async function generateApprovalToken(
  uid: string,
  meetingId: string,
  expiryHours = 48
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + expiryHours * 60 * 60 * 1000);

  const doc: ApprovalTokenDocument = {
    uid,
    meetingId,
    expiresAt,
    used: false,
    createdAt: now,
  };

  await db().collection("approvalTokens").doc(token).set(doc);
  return token;
}

/**
 * Validates an approval token and returns the associated uid + meetingId.
 *
 * Throws an error if the token:
 *   - Does not exist
 *   - Has already been used
 *   - Has expired
 *
 * Does NOT mark the token as used — call markApprovalTokenUsed() separately
 * after the review action is complete so the token can still be read by the
 * review page while processing.
 */
export async function validateApprovalToken(
  token: string
): Promise<{ uid: string; meetingId: string }> {
  const snap = await db().collection("approvalTokens").doc(token).get();

  if (!snap.exists) {
    throw new Error("Invalid or unknown approval token.");
  }

  const data = snap.data() as ApprovalTokenDocument;

  if (data.used) {
    throw new Error("This approval token has already been used.");
  }

  if (data.expiresAt.toMillis() < Date.now()) {
    throw new Error("This approval token has expired.");
  }

  return { uid: data.uid, meetingId: data.meetingId };
}

/**
 * Marks an approval token as consumed so it cannot be reused.
 * Call this after the review action (approve / reject) has been persisted.
 */
export async function markApprovalTokenUsed(token: string): Promise<void> {
  await db().collection("approvalTokens").doc(token).update({ used: true });
}

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
 * Atomically validates an approval token and marks it as consumed in a single
 * Firestore transaction, preventing replay attacks from concurrent requests.
 *
 * Throws an error if the token does not exist, has already been used, or has
 * expired. On success, returns the token's uid and meetingId.
 *
 * Prefer this over the separate validateApprovalToken() + markApprovalTokenUsed()
 * calls whenever consuming the token is the intended outcome (e.g. signing the
 * user in). The token is consumed before any downstream work (custom token
 * creation, etc.), so a concurrent request will fail the transaction even if
 * it arrives after the commit.
 */
export async function validateAndConsumeToken(
  token: string
): Promise<{ uid: string; meetingId: string }> {
  return db().runTransaction(async (transaction) => {
    const ref = db().collection("approvalTokens").doc(token);
    const snap = await transaction.get(ref);

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

    transaction.update(ref, { used: true, usedAt: Timestamp.now() });

    return { uid: data.uid, meetingId: data.meetingId };
  });
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
 *
 * @deprecated Use validateAndConsumeToken() instead, which validates and
 * marks the token used atomically in a single Firestore transaction, preventing
 * the race condition where two concurrent requests both pass validation.
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
 *
 * @deprecated Use validateAndConsumeToken() instead, which validates and
 * marks the token used atomically in a single Firestore transaction, preventing
 * the race condition where two concurrent requests both pass validation.
 */
export async function markApprovalTokenUsed(token: string): Promise<void> {
  await db().collection("approvalTokens").doc(token).update({ used: true });
}

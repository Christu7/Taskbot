import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { UserDocument, DEFAULT_PREFERENCES } from "../models/user";

const db = () => admin.firestore();
const usersCol = () => db().collection("users");

/**
 * Creates a new user document in Firestore with sensible defaults.
 * Should be called once, on first sign-in via the Auth onCreate trigger.
 *
 * @param uid - Firebase Auth UID (also used as the document ID)
 * @param data - Partial user data sourced from the Firebase Auth record
 * @returns The fully-populated UserDocument that was written to Firestore
 */
export async function createUser(
  uid: string,
  data: Pick<UserDocument, "email" | "displayName">
): Promise<UserDocument> {
  const now = FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp;

  const user: UserDocument = {
    uid,
    email: data.email,
    displayName: data.displayName,
    isActive: true,
    preferences: { ...DEFAULT_PREFERENCES },
    hasValidTokens: false,
    createdAt: now,
    updatedAt: now,
  };

  await usersCol().doc(uid).set(user);
  return user;
}

/**
 * Retrieves a user document from Firestore by UID.
 *
 * @param uid - Firebase Auth UID
 * @returns The UserDocument, or null if no document exists for this UID
 */
export async function getUser(uid: string): Promise<UserDocument | null> {
  const snap = await usersCol().doc(uid).get();
  if (!snap.exists) return null;
  return snap.data() as UserDocument;
}

/**
 * Applies a partial update to an existing user document.
 * Always stamps updatedAt with the server timestamp.
 *
 * @param uid - Firebase Auth UID
 * @param partial - Fields to update (nested paths supported via dot notation)
 */
export async function updateUser(
  uid: string,
  partial: Partial<Omit<UserDocument, "uid" | "createdAt">>
): Promise<void> {
  await usersCol().doc(uid).update({
    ...partial,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Returns all users with isActive === true.
 * Used by scheduled jobs to determine which users should have tasks processed.
 *
 * @returns Array of active UserDocuments
 */
export async function getActiveUsers(): Promise<UserDocument[]> {
  const snap = await usersCol().where("isActive", "==", true).get();
  return snap.docs.map((doc) => doc.data() as UserDocument);
}

/**
 * Finds a user by their email address.
 * Needed when matching meeting attendees to registered TaskBot users.
 *
 * @param email - Email address to search for
 * @returns The matching UserDocument, or null if no user has that email
 */
export async function getUserByEmail(email: string): Promise<UserDocument | null> {
  const snap = await usersCol().where("email", "==", email).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data() as UserDocument;
}

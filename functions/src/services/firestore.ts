import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { UserDocument, DEFAULT_PREFERENCES } from "../models/user";

const db = () => admin.firestore();
const usersCol = () => db().collection("users");

/**
 * Returns true when no user documents exist yet — i.e. the caller is the
 * first user to sign up. Used by the Auth onCreate trigger to auto-promote
 * the first user to the "admin" role.
 */
export async function isFirstUser(): Promise<boolean> {
  const snap = await usersCol().limit(1).get();
  return snap.empty;
}

/**
 * Returns the first active organization whose allowedDomains contains any of
 * the given domains, or null if none match.
 *
 * Used internally by createUser to validate the caller's email domain before
 * any Firestore writes occur.
 */
export async function getOrgByAllowedDomain(
  domain: string
): Promise<{ id: string; data: admin.firestore.DocumentData } | null> {
  const snap = await db()
    .collection("organizations")
    .where("allowedDomains", "array-contains", domain)
    .where("isActive", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

/**
 * Creates a new user document in Firestore with sensible defaults.
 * Should be called once, on first sign-in via the Auth onCreate trigger.
 *
 * Validates the user's email domain against active organizations **before**
 * writing anything to Firestore. Throws if the domain is unrecognized so the
 * caller can clean up the Auth account — no Firestore document is ever
 * created for a rejected user.
 *
 * @param uid  - Firebase Auth UID (also used as the document ID)
 * @param data - Partial user data sourced from the Firebase Auth record
 * @param role - Role to assign; defaults to "user"
 * @returns The fully-populated UserDocument that was written to Firestore
 * @throws If the email has no domain or the domain belongs to no active org
 */
export async function createUser(
  uid: string,
  data: Pick<UserDocument, "email" | "displayName">,
  role: "admin" | "user" = "user"
): Promise<UserDocument> {
  // ── 1. Validate domain before any write ───────────────────────────────────
  const domain = data.email.split("@")[1];
  if (!domain) {
    throw new Error(`Cannot create user: invalid email address "${data.email}"`);
  }

  const org = await getOrgByAllowedDomain(domain);
  if (!org) {
    throw new Error(`Domain not provisioned: ${domain}`);
  }

  // ── 2. Write user document ────────────────────────────────────────────────
  const now = FieldValue.serverTimestamp() as unknown as admin.firestore.Timestamp;

  const user: UserDocument = {
    uid,
    orgId: org.id,
    email: data.email,
    displayName: data.displayName,
    isActive: true,
    preferences: { ...DEFAULT_PREFERENCES },
    hasValidTokens: false,
    role,
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

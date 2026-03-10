import * as admin from "firebase-admin";
import { logger } from "firebase-functions";
import { TaskDestination, TaskData, ExternalTaskRef, DestinationTokens } from "./taskDestination";
import { GoogleTasksDestination } from "./googleTasksDestination";
import { AsanaDestination } from "./asanaDestination";
import { isAsanaConnected } from "../asana/asanaAuth";
import { normalizeTaskDestination } from "../../models/user";
import { getValidAccessToken } from "../../auth";
import { sendAsanaWarningEmail } from "../emailSender";

type ExternalRef = { destination: string; externalId: string; externalUrl: string };

const db = () => admin.firestore();

/**
 * Sends a warning email to the user when an Asana task creation was skipped
 * because their Asana account is not connected or has expired.
 * Fetches the user's tokens and email from Firestore — best-effort, non-fatal.
 */
async function sendAsanaFallbackWarning(uid: string): Promise<void> {
  const userSnap = await db().collection("users").doc(uid).get();
  const user = userSnap.data();
  if (!user?.email) return;

  const accessToken = await getValidAccessToken(uid);
  const email = user.email as string;
  const name = (user.displayName as string | undefined) || email;

  await sendAsanaWarningEmail(accessToken, email, email, name);
}

/**
 * Resolves an array of destination keys to live destination instances.
 * Skips Asana silently if the user hasn't connected it yet.
 */
async function resolveDestinations(
  uid: string,
  setting: ("google_tasks" | "asana")[]
): Promise<TaskDestination[]> {
  const dests: TaskDestination[] = [];

  if (setting.includes("google_tasks")) {
    dests.push(new GoogleTasksDestination());
  }

  if (setting.includes("asana")) {
    const connected = await isAsanaConnected(uid);
    if (connected) {
      dests.push(new AsanaDestination());
    } else {
      logger.warn(
        `taskRouter: user ${uid} has "asana" selected but Asana is not connected; skipping`
      );
      // Notify the user via email (best-effort — don't block task creation)
      sendAsanaFallbackWarning(uid).catch((err) =>
        logger.warn("taskRouter: asana warning email failed", {
          uid,
          error: (err as Error).message,
        })
      );
    }
  }

  // Safe fallback if nothing resolved (e.g. asana selected but not connected)
  return dests.length ? dests : [new GoogleTasksDestination()];
}

/**
 * Returns the list of TaskDestination instances configured for a user.
 * Falls back to org defaults when the user has no explicit preference.
 */
export async function getDestinationsForUser(uid: string): Promise<TaskDestination[]> {
  // 1. Check user-level preference
  const userSnap = await db().collection("users").doc(uid).get();
  const rawUserPref = userSnap.data()?.preferences?.taskDestination;

  if (rawUserPref !== undefined) {
    const pref = normalizeTaskDestination(rawUserPref);
    logger.debug(`taskRouter: user ${uid} has destination preference ${JSON.stringify(pref)}`);
    return resolveDestinations(uid, pref);
  }

  // 2. Fall back to org defaults
  const orgSnap = await db().collection("config").doc("orgDefaults").get();
  const orgPref = normalizeTaskDestination(orgSnap.data()?.taskDestination ?? "google_tasks");

  logger.debug(`taskRouter: user ${uid} inheriting org default destination ${JSON.stringify(orgPref)}`);
  return resolveDestinations(uid, orgPref);
}

/**
 * Marks a task as complete in every external system referenced by externalRefs.
 */
export async function completeExternalRefs(
  uid: string,
  externalRefs: ExternalRef[],
  accessToken: string
): Promise<void> {
  const tokens: DestinationTokens = { accessToken, uid };
  await Promise.all(
    externalRefs.map(async (ref) => {
      const dest: TaskDestination =
        ref.destination === "asana" ? new AsanaDestination() : new GoogleTasksDestination();
      try {
        await dest.completeTask(tokens, ref.externalId);
      } catch (err) {
        logger.warn(`completeExternalRefs: failed for ${ref.destination}/${ref.externalId}`, err);
      }
    })
  );
}

/**
 * Updates title/description/dueDate in every external system referenced by externalRefs.
 */
export async function updateExternalRefs(
  uid: string,
  externalRefs: ExternalRef[],
  accessToken: string,
  updates: Partial<TaskData>
): Promise<void> {
  const tokens: DestinationTokens = { accessToken, uid };
  await Promise.all(
    externalRefs.map(async (ref) => {
      const dest: TaskDestination =
        ref.destination === "asana" ? new AsanaDestination() : new GoogleTasksDestination();
      try {
        await dest.updateTask(tokens, ref.externalId, updates);
      } catch (err) {
        logger.warn(`updateExternalRefs: failed for ${ref.destination}/${ref.externalId}`, err);
      }
    })
  );
}

/**
 * Creates a task in every destination configured for the user.
 * Returns the external refs from all destinations.
 */
export async function routeTask(
  uid: string,
  taskData: TaskData,
  tokens: DestinationTokens
): Promise<ExternalTaskRef[]> {
  const destinations = await getDestinationsForUser(uid);
  const refs = await Promise.all(destinations.map((d) => d.createTask(tokens, taskData)));
  return refs;
}

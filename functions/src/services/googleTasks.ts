import { google } from "googleapis";
import { logger } from "firebase-functions";
import { createOAuthClient } from "../auth";
import { getUser, updateUser } from "./firestore";

const TASK_LIST_NAME = "MeetBot";

function buildTasksClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.tasks({ version: "v1", auth: authClient });
}

/**
 * Ensures the "TaskBot" task list exists in the user's Google Tasks account.
 * Caches the list ID on the user document to avoid repeated API calls on
 * subsequent task creations.
 *
 * @returns The Google Tasks list ID for the "TaskBot" list.
 */
export async function ensureTaskList(accessToken: string, uid: string): Promise<string> {
  // Return cached list ID if available
  const user = await getUser(uid);
  if (user?.taskListId) {
    return user.taskListId;
  }

  const tasks = buildTasksClient(accessToken);

  // Search existing lists for "TaskBot"
  const listRes = await tasks.tasklists.list({ maxResults: 100 });
  const existing = (listRes.data.items ?? []).find((l) => l.title === TASK_LIST_NAME);

  if (existing?.id) {
    await updateUser(uid, { taskListId: existing.id });
    return existing.id;
  }

  // Create the list
  const created = await tasks.tasklists.insert({
    requestBody: { title: TASK_LIST_NAME },
  });

  if (!created.data.id) {
    throw new Error("Failed to create TaskBot task list — API returned no ID");
  }

  await updateUser(uid, { taskListId: created.data.id });
  logger.info(`googleTasks: created "${TASK_LIST_NAME}" task list for user ${uid}`);
  return created.data.id;
}

interface TaskData {
  title: string;
  notes: string;
  due: string | null;
}

/**
 * Creates a task in the specified Google Tasks list.
 *
 * @returns The newly created task's ID.
 */
export async function createGoogleTask(
  accessToken: string,
  listId: string,
  taskData: TaskData
): Promise<string> {
  const tasks = buildTasksClient(accessToken);

  const requestBody: { title: string; notes: string; due?: string } = {
    title: taskData.title,
    notes: taskData.notes,
  };

  if (taskData.due) {
    // Google Tasks API requires RFC 3339 format for due dates.
    // If it's a date-only string (YYYY-MM-DD), append midnight UTC.
    requestBody.due = taskData.due.includes("T")
      ? taskData.due
      : `${taskData.due}T00:00:00.000Z`;
  }

  const res = await tasks.tasks.insert({
    tasklist: listId,
    requestBody,
  });

  if (!res.data.id) {
    throw new Error("Google Tasks API returned a task with no ID");
  }

  return res.data.id;
}

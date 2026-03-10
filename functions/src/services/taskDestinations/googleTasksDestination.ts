import { google } from "googleapis";
import { logger } from "firebase-functions";
import { createOAuthClient } from "../../auth";
import { getUser, updateUser } from "../firestore";
import { TaskDestination, TaskData, ExternalTaskRef, ExternalTaskStatus, GoogleTokens } from "./taskDestination";
import { TokenExpiredError } from "../../utils/errors";

const TASK_LIST_NAME = "TaskBot";

function buildTasksClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.tasks({ version: "v1", auth: authClient });
}

/**
 * Ensures the "TaskBot" task list exists in the user's Google Tasks account.
 * Caches the list ID on the user document to avoid repeated API calls.
 */
async function ensureTaskList(accessToken: string, uid: string): Promise<string> {
  const user = await getUser(uid);
  if (user?.taskListId) return user.taskListId;

  const tasks = buildTasksClient(accessToken);
  const listRes = await tasks.tasklists.list({ maxResults: 100 });
  const existing = (listRes.data.items ?? []).find((l) => l.title === TASK_LIST_NAME);

  if (existing?.id) {
    await updateUser(uid, { taskListId: existing.id });
    return existing.id;
  }

  const created = await tasks.tasklists.insert({
    requestBody: { title: TASK_LIST_NAME },
  });

  if (!created.data.id) {
    throw new Error("Failed to create TaskBot task list — API returned no ID");
  }

  await updateUser(uid, { taskListId: created.data.id });
  logger.info(`googleTasksDestination: created "${TASK_LIST_NAME}" task list for user ${uid}`);
  return created.data.id;
}

/**
 * Google Tasks implementation of TaskDestination.
 *
 * `tokens` shape: { accessToken: string, uid: string }
 */
export class GoogleTasksDestination implements TaskDestination {
  async createTask(
    tokens: GoogleTokens,
    taskData: TaskData
  ): Promise<ExternalTaskRef> {
    const { accessToken, uid } = tokens;
    const listId = await ensureTaskList(accessToken, uid);
    const tasksClient = buildTasksClient(accessToken);

    const sourceLines: string[] = [];
    if (taskData.sourceLink) sourceLines.push(`Source: ${taskData.sourceLink}`);
    sourceLines.push(
      `Extracted by TaskBot from: ${taskData.meetingTitle}` +
      (taskData.meetingDate ? ` (${taskData.meetingDate})` : "")
    );

    const notes = [taskData.description, "", "---", ...sourceLines].join("\n");

    const requestBody: { title: string; notes: string; due?: string } = {
      title: taskData.title,
      notes,
    };

    if (taskData.dueDate) {
      requestBody.due = taskData.dueDate.includes("T")
        ? taskData.dueDate
        : `${taskData.dueDate}T00:00:00.000Z`;
    }

    const res = await tasksClient.tasks.insert({ tasklist: listId, requestBody });

    if (!res.data.id) {
      throw new Error("Google Tasks API returned a task with no ID");
    }

    const externalId = res.data.id;
    // Build a deep link to the task. Google Tasks doesn't have stable per-task
    // deep links in the web UI, so we link to the list instead.
    const externalUrl = "https://tasks.google.com/";

    return { externalId, externalUrl, destination: "google_tasks" };
  }

  async updateTask(
    tokens: GoogleTokens,
    externalId: string,
    updates: Partial<TaskData>
  ): Promise<void> {
    const { accessToken, uid } = tokens;
    const listId = await ensureTaskList(accessToken, uid);
    const tasksClient = buildTasksClient(accessToken);

    const patch: Record<string, string> = {};
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.description !== undefined) patch.notes = updates.description;
    if (updates.dueDate !== undefined) {
      patch.due = updates.dueDate.includes("T")
        ? updates.dueDate
        : `${updates.dueDate}T00:00:00.000Z`;
    }

    await tasksClient.tasks.patch({ tasklist: listId, task: externalId, requestBody: patch });
  }

  async completeTask(
    tokens: GoogleTokens,
    externalId: string
  ): Promise<void> {
    const { accessToken, uid } = tokens;
    const listId = await ensureTaskList(accessToken, uid);
    const tasksClient = buildTasksClient(accessToken);

    await tasksClient.tasks.patch({
      tasklist: listId,
      task: externalId,
      requestBody: { status: "completed" },
    });
  }

  async getTask(
    tokens: GoogleTokens,
    externalId: string
  ): Promise<ExternalTaskStatus> {
    const { accessToken, uid } = tokens;

    let listId: string;
    try {
      listId = await ensureTaskList(accessToken, uid);
    } catch (err) {
      const status = (err as { status?: number; code?: number }).status
        ?? (err as { status?: number; code?: number }).code;
      if (status === 401 || status === 403) {
        throw new TokenExpiredError(uid, `Google Tasks auth error: ${(err as Error).message}`);
      }
      throw err;
    }

    const tasksClient = buildTasksClient(accessToken);

    try {
      const res = await tasksClient.tasks.get({ tasklist: listId, task: externalId });
      const data = res.data;

      // Google Tasks doesn't expose a reliable per-task modified timestamp in
      // the standard API response — `updated` is the best available proxy.
      const updatedStr = data.updated ?? data.due ?? null;
      const externalUpdatedAt = updatedStr ? new Date(updatedStr) : new Date(0);

      return {
        exists: true,
        title: data.title ?? "",
        description: data.notes ?? "",
        isCompleted: data.status === "completed",
        externalUpdatedAt,
        rawResponse: data,
      };
    } catch (err) {
      const status = (err as { status?: number; code?: number }).status
        ?? (err as { status?: number; code?: number }).code;

      if (status === 404) {
        return {
          exists: false,
          title: "",
          description: "",
          isCompleted: false,
          externalUpdatedAt: new Date(0),
          rawResponse: null,
        };
      }
      if (status === 401 || status === 403) {
        throw new TokenExpiredError(uid, `Google Tasks auth error (status ${status})`);
      }
      throw err;
    }
  }
}

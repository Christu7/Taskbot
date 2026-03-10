import * as admin from "firebase-admin";
import { logger } from "firebase-functions";
import { getValidAsanaAccessToken } from "../asana/asanaAuth";
import * as asanaApi from "../asana/asanaApi";
import {
  TaskDestination,
  TaskData,
  ExternalTaskRef,
  ExternalTaskStatus,
  GoogleTokens,
} from "./taskDestination";
import { TokenExpiredError } from "../../utils/errors";

function asanaHttpStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/HTTP (\d{3})/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Asana implementation of TaskDestination.
 *
 * `tokens` shape: { accessToken: string, uid: string }
 * The `uid` is used to:
 *   - Look up the user's configured asanaWorkspaceId and asanaProjectId
 *   - Refresh Asana tokens if needed (via getValidAsanaAccessToken)
 */
export class AsanaDestination implements TaskDestination {
  private async getProjectId(uid: string): Promise<string> {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    const projectId = snap.data()?.preferences?.asanaProjectId as string | undefined;
    if (!projectId) {
      throw new Error(
        `No Asana project configured for user ${uid}. ` +
        "Go to Settings → Task Destinations to select a workspace and project."
      );
    }
    return projectId;
  }

  private async getWorkspaceId(uid: string): Promise<string | undefined> {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    return snap.data()?.preferences?.asanaWorkspaceId as string | undefined;
  }

  async createTask(
    tokens: GoogleTokens,
    taskData: TaskData
  ): Promise<ExternalTaskRef> {
    const { uid } = tokens;
    // Always get a fresh token — Asana tokens may have different expiry than Google
    const accessToken = await getValidAsanaAccessToken(uid);

    const projectId = await this.getProjectId(uid);
    const workspaceId = await this.getWorkspaceId(uid);

    // Try to find the task assignee in the workspace by matching the user's own
    // email (since tasks are created in the assignee's account, they are "me").
    // For a shared-project model, look up by email instead.
    let assignee: string | null = "me";

    // Build Asana-formatted notes
    const sourceLines: string[] = [];
    if (taskData.sourceLink) sourceLines.push(`Source: ${taskData.sourceLink}`);
    sourceLines.push(
      `Extracted by TaskBot from: ${taskData.meetingTitle}` +
      (taskData.meetingDate ? ` (${taskData.meetingDate})` : "")
    );
    const notes = [taskData.description, "", "---", ...sourceLines].join("\n");

    // Asana uses YYYY-MM-DD for due dates — strip any time component
    const due_on = taskData.dueDate
      ? taskData.dueDate.split("T")[0]
      : undefined;

    // If assignee lookup via workspace fails gracefully, leave unassigned
    if (workspaceId) {
      try {
        const workspaceUsers = await asanaApi.getWorkspaceUsers(accessToken, workspaceId);
        const userSnap = await admin.firestore().collection("users").doc(uid).get();
        const userEmail = userSnap.data()?.email as string | undefined;
        if (userEmail) {
          const match = workspaceUsers.find(
            (u) => u.email?.toLowerCase() === userEmail.toLowerCase()
          );
          if (match) {
            assignee = match.gid;
          } else {
            logger.warn(
              `asanaDestination: user ${uid} (${userEmail}) not found in workspace ${workspaceId}; leaving unassigned`
            );
            assignee = null;
          }
        }
      } catch (err) {
        logger.warn("asanaDestination: workspace user lookup failed, using \"me\"", {
          error: (err as Error).message,
        });
      }
    }

    const created = await asanaApi.createTask(accessToken, {
      name: taskData.title,
      notes,
      ...(due_on ? { due_on } : {}),
      assignee,
      projects: [projectId],
    });

    const externalId = created.gid;
    const externalUrl = created.permalink_url ?? `https://app.asana.com/0/${projectId}/${externalId}`;

    logger.info(`asanaDestination: created task ${externalId} for user ${uid}`);
    return { externalId, externalUrl, destination: "asana" };
  }

  async updateTask(
    tokens: GoogleTokens,
    externalId: string,
    updates: Partial<TaskData>
  ): Promise<void> {
    const { uid } = tokens;
    const accessToken = await getValidAsanaAccessToken(uid);

    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.name = updates.title;
    if (updates.description !== undefined) body.notes = updates.description;
    if (updates.dueDate !== undefined) {
      body.due_on = updates.dueDate ? updates.dueDate.split("T")[0] : null;
    }

    await asanaApi.updateTask(accessToken, externalId, body);
  }

  async completeTask(tokens: GoogleTokens, externalId: string): Promise<void> {
    const { uid } = tokens;
    const accessToken = await getValidAsanaAccessToken(uid);
    await asanaApi.completeTask(accessToken, externalId);
  }

  async getTask(
    tokens: GoogleTokens,
    externalId: string
  ): Promise<ExternalTaskStatus> {
    const { uid } = tokens;

    let accessToken: string;
    try {
      accessToken = await getValidAsanaAccessToken(uid);
    } catch (err) {
      throw new TokenExpiredError(uid, `Asana token refresh failed: ${(err as Error).message}`);
    }

    try {
      const task = await asanaApi.getTask(accessToken, externalId);
      const externalUpdatedAt = task.modified_at ? new Date(task.modified_at) : new Date(0);

      return {
        exists: true,
        title: task.name,
        description: task.notes ?? "",
        isCompleted: task.completed,
        externalUpdatedAt,
        assigneeEmail: task.assignee?.email,
        rawResponse: task,
      };
    } catch (err) {
      const status = asanaHttpStatus(err);

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
        throw new TokenExpiredError(uid, `Asana auth error (status ${status})`);
      }
      throw err;
    }
  }
}

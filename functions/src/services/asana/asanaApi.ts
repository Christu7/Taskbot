/**
 * Thin Asana REST API client using the Node 22 built-in fetch.
 * Docs: https://developers.asana.com/reference/rest-api-reference
 */

import { fetchWithTimeout } from "../../utils/fetchWithTimeout";

const BASE = "https://app.asana.com/api/1.0";

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface AsanaWorkspace {
  gid: string;
  name: string;
  resource_type: string;
}

export interface AsanaProject {
  gid: string;
  name: string;
  resource_type: string;
}

export interface AsanaUser {
  gid: string;
  name: string;
  email?: string;
  resource_type: string;
}

export interface AsanaTaskResult {
  gid: string;
  name: string;
  notes?: string;
  completed: boolean;
  modified_at?: string;
  assignee?: { gid: string; name?: string; email?: string; resource_type?: string } | null;
  resource_type: string;
  permalink_url?: string;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function asanaRequest<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body !== undefined ? JSON.stringify({ data: body }) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Asana API ${method} ${path} failed (HTTP ${res.status}): ${text}`);
  }

  const json = await res.json() as { data: T };
  return json.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Lists all workspaces accessible to the authenticated user. */
export async function getWorkspaces(accessToken: string): Promise<AsanaWorkspace[]> {
  return asanaRequest<AsanaWorkspace[]>(accessToken, "GET", "/workspaces");
}

/** Lists all projects in a given workspace. */
export async function getProjects(
  accessToken: string,
  workspaceId: string
): Promise<AsanaProject[]> {
  return asanaRequest<AsanaProject[]>(
    accessToken,
    "GET",
    `/projects?workspace=${encodeURIComponent(workspaceId)}&opt_fields=gid,name`
  );
}

/**
 * Lists all members of a workspace.
 * Used to resolve a meeting-assigned email to an Asana user GID.
 */
export async function getWorkspaceUsers(
  accessToken: string,
  workspaceId: string
): Promise<AsanaUser[]> {
  return asanaRequest<AsanaUser[]>(
    accessToken,
    "GET",
    `/workspaces/${encodeURIComponent(workspaceId)}/users?opt_fields=gid,name,email`
  );
}

export interface CreateTaskInput {
  name: string;
  notes: string;
  due_on?: string;
  /** Asana user GID, or "me", or null to leave unassigned. */
  assignee?: string | null;
  projects: string[];
}

/** Creates a task and returns the full task object. */
export async function createTask(
  accessToken: string,
  input: CreateTaskInput
): Promise<AsanaTaskResult> {
  const body: Record<string, unknown> = {
    name: input.name,
    notes: input.notes,
    projects: input.projects,
  };
  if (input.due_on) body.due_on = input.due_on;
  if (input.assignee !== undefined) body.assignee = input.assignee;

  return asanaRequest<AsanaTaskResult>(accessToken, "POST", "/tasks", body);
}

/** Updates fields on an existing task. */
export async function updateTask(
  accessToken: string,
  taskGid: string,
  updates: Record<string, unknown>
): Promise<void> {
  await asanaRequest<AsanaTaskResult>(accessToken, "PUT", `/tasks/${encodeURIComponent(taskGid)}`, updates);
}

/** Marks a task as completed. */
export async function completeTask(
  accessToken: string,
  taskGid: string
): Promise<void> {
  await asanaRequest<AsanaTaskResult>(
    accessToken,
    "PUT",
    `/tasks/${encodeURIComponent(taskGid)}`,
    { completed: true }
  );
}

/** Returns the current state of a task with all sync-relevant fields. */
export async function getTask(
  accessToken: string,
  taskGid: string
): Promise<AsanaTaskResult> {
  return asanaRequest<AsanaTaskResult>(
    accessToken,
    "GET",
    `/tasks/${encodeURIComponent(taskGid)}?opt_fields=gid,name,notes,completed,modified_at,assignee,assignee.email,permalink_url`
  );
}

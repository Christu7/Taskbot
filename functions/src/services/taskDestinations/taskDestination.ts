/**
 * Shared data types and the TaskDestination interface used by every destination
 * adapter (Google Tasks, Asana, etc.).
 */

/** Canonical task payload passed to every destination. */
export interface TaskData {
  title: string;
  description: string;
  dueDate?: string;
  /** Drive transcript URL */
  sourceLink: string;
  meetingTitle: string;
  meetingDate: string;
}

/** Reference to a task that was created in an external system. */
export interface ExternalTaskRef {
  /** The ID of the task in the external system. */
  externalId: string;
  /** Deep link to the task in the external system's UI. */
  externalUrl: string;
  /** Which system owns this task. */
  destination: "google_tasks" | "asana";
}

/** Current status of a task as returned by the external system. */
export interface ExternalTaskStatus {
  /** False if the task has been deleted in the external system (404 response). */
  exists: boolean;
  title: string;
  description: string;
  isCompleted: boolean;
  /** When the external system last modified this task. */
  externalUpdatedAt: Date;
  /** Assignee email address if the external system provides it (Asana only). */
  assigneeEmail?: string;
  /** Full raw API response, stored for debugging. */
  rawResponse: unknown;
}

/** Token shape passed to Google Tasks destination methods. */
export interface GoogleTokens {
  accessToken: string;
  uid: string;
}

/** Union of all token shapes — extend when new destinations are added. */
export type DestinationTokens = GoogleTokens;

/**
 * All destination adapters must implement this interface.
 * The `tokens` parameter carries the OAuth credentials needed by each system.
 */
export interface TaskDestination {
  createTask(tokens: DestinationTokens, taskData: TaskData): Promise<ExternalTaskRef>;
  updateTask(tokens: DestinationTokens, externalId: string, updates: Partial<TaskData>): Promise<void>;
  completeTask(tokens: DestinationTokens, externalId: string): Promise<void>;
  getTask(tokens: DestinationTokens, externalId: string): Promise<ExternalTaskStatus>;
}

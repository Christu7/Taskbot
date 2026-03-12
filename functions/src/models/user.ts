import { Timestamp } from "firebase-admin/firestore";

/** Notification delivery channels. Stored as an array; at least one must be selected. */
export type NotifyVia = ("email" | "slack")[];

/** Task destination options. Stored as an array; at least one must be selected. */
export type TaskDestinationPreference = ("google_tasks" | "asana")[];

/**
 * Normalises legacy single-string notifyVia values (written before the
 * checkbox refactor) into the current array format.
 */
export function normalizeNotifyVia(val: unknown): ("email" | "slack")[] {
  if (Array.isArray(val)) return val as ("email" | "slack")[];
  if (val === "both") return ["email", "slack"];
  if (val === "slack") return ["slack"];
  return ["email"]; // default / "email" / anything unknown
}

/**
 * Normalises legacy single-string taskDestination values into the current
 * array format.
 */
export function normalizeTaskDestination(val: unknown): ("google_tasks" | "asana")[] {
  if (Array.isArray(val)) return val as ("google_tasks" | "asana")[];
  if (val === "both") return ["google_tasks", "asana"];
  if (val === "asana") return ["asana"];
  return ["google_tasks"]; // default / "google_tasks" / anything unknown
}

/** User-configurable preferences stored on their Firestore document. */
export interface UserPreferences {
  /** How to notify the user. Only "email" is supported in the MVP. */
  notifyVia: NotifyVia;
  /** When true, incoming tasks are approved automatically without user review. */
  autoApprove: boolean;
  /** How many hours a pending proposal stays open before it expires. Default: 48. */
  proposalExpiryHours: number;
  /**
   * Which task system(s) to send approved tasks to.
   * When absent, the org default (config/orgDefaults.taskDestination) is used.
   */
  taskDestination?: TaskDestinationPreference;
  /** Asana workspace GID selected by the user. */
  asanaWorkspaceId?: string;
  /** Asana project GID selected by the user. */
  asanaProjectId?: string;
  /** Slack member ID (e.g. "U0123456") — populated by the Slack connect flow. */
  slackUserId?: string;
}

/**
 * Shape of the document stored at users/{uid} in Firestore.
 *
 * @example
 * const user: UserDocument = {
 *   uid: "abc123",
 *   email: "alice@example.com",
 *   displayName: "Alice",
 *   isActive: true,
 *   preferences: { notifyVia: "email", autoApprove: false, proposalExpiryHours: 48 },
 *   hasValidTokens: false,
 *   createdAt: Timestamp.now(),
 *   updatedAt: Timestamp.now(),
 * };
 */
export interface UserDocument {
  /** Firebase Auth UID — mirrors the document ID. */
  uid: string;
  /** User's email address from Firebase Auth. */
  email: string;
  /** User's display name from Firebase Auth. */
  displayName: string;
  /**
   * Master on/off toggle for the TaskBot service.
   * When false, no tasks are processed for this user.
   * Default: true.
   */
  isActive: boolean;
  /** Per-user notification and behaviour preferences. */
  preferences: UserPreferences;
  /**
   * Computed flag: true when we hold a valid (non-expired) refresh token for
   * this user in users/{uid}/tokens/google. Updated after each OAuth flow.
   */
  hasValidTokens: boolean;
  /**
   * Cached Google Tasks list ID for the "TaskBot" list.
   * Populated by ensureTaskList() on first task creation to avoid repeated
   * list-lookup API calls on subsequent task creations.
   */
  taskListId?: string;
  /**
   * The active AI provider for this user ("anthropic" | "openai").
   * When absent, the server falls back to the AI_PROVIDER env var (default: "anthropic").
   */
  aiProvider?: string;
  /**
   * Role-based access level.
   * - "admin": can manage org settings, users, and credentials via the admin panel.
   * - "project_manager": can view and edit all tasks across all users, but cannot
   *   manage system configuration (credentials, user roles, org settings).
   * - "user": default role; can only manage their own tasks and preferences.
   * The first user to sign up is automatically assigned "admin".
   */
  role: "admin" | "project_manager" | "user";
  /** UID of the admin who last changed this user's role. */
  promotedBy?: string;
  /** When the role was last changed. */
  promotedAt?: Timestamp;
  /** When the document was first created. */
  createdAt: Timestamp;
  /** When the document was last updated. */
  updatedAt: Timestamp;
}

/** Default preferences applied when a new user document is created. */
export const DEFAULT_PREFERENCES: UserPreferences = {
  notifyVia: ["email"],
  autoApprove: false,
  proposalExpiryHours: 48,
};

import { Timestamp } from "firebase-admin/firestore";

/** Notification delivery channels available to the user. MVP only supports email. */
export type NotifyVia = "email";

/** User-configurable preferences stored on their Firestore document. */
export interface UserPreferences {
  /** How to notify the user. Only "email" is supported in the MVP. */
  notifyVia: NotifyVia;
  /** When true, incoming tasks are approved automatically without user review. */
  autoApprove: boolean;
  /** How many hours a pending proposal stays open before it expires. Default: 48. */
  proposalExpiryHours: number;
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
  /** When the document was first created. */
  createdAt: Timestamp;
  /** When the document was last updated. */
  updatedAt: Timestamp;
}

/** Default preferences applied when a new user document is created. */
export const DEFAULT_PREFERENCES: UserPreferences = {
  notifyVia: "email",
  autoApprove: false,
  proposalExpiryHours: 48,
};

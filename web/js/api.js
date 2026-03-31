// API client — thin wrapper around fetch that adds Firebase auth headers.
// All requests use relative URLs so Firebase Hosting handles routing in
// both production and the local emulator.

import { auth } from "./firebase-config.js";

async function getAuthHeaders() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function request(method, path, body) {
  const headers = await getAuthHeaders();
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  // ── Proposals ────────────────────────────────────────────────────────────
  /** Returns meetings grouped with their pending proposals. */
  getPendingMeetings: () => request("GET", "/proposals/pending"),

  /** Returns all proposals for a specific meeting. */
  getMeetingProposals: (meetingId) =>
    request("GET", `/proposals?meetingId=${encodeURIComponent(meetingId)}`),

  /** Approve, reject, or edit a single proposal. */
  updateProposal: (meetingId, taskId, body) =>
    request("PATCH", `/proposals/${meetingId}/${taskId}`, body),

  /** Bulk approve or reject all pending proposals for a meeting.
   *  taskOverrides: optional map of taskId → { asanaProjectId } for per-task routing. */
  bulkAction: (meetingId, action, taskOverrides) =>
    request("PATCH", `/proposals/${meetingId}/bulk`, {
      action,
      ...(taskOverrides ? { taskOverrides } : {}),
    }),

  /** Returns a single proposal by ID. Used for polling after approval. */
  getProposal: (meetingId, taskId) =>
    request("GET", `/proposals/${encodeURIComponent(meetingId)}/${encodeURIComponent(taskId)}`),

  // ── Settings ─────────────────────────────────────────────────────────────
  getSettings: () => request("GET", "/settings"),

  updateSettings: (body) => request("PATCH", "/settings", body),

  // ── API Key Management ────────────────────────────────────────────────────
  /** Returns { activeProvider, providers: { anthropic: {configured, masked}, openai: {...} } } */
  getApiKeys: () => request("GET", "/settings/api-keys"),

  /** Saves an API key for the given provider. Returns { masked }. */
  addApiKey: (provider, key) => request("POST", `/settings/api-keys/${provider}`, { key }),

  /** Removes the API key for the given provider. */
  removeApiKey: (provider) => request("DELETE", `/settings/api-keys/${provider}`),

  /** Sets the active AI provider (must have a key saved first). */
  setActiveProvider: (provider) => request("PATCH", "/settings/api-keys/active", { provider }),

  // ── Asana ─────────────────────────────────────────────────────────────────
  /** Returns { connected, asanaWorkspaceId, asanaProjectId, taskDestination }. */
  getAsanaSettings: () => request("GET", "/settings/asana"),

  /** Lists Asana workspaces for the authenticated user. */
  getAsanaWorkspaces: () => request("GET", "/settings/asana/workspaces"),

  /** Lists Asana projects for a workspace. */
  getAsanaProjects: (workspaceId) =>
    request("GET", `/settings/asana/projects?workspaceId=${encodeURIComponent(workspaceId)}`),

  /** Disconnects the user's Asana account. */
  disconnectAsana: () => request("DELETE", "/settings/asana"),

  // ── Slack ──────────────────────────────────────────────────────────────────
  /** Returns { connected, slackUserId, notifyVia }. */
  getSlackSettings: () => request("GET", "/settings/slack"),

  /** Looks up the user's Slack account by email and saves their slackUserId. */
  connectSlack: (slackEmail) => request("POST", "/settings/slack/connect", { slackEmail }),

  /** Removes the user's slackUserId. */
  disconnectSlack: () => request("DELETE", "/settings/slack"),

  // ── Tasks ─────────────────────────────────────────────────────────────────
  /** Returns active tasks (created, in_progress, completed) for the user.
   *  For PM/admin, accepts optional params: { viewAll: true } or { userId: uid }. */
  getTasks: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.viewAll) qs.set("viewAll", "true");
    if (params.userId) qs.set("userId", params.userId);
    const q = qs.toString();
    return request("GET", `/tasks${q ? "?" + q : ""}`);
  },

  /** Updates title, description, dueDate, status, or assigneeUid for a task. */
  updateTask: (meetingId, taskId, body) =>
    request("PATCH", `/tasks/${encodeURIComponent(meetingId)}/${encodeURIComponent(taskId)}`, body),

  /** Marks a task completed in Firestore and in external systems. */
  completeTask: (meetingId, taskId) =>
    request("POST", `/tasks/${encodeURIComponent(meetingId)}/${encodeURIComponent(taskId)}/complete`),

  /** Reopens a completed task (status → in_progress). */
  reopenTask: (meetingId, taskId) =>
    request("POST", `/tasks/${encodeURIComponent(meetingId)}/${encodeURIComponent(taskId)}/reopen`),

  /** Returns all active TaskBot users for the reassign dropdown. */
  getActiveUsers: () => request("GET", "/users/active"),

  /** Reassigns a pending proposal to another user. Admin/PM only. */
  reassignProposal: (meetingId, taskId, newAssigneeUid) =>
    request("PATCH", `/proposals/${encodeURIComponent(meetingId)}/${encodeURIComponent(taskId)}/reassign`, { newAssigneeUid }),

  // ── Sync ──────────────────────────────────────────────────────────────────
  /** Triggers an immediate sync for the current user. Returns { synced, errors, deleted }. */
  syncNow: () => request("POST", "/sync/now"),

  /**
   * Recreates a task in its external system after it was deleted there.
   * (Calls the task-update endpoint with a special recreate flag.)
   */
  recreateTask: (meetingId, taskId) =>
    request("POST", `/tasks/${encodeURIComponent(meetingId)}/${encodeURIComponent(taskId)}/recreate`),

  // ── Org Defaults (admin only) ─────────────────────────────────────────────
  /** Returns { notifyVia, taskDestination } org-wide defaults. Admin only. */
  getOrgDefaults: () => request("GET", "/config/org-defaults"),

  /** Updates org-wide defaults. Admin only. */
  updateOrgDefaults: (body) => request("PATCH", "/config/org-defaults", body),

  // ── Admin: Secrets ────────────────────────────────────────────────────────
  /** Returns masked credential status for all integrations. Admin only. */
  getAdminSecrets: () => request("GET", "/admin/secrets"),

  /** Saves credentials. Only provided fields are written. Admin only. */
  setAdminSecrets: (body) => request("PUT", "/admin/secrets", body),

  /** Tests each configured credential and returns health status. Admin only. */
  testAdminSecrets: () => request("POST", "/admin/secrets/test"),

  // ── Admin: User Management ────────────────────────────────────────────────
  /** Returns an enriched list of all registered users. Admin only. Accepts optional search/role/status params. */
  listUsers: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.role) qs.set("role", params.role);
    if (params.status) qs.set("status", params.status);
    const q = qs.toString();
    return request("GET", `/admin/users${q ? "?" + q : ""}`);
  },

  /** Returns aggregate stats: { total, active, admins, connectedAsana, connectedSlack }. Admin only. */
  getUserStats: () => request("GET", "/admin/users/stats"),

  /** Invites a user by email — stores the invite and sends a sign-in link. Admin only. */
  inviteUser: (email) => request("POST", "/admin/invite", { email }),

  /** Activates or deactivates multiple users at once. Admin only. */
  bulkSetUserStatus: (uids, isActive) => request("PATCH", "/admin/users/bulk-status", { uids, isActive }),

  /** Sets a user's role to "admin" or "user". Admin only. */
  setUserRole: (uid, role) => request("PATCH", `/admin/users/${encodeURIComponent(uid)}/role`, { role }),

  /** Activates or deactivates a user account. Admin only. */
  setUserStatus: (uid, isActive) => request("PATCH", `/admin/users/${encodeURIComponent(uid)}/status`, { isActive }),

  /** Permanently deletes a user. Admin only. */
  deleteUser: (uid) => request("DELETE", `/admin/users/${encodeURIComponent(uid)}`),

  // ── Admin: Dashboard, Activity, Meetings ─────────────────────────────────
  /** Returns summary stats + integration health for the admin dashboard. Admin only. */
  getDashboard: () => request("GET", "/admin/dashboard"),

  /** Returns the most recent activity log entries. Admin only. */
  getActivity: (limit = 20) => request("GET", `/admin/activity?limit=${limit}`),

  /** Returns paginated processed meetings. Admin only. */
  getMeetings: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return request("GET", `/admin/meetings${q ? "?" + q : ""}`);
  },

  /** Reprocesses a failed or awaiting_configuration meeting. Admin only. */
  reprocessMeeting: (meetingId) => request("POST", `/admin/meetings/${encodeURIComponent(meetingId)}/reprocess`),

  /** Returns proposals for a specific meeting. Admin only. */
  getProposalsForMeeting: (meetingId) => request("GET", `/admin/meetings/${encodeURIComponent(meetingId)}/proposals`),

  // ── Admin: Setup Wizard ───────────────────────────────────────────────────
  /** Returns setup wizard state: { completed, completedAt, steps }. Admin only. */
  getSetupStatus: () => request("GET", "/admin/setup-status"),

  /** Marks the setup wizard as completed. Admin only. */
  completeSetup: () => request("POST", "/admin/setup-complete"),

  // ── Admin: Export ─────────────────────────────────────────────────────────
  /**
   * Exports all Firestore data as a JSON file download.
   * Encrypted secrets are excluded. Admin only.
   */
  exportData: async () => {
    const headers = await (async () => {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      const token = await user.getIdToken();
      return { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
    })();
    const res = await fetch("/api/admin/export", { method: "POST", headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Export failed (${res.status})`);
    }
    return res; // Caller receives raw Response to handle the Blob download
  },

  // ── Transcripts status (dashboard banner) ────────────────────────────────
  /** Returns { count } of transcripts stuck in awaiting_configuration. */
  getAwaitingCount: () => request("GET", "/transcripts/awaiting"),

  // ── Token-based auth (email link, no Firebase auth needed yet) ───────────
  validateToken: async (token) => {
    const res = await fetch("/api/auth/validate-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Token validation failed");
    }
    return res.json();
  },
};

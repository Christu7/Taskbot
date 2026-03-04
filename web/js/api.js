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

  /** Bulk approve or reject all pending proposals for a meeting. */
  bulkAction: (meetingId, action) =>
    request("PATCH", `/proposals/${meetingId}/bulk`, { action }),

  // ── Settings ─────────────────────────────────────────────────────────────
  getSettings: () => request("GET", "/settings"),

  updateSettings: (body) => request("PATCH", "/settings", body),

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

// OAuth scopes requested in the secondary consent flow.
// These are in addition to the basic identity scopes Firebase Auth handles.
export const OAUTH_SCOPES: string[] = [
  "openid",
  "email",
  "profile",
  // Read meeting transcripts from Google Drive
  "https://www.googleapis.com/auth/drive.readonly",
  // Create and manage tasks in Google Tasks
  "https://www.googleapis.com/auth/tasks",
  // Read calendar events to identify attendees
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

// State tokens expire after 10 minutes.
// If a user takes longer than this to complete the consent screen, they'll need to restart.
export const STATE_TTL_MS = 10 * 60 * 1000;

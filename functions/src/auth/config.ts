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
  // Send notification emails on behalf of the user
  "https://www.googleapis.com/auth/gmail.send",
  // Read Gmail messages to detect Gemini Notes emails (gmailWatcher)
  // NOTE: adding this scope requires existing users to re-authorise via Settings → Reconnect
  "https://www.googleapis.com/auth/gmail.readonly",
];

// State tokens expire after 10 minutes.
// If a user takes longer than this to complete the consent screen, they'll need to restart.
export const STATE_TTL_MS = 10 * 60 * 1000;

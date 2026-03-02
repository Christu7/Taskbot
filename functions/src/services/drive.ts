import { google } from "googleapis";
import { createOAuthClient } from "../auth";

/** A single Google Meet transcript file returned by Drive search. */
export interface TranscriptFile {
  /** Google Drive file ID. */
  fileId: string;
  /** Full file name as it appears in Drive (e.g. "Meeting transcript - Weekly Sync - 2026-03-02"). */
  fileName: string;
  /** ISO 8601 creation timestamp returned by the Drive API. */
  createdTime: string;
  /** URL to open the file in Google Docs. */
  webViewLink: string;
}

/**
 * Builds an authenticated Google Drive client for a specific user.
 * Uses the provided access token directly — callers are responsible for
 * ensuring the token is valid (i.e. call getValidAccessToken first).
 *
 * @param accessToken - A valid, non-expired OAuth access token for the user
 */
function buildDriveClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth: authClient });
}

/**
 * Searches a user's Google Drive for Google Meet transcript documents
 * created or modified after the given timestamp.
 *
 * Google Meet transcripts are Google Docs whose names match the pattern:
 *   "Meeting transcript - <meeting name> - <date>"
 *
 * The Drive query used:
 *   mimeType='application/vnd.google-apps.document'
 *   and name contains 'transcript'
 *   and modifiedTime > '<sinceTimestamp ISO>'
 *
 * @param accessToken  - Valid OAuth access token for the user
 * @param sinceTimestamp - Only return files modified after this date
 * @returns Array of matching transcript file metadata (may be empty)
 */
export async function findNewTranscripts(
  accessToken: string,
  sinceTimestamp: Date
): Promise<TranscriptFile[]> {
  const drive = buildDriveClient(accessToken);
  const isoSince = sinceTimestamp.toISOString();

  const query = [
    "mimeType='application/vnd.google-apps.document'",
    "name contains 'transcript'",
    `modifiedTime > '${isoSince}'`,
    "trashed = false",
  ].join(" and ");

  const response = await drive.files.list({
    q: query,
    fields: "files(id, name, createdTime, webViewLink)",
    orderBy: "createdTime desc",
    pageSize: 50, // Reasonable upper bound per poll cycle
  });

  const files = response.data.files ?? [];

  return files
    .filter((f) => f.id && f.name && f.createdTime && f.webViewLink)
    .map((f) => ({
      fileId: f.id as string,
      fileName: f.name as string,
      createdTime: f.createdTime as string,
      webViewLink: f.webViewLink as string,
    }));
}

/**
 * Exports a Google Doc as plain text via the Drive API.
 *
 * The Drive `files.export` endpoint converts Google Workspace formats
 * (Docs, Sheets, etc.) to standard MIME types. We request text/plain
 * so downstream processing works on raw transcript text without HTML.
 *
 * @param accessToken - Valid OAuth access token for the user
 * @param fileId      - Google Drive file ID of the transcript document
 * @returns The full transcript as a UTF-8 plain-text string
 */
export async function getTranscriptContent(
  accessToken: string,
  fileId: string
): Promise<string> {
  const drive = buildDriveClient(accessToken);

  const response = await drive.files.export(
    { fileId, mimeType: "text/plain" },
    { responseType: "text" }
  );

  // The axios response body is typed as `unknown` for text responses
  return String(response.data);
}

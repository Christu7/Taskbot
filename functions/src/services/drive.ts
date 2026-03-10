import { google, docs_v1 } from "googleapis";

// Local type definitions for the Docs Tabs API, which was added after the
// version of googleapis currently installed. The runtime API supports it;
// we just need to define the types ourselves.
interface DocTabProperties {
  title?: string;
}
interface DocTab {
  tabProperties?: DocTabProperties;
  documentTab?: {
    body?: {
      content?: docs_v1.Schema$StructuralElement[];
    };
  };
}
import { createOAuthClient } from "../auth";
import { logger } from "firebase-functions";
import { TokenExpiredError, TranscriptNotFoundError, APIQuotaError } from "../utils/errors";

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
 * Content extracted from a Google Meet document.
 *
 * plain_transcript — Classic "Meeting transcript" Google Doc exported as plain text.
 * gemini_notes     — Gemini Notes doc with a "Transcript" tab (and optionally a "Notes" tab).
 *
 * NOTE ON SCOPES: The Docs API `documents.get` call used for tab detection is covered
 * by the `drive.readonly` scope already requested during OAuth. No additional scope is needed.
 */
export interface TranscriptContent {
  /** The raw transcript text — the authoritative source for action items. */
  transcript: string;
  /**
   * AI-generated meeting summary from the "Notes" tab.
   * Only present when format === "gemini_notes" and the Notes tab was found.
   */
  notes?: string;
  /** Which document format was detected. */
  format: "plain_transcript" | "gemini_notes";
}

/**
 * Builds an authenticated Google Drive client.
 */
function buildDriveClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth: authClient });
}

/**
 * Builds an authenticated Google Docs client.
 * The Docs API `documents.get` method is covered by the `drive.readonly` OAuth scope.
 */
function buildDocsClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.docs({ version: "v1", auth: authClient });
}

/** Extract HTTP status from a googleapis error object. */
function getErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; response?: { status?: number } };
  return e.status ?? e.code ?? e.response?.status;
}

/**
 * Extracts plain text from a Docs API `StructuralElement` array.
 * Handles paragraphs and basic table cells; ignores structural elements
 * that don't contain user-readable text (e.g. section breaks).
 */
function extractTextFromStructuralElements(
  elements: docs_v1.Schema$StructuralElement[]
): string {
  const parts: string[] = [];

  for (const elem of elements) {
    if (elem.paragraph?.elements) {
      for (const pe of elem.paragraph.elements) {
        if (pe.textRun?.content) {
          parts.push(pe.textRun.content);
        }
      }
    } else if (elem.table?.tableRows) {
      for (const row of elem.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          const cellText = extractTextFromStructuralElements(cell.content ?? []);
          if (cellText) parts.push(cellText + "\n");
        }
      }
    }
  }

  return parts.join("").trim();
}

// ─── Pattern A: classic transcript files ─────────────────────────────────────

/**
 * Pattern A: queries for Google Docs with "transcript" in the filename.
 * This is the original Google Meet transcript format.
 */
async function findPatternAFiles(
  drive: ReturnType<typeof buildDriveClient>,
  isoSince: string
): Promise<TranscriptFile[]> {
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
    pageSize: 50,
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

// ─── Pattern B: Gemini Notes files ───────────────────────────────────────────

/**
 * Pattern B: queries for Google Docs inside the "My Meeting Notes" folder.
 *
 * When Google Meet generates Gemini Notes, it creates a Google Doc named after
 * the meeting (no "transcript" in the name) inside this specific folder.
 * The doc contains two tabs: "Notes" (AI summary) and "Transcript" (raw text).
 *
 * Returns an empty array if the folder doesn't exist (user hasn't used Gemini
 * Notes yet) or if the Drive API call fails — failure is non-fatal.
 */
async function findPatternBFiles(
  drive: ReturnType<typeof buildDriveClient>,
  isoSince: string
): Promise<TranscriptFile[]> {
  // Step 1: Find the "My Meeting Notes" folder
  let folderId: string;
  try {
    const folderRes = await drive.files.list({
      q: [
        "mimeType='application/vnd.google-apps.folder'",
        "name='My Meeting Notes'",
        "trashed = false",
      ].join(" and "),
      fields: "files(id, name)",
      pageSize: 5,
    });

    const folders = folderRes.data.files ?? [];
    if (folders.length === 0) {
      // Log at info level so it's visible in Cloud Function logs during debugging.
      // This is the most common reason Pattern B finds nothing.
      logger.info(
        "findPatternBFiles: 'My Meeting Notes' folder not found in Drive — " +
        "user may not have used Gemini Notes yet, or the folder has a different name"
      );
      return [];
    }
    folderId = folders[0].id as string;
    logger.info(
      `findPatternBFiles: found 'My Meeting Notes' folder (id: ${folderId}), ` +
      `searching for docs modified after ${isoSince}`
    );
  } catch (err) {
    // Folder lookup failure is non-fatal — Pattern A still works
    logger.warn("findPatternBFiles: folder lookup failed (non-fatal)", { error: (err as Error).message });
    return [];
  }

  // Step 2: Find recent Google Docs in that folder
  try {
    const query = [
      "mimeType='application/vnd.google-apps.document'",
      `'${folderId}' in parents`,
      `modifiedTime > '${isoSince}'`,
      "trashed = false",
    ].join(" and ");

    const response = await drive.files.list({
      q: query,
      fields: "files(id, name, createdTime, webViewLink)",
      orderBy: "createdTime desc",
      pageSize: 50,
    });

    const files = response.data.files ?? [];
    logger.info(
      `findPatternBFiles: found ${files.length} candidate Gemini Notes doc(s) in 'My Meeting Notes' folder`
    );
    return files
      .filter((f) => f.id && f.name && f.createdTime && f.webViewLink)
      .map((f) => ({
        fileId: f.id as string,
        fileName: f.name as string,
        createdTime: f.createdTime as string,
        webViewLink: f.webViewLink as string,
      }));
  } catch (err) {
    logger.warn("findPatternBFiles: folder contents lookup failed (non-fatal)", { error: (err as Error).message });
    return [];
  }
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Searches a user's Google Drive for Google Meet documents (both formats):
 *
 * Pattern A — Classic transcript: name contains "transcript"
 *   e.g. "Meeting transcript - Weekly Sync - Feb 25, 2026"
 *
 * Pattern B — Gemini Notes: Google Doc in "My Meeting Notes" folder
 *   e.g. "Weekly Sync" (no date in name; doc has "Notes" + "Transcript" tabs)
 *
 * Results from both patterns are combined and deduplicated by Drive file ID.
 *
 * @param accessToken    - Valid OAuth access token for the user
 * @param sinceTimestamp - Only return files modified after this date
 * @returns Array of matching file metadata (may be empty)
 * @throws TokenExpiredError if the access token is revoked/expired
 * @throws APIQuotaError if the Drive quota is exceeded
 */
export async function findNewTranscripts(
  accessToken: string,
  sinceTimestamp: Date
): Promise<TranscriptFile[]> {
  const drive = buildDriveClient(accessToken);
  const isoSince = sinceTimestamp.toISOString();

  try {
    // Run both pattern queries concurrently — Pattern B failure is handled internally
    const [patternA, patternB] = await Promise.all([
      findPatternAFiles(drive, isoSince),
      findPatternBFiles(drive, isoSince),
    ]);

    // Merge and deduplicate by file ID (a file can't match both patterns, but be safe)
    const seen = new Set<string>();
    const combined: TranscriptFile[] = [];
    for (const file of [...patternA, ...patternB]) {
      if (!seen.has(file.fileId)) {
        seen.add(file.fileId);
        combined.push(file);
      }
    }

    return combined;
  } catch (err) {
    const status = getErrorStatus(err);
    const message = (err as Error).message ?? "";

    if (status === 401 || message.includes("401") || message.toLowerCase().includes("unauthorized")) {
      throw new TokenExpiredError("unknown", `Drive API auth error: ${message}`);
    }
    if (status === 429 || message.includes("429") || message.toLowerCase().includes("quota")) {
      throw new APIQuotaError("Google Drive", message);
    }
    throw err;
  }
}

/**
 * Fetches and returns the content of a Google Meet document.
 *
 * Format detection strategy:
 *   1. Call the Google Docs API with `includeTabsContent: true`.
 *   2. If the response has a tab named "Transcript", this is a Gemini Notes doc.
 *      Extract the "Transcript" tab text and, if present, the "Notes" tab text.
 *   3. Otherwise, fall back to the Drive `files.export` API for plain-text export.
 *
 * SCOPE NOTE: The Docs API `documents.get` call is covered by the `drive.readonly`
 * scope already granted during OAuth. No additional scope is required.
 *
 * @param accessToken - Valid OAuth access token for the user
 * @param fileId      - Google Drive file ID of the document
 * @returns Extracted transcript content with format annotation
 * @throws TranscriptNotFoundError if the file does not exist or is inaccessible
 * @throws TokenExpiredError if the access token is revoked/expired
 * @throws APIQuotaError if the Drive quota is exceeded
 */
export async function getTranscriptContent(
  accessToken: string,
  fileId: string
): Promise<TranscriptContent> {
  const drive = buildDriveClient(accessToken);
  const docs = buildDocsClient(accessToken);

  // ── Step 1: Try the Docs API to detect the tab structure ─────────────────
  // `includeTabsContent` is not yet in the googleapis TypeScript types, so we
  // pass it via query params and cast the response to the known schema type.
  try {
    const docRes = await docs.documents.get(
      { documentId: fileId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: { includeTabsContent: true } } as any
    );

    const docData = docRes.data as unknown as Record<string, unknown>;
    const tabs: DocTab[] = (docData.tabs as DocTab[] | undefined) ?? [];

    // Look for a tab explicitly named "Transcript" (case-insensitive)
    const transcriptTab = tabs.find(
      (t) => t.tabProperties?.title?.toLowerCase() === "transcript"
    );

    if (transcriptTab) {
      // ── Gemini Notes format: extract per-tab content ───────────────────
      const transcriptText = extractTextFromStructuralElements(
        transcriptTab.documentTab?.body?.content ?? []
      );

      // Also extract the "Notes" tab if present
      const notesTab = tabs.find(
        (t) => t.tabProperties?.title?.toLowerCase() === "notes"
      );
      const notesText = notesTab
        ? extractTextFromStructuralElements(notesTab.documentTab?.body?.content ?? [])
        : undefined;

      return {
        transcript: transcriptText,
        notes: notesText || undefined,
        format: "gemini_notes",
      };
    }

    // ── No "Transcript" tab found — fall through to Drive export ──────────
  } catch (err) {
    const status = getErrorStatus(err);
    const message = (err as Error).message ?? "";

    // Re-throw auth and not-found errors immediately
    if (
      status === 404 ||
      message.toLowerCase().includes("file not found") ||
      message.toLowerCase().includes("notfound")
    ) {
      throw new TranscriptNotFoundError(fileId, message);
    }
    if (status === 401 || message.includes("401") || message.toLowerCase().includes("unauthorized")) {
      throw new TokenExpiredError("unknown", `Docs API auth error for ${fileId}: ${message}`);
    }
    // For other Docs API errors, log and fall through to the Drive export fallback
    // (e.g. the file exists but the Docs API returns an unexpected structure)
  }

  // ── Step 2: Fallback — Drive export as plain text (classic transcript) ───
  try {
    const response = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" }
    );

    return {
      transcript: String(response.data),
      format: "plain_transcript",
    };
  } catch (err) {
    const status = getErrorStatus(err);
    const message = (err as Error).message ?? "";

    if (
      status === 404 ||
      message.toLowerCase().includes("file not found") ||
      message.toLowerCase().includes("notfound")
    ) {
      throw new TranscriptNotFoundError(fileId, message);
    }
    if (status === 401 || message.includes("401") || message.toLowerCase().includes("unauthorized")) {
      throw new TokenExpiredError("unknown", `Drive API auth error exporting ${fileId}: ${message}`);
    }
    if (status === 429 || message.includes("429") || message.toLowerCase().includes("quota")) {
      throw new APIQuotaError("Google Drive", message);
    }
    throw err;
  }
}

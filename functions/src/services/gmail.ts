import { google, gmail_v1 } from "googleapis";
import { createOAuthClient } from "../auth";
import { logger } from "firebase-functions";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal reference to a Gemini Notes email identified in Gmail. */
export interface GeminiNotesEmailRef {
  messageId: string;
  subject: string;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

/**
 * Gemini Notes email subject pattern.
 * Examples:
 *   "Notes: 'Weekly Sync' 25 Mar 2026"
 *   "Notes: 'Q1 Planning' 3 January 2026"
 */
const SUBJECT_RE = /^Notes: '(.+)' (\d{1,2} \w+ \d{4})$/;

/** Matches the first Google Docs document URL in an email body. */
const DOC_URL_RE = /https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// ─── Client builder ───────────────────────────────────────────────────────────

function buildGmailClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: authClient });
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Performs a minimal Gmail API call to verify the access token has the
 * `gmail.readonly` scope.  Returns normally on success, throws a
 * `GmailScopeError` if the token is valid but missing the required scope
 * (HTTP 403 / "insufficient permission").
 */
export async function testGmailReadAccess(accessToken: string): Promise<void> {
  const gmail = buildGmailClient(accessToken);
  try {
    await gmail.users.messages.list({ userId: "me", maxResults: 1 });
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ??
                   (err as { code?: number; status?: number }).status;
    const message = (err as Error).message ?? "";
    if (status === 403 || /insufficient.permission/i.test(message)) {
      throw new GmailScopeError("gmail.readonly scope missing — user must re-authorize");
    }
    throw err;
  }
}

/** Thrown when a Gmail API call fails due to missing OAuth scope (not expired token). */
export class GmailScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailScopeError";
  }
}

/**
 * Search Gmail for Gemini Notes emails received after `sinceTimestamp`.
 *
 * Uses a broad query ("from:gemini subject:Notes") and verifies each result
 * against SUBJECT_RE to avoid false positives.  Intentionally permissive to
 * maximise discoverability during initial rollout — tighten once the sender
 * address is confirmed from the From: logs below.
 *
 * @param accessToken    - Valid OAuth access token with `gmail.readonly` scope
 * @param sinceTimestamp - Lower bound; only emails received after this date are returned
 * @returns Array of matching message refs (may be empty)
 */
export async function findGeminiNotesEmails(
  accessToken: string,
  sinceTimestamp: Date
): Promise<GeminiNotesEmailRef[]> {
  const gmail = buildGmailClient(accessToken);
  const afterUnix = Math.floor(sinceTimestamp.getTime() / 1000);

  // FIX 2: Broader query — drops the apostrophe/quote pattern that may not
  // match all Gmail subject encodings.  SUBJECT_RE does the strict filtering.
  const query = `from:gemini subject:Notes after:${afterUnix}`;

  logger.info(`findGeminiNotesEmails: query="${query}"`);

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 20,
  });

  const messages = listRes.data.messages ?? [];
  logger.info(`findGeminiNotesEmails: raw API result — ${messages.length} message(s)`);
  if (messages.length === 0) return [];

  const results: GeminiNotesEmailRef[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;
    try {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From"],
      });

      const headers = detail.data.payload?.headers ?? [];
      const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
      const from    = headers.find((h) => h.name === "From")?.value ?? "";

      if (!SUBJECT_RE.test(subject)) continue;

      // Log raw From: for diagnostics — helpful during initial rollout to confirm
      // the sender address and never stored anywhere.
      logger.info(
        `gmailWatcher: matched Gemini Notes email — from: "${from}" subject: "${subject}"`
      );

      results.push({ messageId: msg.id, subject });
    } catch (err) {
      logger.warn(
        `findGeminiNotesEmails: failed to fetch metadata for message ${msg.id}`,
        { error: (err as Error).message }
      );
    }
  }

  return results;
}

/**
 * Extracts the Google Docs document ID from a Gemini Notes email body.
 *
 * Fetches the full message and scans MIME parts for a Google Docs URL.
 *
 * @param accessToken - Valid OAuth access token with `gmail.readonly` scope
 * @param messageId   - Gmail message ID to inspect
 * @returns Object with docId and docUrl, or null if no Docs link is found
 */
export async function extractGeminiNotesDocId(
  accessToken: string,
  messageId: string
): Promise<{ docId: string; docUrl: string } | null> {
  const gmail = buildGmailClient(accessToken);

  const detail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const body = extractBodyText(detail.data.payload);
  if (!body) {
    logger.warn(`extractGeminiNotesDocId: no body text found in message ${messageId}`);
    return null;
  }

  const match = body.match(DOC_URL_RE);
  if (!match) {
    logger.warn(`extractGeminiNotesDocId: no Google Docs URL found in message ${messageId}`);
    return null;
  }

  const docId  = match[1];
  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  return { docId, docUrl };
}

/**
 * Parses a Gemini Notes email subject into meeting title and ISO date.
 *
 * Expected format: "Notes: 'Meeting Title' DD Mon YYYY"
 *
 * @param subject - Raw email subject string
 * @returns `{ meetingTitle, meetingDate }` where meetingDate is "YYYY-MM-DD", or null
 */
export function parseGeminiNotesSubject(
  subject: string
): { meetingTitle: string; meetingDate: string } | null {
  const match = subject.match(SUBJECT_RE);
  if (!match) return null;

  const meetingTitle = match[1];
  const dateStr = match[2]; // e.g. "25 Mar 2026"

  const meetingDate = parseDateString(dateStr);
  if (!meetingDate) return null;

  return { meetingTitle, meetingDate };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converts a date string like "25 Mar 2026" to an ISO date "2026-03-25".
 * Returns null if the string doesn't match the expected format.
 */
function parseDateString(dateStr: string): string | null {
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [day, monthWord, year] = parts;
  const month = MONTH_MAP[monthWord.toLowerCase().slice(0, 3)];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

/**
 * Recursively walks a Gmail MIME payload tree, returning the first text chunk
 * that contains a Google Docs URL.  Decodes base64url-encoded body data.
 */
function extractBodyText(payload: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!payload) return null;

  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    if (decoded.includes("docs.google.com")) return decoded;
  }

  for (const part of payload.parts ?? []) {
    const result = extractBodyText(part);
    if (result) return result;
  }

  return null;
}

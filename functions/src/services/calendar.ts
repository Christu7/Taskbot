import { google } from "googleapis";
import { logger } from "firebase-functions";
import { createOAuthClient } from "../auth";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of successfully parsing a Google Meet transcript filename. */
export interface ParsedTranscriptFilename {
  /** The human-readable meeting name extracted from the filename. */
  meetingName: string;
  /** ISO 8601 date string (YYYY-MM-DD) extracted from the filename. */
  date: string;
}

/** A Google Calendar event with the fields TaskBot needs. */
export interface CalendarEvent {
  /** Google Calendar event ID. */
  eventId: string;
  /** Email addresses of all attendees on the event (including organizer). */
  attendees: string[];
  /** Email address of the event organizer. */
  organizer: string;
  /** ISO 8601 start time of the event. */
  startTime: string;
  /** ISO 8601 end time of the event. */
  endTime: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Maps abbreviated and full month names to zero-padded month numbers.
 * Used when parsing the date portion of a transcript filename.
 */
const MONTH_MAP: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

/**
 * Builds an authenticated Google Calendar client for a specific user.
 *
 * @param accessToken - A valid, non-expired OAuth access token for the user
 */
function buildCalendarClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth: authClient });
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Parses meeting name and date from a Google Meet transcript filename.
 *
 * Google Meet generates transcript filenames in the format:
 *   "Meeting transcript - <Meeting Name> - <Month Day, Year>"
 *
 * Examples:
 *   "Meeting transcript - Weekly Standup - Feb 25, 2026"
 *     → { meetingName: "Weekly Standup", date: "2026-02-25" }
 *   "Meeting transcript - Team A - Team B Review - Mar 2, 2026"
 *     → { meetingName: "Team A - Team B Review", date: "2026-03-02" }
 *
 * Splitting strategy: split on " - " and treat the last segment as the date
 * and everything between the first and last segment as the meeting name.
 * This correctly handles meeting names that themselves contain " - ".
 *
 * @param filename - Full Drive filename, with or without a file extension
 * @returns Parsed result, or null if the filename doesn't match the expected pattern
 */
export function parseTranscriptFilename(filename: string): ParsedTranscriptFilename | null {
  // Strip any file extension (Google Docs don't have one, but be defensive)
  const name = filename.replace(/\.[^.]+$/, "").trim();

  const parts = name.split(" - ");

  // Minimum valid structure: ["Meeting transcript", "<name>", "<date>"]
  if (parts.length < 3) return null;

  // First segment must be the "Meeting transcript" prefix
  if (!parts[0].trim().toLowerCase().startsWith("meeting transcript")) return null;

  // Last segment is the date; everything in between is the meeting name
  const rawDate = parts[parts.length - 1].trim();
  const meetingName = parts.slice(1, -1).join(" - ").trim();

  if (!meetingName) return null;

  // Parse date formats: "Feb 25, 2026" | "February 25, 2026" | "Feb 25 2026"
  const dateMatch = rawDate.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!dateMatch) return null;

  const monthKey = dateMatch[1].toLowerCase();
  const day = dateMatch[2].padStart(2, "0");
  const year = dateMatch[3];
  const month = MONTH_MAP[monthKey];

  if (!month) {
    logger.warn(`parseTranscriptFilename: unrecognised month "${dateMatch[1]}" in filename "${filename}"`);
    return null;
  }

  return { meetingName, date: `${year}-${month}-${day}` };
}

/**
 * Searches the user's primary Google Calendar for an event that matches
 * the given meeting title on (or around) the given date.
 *
 * Search strategy:
 * 1. Queries a full 24-hour UTC window for the given date using the Calendar
 *    API's full-text search parameter (`q`), which searches across event
 *    summary, description, location, and attendee display names.
 * 2. Among the returned events, prefers an exact title match (case-insensitive,
 *    normalised whitespace). Falls back to the first result if none match exactly.
 * 3. Sets `singleEvents: true` so recurring meeting instances are returned as
 *    individual events rather than the recurring rule — this ensures the correct
 *    attendee list for that specific occurrence.
 *
 * Edge cases handled:
 * - No events found → returns null (caller logs a warning)
 * - Missing attendees array on event → returns empty array
 * - Missing organizer on event → returns empty string
 *
 * @param accessToken    - Valid OAuth access token for the user
 * @param meetingTitle   - Meeting name to search for (e.g. "Weekly Standup")
 * @param approximateDate - ISO 8601 date string (YYYY-MM-DD) from the filename
 * @returns The best-matching CalendarEvent, or null if none found
 */
export async function findMeetingEvent(
  accessToken: string,
  meetingTitle: string,
  approximateDate: string
): Promise<CalendarEvent | null> {
  const calendar = buildCalendarClient(accessToken);

  // Full UTC day window — covers meetings in any timezone on that calendar date
  const timeMin = `${approximateDate}T00:00:00Z`;
  const timeMax = `${approximateDate}T23:59:59Z`;

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    q: meetingTitle,       // Full-text search across summary, description, attendees
    singleEvents: true,    // Expand recurring events into individual instances
    orderBy: "startTime",
    maxResults: 10,
  });

  const events = response.data.items ?? [];

  if (events.length === 0) return null;

  // Prefer an exact title match; fall back to the first (closest) result
  const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const targetTitle = normalise(meetingTitle);
  const matched = events.find((e) => normalise(e.summary ?? "") === targetTitle) ?? events[0];

  const attendees = (matched.attendees ?? [])
    .map((a) => a.email)
    .filter((email): email is string => typeof email === "string" && email.length > 0);

  return {
    eventId: matched.id ?? "",
    attendees,
    organizer: matched.organizer?.email ?? "",
    startTime: matched.start?.dateTime ?? matched.start?.date ?? "",
    endTime: matched.end?.dateTime ?? matched.end?.date ?? "",
  };
}

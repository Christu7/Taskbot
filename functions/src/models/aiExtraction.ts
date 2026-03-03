/**
 * How confident the model is that this item is a real, committed action item.
 *
 * high   — Someone clearly committed to doing something ("Alice will send the report by Friday")
 * medium — Likely an action item but phrasing was indirect ("we should probably update the docs")
 * low    — Very uncertain; could be vague, hypothetical, or referring to past work
 */
export type ExtractionConfidence = "high" | "medium" | "low";

/**
 * A single action item extracted from a meeting transcript by the AI.
 * The `id` is assigned by the extractor, not the AI model.
 */
export interface ExtractedTask {
  /** UUID assigned by the extractor after parsing. */
  id: string;
  /** Concise, actionable title written in imperative form (e.g. "Send Q4 report to board"). */
  title: string;
  /** Explanation of the task with context drawn from the transcript. */
  description: string;
  /** Email of the assigned person, matched against known attendees. Empty string if unknown. */
  assigneeEmail: string;
  /** Name of the assigned person as spoken in the meeting. */
  assigneeName: string;
  /** How certain the model is that this is a real committed action item. */
  confidence: ExtractionConfidence;
  /** The ~2–3 sentence portion of the transcript this task was derived from. */
  transcriptExcerpt: string;
  /**
   * True when the task touches sensitive topics: HR matters, personal issues,
   * salary discussions, disciplinary actions, etc. When true, the title should
   * be neutral and not repeat sensitive details verbatim.
   */
  isSensitive: boolean;
  /**
   * ISO 8601 date string (YYYY-MM-DD) if a concrete deadline was explicitly stated.
   * null if no deadline was mentioned — never guessed or inferred.
   */
  suggestedDueDate: string | null;
  /**
   * The exact text used to refer to the assignee in the transcript.
   * Useful for debugging mismatches between names and email addresses.
   */
  rawAssigneeText: string;
}

/**
 * Meeting metadata passed to the AI alongside the transcript.
 * Helps the model match first names to attendee email addresses.
 */
export interface MeetingContext {
  /** Human-readable meeting title (e.g. "Weekly Standup"). */
  meetingTitle: string;
  /**
   * Display names of all confirmed attendees.
   * The AI uses these to identify who tasks are assigned to.
   */
  attendeeNames: string[];
  /** ISO 8601 date string (YYYY-MM-DD) of when the meeting took place. */
  meetingDate: string;
}

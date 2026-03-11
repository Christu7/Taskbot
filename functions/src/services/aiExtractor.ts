import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext, ExtractionConfidence } from "../models/aiExtraction";
import { getAIProvider, getAIProviderForUser } from "./aiProvider";

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_CONFIDENCE = new Set<string>(["high", "medium", "low"]);

/**
 * Validates that an object parsed from the model's JSON response has all the
 * fields required by ExtractedTask. Coerces types where reasonable
 * (e.g. missing boolean → false) rather than rejecting the whole batch.
 *
 * @param raw   - Object parsed from the model's JSON output
 * @param index - Position in the array, used for error messages
 * @returns A valid ExtractedTask with a freshly generated id
 * @throws If required string fields are missing or confidence is invalid
 */
function validateAndNormalise(raw: unknown, index: number): ExtractedTask {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Task at index ${index} is not an object.`);
  }

  const t = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ["title", "description", "assigneeName", "assigneeEmail",
    "transcriptExcerpt", "rawAssigneeText"] as const) {
    if (typeof t[field] !== "string") {
      throw new Error(`Task[${index}].${field} must be a string (got ${typeof t[field]}).`);
    }
  }

  // confidence must be one of the three allowed values
  if (typeof t.confidence !== "string" || !VALID_CONFIDENCE.has(t.confidence)) {
    throw new Error(
      `Task[${index}].confidence must be "high" | "medium" | "low" (got "${t.confidence}").`
    );
  }

  // isSensitive: coerce to boolean if missing or wrong type
  const isSensitive = typeof t.isSensitive === "boolean" ? t.isSensitive : false;

  // suggestedDueDate: must be a YYYY-MM-DD string or null
  let suggestedDueDate: string | null = null;
  if (typeof t.suggestedDueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.suggestedDueDate)) {
    suggestedDueDate = t.suggestedDueDate;
  }

  return {
    id: randomUUID(),
    title: t.title as string,
    description: t.description as string,
    assigneeName: t.assigneeName as string,
    assigneeEmail: t.assigneeEmail as string,
    confidence: t.confidence as ExtractionConfidence,
    transcriptExcerpt: t.transcriptExcerpt as string,
    isSensitive,
    suggestedDueDate,
    rawAssigneeText: t.rawAssigneeText as string,
    sharedWith: Array.isArray(t.sharedWith)
      ? (t.sharedWith as unknown[]).filter((e): e is string => typeof e === "string")
      : [],
  };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Extracts action items from a meeting transcript using the configured AI provider.
 *
 * Pipeline:
 *   1. Get the AI provider (reads AI_PROVIDER env var, defaults to Anthropic)
 *   2. Call extractTasks — the provider handles prompt building and JSON retry
 *   3. Validate and normalise each item in the returned array
 *   4. Skip invalid items with a warning rather than failing the entire batch
 *   5. Return the validated ExtractedTask array
 *
 * @param transcript - Full plain-text transcript content
 * @param context    - Meeting metadata (title, attendees, date)
 * @returns Array of validated action items (may be empty)
 */
export async function extractTasksFromTranscript(
  transcript: string,
  context: MeetingContext,
  uid?: string
): Promise<{ tasks: ExtractedTask[]; tokensUsed: { input: number; output: number } }> {
  if (!transcript.trim()) {
    logger.warn("aiExtractor: received empty transcript — skipping extraction");
    return { tasks: [], tokensUsed: { input: 0, output: 0 } };
  }

  logger.info("aiExtractor: starting extraction", {
    meeting: context.meetingTitle,
    date: context.meetingDate,
    attendees: context.attendeeNames.length,
    transcriptLength: transcript.length,
  });

  const provider = uid ? await getAIProviderForUser(uid) : await getAIProvider();
  const result = await provider.extractTasks(transcript, context);
  const rawTasks = result.tasks;
  const tokensUsed = result.tokensUsed;

  logger.info(`aiExtractor: model returned ${rawTasks.length} raw task(s)`);

  // Validate each task independently — a bad item skips, doesn't abort the batch
  const validated: ExtractedTask[] = [];
  for (let i = 0; i < rawTasks.length; i++) {
    try {
      validated.push(validateAndNormalise(rawTasks[i], i));
    } catch (err) {
      logger.warn(`aiExtractor: skipping invalid task at index ${i}`, {
        error: (err as Error).message,
        raw: rawTasks[i],
      });
    }
  }

  logger.info(
    `aiExtractor: extraction complete — ${validated.length} valid task(s) extracted ` +
    `(${rawTasks.length - validated.length} skipped due to validation errors)`
  );

  return { tasks: validated, tokensUsed };
}

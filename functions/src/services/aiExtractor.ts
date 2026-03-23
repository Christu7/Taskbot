import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext, ExtractionConfidence } from "../models/aiExtraction";
import { getAIProvider, getAIProviderForUser } from "./aiProvider";
import { AIExtractionError } from "../utils/errors";

// ─── Constants ────────────────────────────────────────────────────────────────

/** ~6,000 tokens at ~4 chars/token. Transcripts under this limit are not chunked. */
const CHUNK_CHAR_LIMIT = 24_000;
/** Delay between sequential chunk calls to stay under the rate limit. */
const CHUNK_DELAY_MS = 3_000;
/** Wait time before retrying a chunk that hit a 429 rate limit error. */
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns true if the error is an API rate-limit (HTTP 429) response. */
function isRateLimitError(err: unknown): boolean {
  const e = err as Record<string, unknown>;
  return (
    e?.status === 429 ||
    (typeof e?.message === "string" && /rate.?limit/i.test(e.message as string))
  );
}

/**
 * Runs validateAndNormalise over an array of raw model output objects.
 * Invalid items are skipped with a warning rather than aborting the batch.
 */
function validateAll(rawTasks: unknown[]): ExtractedTask[] {
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
  return validated;
}

/**
 * Splits a Google Meet transcript into chunks of approximately 6,000 tokens
 * (using 24,000 characters as a proxy). Splits only at speaker-label line
 * boundaries (lines matching /^Name: /), never mid-utterance.
 *
 * Returns a single-element array when the transcript fits within the limit.
 */
export function chunkTranscript(text: string): string[] {
  if (text.length <= CHUNK_CHAR_LIMIT) return [text];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = offset + CHUNK_CHAR_LIMIT;

    if (end >= text.length) {
      chunks.push(text.slice(offset));
      break;
    }

    // Within the window, find the last speaker-label boundary:
    // a \n followed by a line starting with "Name: "
    const window = text.slice(offset, end);
    const speakerBoundaryRegex = /\n(?=[A-Za-z][^:\n]*:)/g;
    let lastBoundary = -1;
    let m: RegExpExecArray | null;
    while ((m = speakerBoundaryRegex.exec(window)) !== null) {
      lastBoundary = m.index;
    }

    if (lastBoundary <= 0) {
      // No speaker boundary found in window — hard cut at the char limit
      chunks.push(window);
      offset = end;
    } else {
      chunks.push(window.slice(0, lastBoundary));
      offset += lastBoundary + 1; // +1 skips the \n so next chunk starts with the speaker name
    }
  }

  return chunks;
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
  const chunks = chunkTranscript(transcript);

  // ── Single chunk: original behavior, no delay or dedup overhead ───────────
  if (chunks.length === 1) {
    const result = await provider.extractTasks(transcript, context);
    const rawTasks = result.tasks;

    logger.info(`aiExtractor: model returned ${rawTasks.length} raw task(s)`);

    const validated = validateAll(rawTasks as unknown[]);
    logger.info(
      `aiExtractor: extraction complete — ${validated.length} valid task(s) extracted ` +
      `(${(rawTasks as unknown[]).length - validated.length} skipped due to validation errors)`
    );
    return { tasks: validated, tokensUsed: result.tokensUsed };
  }

  // ── Multi-chunk path ───────────────────────────────────────────────────────
  logger.info(
    `aiExtractor: transcript split into ${chunks.length} chunks ` +
    `(${transcript.length} chars total)`
  );

  const allRawTasks: unknown[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_DELAY_MS);

    logger.info(`aiExtractor: processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);

    let chunkResult;
    try {
      chunkResult = await provider.extractTasks(chunks[i], context);
    } catch (err) {
      if (!isRateLimitError(err)) throw err;

      logger.warn(
        `aiExtractor: rate limit on chunk ${i + 1}/${chunks.length} — retrying in 60s`,
        { error: (err as Error).message }
      );
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);

      try {
        chunkResult = await provider.extractTasks(chunks[i], context);
      } catch (retryErr) {
        throw new AIExtractionError(
          "rate_limit",
          `Chunk ${i + 1}/${chunks.length} failed after rate-limit retry: ${(retryErr as Error).message}`
        );
      }
    }

    logger.info(`aiExtractor: chunk ${i + 1} returned ${chunkResult.tasks.length} task(s)`);
    allRawTasks.push(...(chunkResult.tasks as unknown[]));
    totalInput += chunkResult.tokensUsed.input;
    totalOutput += chunkResult.tokensUsed.output;
  }

  logger.info(`aiExtractor: all chunks processed — ${allRawTasks.length} raw task(s), running dedup`);

  // ── Dedup step: one small AI call over task strings only ──────────────────
  const dedupResult = await provider.deduplicateTasks(allRawTasks as ExtractedTask[]);
  totalInput += dedupResult.tokensUsed.input;
  totalOutput += dedupResult.tokensUsed.output;

  logger.info(
    `aiExtractor: dedup complete — ${allRawTasks.length} → ${dedupResult.tasks.length} task(s)`
  );

  const validated = validateAll(dedupResult.tasks as unknown[]);
  logger.info(
    `aiExtractor: extraction complete — ${validated.length} valid task(s) extracted ` +
    `(${(dedupResult.tasks as unknown[]).length - validated.length} skipped due to validation errors)`
  );

  return { tasks: validated, tokensUsed: { input: totalInput, output: totalOutput } };
}

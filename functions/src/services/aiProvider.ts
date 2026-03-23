import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext } from "../models/aiExtraction";
import { buildExtractionPrompt } from "../prompts/taskExtraction";
import { OpenAIProvider } from "./openaiProvider";
import { AIExtractionError } from "../utils/errors";
import { getSecret } from "./secrets";

// ─── Interface ────────────────────────────────────────────────────────────────

/** Combined result returned by every AI provider's extractTasks call. */
export interface AIExtractionResult {
  tasks: ExtractedTask[];
  tokensUsed: { input: number; output: number };
}

/**
 * Abstraction over AI providers for task extraction.
 * Implement this interface to add a new provider (OpenAI, Gemini, etc.)
 * without touching the orchestration layer.
 */
export interface AIProvider {
  /**
   * Extract action items from a meeting transcript.
   *
   * @param transcript - Full plain-text transcript
   * @param context    - Meeting metadata passed to the model for context
   * @returns Extracted tasks and token usage counts
   */
  extractTasks(transcript: string, context: MeetingContext): Promise<AIExtractionResult>;

  /**
   * Deduplicate a flat list of tasks collected from multiple transcript chunks.
   * The model removes exact and near-duplicate entries and returns the cleaned array.
   *
   * @param tasks - Raw task objects from one or more chunk extraction calls
   * @returns Deduplicated task array and token usage counts
   */
  deduplicateTasks(tasks: ExtractedTask[]): Promise<AIExtractionResult>;
}

// ─── JSON parsing helpers ─────────────────────────────────────────────────────

/**
 * Extracts the JSON array substring from a model response by finding the
 * first '[' and last ']', ignoring any surrounding prose or code fences.
 * This is more resilient than regex matching when the model adds commentary.
 */
function extractJsonString(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON array found in model response.");
  }
  return text.slice(start, end + 1);
}

/**
 * Parses the raw model response text into a plain JavaScript array.
 * Throws if the text contains no parseable JSON array.
 */
function parseRawResponse(text: string): unknown[] {
  const jsonStr = extractJsonString(text);
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array but got: ${typeof parsed}`);
  }
  return parsed;
}

// ─── Anthropic provider ───────────────────────────────────────────────────────

/** Default Anthropic model. Override with ANTHROPIC_MODEL env var (or legacy AI_MODEL). */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/**
 * Task extraction provider backed by the Anthropic Claude API.
 *
 * Retry strategy: if the first response contains malformed JSON, the provider
 * sends a follow-up turn asking the model to return only the JSON array.
 * If the second attempt also fails, the error is re-thrown to the caller.
 *
 * The API client is initialised lazily on first extractTasks() call so that
 * the (async) getSecret() call does not block module loading.
 */
export class AnthropicProvider implements AIProvider {
  /** Optional per-user API key override (from users/{uid}/apiKeys/anthropic.key). */
  private apiKeyOverride?: string;
  private client: Anthropic | null = null;
  private model: string;

  constructor(apiKeyOverride?: string) {
    this.apiKeyOverride = apiKeyOverride;
    // ANTHROPIC_MODEL takes priority; fall back to legacy AI_MODEL, then the default
    this.model = process.env.ANTHROPIC_MODEL ?? process.env.AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  }

  /** Returns (and caches) the initialised Anthropic client. */
  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    // Per-user key takes priority; fall back to org-level secret
    const apiKey = this.apiKeyOverride ?? await getSecret("ai.apiKey");
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async extractTasks(transcript: string, context: MeetingContext): Promise<AIExtractionResult> {
    const client = await this.getClient();
    const { system, user } = buildExtractionPrompt(transcript, context);

    let totalInput = 0;
    let totalOutput = 0;

    // ── First attempt ──────────────────────────────────────────────────────
    const firstResponse = await client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: user }],
    });

    totalInput += firstResponse.usage.input_tokens;
    totalOutput += firstResponse.usage.output_tokens;

    const firstText = this.extractText(firstResponse);

    try {
      return {
        tasks: parseRawResponse(firstText) as ExtractedTask[],
        tokensUsed: { input: totalInput, output: totalOutput },
      };
    } catch (firstErr) {
      logger.warn("aiProvider: first response was not valid JSON — retrying", {
        error: (firstErr as Error).message,
        snippet: firstText.slice(0, 200),
      });
    }

    // ── Retry: send the bad response back and ask for clean JSON ──────────
    const retryResponse = await client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: firstText },
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. " +
            "Please return only the JSON array inside a ```json code block, with no other text before or after it.",
        },
      ],
    });

    totalInput += retryResponse.usage.input_tokens;
    totalOutput += retryResponse.usage.output_tokens;

    const retryText = this.extractText(retryResponse);

    try {
      return {
        tasks: parseRawResponse(retryText) as ExtractedTask[],
        tokensUsed: { input: totalInput, output: totalOutput },
      };
    } catch (err) {
      throw new AIExtractionError("anthropic", (err as Error).message);
    }
  }

  async deduplicateTasks(tasks: ExtractedTask[]): Promise<AIExtractionResult> {
    const client = await this.getClient();
    const prompt =
      "The following tasks were extracted from different segments of the same meeting. " +
      "Remove exact duplicates and near-duplicates. Return a clean deduplicated JSON array " +
      "of tasks in the same format, inside a ```json code block.\n\n" +
      "Tasks: " + JSON.stringify(tasks);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text = this.extractText(response);
    try {
      return {
        tasks: parseRawResponse(text) as ExtractedTask[],
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      };
    } catch (err) {
      throw new AIExtractionError("anthropic", `Dedup parse failed: ${(err as Error).message}`);
    }
  }

  /** Concatenates all text blocks from a Claude API response. */
  private extractText(response: Anthropic.Message): string {
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns the configured AI provider instance.
 *
 * Provider selection order:
 *   1. config/secrets.ai.provider (set via Admin > Settings)
 *   2. AI_PROVIDER environment variable (fallback / fresh deployments)
 *   3. Default: "anthropic"
 *
 * The provider's API key is resolved lazily inside extractTasks().
 * Model selection (env vars, unchanged):
 *   Anthropic → ANTHROPIC_MODEL (e.g. claude-haiku-4-5-20251001, claude-sonnet-4-6)
 *   OpenAI    → OPENAI_MODEL    (e.g. gpt-4o-mini, gpt-4o)
 */
export async function getAIProvider(): Promise<AIProvider> {
  let provider: string;
  try {
    provider = await getSecret("ai.provider");
  } catch {
    provider = process.env.AI_PROVIDER ?? "anthropic";
  }

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    default:
      throw new Error(
        `Unknown AI provider: "${provider}". Supported values: "anthropic", "openai"`
      );
  }
}

/**
 * Returns the AI provider configured for a specific user.
 *
 * Resolution order:
 *   1. users/{uid}.aiProvider → provider name
 *      (fallback: AI_PROVIDER env var → "anthropic")
 *   2. users/{uid}/apiKeys/{providerName}.key → API key
 *      (fallback: provider's own env var)
 *
 * @param uid - Firebase Auth UID of the user triggering the extraction
 */
export async function getAIProviderForUser(uid: string): Promise<AIProvider> {
  const db = admin.firestore();
  const userSnap = await db.collection("users").doc(uid).get();
  const providerName: string =
    (userSnap.data()?.aiProvider as string | undefined) ??
    process.env.AI_PROVIDER ??
    "anthropic";

  const keySnap = await db
    .collection("users").doc(uid)
    .collection("apiKeys").doc(providerName)
    .get();
  // Per-user key takes priority; passing undefined falls back to org secret in extractTasks()
  const apiKey: string | undefined = keySnap.data()?.key as string | undefined;

  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "openai":
      return new OpenAIProvider(apiKey);
    default:
      throw new Error(
        `Unknown AI provider "${providerName}" for user ${uid}. Supported values: "anthropic", "openai"`
      );
  }
}

import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext } from "../models/aiExtraction";
import { buildExtractionPrompt } from "../prompts/taskExtraction";
import { OpenAIProvider } from "./openaiProvider";
import { AIExtractionError } from "../utils/errors";

// ─── Interface ────────────────────────────────────────────────────────────────

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
   * @returns Array of extracted tasks (may be empty if no action items found)
   */
  extractTasks(transcript: string, context: MeetingContext): Promise<ExtractedTask[]>;
}

// ─── JSON parsing helpers ─────────────────────────────────────────────────────

/**
 * Extracts a JSON array string from a model response that may be wrapped
 * in a markdown code block (```json ... ```) or returned as raw JSON.
 */
function extractJsonString(text: string): string {
  // Prefer a fenced code block: ```json\n[...]\n```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // Fall back to the first [...] array in the response
  const rawArray = text.match(/\[[\s\S]*\]/);
  if (rawArray) return rawArray[0];

  throw new Error("No JSON array found in model response.");
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
 */
export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKeyOverride?: string) {
    const apiKey = apiKeyOverride ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. " +
        "Add it to functions/.env (local) or Firebase Secret Manager (production)."
      );
    }
    this.client = new Anthropic({ apiKey });
    // ANTHROPIC_MODEL takes priority; fall back to legacy AI_MODEL, then the default
    this.model = process.env.ANTHROPIC_MODEL ?? process.env.AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  }

  async extractTasks(transcript: string, context: MeetingContext): Promise<ExtractedTask[]> {
    const { system, user } = buildExtractionPrompt(transcript, context);

    // ── First attempt ──────────────────────────────────────────────────────
    const firstResponse = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });

    const firstText = this.extractText(firstResponse);

    try {
      return parseRawResponse(firstText) as ExtractedTask[];
    } catch (firstErr) {
      logger.warn("aiProvider: first response was not valid JSON — retrying", {
        error: (firstErr as Error).message,
        snippet: firstText.slice(0, 200),
      });
    }

    // ── Retry: send the bad response back and ask for clean JSON ──────────
    const retryResponse = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
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

    const retryText = this.extractText(retryResponse);

    try {
      return parseRawResponse(retryText) as ExtractedTask[];
    } catch (err) {
      throw new AIExtractionError("anthropic", (err as Error).message);
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
 * Reads the AI_PROVIDER environment variable (default: "anthropic").
 *
 * To add a new provider:
 *   1. Implement the AIProvider interface in a new file
 *   2. Add a case here
 *   3. Set AI_PROVIDER=<name> in functions/.env
 *
 * Model selection (set in functions/.env):
 *   Anthropic → ANTHROPIC_MODEL (e.g. claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-4-6)
 *   OpenAI    → OPENAI_MODEL    (e.g. gpt-4o-mini, gpt-4o, o1-mini)
 */
export function getAIProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER ?? "anthropic";

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    default:
      throw new Error(
        `Unknown AI_PROVIDER: "${provider}". Supported values: "anthropic", "openai"`
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

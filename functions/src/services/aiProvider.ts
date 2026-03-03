import Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext } from "../models/aiExtraction";
import { buildExtractionPrompt } from "../prompts/taskExtraction";

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

/** Default model used for extraction. Override with AI_MODEL env var. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

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

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. " +
        "Add it to functions/.env (local) or Firebase Secret Manager (production)."
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = process.env.AI_MODEL ?? DEFAULT_MODEL;
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

    // Let this throw if still invalid — caller handles it
    return parseRawResponse(retryText) as ExtractedTask[];
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
 *   1. Implement the AIProvider interface in a new file (e.g. openaiProvider.ts)
 *   2. Add a case here
 *   3. Set AI_PROVIDER=openai in your environment
 */
export function getAIProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER ?? "anthropic";

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider();
    default:
      throw new Error(
        `Unknown AI_PROVIDER: "${provider}". Supported values: "anthropic"`
      );
  }
}

import OpenAI from "openai";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext } from "../models/aiExtraction";
import { buildExtractionPrompt } from "../prompts/taskExtraction";
import { AIProvider, AIExtractionResult } from "./aiProvider";
import { AIExtractionError } from "../utils/errors";
import { getSecret } from "./secrets";

/** Default OpenAI model. Override with OPENAI_MODEL env var. */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * Task extraction provider backed by the OpenAI API (ChatGPT).
 *
 * Retry strategy mirrors the AnthropicProvider: if the first response
 * contains malformed JSON, a follow-up message is sent asking for clean JSON.
 */
export class OpenAIProvider implements AIProvider {
  private apiKeyOverride?: string;
  private client: OpenAI | null = null;
  private model: string;

  constructor(apiKeyOverride?: string) {
    this.apiKeyOverride = apiKeyOverride;
    this.model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  }

  private async getClient(): Promise<OpenAI> {
    if (this.client) return this.client;
    const apiKey = this.apiKeyOverride ?? await getSecret("ai.apiKey");
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  async extractTasks(transcript: string, context: MeetingContext): Promise<AIExtractionResult> {
    const client = await this.getClient();
    const { system, user } = buildExtractionPrompt(transcript, context);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    let totalInput = 0;
    let totalOutput = 0;

    // ── First attempt ──────────────────────────────────────────────────────
    const firstResponse = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages,
    });

    totalInput += firstResponse.usage?.prompt_tokens ?? 0;
    totalOutput += firstResponse.usage?.completion_tokens ?? 0;

    const firstText = firstResponse.choices[0]?.message?.content ?? "";

    try {
      return {
        tasks: this.parseResponse(firstText),
        tokensUsed: { input: totalInput, output: totalOutput },
      };
    } catch (firstErr) {
      logger.warn("openaiProvider: first response was not valid JSON — retrying", {
        error: (firstErr as Error).message,
        snippet: firstText.slice(0, 200),
      });
    }

    // ── Retry: send the bad response back and ask for clean JSON ──────────
    const retryResponse = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        ...messages,
        { role: "assistant", content: firstText },
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. " +
            "Please return only the JSON array inside a ```json code block, with no other text before or after it.",
        },
      ],
    });

    totalInput += retryResponse.usage?.prompt_tokens ?? 0;
    totalOutput += retryResponse.usage?.completion_tokens ?? 0;

    const retryText = retryResponse.choices[0]?.message?.content ?? "";

    try {
      return {
        tasks: this.parseResponse(retryText),
        tokensUsed: { input: totalInput, output: totalOutput },
      };
    } catch (err) {
      throw new AIExtractionError("openai", (err as Error).message);
    }
  }

  async deduplicateTasks(tasks: ExtractedTask[]): Promise<AIExtractionResult> {
    const client = await this.getClient();
    const prompt =
      "The following tasks were extracted from different segments of the same meeting. " +
      "Remove exact duplicates and near-duplicates. Return a clean deduplicated JSON array " +
      "of tasks in the same format, inside a ```json code block.\n\n" +
      "Tasks: " + JSON.stringify(tasks);

    const response = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices[0]?.message?.content ?? "";
    try {
      return {
        tasks: this.parseResponse(text),
        tokensUsed: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      throw new AIExtractionError("openai", `Dedup parse failed: ${(err as Error).message}`);
    }
  }

  private parseResponse(text: string): ExtractedTask[] {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenced ? fenced[1].trim() : text.match(/\[[\s\S]*\]/)?.[0];
    if (!jsonStr) throw new Error("No JSON array found in model response.");
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array but got: ${typeof parsed}`);
    return parsed as ExtractedTask[];
  }
}

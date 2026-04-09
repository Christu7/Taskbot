import OpenAI from "openai";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext } from "../models/aiExtraction";
import { buildExtractionPrompt } from "../prompts/taskExtraction";
import { AIProvider, AIExtractionResult, InsightsTheme } from "./aiProvider";
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
    const titlesOnly = tasks.map((t) => ({ title: t.title, description: t.description }));
    const prompt =
      "The following tasks were extracted from different segments of the same meeting. " +
      "Remove exact duplicates and near-duplicates. " +
      "Return ONLY a JSON array where each element has two fields: " +
      "\"title\" (string) and \"description\" (string). " +
      "Be concise — no other fields. Output inside a ```json code block.\n\n" +
      "Tasks: " + JSON.stringify(titlesOnly);

    const response = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const tokensUsed = {
      input: response.usage?.prompt_tokens ?? 0,
      output: response.usage?.completion_tokens ?? 0,
    };
    try {
      return { tasks: this.parseResponse(text), tokensUsed };
    } catch (err) {
      logger.warn(
        "openaiProvider: dedup parse failed after retry — returning raw tasks as-is",
        { error: (err as Error).message }
      );
      return { tasks, tokensUsed };
    }
  }

  async extractInsights(transcript: string): Promise<InsightsTheme[]> {
    const client = await this.getClient();

    const system =
      "You are an assistant that extracts key themes from meeting transcripts. " +
      "Return only valid JSON, no markdown, no preamble.";

    const userMsg =
      "Analyze this meeting transcript and extract 5-8 key themes discussed. " +
      "For each theme provide a short title (3-6 words) and a 2-3 sentence summary of what was said.\n\n" +
      "Return a JSON array with this exact structure:\n" +
      "[{ \"title\": string, \"summary\": string }]\n\n" +
      "Transcript:\n" + transcript;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ];

    // ── First attempt ──────────────────────────────────────────────────────
    const firstResponse = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages,
    });

    const firstText = firstResponse.choices[0]?.message?.content ?? "";

    try {
      return this.parseResponse(firstText) as unknown as InsightsTheme[];
    } catch (firstErr) {
      logger.warn("openaiProvider: insights first response not valid JSON — retrying", {
        error: (firstErr as Error).message,
        snippet: firstText.slice(0, 200),
      });
    }

    // ── Retry ──────────────────────────────────────────────────────────────
    const retryResponse = await client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        ...messages,
        { role: "assistant", content: firstText },
        { role: "user", content: "Your previous response was not valid JSON. Please return only the JSON array, with no other text before or after it." },
      ],
    });

    const retryText = retryResponse.choices[0]?.message?.content ?? "";

    try {
      return this.parseResponse(retryText) as unknown as InsightsTheme[];
    } catch (err) {
      throw new AIExtractionError("openai", (err as Error).message);
    }
  }

  private parseResponse(text: string): ExtractedTask[] {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("No JSON array found in model response.");
    }
    const jsonStr = text.slice(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array but got: ${typeof parsed}`);
    return parsed as ExtractedTask[];
  }
}

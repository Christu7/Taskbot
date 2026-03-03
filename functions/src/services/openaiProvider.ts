import OpenAI from "openai";
import { logger } from "firebase-functions";
import { ExtractedTask, MeetingContext } from "../models/aiExtraction";
import { buildExtractionPrompt } from "../prompts/taskExtraction";
import { AIProvider } from "./aiProvider";

/** Default OpenAI model. Override with OPENAI_MODEL env var. */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * Task extraction provider backed by the OpenAI API (ChatGPT).
 *
 * Retry strategy mirrors the AnthropicProvider: if the first response
 * contains malformed JSON, a follow-up message is sent asking for clean JSON.
 */
export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. " +
        "Add it to functions/.env (local) or Firebase Secret Manager (production)."
      );
    }
    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  }

  async extractTasks(transcript: string, context: MeetingContext): Promise<ExtractedTask[]> {
    const { system, user } = buildExtractionPrompt(transcript, context);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    // ── First attempt ──────────────────────────────────────────────────────
    const firstResponse = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages,
    });

    const firstText = firstResponse.choices[0]?.message?.content ?? "";

    try {
      return this.parseResponse(firstText);
    } catch (firstErr) {
      logger.warn("openaiProvider: first response was not valid JSON — retrying", {
        error: (firstErr as Error).message,
        snippet: firstText.slice(0, 200),
      });
    }

    // ── Retry: send the bad response back and ask for clean JSON ──────────
    const retryResponse = await this.client.chat.completions.create({
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

    const retryText = retryResponse.choices[0]?.message?.content ?? "";

    // Let this throw if still invalid — caller handles it
    return this.parseResponse(retryText);
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

import { MeetingContext } from "../models/aiExtraction";

/**
 * The structured prompt sent to the AI model for task extraction.
 * Kept in a dedicated file so it can be iterated on independently of the
 * provider and orchestration logic.
 */
export interface ExtractionPrompt {
  system: string;
  user: string;
}

/** The JSON schema description included in the prompt. */
const TASK_SCHEMA = `
{
  "title": string,              // Concise imperative title, e.g. "Send Q4 report to the board"
  "description": string,        // 1–2 sentences of context from the transcript
  "assigneeName": string,       // Name as spoken, e.g. "Alice" or "Bob from engineering"
  "assigneeEmail": string,      // Match to attendee list if possible; otherwise ""
  "confidence": "high" | "medium" | "low",
  "transcriptExcerpt": string,  // The 2–3 verbatim sentences this task came from
  "isSensitive": boolean,       // true for HR, personal, salary, disciplinary topics
  "suggestedDueDate": string | null, // "YYYY-MM-DD" only if explicitly stated; null otherwise
  "rawAssigneeText": string     // Exact text used to refer to this person in the transcript
}`.trim();

/** Few-shot examples embedded in the prompt to demonstrate expected behaviour. */
const FEW_SHOT_EXAMPLES = `
## Examples

### Example 1 — Clear commitment, high confidence
Transcript excerpt:
  "Alice, can you send the Q4 report to the board before end of Friday? Also Bob said he'd
   finish updating the API documentation by next Wednesday."

Output:
\`\`\`json
[
  {
    "title": "Send Q4 report to the board",
    "description": "Alice was directly asked to send the Q4 report to the board. Deadline is end of Friday.",
    "assigneeName": "Alice",
    "assigneeEmail": "alice@example.com",
    "confidence": "high",
    "transcriptExcerpt": "Alice, can you send the Q4 report to the board before end of Friday?",
    "isSensitive": false,
    "suggestedDueDate": "2026-02-27",
    "rawAssigneeText": "Alice"
  },
  {
    "title": "Update API documentation",
    "description": "Bob committed to finishing the API documentation update by next Wednesday.",
    "assigneeName": "Bob",
    "assigneeEmail": "bob@example.com",
    "confidence": "high",
    "transcriptExcerpt": "Bob said he'd finish updating the API documentation by next Wednesday.",
    "isSensitive": false,
    "suggestedDueDate": "2026-03-04",
    "rawAssigneeText": "Bob"
  }
]
\`\`\`

### Example 2 — Vague / unowned, low confidence
Transcript excerpt:
  "Yeah, someone should probably take a look at those performance issues at some point.
   It's been slow for a while."

Output:
\`\`\`json
[
  {
    "title": "Investigate performance issues",
    "description": "The team mentioned ongoing performance issues but no specific owner or deadline was established. Ownership is unclear.",
    "assigneeName": "",
    "assigneeEmail": "",
    "confidence": "low",
    "transcriptExcerpt": "Someone should probably take a look at those performance issues at some point. It's been slow for a while.",
    "isSensitive": false,
    "suggestedDueDate": null,
    "rawAssigneeText": "someone"
  }
]
\`\`\`

### Example 3 — Sensitive topic
Transcript excerpt:
  "We really need to deal with Mark's situation. Sarah, can you set up a meeting with HR
   about his performance and the PIP we discussed last week?"

Output:
\`\`\`json
[
  {
    "title": "Schedule HR follow-up meeting",
    "description": "Sarah was asked to coordinate a meeting with HR regarding a personnel matter discussed in this meeting. Details are sensitive.",
    "assigneeName": "Sarah",
    "assigneeEmail": "sarah@example.com",
    "confidence": "high",
    "transcriptExcerpt": "Sarah, can you set up a meeting with HR about his performance and the PIP we discussed last week?",
    "isSensitive": true,
    "suggestedDueDate": null,
    "rawAssigneeText": "Sarah"
  }
]
\`\`\``.trim();

/**
 * Builds the system + user messages for the task extraction request.
 *
 * The system prompt establishes the model's role and hard rules.
 * The user message injects the meeting context and transcript.
 *
 * @param transcript - Full plain-text transcript content
 * @param context    - Meeting metadata (title, attendees, date)
 */
export function buildExtractionPrompt(
  transcript: string,
  context: MeetingContext
): ExtractionPrompt {
  const attendeeList = context.attendeeNames.length > 0
    ? context.attendeeNames.join(", ")
    : "Unknown (no attendee list available)";

  const system = `You are a meeting assistant that extracts clear, committed action items from meeting transcripts.

Your job is to identify tasks that someone explicitly agreed to do, was assigned by someone else, or clearly volunteered for. You output structured JSON — nothing else.

## Hard rules

1. **Only extract real commitments.** Vague suggestions, hypothetical discussions, and references to past work are not action items. When uncertain, use confidence "low" and explain the ambiguity in the description.

2. **Never invent deadlines.** Only populate suggestedDueDate if a specific date or deadline was explicitly stated in the transcript. "Soon" or "this week" are not specific — leave it null.

3. **Sensitive topics require neutral titles.** If a task touches HR matters, personal issues, salary, performance reviews, disciplinary actions, mental health, or legal matters: set isSensitive = true and write a neutral title that points to the topic without copying sensitive details verbatim.

4. **Match assignees to the attendee list.** Use the provided attendee names to resolve first names to full names. Set assigneeEmail to "" if you cannot confidently match the person.

5. **Output only the JSON array.** Wrap it in a \`\`\`json code block. No explanation, no preamble, no text after the closing backticks.`;

  const user = `# Meeting Context
- **Title:** ${context.meetingTitle}
- **Date:** ${context.meetingDate}
- **Attendees:** ${attendeeList}

# Transcript

${transcript}

---

# Your Task

Extract every action item from the transcript above. Follow the hard rules in your instructions exactly.

Each task must match this schema:
\`\`\`
${TASK_SCHEMA}
\`\`\`

${FEW_SHOT_EXAMPLES}

---

Now extract tasks from the transcript above. Return your answer as a single \`\`\`json code block containing an array. If there are no action items, return an empty array \`[]\`.`;

  return { system, user };
}

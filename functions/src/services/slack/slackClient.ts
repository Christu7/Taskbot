/**
 * Thin Slack Web API client using Node 22 built-in fetch.
 * Covers the subset of endpoints TaskBot needs.
 */

const BASE = "https://slack.com/api";

// ─── Response shapes ──────────────────────────────────────────────────────────

interface SlackBaseResponse {
  ok: boolean;
  error?: string;
}

interface PostMessageResponse extends SlackBaseResponse {
  ts: string;
  channel: string;
}

interface LookupByEmailResponse extends SlackBaseResponse {
  user?: {
    id: string;
    name: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

// ─── Block Kit types ──────────────────────────────────────────────────────────

interface PlainTextObject {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}

interface MrkdwnTextObject {
  type: "mrkdwn";
  text: string;
}

type TextObject = PlainTextObject | MrkdwnTextObject;

export interface HeaderBlock {
  type: "header";
  text: PlainTextObject;
}

export interface SectionBlock {
  type: "section";
  block_id?: string;
  text: TextObject;
}

export interface DividerBlock {
  type: "divider";
}

export interface ButtonElement {
  type: "button";
  action_id: string;
  text: PlainTextObject;
  value: string;
  style?: "primary" | "danger";
}

export interface ActionsBlock {
  type: "actions";
  block_id?: string;
  elements: ButtonElement[];
}

export interface ContextBlock {
  type: "context";
  block_id?: string;
  elements: TextObject[];
}

export type SlackBlock =
  | HeaderBlock
  | SectionBlock
  | DividerBlock
  | ActionsBlock
  | ContextBlock;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function slackPost<T extends SlackBaseResponse>(
  method: string,
  token: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack API ${method} HTTP ${res.status}`);
  }

  const data = await res.json() as T;

  if (!data.ok) {
    throw new Error(`Slack ${method} error: ${data.error ?? "unknown"}`);
  }

  return data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Posts a message to a channel or DM.
 * Returns the message timestamp (used for later updates).
 */
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  blocks: SlackBlock[]
): Promise<{ ts: string; channel: string }> {
  const data = await slackPost<PostMessageResponse>("chat.postMessage", token, {
    channel,
    text,
    blocks,
  });
  return { ts: data.ts, channel: data.channel };
}

/**
 * Updates an existing message in-place.
 */
export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks: SlackBlock[]
): Promise<void> {
  await slackPost<SlackBaseResponse>("chat.update", token, {
    channel,
    ts,
    text,
    blocks,
  });
}

/**
 * Sends an ephemeral message visible only to a specific user.
 */
export async function postEphemeral(
  token: string,
  channel: string,
  user: string,
  text: string,
  blocks: SlackBlock[]
): Promise<void> {
  await slackPost<SlackBaseResponse>("chat.postEphemeral", token, {
    channel,
    user,
    text,
    blocks,
  });
}

/**
 * Looks up a Slack user by their email address.
 * Returns { id, displayName } or null if not found.
 * Requires users:read and users:read.email bot scopes.
 */
export async function lookupUserByEmail(
  token: string,
  email: string
): Promise<{ id: string; displayName: string } | null> {
  const res = await fetch(
    `${BASE}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { "Authorization": `Bearer ${token}` } }
  );

  if (!res.ok) {
    throw new Error(`Slack lookupByEmail HTTP ${res.status}`);
  }

  const data = await res.json() as LookupByEmailResponse;

  if (!data.ok) {
    if (data.error === "users_not_found") return null;
    throw new Error(`Slack lookupByEmail error: ${data.error ?? "unknown"}`);
  }

  const user = data.user;
  if (!user) return null;

  const displayName =
    user.profile?.display_name ||
    user.profile?.real_name ||
    user.name;

  return { id: user.id, displayName };
}

/**
 * Posts a JSON body to a Slack response_url (for interaction callbacks).
 */
export async function postToResponseUrl(
  responseUrl: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack response_url POST failed: HTTP ${res.status}`);
  }
}

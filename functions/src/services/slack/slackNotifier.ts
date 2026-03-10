import { logger } from "firebase-functions";
import { ProposalDocument } from "../../models/proposal";
import {
  postMessage,
  SlackBlock,
  SectionBlock,
  ActionsBlock,
  ContextBlock,
  DividerBlock,
  HeaderBlock,
  ButtonElement,
} from "./slackClient";

const MAX_TASKS_IN_MESSAGE = 10;
const MAX_DESC_LENGTH = 200;

type ProposalWithId = ProposalDocument & { id: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function confidenceEmoji(confidence: string): string {
  if (confidence === "high") return "🟢";
  if (confidence === "medium") return "🟡";
  return "🔴";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

function escMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Encodes meetingId + taskId into a Slack button value (max 2000 chars). */
function buttonValue(meetingId: string, taskId: string): string {
  return JSON.stringify({ m: meetingId, t: taskId });
}

// ─── Block builders ───────────────────────────────────────────────────────────

function buildTaskBlocks(proposal: ProposalWithId): SlackBlock[] {
  const confidence = confidenceEmoji(proposal.confidence);
  const titleText = `*${escMrkdwn(proposal.title)}*  ${confidence} ${proposal.confidence.toUpperCase()}`;

  const titleBlock: SectionBlock = {
    type: "section",
    block_id: `tb_title_${proposal.id}`,
    text: { type: "mrkdwn", text: titleText },
  };

  const descText = truncate(escMrkdwn(proposal.description), MAX_DESC_LENGTH);
  const descBlock: SectionBlock = {
    type: "section",
    block_id: `tb_desc_${proposal.id}`,
    text: { type: "mrkdwn", text: descText },
  };

  const val = buttonValue(proposal.meetingId, proposal.id);

  const approveBtn: ButtonElement = {
    type: "button",
    action_id: "tb_approve",
    text: { type: "plain_text", text: "Approve", emoji: false },
    style: "primary",
    value: val,
  };

  const rejectBtn: ButtonElement = {
    type: "button",
    action_id: "tb_reject",
    text: { type: "plain_text", text: "Reject", emoji: false },
    style: "danger",
    value: val,
  };

  const viewBtn: ButtonElement = {
    type: "button",
    action_id: "tb_view",
    text: { type: "plain_text", text: "View Details", emoji: false },
    value: val,
  };

  const actionsBlock: ActionsBlock = {
    type: "actions",
    block_id: `tb_actions_${proposal.id}`,
    elements: [approveBtn, rejectBtn, viewBtn],
  };

  const divider: DividerBlock = { type: "divider" };

  return [titleBlock, descBlock, actionsBlock, divider];
}

function buildMessage(
  proposals: ProposalWithId[],
  meetingTitle: string,
  reviewLink: string,
  expiryHours: number
): { text: string; blocks: SlackBlock[] } {
  const count = proposals.length;
  const visibleProposals = proposals.slice(0, MAX_TASKS_IN_MESSAGE);
  const overflow = count - visibleProposals.length;

  const headerBlock: HeaderBlock = {
    type: "header",
    text: {
      type: "plain_text",
      text: `TaskBot: ${count} proposed task${count !== 1 ? "s" : ""} from ${meetingTitle}`,
      emoji: false,
    },
  };

  const introBlock: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `Review and approve or reject each task. They expire in *${expiryHours}h*.`,
    },
  };

  const divider: DividerBlock = { type: "divider" };

  const taskBlocks = visibleProposals.flatMap(buildTaskBlocks);

  const footerParts: SlackBlock[] = [];

  if (overflow > 0) {
    const overflowBlock: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_…and ${overflow} more task${overflow !== 1 ? "s" : ""} — <${reviewLink}|review all in the dashboard>_`,
        },
      ],
    };
    footerParts.push(overflowBlock);
  }

  const dashboardBlock: SectionBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `<${reviewLink}|Open full review dashboard>`,
    },
  };

  footerParts.push(dashboardBlock);

  const blocks: SlackBlock[] = [
    headerBlock,
    introBlock,
    divider,
    ...taskBlocks,
    ...footerParts,
  ];

  const text = `TaskBot: ${count} proposed task${count !== 1 ? "s" : ""} from "${meetingTitle}"`;

  return { text, blocks };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sends a Block Kit DM to the given Slack user with interactive approve/reject
 * buttons for each proposed task.
 */
export async function sendSlackProposalNotification(
  botToken: string,
  slackUserId: string,
  proposals: ProposalWithId[],
  meetingTitle: string,
  reviewLink: string,
  expiryHours: number
): Promise<void> {
  const { text, blocks } = buildMessage(proposals, meetingTitle, reviewLink, expiryHours);

  await postMessage(botToken, slackUserId, text, blocks);

  logger.info(
    `slackNotifier: sent ${proposals.length} proposal(s) from "${meetingTitle}" ` +
    `to Slack user ${slackUserId}`
  );
}

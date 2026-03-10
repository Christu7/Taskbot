import { google } from "googleapis";
import { logger } from "firebase-functions";
import { createOAuthClient } from "../auth";
import { ProposalDocument } from "../models/proposal";

// ─── Gmail client ─────────────────────────────────────────────────────────────

/**
 * Builds an authenticated Gmail client for a specific user.
 * Mirrors the pattern used in drive.ts / calendar.ts.
 *
 * @param accessToken - A valid, non-expired OAuth access token with gmail.send scope
 */
function buildGmailClient(accessToken: string) {
  const authClient = createOAuthClient();
  authClient.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: authClient });
}

// ─── RFC 2822 message builder ─────────────────────────────────────────────────

/**
 * Encodes an email message as a base64url string suitable for the Gmail API's
 * `users.messages.send` raw field.
 *
 * The Gmail API requires RFC 2822 format, base64url-encoded (no padding).
 */
function encodeRawMessage(
  fromEmail: string,
  toEmail: string,
  subject: string,
  html: string
): string {
  const headers = [
    `From: TaskBot <${fromEmail}>`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ].join("\r\n");

  const raw = `${headers}\r\n\r\n${html}`;

  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ─── HTML email template ──────────────────────────────────────────────────────

/** Escapes special HTML characters to prevent injection in email content. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + "…";
}

function confidenceBadge(confidence: string): string {
  const colors: Record<string, string> = {
    high: "#34a853",
    medium: "#f29900",
    low: "#ea4335",
  };
  const color = colors[confidence] ?? "#888888";
  const label = esc(confidence.toUpperCase());
  return `<span style="background:${color};color:#ffffff;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:bold;letter-spacing:0.5px;">${label}</span>`;
}

function buildEmailHtml(
  recipientName: string,
  meetingTitle: string,
  proposals: ProposalDocument[],
  reviewLink: string,
  approveAllLink: string,
  expiryHours: number
): string {
  const count = proposals.length;

  const taskCards = proposals
    .map(
      (p) => `
      <div style="border:1px solid #e0e0e0;border-radius:6px;padding:14px 16px;margin-bottom:12px;background:#fafafa;">
        <p style="font-weight:bold;margin:0 0 8px;font-size:15px;color:#1a1a1a;">${esc(p.title)}</p>
        ${confidenceBadge(p.confidence)}
        ${p.transcriptExcerpt ? `<p style="font-size:13px;color:#555555;margin:10px 0 0;font-style:italic;border-left:3px solid #dadce0;padding-left:10px;line-height:1.5;">&ldquo;${esc(truncate(p.transcriptExcerpt, 160))}&rdquo;</p>` : ""}
      </div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#1a73e8;padding:20px 28px;">
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:-0.5px;">TaskBot</h1>
          <p style="margin:4px 0 0;color:#c5d8f8;font-size:13px;">Meeting action items for your review</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px;">
          <p style="margin:0 0 6px;font-size:15px;color:#333333;">Hi <strong>${esc(recipientName)}</strong>,</p>
          <p style="margin:0 0 22px;font-size:15px;color:#333333;line-height:1.5;">
            <strong>${count}</strong> action item${count !== 1 ? "s were" : " was"} extracted from
            <strong>${esc(meetingTitle)}</strong> and assigned to you.
          </p>

          ${taskCards}

          <!-- Primary CTA -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 16px;">
            <tr><td align="center">
              <a href="${reviewLink}"
                 style="background:#1a73e8;color:#ffffff;padding:13px 32px;text-decoration:none;
                        border-radius:5px;font-weight:bold;font-size:15px;display:inline-block;">
                Review Task${count !== 1 ? "s" : ""}
              </a>
            </td></tr>
          </table>

          <!-- Secondary CTA -->
          <p style="text-align:center;margin:0 0 28px;font-size:14px;">
            <a href="${approveAllLink}" style="color:#1a73e8;text-decoration:none;">
              Approve all ${count} task${count !== 1 ? "s" : ""} at once
            </a>
          </p>

          <!-- Footer -->
          <hr style="border:none;border-top:1px solid #e8e8e8;margin:0 0 16px;">
          <p style="font-size:12px;color:#888888;margin:0;line-height:1.6;">
            Task${count !== 1 ? "s" : ""} will expire in <strong>${expiryHours} hours</strong> if not reviewed.
            You received this because you were a participant in this meeting.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const SETTINGS_URL = `${process.env.APP_URL ?? "https://taskbot-fb10d.web.app"}/settings`;

/**
 * Sends a proposal notification email via the Gmail API using the
 * meeting organizer's stored OAuth tokens.
 *
 * The email is sent FROM the user who detected the transcript (detectedByUid),
 * appearing naturally as coming from the meeting organizer.
 * No external SMTP credentials are required.
 *
 * @param senderAccessToken - Valid access token for the sender (detectedByUid), with gmail.send scope
 * @param senderEmail       - Sender's Gmail address (used in the From header)
 * @param recipientEmail    - Address to send the notification to
 * @param recipientName     - Recipient's display name (used in greeting)
 * @param meetingTitle      - Human-readable meeting title
 * @param proposals         - Pending proposals assigned to this recipient
 * @param reviewLink        - Pre-authenticated URL to the review page
 * @param approveAllLink    - URL that triggers bulk approval
 * @param expiryHours       - Used in footer text (default: 48)
 */
export async function sendProposalNotification(
  senderAccessToken: string,
  senderEmail: string,
  recipientEmail: string,
  recipientName: string,
  meetingTitle: string,
  proposals: ProposalDocument[],
  reviewLink: string,
  approveAllLink: string,
  expiryHours = 48
): Promise<void> {
  const count = proposals.length;
  const subject = `TaskBot: ${count} proposed task${count !== 1 ? "s" : ""} from "${meetingTitle}"`;

  const html = buildEmailHtml(
    recipientName,
    meetingTitle,
    proposals,
    reviewLink,
    approveAllLink,
    expiryHours
  );

  const gmail = buildGmailClient(senderAccessToken);

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodeRawMessage(senderEmail, recipientEmail, subject, html),
    },
  });

  logger.info(
    `emailSender: sent via Gmail API from ${senderEmail} to ${recipientEmail} — ` +
    `${count} proposal(s) from "${meetingTitle}"`
  );
}

/**
 * Sends a brief warning email when a task was routed to Google Tasks instead
 * of Asana because the user's Asana account is not connected or has expired.
 */
export async function sendAsanaWarningEmail(
  senderAccessToken: string,
  senderEmail: string,
  recipientEmail: string,
  recipientName: string
): Promise<void> {
  const subject = "TaskBot: Asana not connected — task sent to Google Tasks";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#333333;">
  <h2 style="color:#e67e22;margin:0 0 16px;">Asana not connected</h2>
  <p style="margin:0 0 12px;">Hi <strong>${esc(recipientName)}</strong>,</p>
  <p style="margin:0 0 12px;line-height:1.5;">
    Your task destination includes Asana, but your Asana account is not connected
    or your access has expired. The task was created in <strong>Google Tasks</strong> instead.
  </p>
  <p style="margin:0 0 24px;line-height:1.5;">
    To reconnect Asana, visit your
    <a href="${SETTINGS_URL}" style="color:#1a73e8;">TaskBot settings</a>.
  </p>
  <hr style="border:none;border-top:1px solid #e8e8e8;margin:0 0 16px;">
  <p style="font-size:12px;color:#888888;margin:0;">
    You received this because your task destination preference includes Asana.
  </p>
</body>
</html>`;

  const gmail = buildGmailClient(senderAccessToken);
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodeRawMessage(senderEmail, recipientEmail, subject, html) },
  });

  logger.info(`emailSender: sent Asana warning to ${recipientEmail}`);
}

/**
 * Sends an invitation email via the Gmail API using the admin's OAuth tokens.
 * The recipient receives a link to sign in to TaskBot using Google SSO.
 *
 * @param senderAccessToken - Valid access token for the admin, with gmail.send scope
 * @param senderEmail       - Admin's Gmail address (used in the From header)
 * @param recipientEmail    - Address to send the invite to
 * @param appUrl            - The TaskBot application URL included in the CTA button
 */
export async function sendInviteEmail(
  senderAccessToken: string,
  senderEmail: string,
  recipientEmail: string,
  appUrl: string
): Promise<void> {
  const subject = "You've been invited to TaskBot";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#1a73e8;padding:20px 28px;">
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:-0.5px;">TaskBot</h1>
          <p style="margin:4px 0 0;color:#c5d8f8;font-size:13px;">Automatic action items from your meetings</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:15px;color:#333333;line-height:1.5;">
            You've been invited to <strong>TaskBot</strong> — a tool that automatically extracts
            action items from your meeting transcripts and creates tasks in Google Tasks or Asana.
          </p>
          <p style="margin:0 0 24px;font-size:15px;color:#333333;line-height:1.5;">
            Sign in with your Google account to get started. No password required.
          </p>

          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td align="center">
              <a href="${appUrl}"
                 style="background:#1a73e8;color:#ffffff;padding:13px 32px;text-decoration:none;
                        border-radius:5px;font-weight:bold;font-size:15px;display:inline-block;">
                Sign in to TaskBot
              </a>
            </td></tr>
          </table>

          <!-- Footer -->
          <hr style="border:none;border-top:1px solid #e8e8e8;margin:0 0 16px;">
          <p style="font-size:12px;color:#888888;margin:0;line-height:1.6;">
            You received this invite because someone on your team added you to TaskBot.
            If you were not expecting this, you can safely ignore this email.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const gmail = buildGmailClient(senderAccessToken);
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodeRawMessage(senderEmail, recipientEmail, subject, html) },
  });

  logger.info(`emailSender: sent invite to ${recipientEmail}`);
}

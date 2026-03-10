import { logger } from "firebase-functions";
import { NotificationChannel, ChannelContext } from "./notificationChannel";
import { sendSlackProposalNotification } from "../slack/slackNotifier";
import { EmailChannel } from "./emailChannel";
import { getSecret } from "../secrets";

/**
 * Notification channel implementation that delivers proposals via Slack DM.
 * Falls back to email when the bot token is absent or the user has no slackUserId.
 */
export class SlackChannel implements NotificationChannel {
  readonly channelName = "slack";

  async send(ctx: ChannelContext): Promise<void> {
    let botToken: string;
    try {
      botToken = await getSecret("slack.botToken");
    } catch {
      logger.warn(
        `SlackChannel: slack.botToken not configured — falling back to email for user ${ctx.uid}`
      );
      await new EmailChannel().send(ctx);
      return;
    }

    const slackUserId = ctx.user.preferences?.slackUserId;
    if (!slackUserId) {
      logger.warn(
        `SlackChannel: user ${ctx.uid} has no slackUserId — falling back to email`
      );
      await new EmailChannel().send(ctx);
      return;
    }

    await sendSlackProposalNotification(
      botToken,
      slackUserId,
      ctx.proposals,
      ctx.meetingTitle,
      ctx.reviewLink,
      ctx.expiryHours
    );
  }
}

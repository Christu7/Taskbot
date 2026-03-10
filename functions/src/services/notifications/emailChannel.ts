import { NotificationChannel, ChannelContext } from "./notificationChannel";
import { sendProposalNotification } from "../emailSender";

/**
 * Notification channel implementation that delivers proposals via Gmail API.
 */
export class EmailChannel implements NotificationChannel {
  readonly channelName = "email";

  async send(ctx: ChannelContext): Promise<void> {
    await sendProposalNotification(
      ctx.senderAccessToken,
      ctx.senderEmail,
      ctx.user.email,
      ctx.user.displayName || ctx.user.email,
      ctx.meetingTitle,
      ctx.proposals,
      ctx.reviewLink,
      ctx.approveAllLink,
      ctx.expiryHours
    );
  }
}

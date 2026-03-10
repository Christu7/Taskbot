import { ProposalDocument } from "../../models/proposal";
import { UserDocument } from "../../models/user";

/**
 * Common context passed to every notification channel.
 * Channels use whatever subset of this they need.
 */
export interface ChannelContext {
  uid: string;
  user: UserDocument;
  proposals: Array<ProposalDocument & { id: string }>;
  meetingTitle: string;
  meetingId: string;
  reviewLink: string;
  approveAllLink: string;
  expiryHours: number;
  /** Required by the email channel to send via Gmail API. */
  senderAccessToken: string;
  senderEmail: string;
}

/**
 * Abstraction for a single notification delivery channel.
 * Each channel implementation is responsible for its own error handling
 * and should throw if the notification could not be delivered.
 */
export interface NotificationChannel {
  /** Human-readable channel name used in logs. */
  readonly channelName: string;
  /** Sends proposal notifications to the user. Throws on failure. */
  send(ctx: ChannelContext): Promise<void>;
}

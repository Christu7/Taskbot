import * as admin from "firebase-admin";
import { logger } from "firebase-functions";
import { UserDocument, normalizeNotifyVia } from "../../models/user";
import { ChannelContext } from "./notificationChannel";
import { EmailChannel } from "./emailChannel";
import { SlackChannel } from "./slackChannel";

/** Re-exported for callers that were typed against the old interface name. */
export type NotificationContext = ChannelContext;

const CHANNELS: Record<string, EmailChannel | SlackChannel> = {
  email: new EmailChannel(),
  slack: new SlackChannel(),
};

/**
 * Resolves which notification channels to use for a user.
 * Cascade: user preference → org default (config/orgDefaults) → ["email"]
 */
async function resolveChannelKeys(user: UserDocument): Promise<("email" | "slack")[]> {
  const rawPref = user.preferences?.notifyVia;

  if (rawPref !== undefined) {
    return normalizeNotifyVia(rawPref);
  }

  // Fall back to org default
  const orgSnap = await admin.firestore().collection("config").doc("orgDefaults").get();
  const orgPref = orgSnap.data()?.notifyVia;
  if (orgPref !== undefined) {
    logger.debug(`notificationRouter: using org default notifyVia ${JSON.stringify(orgPref)}`);
    return normalizeNotifyVia(orgPref);
  }

  return ["email"];
}

/**
 * Routes a proposal notification to the appropriate channel(s) based on the
 * user's `notifyVia` preference, falling back to org defaults then email.
 *
 * Slack automatically falls back to email when the user has no slackUserId or
 * SLACK_BOT_TOKEN is absent. Individual channel failures are logged but do not
 * throw, so the caller can continue processing other users.
 */
export async function routeNotification(ctx: NotificationContext): Promise<void> {
  const channelKeys = await resolveChannelKeys(ctx.user);

  const tasks: Promise<void>[] = channelKeys.map((key) => {
    const channel = CHANNELS[key];
    if (!channel) {
      logger.warn(`notificationRouter: unknown channel "${key}" — skipping`);
      return Promise.resolve();
    }
    return channel.send(ctx);
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") {
      logger.error("notificationRouter: channel failed", {
        error: (r.reason as Error)?.message ?? "unknown",
        uid: ctx.uid,
        channels: channelKeys,
      });
    }
  }
}

# Slack App Setup for TaskBot

## 1. Create the Slack App

1. Go to https://api.slack.com/apps and click **Create New App → From scratch**
2. Name it **TaskBot**, select your workspace, click **Create App**

---

## 2. Configure Bot Token Scopes

In the app's left sidebar, go to **OAuth & Permissions → Scopes → Bot Token Scopes**.
Add these scopes:

| Scope | Purpose |
|---|---|
| `chat:write` | Send DMs and messages |
| `users:read` | Look up workspace users |
| `users:read.email` | Match TaskBot users by email address |

---

## 3. Enable Interactivity

In the left sidebar, go to **Interactivity & Shortcuts**.

1. Toggle **Interactivity** ON
2. Set the **Request URL** to:
   ```
   https://us-central1-taskbot-fb10d.cloudfunctions.net/slackInteraction
   ```
3. Click **Save Changes**

---

## 4. Install the App to Your Workspace

In the left sidebar, go to **OAuth & Permissions**.

1. Click **Install to Workspace**
2. Authorize the requested permissions
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

---

## 5. Get the Signing Secret

In the left sidebar, go to **Basic Information → App Credentials**.

Copy the **Signing Secret** — used to verify that interaction payloads actually
come from Slack.

---

## 6. Set Environment Variables

Add to `functions/.env` (local dev):
```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

For production, set via Firebase Secret Manager:
```bash
npx firebase functions:secrets:set SLACK_BOT_TOKEN
npx firebase functions:secrets:set SLACK_SIGNING_SECRET
```

Then redeploy:
```bash
npm run deploy
```

---

## 7. Connect Your Account in Settings

1. Go to **https://taskbot-fb10d.web.app/settings**
2. Under **Connected Accounts → Slack**, click **Connect Slack**
3. If your Firebase account email matches your Slack email, it auto-connects
4. Set **Notification Channel** to **Slack** or **Both** and save

---

## How It Works

- When a meeting transcript is processed, TaskBot sends you a Slack DM with
  the proposed tasks as interactive Block Kit cards
- Each task has three buttons: **Approve**, **Reject**, and **View Details**
- Approving via Slack button triggers the same `taskCreator` pipeline as the web app
- The message updates in-place to show the result after each action
- "View Details" shows an ephemeral message with the full description,
  transcript excerpt, and Drive link — without replacing the original message

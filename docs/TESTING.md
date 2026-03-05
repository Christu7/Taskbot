# TaskBot — Manual Testing Guide

## Prerequisites

- Firebase CLI installed (`npm install -g firebase-tools`)
- Emulators started: `npm run serve` from the project root
- A test Google account with Drive, Calendar, Tasks, and Gmail enabled

---

## 1. Full Pipeline Walk-Through

### Step 1 — Sign in

1. Open http://localhost:3000
2. Click **Sign in with Google** → authenticate with your test account
3. You should be redirected to the **Dashboard**

### Step 2 — Connect Google Account

1. Go to **Settings** → you should see "Google Account not connected"
2. Click **Reconnect** → complete the Google consent screen (grant all scopes)
3. You'll be redirected back to the app; the banner should disappear

### Step 3 — Create a test transcript

In Google Drive (your real Drive, not the emulator), create a Google Doc named:

```
Meeting transcript - Test Sync - 2026-03-04
```

Add some content with explicit action items, e.g.:

```
Alice: I'll send the report by Friday.
Bob: Can you also update the spreadsheet?
Alice: Yes, I'll do that too.
```

### Step 4 — Trigger the Drive Watcher manually

The watcher runs every 10 minutes in production. To trigger it immediately:

```bash
# Call the Cloud Function directly
curl -X POST "http://127.0.0.1:5001/taskbot-fb10d/us-central1/driveWatcher"
```

Or via the Firebase Emulator UI at http://localhost:4000 → Functions → driveWatcher → **Run**.

### Step 5 — Verify Firestore

In the Emulator UI (http://localhost:4000) → Firestore:

- **`processedTranscripts/`** — you should see a new doc with:
  - `status: "pending"` → `"processing"` → `"extracting"` → `"proposed"`
  - `meetingTitle`: your meeting name
  - `attendeeEmails`: list of known users

If the status is `"failed"`, check `error` field for the reason.

### Step 6 — Check your email

You should receive a notification email with task cards. The email contains a **Review** link.

To test locally, check the emulator logs for the email content (the emulator doesn't send real email — look for `sendProposalNotification` in the function logs).

### Step 7 — Review proposals

1. Click **Review** in the email (or navigate to Dashboard → click the meeting)
2. You should see proposal cards with **Approve**, **Edit**, **Reject** buttons
3. Approve a task → status shows "Creating in Google Tasks..." → then "Created"

### Step 8 — Verify Google Tasks

Open https://tasks.google.com — you should see the task in a **TaskBot** list.

---

## 2. Testing Individual Components

### Test the Health Check

```bash
# Basic check (no AI call)
curl https://us-central1-taskbot-fb10d.cloudfunctions.net/healthCheck

# With live AI test (costs ~1 token)
curl "https://us-central1-taskbot-fb10d.cloudfunctions.net/healthCheck?ai=true"
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "...",
  "services": {
    "auth":       { "status": "ok" },
    "firestore":  { "status": "ok" },
    "aiProvider": { "status": "ok", "detail": "anthropic / claude-sonnet-4-6" },
    "googleApis": { "status": "ok" },
    "envVars":    { "status": "ok" }
  }
}
```

### Test AI Extraction in Isolation

Set `processedTranscripts/{id}` to `status: "pending"` in Firestore with a real `driveFileId`. The `processTranscript` function will trigger automatically.

Alternatively, trigger it from the Emulator UI.

### Test Proposal Expiry

1. In Firestore, manually set a proposal's `expiresAt` to a past timestamp
2. Trigger `expireProposals` from the Emulator UI
3. The proposal's `status` should change to `"expired"`

### Test API Key Management (Settings Page)

1. Go to **Settings** → **AI Provider** section
2. Click **Add Key** next to Anthropic → paste a valid key → **Confirm**
3. The masked key (`sk-ant-api...****`) should appear
4. Select **Anthropic** in the Active Provider dropdown → **Save Provider**
5. Check Firestore: `users/{uid}.aiProvider` should be `"anthropic"`
6. Check `users/{uid}/apiKeys/anthropic` — the doc should exist (never readable from client)

---

## 3. Common Issues & Debugging

### "No OAuth tokens found"

The user hasn't connected their Google Account. Go to Settings → Reconnect.

### Transcript not found after Drive Watcher runs

- Check that the filename matches the pattern: `Meeting transcript - <title> - <date>`
- The Drive Watcher looks back only 15 minutes — create the file within that window

### AI extraction fails

- Check function logs for `AIExtractionError`
- Verify `ANTHROPIC_API_KEY` in `functions/.env`
- The pipeline retries once after 30 seconds automatically

### Email not received

In production, check Gmail API quota. Locally, emails aren't sent — look for the email content in function logs (grep for `sendProposalNotification`).

### `hasValidTokens` stays `false` after reconnecting

This can happen if the OAuth callback redirected before Firestore updated. Trigger a Drive Watcher cycle — it self-heals the flag when tokens are valid.

---

## 4. Checking Logs

### Local (emulator)

Logs stream to the terminal where `npm run serve` is running.

Filter by function name:
```bash
# In a second terminal, grep the emulator output
# Or use the Emulator UI → Logs tab at http://localhost:4000
```

### Production (Firebase Console)

1. Go to https://console.firebase.google.com/project/taskbot-fb10d
2. **Functions** → select a function → **Logs**
3. Or use Cloud Logging:
   ```bash
   gcloud logging read "resource.type=cloud_function" --project=taskbot-fb10d --limit=50
   ```

---

## 5. Resetting Test Data

To start fresh, clear these Firestore collections from the Emulator UI or with the Admin SDK:

```bash
# Delete all test data via the Emulator UI
# http://localhost:4000 → Firestore → select collection → delete all docs

# Or with the Firebase CLI
firebase firestore:delete processedTranscripts --all-collections --project taskbot-fb10d
firebase firestore:delete proposals --all-collections --project taskbot-fb10d
firebase firestore:delete approvalTokens --project taskbot-fb10d
```

> **Never run these against production.** Add `--project taskbot-fb10d` only after confirming the emulator is targeted.

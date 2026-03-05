# TaskBot — Integration Test Checklist

Run through this checklist top-to-bottom after every significant deployment.
Each item references the relevant component so you know where to look if it fails.

**Environment**: start the emulators with `npm run serve` and open http://localhost:3000
**Prerequisites**: a real Google account with Drive, Calendar, Gmail, and Tasks enabled

---

## 1. Auth & Onboarding

- [ ] **New user sign-up — Google SSO**
  - Open http://localhost:3000 → click **Sign in with Google** → authenticate
  - Expected: redirected to `/dashboard`
  - Verify: `users/{uid}` document created in Firestore (Emulator UI → http://localhost:4000)

- [ ] **OAuth consent — Google account connection**
  - Go to **Settings** → banner says "Google Account not connected"
  - Click **Reconnect** → complete consent screen granting all scopes
  - Expected: redirected back to app, banner disappears
  - Verify: `users/{uid}.hasValidTokens = true`; `users/{uid}/tokens/google` document exists

- [ ] **Returning user — stays signed in**
  - Refresh the page → still on dashboard, not redirected to sign-in

---

## 2. Settings Page

- [ ] **Active/inactive toggle**
  - Toggle **Active** off → **Save** → verify `users/{uid}.isActive = false` in Firestore
  - Toggle back on → **Save** → verify `isActive = true`

- [ ] **Preferences**
  - Change **Proposal expiry** to 24 h → **Save** → verify `users/{uid}.preferences.proposalExpiryHours = 24`

- [ ] **AI Provider key management**
  - Click **Add Key** next to Anthropic → enter a key → **Confirm**
  - Masked key (`sk-ant-api...****`) appears; raw key is NOT shown
  - Select **Anthropic** in the provider dropdown → **Save Provider**
  - Verify: `users/{uid}.aiProvider = "anthropic"` in Firestore
  - Verify: `users/{uid}/apiKeys/anthropic` document exists (never readable from client)
  - Click **Remove** next to the key → it disappears from the UI

---

## 3. Transcript Detection

- [ ] **Meeting transcript detected within 15 minutes**
  - In Google Drive, create a Google Doc named:
    `Meeting transcript - <your title> - <YYYY-MM-DD>`
    with 2-3 clear action items (e.g. "Alice will send the report by Friday.")
  - Trigger the watcher immediately:
    ```bash
    curl -X POST "http://127.0.0.1:5001/taskbot-fb10d/us-central1/driveWatcher"
    ```
  - Verify: `processedTranscripts/{fileId}` document appears with `status: "pending"` → `"processing"` → `"extracting"` → `"proposed"`

- [ ] **Attendees identified from Calendar**
  - If a real Google Calendar event exists for the meeting, verify `attendeeEmails` contains the expected addresses
  - If no Calendar event: `attendeeEmails` contains at least the detecting user's email (fallback)

- [ ] **Duplicate prevention — same file detected twice**
  - Trigger `driveWatcher` a second time before processing completes
  - Verify: only ONE `processedTranscripts` document exists for that file

- [ ] **Duplicate prevention — multiple users' Drive copies**
  - If a second test user was in the same meeting, trigger their watcher cycle
  - Verify: the title + time dedup prevents a second `processedTranscripts` document from being created

---

## 4. AI Extraction

- [ ] **AI produces reasonable tasks**
  - After status reaches `"proposed"`, check `proposals/{meetingId}/tasks/`
  - Verify: task titles match the action items in the transcript
  - Verify: `assigneeEmail` is populated for each task
  - Verify: `confidence` is one of `"high"`, `"medium"`, `"low"`
  - Verify: `suggestedDueDate` is a valid `YYYY-MM-DD` string or `null`

- [ ] **Zero-tasks case handled gracefully**
  - Create a transcript with no action items (e.g. a status update meeting)
  - Verify: `processedTranscripts.status = "completed"` (not `"failed"`)

---

## 5. Email Notification

- [ ] **Notification email received**
  - After status = `"proposed"`, check function logs for `sendProposalNotification`
  - (Locally, emails are not sent — look in emulator logs for the email body)
  - Expected content: meeting title, task cards, **Review** link, **Approve All** link

- [ ] **Review link contains correct token**
  - Copy the review URL from the log; verify it matches `APP_URL/review?token=<64-char hex>`

---

## 6. Review Page — Email Click-Through (Token Flow)

- [ ] **Click review link → land on proposals**
  - Open the review URL from the email
  - Expected: proposals page loads with correct meeting title and task cards
  - Verify: user is signed in (name/email chip appears in header)

- [ ] **Expired token shows appropriate message**
  - In Firestore, set `approvalTokens/{token}.expiresAt` to a past timestamp
  - Open the review URL again
  - Expected: "This approval link has expired" message + **Sign in to Dashboard** button

- [ ] **Already-used token shows appropriate message**
  - After approving a task, try opening the same review URL again
  - Expected: "This link has already been used" message + **Sign in to Dashboard** button

---

## 7. Review Page — Dashboard Flow (Auth Flow)

- [ ] **Sign in → see pending proposals on dashboard**
  - Navigate to `/dashboard` while signed in
  - Expected: meeting card(s) with count of pending proposals

- [ ] **Click meeting → review page loads via auth flow**
  - Click a meeting card → redirected to `/review?meetingId=...`
  - Expected: proposals load without requiring the email token

---

## 8. Task Actions

- [ ] **Approve single task → created in Google Tasks**
  - Click **Approve** on a proposal card
  - Expected: button replaced by "⏳ Creating in Google Tasks…"
  - Within ~10 s: "✓ Created in Google Tasks — View" appears
  - Verify: task exists in https://tasks.google.com under the **TaskBot** list

- [ ] **Task notes contain Drive link and meeting info**
  - Open the created task in Google Tasks → expand notes
  - Expected: Drive file link + "Extracted by TaskBot from: \<meeting title\>"

- [ ] **Edit task → edited version created in Google Tasks**
  - Click **Edit** on a pending proposal → change the title → **Save & Approve**
  - Verify: Google Task title matches your edited version (not the AI original)

- [ ] **Reject task → not created in Google Tasks**
  - Click **Reject** on a proposal
  - Expected: card shows "✗ Rejected"; no task appears in Google Tasks

- [ ] **Approve All**
  - With multiple pending proposals, click **Approve All**
  - Expected: all cards update to "Approved"; all tasks appear in Google Tasks
  - Verify: `api.bulkAction` response shows correct `updated` count

- [ ] **Retry after failure**
  - Simulate a failure: revoke a user's Google Tasks scope mid-approval
  - Expected: card shows "✗ Failed to create in Google Tasks" + **Retry** button
  - Click Retry → task is created on second attempt

---

## 9. Expiry & Cleanup

- [ ] **Expired proposals cleaned up**
  - Set `proposals/{meetingId}/tasks/{taskId}.expiresAt` to a past timestamp
  - Trigger `expireProposals`:
    ```bash
    curl -X POST "http://127.0.0.1:5001/taskbot-fb10d/us-central1/expireProposals"
    ```
  - Verify: `status` changed to `"expired"`
  - Verify: expired approval tokens deleted from `approvalTokens/`

- [ ] **Race condition: approve a proposal at the same time as expiry**
  - Set `expiresAt` to ~1 s in the future
  - Immediately click **Approve**
  - Expected: either approved successfully OR receives a clear 409 error ("Proposal is already 'expired'")
  - The proposal must NOT silently end up as "expired" after a successful approval response

---

## 10. Token Revocation

- [ ] **User with revoked tokens sees "reconnect" prompt**
  - In Google Account settings, revoke TaskBot's access
  - Trigger a `driveWatcher` cycle
  - Verify: `users/{uid}.hasValidTokens = false`
  - Open Settings → banner "Google Account not connected" reappears

---

## 11. Health Check

- [ ] **Health check returns OK for all services**
  ```bash
  # Production
  curl https://us-central1-taskbot-fb10d.cloudfunctions.net/healthCheck

  # With live AI call (~1 token)
  curl "https://us-central1-taskbot-fb10d.cloudfunctions.net/healthCheck?ai=true"
  ```
  Expected:
  ```json
  {
    "status": "ok",
    "services": {
      "auth":       { "status": "ok" },
      "firestore":  { "status": "ok" },
      "aiProvider": { "status": "ok" },
      "googleApis": { "status": "ok" },
      "envVars":    { "status": "ok" }
    }
  }
  ```

---

## 12. Security Spot-Checks

- [ ] **Client cannot read OAuth tokens directly**
  - In browser devtools, try:
    ```js
    firebase.firestore().doc(`users/${uid}/tokens/google`).get()
    ```
  - Expected: permission denied error

- [ ] **Client cannot read approval tokens directly**
  - Try: `firebase.firestore().doc("approvalTokens/<any-token>").get()`
  - Expected: permission denied

- [ ] **User cannot read another user's proposals**
  - Try fetching `proposals/{otherMeetingId}/tasks/{taskId}` where `assigneeUid !== yourUid`
  - Expected: permission denied

- [ ] **API keys never returned in plaintext**
  - Call `GET /api/settings/api-keys` and verify the response only contains `masked` (never `key`)

---

## Notes

- If a step fails, check function logs first: Emulator UI → Logs tab → filter by function name
- To reset test data between runs, see [TESTING.md §5 — Resetting Test Data](TESTING.md)
- For production log access, see [TESTING.md §4 — Checking Logs](TESTING.md)

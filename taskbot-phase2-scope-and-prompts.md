# TaskBot Phase 2 — Scope & Claude Code Prompts

**Builds on:** MVP (Google Tasks, email notifications, approval web app)
**New features:** Asana integration, Slack integration, Kanban task dashboard with two-way sync
**Date:** March 5, 2026

---

## 1. What Phase 2 Adds

Three major capabilities on top of the working MVP:

**Asana Integration** — Users can choose to push approved tasks to Asana instead of (or in addition to) Google Tasks. Supports an org-wide default with per-user override.

**Slack Integration** — Notification channel with interactive approve/reject buttons directly in Slack DMs. Users pick email, Slack, or both in their settings.

**Task Dashboard** — Kanban-style board (pending / in progress / done) showing all tasks created by TaskBot. Two-way sync: marking a task complete on the dashboard marks it complete in Google Tasks / Asana, and vice versa. Supports editing, completing, and reassigning tasks to any TaskBot user.

---

## 2. Architecture Changes

### 2.1 — Task Destination Abstraction

The MVP hardcodes Google Tasks as the output. Phase 2 introduces a **task destination** pattern:

```
                    ┌─────────────────────┐
                    │  Approved Proposal   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Task Router         │
                    │  (reads user prefs)  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌────────────────┐ ┌───────────┐ ┌──────────────┐
     │ Google Tasks    │ │  Asana    │ │  Future:     │
     │ Creator         │ │  Creator  │ │  Jira, etc.  │
     └────────────────┘ └───────────┘ └──────────────┘
```

Each destination implements the same interface: `createTask()`, `updateTask()`, `completeTask()`, `getTask()`. The router reads the user's preference and delegates.

### 2.2 — Notification Channel Abstraction

Same pattern for notifications:

```
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌────────────────┐ ┌───────────┐ ┌──────────────┐
     │ Email           │ │  Slack    │ │  Future:     │
     │ Notifier        │ │  Notifier │ │  Teams, etc. │
     └────────────────┘ └───────────┘ └──────────────┘
```

User settings determine which channels fire. If "both," both run.

### 2.3 — Two-Way Sync Model

This is the most complex addition. The dashboard needs to reflect the current state of tasks in external systems, and actions on the dashboard need to propagate back.

**Sync strategy:**

- **Dashboard → External** (immediate): When a user acts on the dashboard (complete, edit, reassign), we immediately call the external API (Google Tasks / Asana) to apply the change.
- **External → Dashboard** (polling): A scheduled function polls external task systems every 5–10 minutes to detect changes made outside TaskBot (e.g., someone completes a task in Asana directly). Updates are written back to Firestore.
- **Conflict resolution:** Last-write-wins. If someone edits a task on the dashboard at the same time as in Asana, the most recent change wins. For MVP of Phase 2, this is acceptable — conflicts will be rare at 50 users.

### 2.4 — Updated User Settings Model

```
users/{uid}/preferences:
  taskDestination: "google_tasks" | "asana" | "both"
  notifyVia: "email" | "slack" | "both"
  autoApprove: boolean
  proposalExpiryHours: number
  asanaWorkspaceId?: string
  asanaProjectId?: string
  slackUserId?: string
```

Plus org-level defaults:

```
config/orgDefaults:
  taskDestination: "google_tasks"
  notifyVia: "email"
```

Users who haven't set a preference inherit the org default.

---

## 3. Work Packages & Estimates

| # | Work Package | Estimate |
|---|---|---|
| **WP1** | Task destination abstraction + refactor | 0.5 week |
| **WP2** | Asana OAuth + task creation | 1–1.5 weeks |
| **WP3** | Slack App setup + interactive notifications | 1.5–2 weeks |
| **WP4** | Kanban dashboard (Firestore-only, no sync yet) | 1.5–2 weeks |
| **WP5** | Two-way sync engine | 1.5–2 weeks |
| **WP6** | Task reassignment | 0.5–1 week |
| **WP7** | Notification channel abstraction + settings UI | 0.5–1 week |
| **WP8** | Integration testing + polish | 1–1.5 weeks |

**Total estimate: 8–11 weeks**

---

## 4. Claude Code Prompts

---

### Prompt 1 — Task Destination Abstraction

```
I need to refactor how TaskBot creates tasks so we can support multiple
destinations (Google Tasks, Asana, and future systems).

Currently, when a proposal is approved, the taskCreator.ts function
directly calls the Google Tasks API. I need to abstract this into a
pluggable destination system.

Please:

1. Create /functions/src/services/taskDestinations/taskDestination.ts:
   - Define a TypeScript interface TaskDestination with these methods:
     * createTask(tokens: any, taskData: TaskData): Promise<ExternalTaskRef>
     * updateTask(tokens: any, externalId: string, updates: Partial<TaskData>): Promise<void>
     * completeTask(tokens: any, externalId: string): Promise<void>
     * getTask(tokens: any, externalId: string): Promise<ExternalTaskStatus>
   - Define TaskData interface:
     * title: string
     * description: string
     * dueDate?: string
     * sourceLink: string (Drive transcript URL)
     * meetingTitle: string
     * meetingDate: string
   - Define ExternalTaskRef:
     * externalId: string (the ID in the external system)
     * externalUrl: string (deep link to the task in the external system)
     * destination: "google_tasks" | "asana"

2. Move the existing Google Tasks logic into
   /functions/src/services/taskDestinations/googleTasksDestination.ts
   that implements the TaskDestination interface.

3. Create /functions/src/services/taskDestinations/taskRouter.ts:
   - Function: getDestinationsForUser(uid: string): Promise<TaskDestination[]>
     * Reads the user's preferences from Firestore
     * If no preference set, reads org defaults from config/orgDefaults
     * Returns an array of destination instances (could be one or both)
   - Function: routeTask(uid: string, taskData: TaskData): Promise<ExternalTaskRef[]>
     * Gets destinations for user
     * Calls createTask on each destination
     * Returns all external refs

4. Update taskCreator.ts to use the router instead of calling Google
   Tasks directly.

5. Update the proposal Firestore model to support multiple destinations:
   - Change googleTaskId to:
     externalRefs: Array<{ destination: string, externalId: string, externalUrl: string }>
   - Migrate existing data: write a one-time script that converts any
     existing googleTaskId fields to the new externalRefs format.

6. Update the user preferences model in Firestore to include:
   - taskDestination: "google_tasks" | "asana" | "both" (default: "google_tasks")

7. Create a Firestore document at config/orgDefaults with:
   - taskDestination: "google_tasks"
   - notifyVia: "email"

Make sure all existing functionality still works exactly as before —
this is a refactor, not a feature addition. Google Tasks should work
identically after this change.
```

**Checkpoint:** Deploy and run the full pipeline. Tasks should still be created in Google Tasks exactly as before. Check that proposal documents now use the externalRefs format.

---

### Prompt 2 — Asana Integration

```
Add Asana as a task destination for TaskBot.

1. Asana OAuth setup:
   - Create /functions/src/services/asana/asanaAuth.ts
   - Asana uses OAuth 2.0: https://developers.asana.com/docs/oauth
   - Create two Cloud Function HTTP endpoints:
     * GET /api/auth/asana — initiates Asana OAuth flow (generates auth URL,
       redirects user to Asana consent screen)
     * GET /api/auth/asana/callback — handles the OAuth callback, exchanges
       code for tokens, stores tokens in Firestore under
       users/{uid}/asanaTokens
   - Asana tokens include access_token, refresh_token, and expires_in
   - Build a token refresh utility similar to the Google one

   IMPORTANT: I'll need to register an Asana App at
   https://app.asana.com/0/developer-console to get a client ID and secret.
   Add these as environment variables: ASANA_CLIENT_ID, ASANA_CLIENT_SECRET.
   Tell me exactly what redirect URL to configure in Asana's developer console.

2. Asana workspace/project selection:
   - Create /functions/src/services/asana/asanaApi.ts with:
     * getWorkspaces(tokens): lists the user's Asana workspaces
     * getProjects(tokens, workspaceId): lists projects in a workspace
     * createTask(tokens, projectId, taskData): creates a task
     * updateTask(tokens, taskId, updates): updates a task
     * completeTask(tokens, taskId): marks task complete
     * getTask(tokens, taskId): gets current task status
   - Use the Asana REST API (node-fetch or axios — not the official
     Asana npm client, it's heavy and poorly maintained)

3. Create /functions/src/services/taskDestinations/asanaDestination.ts:
   - Implements the TaskDestination interface from Prompt 1
   - createTask maps our TaskData to Asana's format:
     * name → title
     * notes → description + "\n\n---\nSource: [Drive link]\nExtracted
       by TaskBot from: [meeting title] ([date])"
     * due_on → dueDate (Asana uses YYYY-MM-DD format)
     * assignee → needs mapping (see below)
     * projects → [user's configured asanaProjectId]
   - For assignee mapping: look up the task assignee's email in Asana's
     workspace members. If found, assign directly. If not found, leave
     unassigned and add a note: "Originally assigned to [name] in meeting"

4. Add Asana connection flow to the settings page in /web/:
   - New section: "Connected Accounts"
     * Google: [connected] ✓
     * Asana: [Connect Asana] button → triggers OAuth flow
   - After connecting Asana, show a dropdown to select:
     * Workspace (auto-populated from API)
     * Project (auto-populated based on selected workspace)
   - Save selections to user preferences in Firestore
   - Task destination selector: radio buttons for
     "Google Tasks" | "Asana" | "Both"

5. Update taskRouter.ts to include asanaDestination when the user's
   preference includes Asana. Make sure it handles the case where a user
   selects Asana but hasn't connected their account yet (show a warning
   in the UI, fall back to Google Tasks).

Test by connecting your own Asana account (create a free Asana workspace
if you don't have one), approving a task, and verifying it appears in Asana
with the correct title, description, assignee, and Drive link.
```

**Checkpoint:** Approve a test task with destination set to "Asana." Verify it appears in your Asana project with correct details. Then test with "Both" — should appear in Google Tasks AND Asana.

---

### Prompt 3 — Slack App & Interactive Notifications

```
Build the Slack integration for TaskBot — both as a notification channel
and as an interactive approval surface.

This is the most complex prompt, so take it step by step.

PART A — Slack App Setup:

1. Create documentation at /docs/SLACK_SETUP.md explaining:
   - How to create a Slack App at https://api.slack.com/apps
   - Required OAuth scopes:
     * chat:write (send DMs)
     * users:read (look up users by email)
     * users:read.email (match Slack users to TaskBot users)
   - Required features:
     * Interactivity: enable and set the Request URL to our Cloud Function
     * Bot Token: we'll use this to send messages
   - What redirect URL to configure
   - What environment variables to set: SLACK_BOT_TOKEN,
     SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET

2. Create /functions/src/services/slack/slackAuth.ts:
   - OAuth flow for users to connect their Slack identity to TaskBot
   - HTTP endpoints: GET /api/auth/slack and GET /api/auth/slack/callback
   - After auth, store the Slack user ID in the user's Firestore preferences
     (slackUserId field)
   - Also create a function: findSlackUserByEmail(email) that uses the
     Slack API to look up a user's Slack ID from their email address
     (useful for auto-mapping during first setup)

PART B — Slack Notification with Interactive Buttons:

3. Create /functions/src/services/slack/slackNotifier.ts:
   - Function: sendProposalNotification(slackUserId, proposals, meetingTitle)
   - Sends a Slack Block Kit message as a DM to the user
   - Message structure:
     * Header: "TaskBot: [N] proposed tasks from [Meeting Title]"
     * For each task (max 10 — Slack has block limits):
       - Task title (bold)
       - Confidence badge: 🟢 high / 🟡 medium / 🔴 low
       - Truncated description (max 200 chars)
       - Three buttons in an actions block: "Approve ✓" | "Reject ✗" | "View Details"
       - Each button's value encodes: { meetingId, taskId, action }
     * Footer section with a "Review All in Dashboard" link to the web app
     * If more than 10 tasks: show first 10 + "and [N] more — review
       all in dashboard" with link
   - Use Slack's Web API (chat.postMessage) with the bot token

4. Create /functions/src/functions/slackInteraction.ts:
   - HTTP Cloud Function endpoint that receives Slack interaction payloads
   - Slack sends a POST when a user clicks a button
   - Verify the request using the Slack signing secret (CRITICAL for security)
   - Parse the action:
     * "approve" → update proposal status to "approved" in Firestore
       (which triggers the existing taskCreator)
     * "reject" → update proposal status to "rejected"
     * "view_details" → respond with an ephemeral message showing the
       full description + transcript excerpt + Drive link
   - After approve/reject: update the original Slack message to show the
     result (strikethrough + "✓ Approved" or "✗ Rejected") using
     chat.update. This gives instant visual feedback.
   - Register this endpoint URL in the Slack App's Interactivity settings

PART C — Wire It Up:

5. Create /functions/src/services/notifications/notificationRouter.ts:
   - Same pattern as task destinations:
     * Reads user preference (email, slack, both)
     * Falls back to org default if not set
     * Calls the appropriate notifier(s)
   - Update notifyUsers.ts to use the router instead of calling
     emailSender directly

6. Update the settings page in /web/:
   - Add Slack connection: "Connect Slack" button → OAuth flow
   - After connecting, show: "Slack: connected as @username ✓"
   - Notification preference: radio buttons for "Email" | "Slack" | "Both"
   - Save to user preferences

7. Update the org defaults settings (add a simple admin section in
   settings, visible only to the first registered user for now):
   - Default task destination: dropdown
   - Default notification channel: dropdown

Important: The Slack interactive buttons should work as a complete
approval flow — the user should be able to approve/reject tasks without
ever opening the web app. The "View Details" button provides the extra
context they might need to decide.
```

**Checkpoint:** Trigger the full pipeline. You should get a Slack DM with task proposals and working buttons. Approve a task via Slack button → verify it appears in Google Tasks / Asana. Reject one → verify it's marked rejected in Firestore and the Slack message updates.

---

### Prompt 4 — Kanban Task Dashboard

```
Build a Kanban-style task dashboard in the TaskBot web app.

This dashboard shows ALL tasks that TaskBot has created for the logged-in
user, organized in three columns: Pending, In Progress, and Done.

1. Create a new page in /web/ at /tasks (add navigation: Dashboard |
   Tasks | Settings):

   Layout — three-column Kanban board:
   - Column 1: "Pending" — tasks with status "created" (approved and
     pushed to external system but not started)
   - Column 2: "In Progress" — tasks the user has marked as in progress
   - Column 3: "Done" — tasks marked complete

   Each task card shows:
   - Task title (editable — click to edit inline)
   - Destination badge: "Google Tasks" or "Asana" or both (small pills)
   - Source: meeting title + date (small text, links to Drive transcript)
   - Assignee avatar/name (or "You" if self-assigned)
   - Due date (if set) — highlight in red if overdue
   - Confidence badge from original extraction (subtle, small)
   - Actions: "Complete ✓" | "Edit ✏️" | "Reassign 👤"

2. Drag and drop:
   - Users can drag cards between columns to change status
   - Dragging to "Done" triggers the complete action
   - Dragging from "Done" back to "In Progress" reopens the task
   - Use a lightweight drag-and-drop library (recommend SortableJS or
     similar — or implement with HTML5 drag-and-drop if you think
     that's simpler for this case)

3. Filters and sorting:
   - Filter by: meeting (dropdown), date range, destination
   - Sort by: date created, due date, meeting
   - Search: filter cards by title text

4. Task actions — these need to work both in Firestore AND in the
   external system:

   a. Mark complete:
      - Update proposal status in Firestore to "completed"
      - Call the appropriate TaskDestination.completeTask() for each
        external ref
      - Move card to "Done" column
      - Handle errors: if external API fails, show a warning but still
        update Firestore (we'll sync later)

   b. Edit task:
      - Inline editing of title and description
      - On save: update Firestore AND call TaskDestination.updateTask()
        for each external ref
      - Show a saving indicator

   c. Reassign:
      - Click "Reassign" → shows a dropdown of all TaskBot users
        (fetched from Firestore users collection, only active users)
      - On select: update assignee in Firestore
      - In external system: update the assignee (map email → Asana
        member / Google Tasks moves to the new user's task list)
      - If the new assignee doesn't have the external system connected,
        show a warning: "Maria doesn't have Asana connected — task will
        only update in TaskBot"

5. Create the API endpoints in /functions/src/functions/api.ts:
   - GET /api/tasks — returns all tasks for the logged-in user, with
     current status from Firestore. Supports query params: ?status=,
     ?meetingId=, ?from=&to= (date range)
   - PATCH /api/tasks/{meetingId}/{taskId} — update task
     (status, title, description, assignee)
   - POST /api/tasks/{meetingId}/{taskId}/complete — mark complete
   - POST /api/tasks/{meetingId}/{taskId}/reopen — move back from done
   - GET /api/users/active — returns list of active TaskBot users
     (for reassignment dropdown)

6. Add "In Progress" as a valid status to the proposal model:
   - Update the status type to: "pending" | "approved" | "rejected" |
     "edited" | "created" | "in_progress" | "completed" | "expired"

7. Real-time updates:
   - Use Firestore onSnapshot listeners in the frontend so the board
     updates in real-time when tasks change (e.g., if the sync engine
     updates a task's status in the background, the card moves
     automatically)

Style the Kanban board to be clean and usable:
- White cards with subtle shadows
- Column headers with task count badges
- Smooth drag animations
- Mobile responsive (stack columns vertically on small screens)
- Color-coded due dates (grey = no date, blue = upcoming, red = overdue)
```

**Checkpoint:** Navigate to /tasks. You should see your existing approved tasks in the Pending column. Drag one to Done → verify it's marked complete in Google Tasks/Asana. Edit a task title → verify the change appears in the external system.

---

### Prompt 5 — Two-Way Sync Engine

```
Build the two-way sync engine that keeps the TaskBot dashboard in sync
with Google Tasks and Asana.

The dashboard already pushes changes TO external systems (from Prompt 4).
Now we need to pull changes FROM external systems back to Firestore.

1. Create /functions/src/functions/syncEngine.ts:
   - Scheduled Cloud Function that runs every 10 minutes
   - For each active user with tasks in "created" or "in_progress" status:
     * Get all their proposal documents that have externalRefs
     * For each external ref, call TaskDestination.getTask() to get
       the current status from the external system
     * Compare with Firestore status
     * If different: update Firestore to match the external system
   - Implement getTask() for both destinations:

   Google Tasks:
   - GET the task by ID from Google Tasks API
   - Map status: "needsAction" → "created" or "in_progress",
     "completed" → "completed"
   - Also check if title or notes changed externally

   Asana:
   - GET the task by ID from Asana API
   - Map: completed=false → "created" or "in_progress",
     completed=true → "completed"
   - Check name, notes, assignee for changes

2. Conflict handling:
   - Use an "updatedAt" timestamp on each proposal document
   - Use an "externalUpdatedAt" field to track when the external
     system last changed
   - Rule: if externalUpdatedAt > our last sync timestamp, the
     external change wins. Otherwise, our version is authoritative.
   - Log all sync conflicts for debugging

3. Sync status tracking in Firestore — add to proposal documents:
   - lastSyncedAt: Timestamp
   - syncStatus: "synced" | "pending_sync" | "conflict" | "error"
   - externalUpdatedAt: Timestamp (from external system)

4. Performance considerations:
   - Process max 5 users concurrently (same pattern as Drive Watcher)
   - Only sync tasks from the last 30 days (don't check ancient tasks)
   - If a user has more than 50 active tasks, paginate
   - Cache external API responses for 5 minutes to avoid duplicate calls
     if a user has tasks in multiple meetings

5. Add sync status indicator to the dashboard:
   - Small icon on each task card: ✓ synced (green) | ↻ syncing (blue
     spinner) | ⚠ sync error (yellow)
   - A "Last synced: X minutes ago" indicator at the top of the board
   - Manual "Sync Now" button that triggers an immediate sync for the
     current user (separate HTTP Cloud Function)

6. Error resilience:
   - If an external API is down, don't mark tasks as errored — just
     skip and retry next cycle
   - If a task was deleted in the external system, mark it as
     "external_deleted" in Firestore and show it greyed out on the
     board with an option to recreate it
   - If tokens are expired, set a flag and show "Reconnect [service]"
     in the UI (same pattern as MVP)

7. Add a Cloud Function: POST /api/sync/now — triggers immediate sync
   for the requesting user. Called by the "Sync Now" button.
```

**Checkpoint:** Create a task via TaskBot → it appears in Asana. Go to Asana and mark it complete. Wait 10 minutes (or hit Sync Now). The card should move to the Done column automatically. Edit a task title in Google Tasks → verify it updates on the dashboard after sync.

---

### Prompt 6 — Notification Channel Abstraction & Settings

```
Refactor the notification system to support multiple channels and update
the settings UI to handle all Phase 2 preferences.

1. Create /functions/src/services/notifications/notificationChannel.ts:
   - Interface NotificationChannel:
     * sendProposalNotification(userId, proposals, meetingContext): Promise<void>
     * getChannelName(): string
   - Move existing email sender to implement this interface:
     /functions/src/services/notifications/emailChannel.ts
   - Create Slack channel implementation:
     /functions/src/services/notifications/slackChannel.ts
     (wraps the slackNotifier from Prompt 3)

2. Update notificationRouter.ts:
   - Reads user preference: "email" | "slack" | "both"
   - Falls back to org default from config/orgDefaults
   - Sends via all selected channels
   - If a channel fails (e.g., Slack token expired), log the error
     and try the other channel(s) — don't fail silently, but don't
     block the other channels either

3. Overhaul the settings page in /web/ to consolidate all preferences:

   Section 1: TaskBot Status
   - Toggle: Active on/off
   - Auto-approve: checkbox

   Section 2: Connected Accounts
   - Google: [connected as email@thg.com] ✓ | [Reconnect]
   - Asana: [Connect Asana] or [connected to Workspace X / Project Y] ✓
     * If connected, show workspace + project selection dropdowns
     * [Disconnect] link
   - Slack: [Connect Slack] or [connected as @username] ✓
     * [Disconnect] link

   Section 3: Preferences
   - Task destination: Google Tasks | Asana | Both
     (greyed out if Asana not connected, with "Connect Asana first" hint)
   - Notifications: Email | Slack | Both
     (greyed out if Slack not connected, with "Connect Slack first" hint)
   - Proposal expiry: 24h | 48h | 72h

   Section 4: Org Defaults (visible only to admin user)
   - Default task destination
   - Default notification channel
   - Note: "These apply to users who haven't set their own preferences"

4. Handle edge cases in the router:
   - User picks Slack but hasn't connected → fall back to email, show
     a toast warning on next login: "You selected Slack notifications
     but haven't connected Slack yet. Using email as fallback."
   - User picks Asana but Asana tokens expired → fall back to Google
     Tasks, send an email warning: "Your Asana connection has expired.
     Tasks were created in Google Tasks instead. Reconnect Asana in
     settings."

5. Update the user preferences model to support all new fields and
   make sure defaults cascade correctly: user preference → org default
   → system fallback (Google Tasks + email).
```

**Checkpoint:** Change notification preference to "Both." Trigger the pipeline. You should receive both an email AND a Slack DM. Change task destination to "Both" → approve a task → should appear in both Google Tasks and Asana.

---

### Prompt 7 — Integration Testing & Polish

```
Final review and integration testing for Phase 2.

1. Review all new Cloud Functions for:
   - Timeout settings (sync engine and Asana API calls may need 120–300s)
   - Memory allocation (increase if any function handles large datasets)
   - Cold start impact (are there heavy imports that could be lazy-loaded?)

2. Review Firestore security rules for new collections/fields:
   - Asana tokens: same security as Google tokens (owner-only access)
   - approvalTokens from Slack interactions: verify they're properly
     scoped
   - config/orgDefaults: readable by all authenticated users, writable
     only by admin

3. Review the two-way sync for race conditions:
   - What happens if the sync engine runs while a user is editing a task
     on the dashboard? (sync should not overwrite in-flight edits)
   - What happens if the same task exists in Google Tasks AND Asana and
     both change simultaneously? (each destination syncs independently)
   - What happens if a user reassigns a task and the sync runs before
     the reassignment completes in the external system?

4. Add to the existing test checklist (/docs/TEST_CHECKLIST.md):

   Asana Integration:
   - [ ] Connect Asana account via settings → OAuth flow works
   - [ ] Select workspace and project in settings
   - [ ] Set destination to "Asana" → approved task appears in Asana
   - [ ] Set destination to "Both" → task appears in Google Tasks AND Asana
   - [ ] Asana task has correct title, description, Drive link, and assignee
   - [ ] Disconnect Asana → falls back to Google Tasks with warning

   Slack Integration:
   - [ ] Connect Slack via settings → OAuth flow works
   - [ ] Set notification to "Slack" → receive DM with task proposals
   - [ ] Approve task via Slack button → task created in external system
   - [ ] Reject task via Slack button → task marked rejected
   - [ ] View Details button → shows full description + transcript link
   - [ ] Slack message updates after approve/reject (visual feedback)
   - [ ] Set notification to "Both" → receive email AND Slack DM
   - [ ] Disconnect Slack → falls back to email with warning

   Kanban Dashboard:
   - [ ] Tasks board shows all created tasks in correct columns
   - [ ] Drag task to Done → marked complete in external system
   - [ ] Drag task from Done to In Progress → reopened in external system
   - [ ] Edit task inline → change synced to external system
   - [ ] Reassign task to another TaskBot user → assignee updated
   - [ ] Reassign to user without Asana → shows appropriate warning
   - [ ] Filters work (by meeting, date, destination)
   - [ ] Search filters cards by title
   - [ ] Real-time updates (change in Firestore → board updates live)

   Two-Way Sync:
   - [ ] Complete task in Asana → moves to Done on dashboard within 10 min
   - [ ] Complete task in Google Tasks → moves to Done on dashboard
   - [ ] Edit task title in Asana → updates on dashboard after sync
   - [ ] Delete task in external system → shows greyed out with recreate option
   - [ ] "Sync Now" button triggers immediate sync
   - [ ] Sync status indicators show correct state
   - [ ] Expired external tokens → shows reconnect prompt

   Settings:
   - [ ] Connected accounts section shows correct state for all services
   - [ ] Preference changes are saved and respected by the system
   - [ ] Org defaults are applied when user has no preference set
   - [ ] Admin can set org defaults

5. Fix any issues found. List anything that needs my input.
```

**Final Checkpoint:** Run through the entire checklist. Pay special attention to the two-way sync scenarios — those are the most likely to have edge cases.

---

## 5. Environment Variables — Phase 2 Additions

```
# Asana (from Asana Developer Console)
ASANA_CLIENT_ID=your-asana-client-id
ASANA_CLIENT_SECRET=your-asana-client-secret

# Slack (from Slack App settings)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CLIENT_ID=your-slack-client-id
SLACK_CLIENT_SECRET=your-slack-client-secret
```

Set via Firebase CLI:
```bash
npx firebase functions:config:set asana.client_id="VALUE" asana.client_secret="VALUE"
npx firebase functions:config:set slack.bot_token="VALUE" slack.signing_secret="VALUE" slack.client_id="VALUE" slack.client_secret="VALUE"
```

---

## 6. External Setup Required

Before starting the prompts, you'll need to create accounts/apps in these platforms:

**Asana:**
1. Create a free Asana account if you don't have one (for development)
2. Go to https://app.asana.com/0/developer-console
3. Create a new app → note the client ID and secret
4. Set the redirect URL (Claude Code will tell you the exact URL in Prompt 2)

**Slack:**
1. Go to https://api.slack.com/apps → Create New App
2. Choose "From scratch" → name it "TaskBot" → select your workspace
3. Under OAuth & Permissions, add scopes: `chat:write`, `users:read`, `users:read.email`
4. Under Interactivity, enable it (you'll set the Request URL after deploying Prompt 3)
5. Install the app to your workspace
6. Note: Bot Token, Signing Secret, Client ID, Client Secret

---

## 7. Risks Specific to Phase 2

| Risk | Impact | Mitigation |
|---|---|---|
| Asana API rate limits | Sync engine gets throttled at scale | Batch requests, respect rate headers, back off on 429s |
| Slack Block Kit limits | Can't show more than ~10 tasks per message | Truncate + link to web app for full list |
| Two-way sync conflicts | Task state gets confused | Last-write-wins + logging. Acceptable for 50 users |
| Asana adoption unknown | Build integration nobody uses | It's modular — if unused, it sits dormant. No wasted infra cost |
| Sync engine cost | Scheduled function polling every 10 min for 50 users | Optimize: only sync tasks from last 30 days, skip users with no active tasks |

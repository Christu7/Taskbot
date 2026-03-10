# Phase 2 — Prompt 5 (Refined) — Two-Way Sync Engine

Copy the entire block below into Claude Code.

---

```
Build the two-way sync engine that keeps the TaskBot dashboard in sync
with Google Tasks and Asana.

The dashboard (from Prompt 4) already pushes changes TO external systems.
Now we need to pull changes FROM external systems back to Firestore.

I'm giving you a detailed architecture to follow — don't deviate from
this structure.

═══════════════════════════════════════════════════════════════════
PART 1 — FIRESTORE SCHEMA ADDITIONS
═══════════════════════════════════════════════════════════════════

Add these fields to every proposal document at
proposals/{meetingId}/tasks/{taskId}:

  lastSyncedAt: Timestamp | null      // when we last checked external
  syncStatus: "synced" | "pending_sync" | "sync_error" | "external_deleted"
  externalUpdatedAt: Timestamp | null  // last modified time FROM the external system
  localUpdatedAt: Timestamp            // last modified time in OUR system (set on every local write)
  syncError?: string                   // error message if sync failed

IMPORTANT: Every function that writes to a proposal document (taskCreator,
the dashboard PATCH endpoints, the Kanban drag-drop actions from Prompt 4)
must set localUpdatedAt = Timestamp.now() on every write. Review and
update all existing write paths before building the sync engine. This is
the foundation of conflict resolution — if you miss a write path, sync
will overwrite user changes.

The list of write paths to update:
  - taskCreator.ts (on task creation: set localUpdatedAt, syncStatus="synced", lastSyncedAt=now)
  - api.ts PATCH /api/tasks/{meetingId}/{taskId} (on edit)
  - api.ts POST .../complete (on complete)
  - api.ts POST .../reopen (on reopen)
  - slackInteraction.ts (on approve/reject via Slack button)

═══════════════════════════════════════════════════════════════════
PART 2 — IMPLEMENT getTask() ON BOTH DESTINATIONS
═══════════════════════════════════════════════════════════════════

The TaskDestination interface from Prompt 1 already defines:
  getTask(tokens: any, externalId: string): Promise<ExternalTaskStatus>

Define ExternalTaskStatus (if not already defined):

  interface ExternalTaskStatus {
    exists: boolean            // false if task was deleted externally
    title: string
    description: string
    isCompleted: boolean
    externalUpdatedAt: Date    // when the external system last modified this
    assigneeEmail?: string     // only Asana provides this reliably
    rawResponse: any           // store the full API response for debugging
  }

Now implement getTask() in each destination:

A. googleTasksDestination.ts — getTask():
   - Call Google Tasks API: tasks.tasks.get({ tasklist: listId, task: externalId })
   - The user's TaskBot list ID is cached in their Firestore user doc
     (ensureTaskList from Prompt 5.2 already does this)
   - Map the response:
     * exists: true (if API returns 200; catch 404 → exists: false)
     * title: response.title
     * description: response.notes
     * isCompleted: response.status === "completed"
     * externalUpdatedAt: new Date(response.updated)
   - Handle 404 (task deleted) → return { exists: false, ... }
   - Handle 401/403 (token expired) → throw TokenExpiredError

B. asanaDestination.ts — getTask():
   - Call Asana API: GET /tasks/{externalId}
     with opt_fields: "name,notes,completed,modified_at,assignee,assignee.email"
   - Map the response:
     * exists: true (catch 404 → exists: false)
     * title: response.data.name
     * description: response.data.notes
     * isCompleted: response.data.completed === true
     * externalUpdatedAt: new Date(response.data.modified_at)
     * assigneeEmail: response.data.assignee?.email
   - Handle 404 → return { exists: false, ... }
   - Handle 401/403 → throw TokenExpiredError

═══════════════════════════════════════════════════════════════════
PART 3 — SYNC ENGINE (SCHEDULED CLOUD FUNCTION)
═══════════════════════════════════════════════════════════════════

Create /functions/src/functions/syncEngine.ts

This is a scheduled Cloud Function that runs every 10 minutes.
Follow the EXACT same batching pattern as driveWatcher.ts:
  - Get all active users with valid tokens
  - Process max 5 users concurrently using Promise.all with chunking
  - Add a 1-second delay between chunks (same as Drive Watcher)

Structure the function as three composed steps:

  STEP 1: getUsersToSync()
    - Query Firestore: users where isActive === true AND hasValidTokens === true
    - For each user, check if they have ANY proposals with status in
      ["created", "in_progress"] AND lastSyncedAt older than 5 minutes ago
      (or lastSyncedAt is null)
    - Skip users with zero syncable tasks (saves API calls)
    - Return: array of { uid, tokens, asanaTokens? }

  STEP 2: getTasksToSync(uid)
    - Query proposals across ALL meetings for this user:
      collectionGroup query on "tasks" where:
        assigneeUid === uid
        AND status in ["created", "in_progress"]
        AND createdAt > 30 days ago (don't sync ancient tasks)
    - Return: array of proposal documents with their externalRefs
    - IMPORTANT: Use collectionGroup("tasks") with the assigneeUid filter.
      Make sure firestore.indexes.json has the composite index for this:
      collection: "tasks", fields: [assigneeUid ASC, status ASC, createdAt DESC]

  STEP 3: syncSingleTask(proposal, userTokens)
    - For EACH externalRef in the proposal's externalRefs array:
      a. Get the destination instance (google_tasks or asana) from the router
      b. Call destination.getTask(tokens, externalRef.externalId)
      c. Compare with Firestore state using this logic:

    CONFLICT RESOLUTION — follow this decision tree exactly:

    IF external.exists === false:
      → Set syncStatus = "external_deleted"
      → Do NOT change the proposal status
      → Log: "Task {id} deleted externally in {destination}"

    ELSE IF external.isCompleted AND proposal.status !== "completed":
      → Check: is external.externalUpdatedAt > proposal.localUpdatedAt?
        YES → Update proposal: status = "completed", syncStatus = "synced",
              lastSyncedAt = now, externalUpdatedAt = external.externalUpdatedAt
        NO  → Skip (our local change is newer, we'll push it out next cycle)

    ELSE IF !external.isCompleted AND proposal.status === "completed":
      → Someone reopened the task externally
      → Check: is external.externalUpdatedAt > proposal.localUpdatedAt?
        YES → Update proposal: status = "in_progress", syncStatus = "synced"
        NO  → Skip

    ELSE IF external.title !== proposal title (use editedTitle || title):
      → Check: is external.externalUpdatedAt > proposal.localUpdatedAt?
        YES → Update proposal: editedTitle = external.title, syncStatus = "synced"
        NO  → Skip

    ELSE (no meaningful changes detected):
      → Just update: lastSyncedAt = now, syncStatus = "synced"

    CATCH TokenExpiredError:
      → Set hasValidTokens = false on the user doc
      → Stop syncing this user entirely (break out of the user's task loop)
      → Log warning

    CATCH any other error:
      → Set syncStatus = "sync_error", syncError = error.message on this task
      → Continue to next task (don't abort the whole user)

    IMPORTANT: When updating Firestore in the sync engine, use a Firestore
    transaction or batch write to ensure localUpdatedAt is NOT bumped by
    sync writes. Instead, only update lastSyncedAt and externalUpdatedAt.
    This prevents the sync from creating a feedback loop where syncing a
    task makes it look like a "local change" next cycle.

    Create a dedicated function for sync writes:
      syncUpdateProposal(meetingId, taskId, updates)
    that explicitly does NOT set localUpdatedAt. This is different from
    the normal updateProposal() used by the dashboard/API which DOES
    set localUpdatedAt.

═══════════════════════════════════════════════════════════════════
PART 4 — MANUAL SYNC ENDPOINT
═══════════════════════════════════════════════════════════════════

Add to api.ts:

  POST /api/sync/now
    - Auth required (Firebase token)
    - Runs the sync for ONLY the requesting user (same logic as above,
      but just for one user)
    - Returns: { synced: number, errors: number, deleted: number }
    - Timeout: 120 seconds (set in function config)

═══════════════════════════════════════════════════════════════════
PART 5 — DASHBOARD UI ADDITIONS
═══════════════════════════════════════════════════════════════════

Update the Kanban board in /web/ to show sync state:

1. Sync status icon on each task card (bottom-right corner, small):
   - syncStatus === "synced" → green ✓ (tooltip: "Synced")
   - syncStatus === "pending_sync" → grey clock (tooltip: "Waiting for sync")
   - syncStatus === "sync_error" → yellow ⚠ (tooltip: error message)
   - syncStatus === "external_deleted" → red strikethrough on the card,
     greyed out, with a small "Recreate" button that creates a new task
     in the external system

2. Global sync bar at the top of the Kanban board:
   - Left side: "Last synced: X minutes ago" (reads the most recent
     lastSyncedAt across all visible tasks)
   - Right side: "Sync Now" button
     * On click: POST /api/sync/now
     * Show a spinner while syncing
     * On success: "Synced N tasks" toast
     * On error: "Sync failed — check connection" toast
   - The bar should also show a count of sync errors if any exist:
     "⚠ 2 tasks have sync issues"

3. For "external_deleted" tasks, the Recreate button should:
   - Call the existing task creation flow (TaskDestination.createTask)
   - Update the externalRef with the new external ID
   - Set syncStatus back to "synced"

4. Real-time: The Firestore onSnapshot listeners from Prompt 4 should
   already handle sync updates automatically (the sync engine writes
   to the same proposal documents). Verify this works — when the sync
   engine updates a task status, the Kanban card should move columns
   without a page refresh.

═══════════════════════════════════════════════════════════════════
PART 6 — CLOUD FUNCTION CONFIG
═══════════════════════════════════════════════════════════════════

Set these on the syncEngine function:
  - Timeout: 300 seconds (sync could be slow with many users/tasks)
  - Memory: 512MB
  - Schedule: every 10 minutes

Set on the /api/sync/now function:
  - Timeout: 120 seconds
  - Memory: 256MB

═══════════════════════════════════════════════════════════════════
PART 7 — FIRESTORE INDEXES
═══════════════════════════════════════════════════════════════════

Add these composite indexes to firestore.indexes.json:

  Collection group "tasks":
    - assigneeUid ASC, status ASC, createdAt DESC
    (needed for the collectionGroup query in getTasksToSync)

Deploy indexes BEFORE deploying functions:
  npx firebase deploy --only firestore:indexes

═══════════════════════════════════════════════════════════════════
ORDER OF IMPLEMENTATION
═══════════════════════════════════════════════════════════════════

Build in this exact order:
  1. Schema additions (Part 1) — update all existing write paths first
  2. ExternalTaskStatus type + getTask() implementations (Part 2)
  3. Firestore indexes (Part 7) — deploy these early
  4. Sync engine function (Part 3)
  5. Manual sync endpoint (Part 4)
  6. Dashboard UI additions (Part 5)
  7. Function config (Part 6)
  8. Test: create a task → change it in Google Tasks → hit Sync Now →
     verify dashboard updates

After building, list any write paths you found that I didn't mention
in Part 1 that also needed localUpdatedAt.
```

---

## What this refined prompt does differently

**For your reference — don't include this section in the Claude Code prompt.**

The original Prompt 5 was ~40 lines of high-level intent. This version is ~200 lines of specific architecture. Here's what changed and why:

1. **Explicit Firestore schema** — Instead of "add sync tracking fields," every field is named, typed, and its purpose explained. Sonnet won't have to guess.

2. **All write paths enumerated** — The hardest bug in a sync engine is forgetting to update a timestamp somewhere, creating a loop where sync overwrites user changes. The prompt lists every write path that needs `localUpdatedAt`.

3. **Decision tree for conflict resolution** — Instead of "last-write-wins," there's a concrete if/else tree with exactly what to compare and what to update. This is where the original prompt would have caused Sonnet the most trouble — ambiguous conflict resolution leads to subtle bugs.

4. **Dedicated `syncUpdateProposal` function** — This is the critical insight: sync writes must NOT bump `localUpdatedAt`, or you create a feedback loop. The original prompt didn't mention this at all.

5. **API response mapping spelled out** — Exactly which Google Tasks and Asana API fields map to which ExternalTaskStatus fields. Sonnet won't have to look up API docs.

6. **Build order specified** — Part 1 must come before Part 3, indexes must deploy before functions. The original prompt left ordering implicit.

7. **Reuses existing patterns** — Explicitly tells Sonnet to follow the Drive Watcher's batching pattern (which it already built and understands) rather than inventing a new approach.

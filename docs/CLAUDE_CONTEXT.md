# TaskBot — Claude Context Handout

> Drop this file into a new Claude conversation to provide full project context.
> Last updated: Phase 3 complete (Prompts 1–7).

---

## 1. What TaskBot Is

A Firebase-based SaaS application that:
1. Monitors users' Google Drive for meeting transcript files
2. Uses AI (Claude or GPT) to extract action items
3. Routes extracted tasks to Google Tasks and/or Asana
4. Notifies assignees via email and/or Slack
5. Provides a web dashboard for proposal review, task tracking, and two-way sync
6. Has a full admin panel for credential management, user management, and monitoring

**Stack:** Firebase Cloud Functions (TypeScript, Node 22) · Firestore · Firebase Hosting · Vanilla HTML/CSS/JS

---

## 2. Repository Structure

```
Taskbot/
├── deploy/
│   ├── configs/
│   │   ├── .gitignore        # Ignores all client configs except template
│   │   ├── template.json     # Per-client config template
│   │   └── internal.json     # Reference config (gitignored)
│   ├── setup-new-client.sh   # Bootstrap a new Firebase project
│   ├── deploy.sh             # Deploy updates to one client
│   └── deploy-all.sh         # Deploy updates to all clients
│
├── docs/
│   ├── CLAUDE_CONTEXT.md     # This file
│   ├── TEST_CHECKLIST.md     # Full integration test checklist (Sections 1–19)
│   └── SLACK_SETUP.md        # Slack app configuration guide
│
├── functions/src/
│   ├── index.ts              # Admin SDK init, onUserCreated, oauthInit/Callback, updateUserSettings
│   ├── auth/                 # Google OAuth helpers (config, oauthClient, tokenRefresh, tokenStore)
│   ├── functions/
│   │   ├── api.ts            # Main Express HTTP function (all /api/* routes)
│   │   ├── adminApi.ts       # Admin-only Express router (mounted at /api/admin/*)
│   │   ├── driveWatcher.ts   # Scheduled: polls Drive for new transcripts
│   │   ├── processTranscript.ts  # Firestore trigger: AI extraction pipeline
│   │   ├── notifyUsers.ts    # Firestore trigger: sends notifications when proposed
│   │   ├── taskCreator.ts    # Firestore trigger: creates tasks in external systems
│   │   ├── expireProposals.ts # Scheduled: marks old proposals expired
│   │   ├── syncEngine.ts     # Scheduled: two-way sync with external task systems
│   │   ├── slackInteraction.ts # HTTP: handles Slack button interactions
│   │   └── healthCheck.ts    # HTTP: /healthCheck status endpoint
│   ├── middleware/
│   │   ├── auth.ts           # requireAuth + requireAdmin Express middleware
│   │   └── adminRateLimit.ts # 10 req/min per UID rate limiter for admin routes
│   ├── models/
│   │   ├── user.ts           # UserDocument, UserPreferences interfaces
│   │   ├── proposal.ts       # ProposalDocument interface
│   │   ├── processedTranscript.ts  # ProcessedTranscriptDocument interface
│   │   ├── aiExtraction.ts   # ExtractedTask, MeetingContext interfaces
│   │   └── approvalToken.ts  # ApprovalToken interface
│   ├── prompts/
│   │   └── taskExtraction.ts # AI system prompt for task extraction
│   ├── services/
│   │   ├── secrets.ts        # getSecret / setSecrets / getMaskedSecrets (KMS-encrypted)
│   │   ├── kms.ts            # Cloud KMS encrypt/decrypt wrappers
│   │   ├── aiProvider.ts     # AIProvider interface + AnthropicProvider
│   │   ├── openaiProvider.ts # OpenAI provider implementation
│   │   ├── aiExtractor.ts    # extractTasksFromTranscript orchestrator
│   │   ├── activityLogger.ts # logActivity() → activityLog collection
│   │   ├── drive.ts          # getTranscriptContent from Drive API
│   │   ├── calendar.ts       # getAttendeesFromCalendar
│   │   ├── firestore.ts      # createUser / getUser / updateUser / getUserByEmail
│   │   ├── emailSender.ts    # sendProposalEmail / sendInviteEmail via Gmail API
│   │   ├── googleTasks.ts    # Google Tasks API wrapper
│   │   ├── approvalTokens.ts # generateApprovalToken / validateApprovalToken
│   │   ├── asana/
│   │   │   ├── asanaAuth.ts  # Asana OAuth flow + token storage
│   │   │   └── asanaApi.ts   # Asana API calls (workspaces, projects, tasks)
│   │   ├── slack/
│   │   │   ├── slackClient.ts    # lookupUserByEmail, postMessage
│   │   │   └── slackNotifier.ts  # sendSlackProposalNotification
│   │   ├── notifications/
│   │   │   ├── notificationChannel.ts  # ChannelContext interface
│   │   │   ├── notificationRouter.ts   # Routes to email/slack based on user prefs
│   │   │   ├── emailChannel.ts         # Email notification channel
│   │   │   └── slackChannel.ts         # Slack channel (falls back to email)
│   │   └── taskDestinations/
│   │       ├── taskDestination.ts       # TaskDestination interface
│   │       ├── googleTasksDestination.ts # Google Tasks implementation
│   │       ├── asanaDestination.ts       # Asana implementation
│   │       └── taskRouter.ts             # routeTask / completeExternalRefs / updateExternalRefs
│   └── utils/
│       └── errors.ts         # TokenExpiredError, AIExtractionError, TranscriptNotFoundError
│
├── web/
│   ├── index.html            # Sign-in page
│   ├── dashboard.html        # Pending approvals dashboard
│   ├── review.html           # Proposal review page (email link + direct)
│   ├── tasks.html            # Tasks kanban board
│   ├── settings.html         # Per-user settings (Google/Asana/Slack connections)
│   ├── admin.html            # Admin panel (Settings/Users/Dashboard/Meetings tabs + Setup Wizard)
│   ├── styles.css            # Global styles (all custom CSS)
│   └── js/
│       ├── firebase-config.js  # Firebase SDK init (replace values per project)
│       ├── auth.js             # requireAuth, requireAdminRole, signOutUser, showToast, initAdminNav
│       ├── api.js              # api.* client — all fetch calls to /api/*
│       ├── dashboard.js        # Pending approvals + awaiting-config banner
│       ├── review.js           # Proposal review (token flow + auth flow)
│       ├── tasks.js            # Kanban board + sync now
│       ├── settings.js         # Settings page logic
│       └── admin.js            # Admin panel logic (wizard, creds, users, dashboard, meetings)
│
├── firebase.json             # Firebase project config (functions, hosting, firestore, emulators)
├── firestore.rules           # Security rules
├── firestore.indexes.json    # Composite indexes
├── .env.example              # Environment variable reference (NOT a real .env)
└── .gitignore
```

---

## 3. Firestore Data Model

### `users/{uid}`
```typescript
{
  uid: string
  email: string
  displayName: string
  isActive: boolean
  role: "admin" | "user"          // First user auto-promoted to admin
  hasValidTokens: boolean          // True when Google OAuth tokens are valid
  aiProvider?: "anthropic" | "openai"  // Per-user AI override
  taskListId?: string              // Cached Google Tasks list ID
  preferences: {
    notifyVia: ("email" | "slack")[]
    autoApprove: boolean
    proposalExpiryHours: number    // Default: 48
    taskDestination?: ("google_tasks" | "asana")[]
    asanaWorkspaceId?: string
    asanaProjectId?: string
    slackUserId?: string           // Slack member ID (e.g. "U0123456")
  }
  promotedBy?: string
  promotedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

### `users/{uid}/tokens/google` (Admin SDK only)
KMS-encrypted OAuth tokens. Firestore rules deny all client access.

### `users/{uid}/tokens/asana` (Admin SDK only)
KMS-encrypted Asana OAuth tokens.

### `users/{uid}/apiKeys/{provider}` (Admin SDK only)
Per-user AI provider API keys. `{ key: string, masked: string, createdAt: Timestamp }`

### `processedTranscripts/{driveFileId}`
```typescript
{
  driveFileId: string            // Also the Firestore document ID
  driveFileLink: string
  detectedByUid: string
  meetingTitle: string
  detectedAt: Timestamp
  status: "pending" | "processing" | "extracting" | "proposed" | "completed"
       | "failed" | "awaiting_configuration"
  attendeeEmails: string[]
  error?: string
  transcriptFormat?: "plain_transcript" | "gemini_notes"
  hasNotes?: boolean
  tokensUsed?: { input: number; output: number }
}
```

### `proposals/{meetingId}/tasks/{taskId}`
```typescript
{
  // From AI extraction
  title: string
  description: string
  assigneeEmail: string
  assigneeName: string
  confidence: "high" | "medium" | "low"
  transcriptExcerpt: string
  isSensitive: boolean
  suggestedDueDate: string | null   // ISO 8601
  rawAssigneeText: string
  sharedWith?: string[]
  // Proposal lifecycle
  meetingId: string
  assigneeUid: string
  status: "pending" | "approved" | "rejected" | "edited" | "created"
        | "in_progress" | "completed" | "expired" | "failed"
  editedTitle?: string
  editedDescription?: string
  editedDueDate?: string | null
  reviewedAt?: Timestamp
  createdAt: Timestamp
  expiresAt: Timestamp
  // External task references
  externalRefs?: Array<{ destination: string; externalId: string; externalUrl: string }>
  failureReason?: string
  reassignedFrom?: string
  reassignedFromName?: string
  reassignedAt?: Timestamp
  // Two-way sync
  syncStatus?: "synced" | "pending_sync" | "sync_error" | "external_deleted"
  lastSyncedAt?: Timestamp
  externalUpdatedAt?: Timestamp
  localUpdatedAt?: Timestamp       // Set on every local write, NEVER by sync engine
  syncError?: string
}
```

### `config/secrets` (Admin SDK + admin-only Firestore rule)
KMS-encrypted credentials stored by admin panel. Fields:
- `ai.provider` (plain), `ai.apiKey` (encrypted)
- `slack.botToken` (enc), `slack.signingSecret` (enc), `slack.clientId` (plain), `slack.clientSecret` (enc)
- `asana.clientId` (plain), `asana.clientSecret` (enc)
- `configuredAt`, `configuredBy`

### `config/orgDefaults` (readable by all signed-in users, writable by admins)
```typescript
{
  notifyVia: ("email" | "slack")[]
  taskDestination: ("google_tasks" | "asana")[]
  proposalExpiryHours: 24 | 48 | 72
  autoApprove: boolean
}
```

### `config/setup` (admin-only)
```typescript
{ completed: boolean, completedAt: Timestamp, completedBy: string }
```

### `approvalTokens/{token}` — single-use, 48h TTL (Admin SDK only)
### `oauthStates/{state}` — 10-min CSRF tokens (Admin SDK only)
### `invites/{email}` — invite records (Admin SDK only)
### `activityLog/{auto-id}` — activity feed (Admin SDK only, max ~1000 entries)

---

## 4. Cloud Functions

| Export name | Type | Trigger | Description |
|---|---|---|---|
| `api` | HTTP | `onRequest` | Main API (all `/api/*` routes via Express) |
| `oauthInit` | HTTP | `onRequest` | Starts Google OAuth consent flow |
| `oauthCallback` | HTTP | `onRequest` | Handles Google OAuth callback |
| `updateUserSettings` | HTTP | `onRequest` | Legacy settings endpoint |
| `healthCheck` | HTTP | `onRequest` | `/healthCheck` status endpoint |
| `driveWatcher` | Scheduled | every 5 min | Scans Drive for new transcripts |
| `syncEngine` | Scheduled | every 10 min | Two-way sync with external systems |
| `expireProposals` | Scheduled | every hour | Marks stale proposals expired |
| `processTranscript` | Firestore | onCreate `processedTranscripts/{id}` | AI extraction pipeline |
| `notifyUsers` | Firestore | onUpdate `processedTranscripts/{id}` | Sends notifications on `→ proposed` |
| `taskCreator` | Firestore | onUpdate `proposals/{id}/tasks/{id}` | Creates tasks in external systems |
| `slackInteraction` | HTTP | `onRequest` | Handles Slack button payloads |
| `onUserCreated` | Auth | user().onCreate | Creates user doc; promotes first user to admin |
| `onTaskCreated` | Firestore | onCreate `tasks/{id}` | Stub (legacy) |

---

## 5. API Endpoints (`/api/*`)

All endpoints require `Authorization: Bearer <Firebase-ID-token>` except `/auth/validate-token`.

### User-facing
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/validate-token` | None | Exchange email-link token for Firebase custom token |
| GET | `/proposals/pending` | User | Pending proposals grouped by meeting |
| GET | `/proposals?meetingId=` | User | All proposals for a meeting |
| GET | `/proposals/:meeting/:task` | User | Single proposal |
| PATCH | `/proposals/:meeting/:task` | User | Approve / reject / edit |
| PATCH | `/proposals/:meeting/bulk` | User | Bulk approve/reject |
| POST | `/proposals/:meeting/:task/reassign` | User | Reassign to another user |
| GET | `/tasks` | User | All tasks (created/in_progress/completed) |
| PATCH | `/tasks/:meeting/:task` | User | Update title/description/dueDate/status |
| POST | `/tasks/:meeting/:task/complete` | User | Mark completed |
| POST | `/tasks/:meeting/:task/reopen` | User | Reopen completed task |
| POST | `/tasks/:meeting/:task/recreate` | User | Recreate externally-deleted task |
| POST | `/sync/now` | User | Trigger immediate sync |
| GET | `/users/active` | User | Active users list (for reassign dropdown) |
| GET | `/settings` | User | User settings + `availableIntegrations` |
| PATCH | `/settings` | User | Update isActive + preferences |
| GET | `/settings/api-keys` | User | Masked per-user AI keys |
| POST | `/settings/api-keys/:provider` | User | Save AI key |
| DELETE | `/settings/api-keys/:provider` | User | Remove AI key |
| PATCH | `/settings/api-keys/active` | User | Set active AI provider |
| GET | `/settings/asana` | User | Asana connection status |
| GET | `/settings/asana/workspaces` | User | List Asana workspaces |
| GET | `/settings/asana/projects?workspaceId=` | User | List Asana projects |
| DELETE | `/settings/asana` | User | Disconnect Asana |
| GET | `/auth/asana` | None | Start Asana OAuth flow |
| GET | `/auth/asana/callback` | None | Handle Asana OAuth callback |
| POST | `/settings/slack/connect` | User | Link Slack account by email |
| DELETE | `/settings/slack` | User | Disconnect Slack |
| GET | `/settings/slack` | User | Slack connection status |
| GET | `/config/org-defaults` | Admin | Read org-wide defaults |
| PATCH | `/config/org-defaults` | Admin | Update org-wide defaults |
| GET | `/transcripts/awaiting` | User | Count of awaiting_configuration transcripts |

### Admin-only (`/api/admin/*`) — all require `requireAdmin` + rate limiting (10/min)
| Method | Path | Description |
|---|---|---|
| GET | `/admin/secrets` | Masked credential status |
| PUT | `/admin/secrets` | Save credentials (KMS-encrypted) |
| POST | `/admin/secrets/test` | Test all integrations |
| GET | `/admin/users` | User list with enriched data; `?search=&role=&status=` |
| GET | `/admin/users/stats` | Aggregate user counts |
| PATCH | `/admin/users/:uid/role` | Promote/demote (blocks last-admin demotion) |
| PATCH | `/admin/users/:uid/status` | Activate/deactivate |
| PATCH | `/admin/users/bulk-status` | Bulk status change |
| DELETE | `/admin/users/:uid` | Delete user + tokens + Auth account |
| POST | `/admin/invite` | Store invite + send email |
| GET | `/admin/dashboard` | Summary stats + integration health |
| GET | `/admin/activity?limit=` | Activity log entries |
| GET | `/admin/meetings` | Processed meetings; `?status=&cursor=&limit=` |
| GET | `/admin/meetings/:id/proposals` | Proposals for a meeting |
| POST | `/admin/meetings/:id/reprocess` | Re-trigger pipeline for failed/stuck meeting |
| GET | `/admin/setup-status` | Onboarding wizard state |
| POST | `/admin/setup-complete` | Mark wizard as done |
| POST | `/admin/export` | Download all data as JSON (no secrets) |

---

## 6. AI Extraction Pipeline

```
driveWatcher (every 5 min)
  → scans each active user's Drive for files matching transcript patterns
  → deduplicates by Drive file ID (processedTranscripts doc ID = file ID)
  → creates processedTranscripts/{fileId} { status: "pending" }

processTranscript (onCreate trigger)
  → atomically claims: pending → processing
  → fetches transcript text from Drive API
  → fetches attendees from Calendar API
  → calls extractTasksFromTranscript() → AI provider → structured JSON
  → fans out proposals/{meetingId}/tasks/{taskId} for each matched user
  → status → "proposed" (or "failed" / "awaiting_configuration")

notifyUsers (onUpdate trigger, status pending→proposed)
  → for each unique assignee with pending proposals:
    * generates single-use approval token (48h)
    * routes notification via email or Slack (with email fallback)

taskCreator (onUpdate trigger, status pending→approved/edited)
  → creates task in Google Tasks and/or Asana
  → stores externalRefs on the proposal doc
  → status → "created"

syncEngine (every 10 min)
  → fetches external state for all created/in_progress tasks with externalRefs
  → conflict resolution: externalUpdatedAt > localUpdatedAt → external wins
  → cross-platform sync: winner's state pushed to all other refs
  → handles external deletion (status → "external_deleted")
```

---

## 7. Secrets & Security Architecture

### Credentials stored where
| Credential | Storage | Access |
|---|---|---|
| Google OAuth Client ID/Secret | Firebase env vars (`functions:config`) | Cloud Functions only |
| KMS key name | Firebase env vars | Cloud Functions only |
| Anthropic / OpenAI API key | Firestore `config/secrets` (KMS-encrypted) | Admin SDK via secrets service |
| Slack bot token, signing secret | Firestore `config/secrets` (KMS-encrypted) | Admin SDK via secrets service |
| Asana OAuth credentials | Firestore `config/secrets` (KMS-encrypted) | Admin SDK via secrets service |
| Per-user Google OAuth tokens | `users/{uid}/tokens/google` (KMS-encrypted) | Admin SDK only |
| Per-user Asana tokens | `users/{uid}/tokens/asana` (KMS-encrypted) | Admin SDK only |
| Per-user AI keys | `users/{uid}/apiKeys/{provider}` (plaintext, rules deny client) | Admin SDK only |

### `secrets.ts` resolution chain
1. In-memory cache (module-level Map, unexported, never logged)
2. Firestore `config/secrets` decrypted via KMS
3. Environment variable fallback (for fresh deployments)
4. Throws `"Secret not found"` — triggers `awaiting_configuration` status

### Security rules highlights
- `config/secrets` — `isAdmin()` only
- `config/setup` — `isAdmin()` only
- `activityLog/*` — deny all client access
- `invites/*` — deny all client access
- `users/{uid}/tokens/*` — deny all client access
- `users/{uid}/apiKeys/*` — deny all client access
- `approvalTokens/*` — deny all client access

### CORS
`api` function allows origins: `[process.env.APP_URL, "http://localhost:3000", "http://127.0.0.1:3000"]`

---

## 8. Two-Way Sync Design

**Conflict resolution rule:** external change wins only if `externalUpdatedAt > localUpdatedAt`.
`localUpdatedAt` is set on every dashboard/API write. The sync engine never sets it.

**Cross-platform sync:** When multiple `externalRefs` exist (e.g. Google Tasks + Asana),
the engine selects the "winner" (most recently updated) and pushes its state to all other refs.

**`syncStatus` values:**
- `synced` — Firestore matches external
- `pending_sync` — local change not yet confirmed externally
- `sync_error` — last sync attempt failed
- `external_deleted` — task was deleted in external system

**`syncUpdateProposal()`:** sync engine writes never include `localUpdatedAt`, so they don't
look like "local changes" that would trigger another sync cycle.

---

## 9. Admin Panel

Four tabs: **Settings** · **Users** · **Dashboard** · **Meetings**

**Settings tab:**
- AI credentials (provider + API key) with masked display
- Slack credentials (bot token, signing secret, client ID/secret)
- Asana credentials (client ID/secret)
- Google OAuth (read-only, from env vars)
- Per-section Test buttons + Test All
- Org Defaults (notify channel, task destination, proposal expiry, auto-approve)

**Users tab:**
- Stats bar (total / active / admins / Asana connected / Slack connected)
- Search + role/status filters
- Bulk activate/deactivate
- Promote/demote with last-admin guard
- Delete user (removes tokens + Auth account)
- Invite by email (stores invite + sends email)

**Dashboard tab:**
- Summary cards: users, meetings (this week/total), tasks (this week/total), AI cost (est.)
- Activity feed (last 20 entries from `activityLog`)
- System health panel (integration configured/not-configured)
- Export Data button → downloads `taskbot-export-{timestamp}.json`

**Meetings tab:**
- All `processedTranscripts` with status badge
- Expand row to see proposals
- Reprocess button for `failed` or `awaiting_configuration` meetings

**Setup Wizard** (shown on first admin visit when `config/setup.completed` is false):
- Step 1: AI Provider (provider dropdown + API key)
- Step 2: Notification channels (Slack bot token + signing secret, optional)
- Step 3: Org Defaults (notify channel, task destination, expiry)
- Step 4: Invite team (send invites by email)
- Completion writes `config/setup.completed = true`

---

## 10. Key Patterns & Conventions

### Idempotency
`processTranscript` uses a Firestore transaction to atomically claim `pending → processing`.
The pipeline clears existing proposals before re-writing them, making reprocessing safe.

### Rate limiting
`adminRateLimit` middleware: in-memory Map, 10 req/60s per UID. Per-instance (not global).

### Activity logging
`logActivity(type, message, metadata)` is non-fatal (errors are swallowed).
Called after: meeting processed, tasks approved, notifications sent, user joined, sync complete, reprocess triggered.
Probabilistic pruning keeps `activityLog` at ~1000 entries.

### Notification fallback chain
SlackChannel → falls back to EmailChannel when:
- `slack.botToken` not configured in secrets
- User has no `slackUserId`

### `availableIntegrations` on GET /settings
Returns `{ slack: boolean, asana: boolean }` from `isIntegrationConfigured()`.
Used by Settings page to:
- Grey out and warn about unconfigured Asana section
- Show Slack-not-configured banner

### Dashboard awaiting-configuration banner
`GET /transcripts/awaiting` → `{ count: number }` of meetings stuck in `awaiting_configuration`
for the current user (either `detectedByUid == uid` or user's email in `attendeeEmails`).

### Multi-client deployment
Each client gets their own Firebase project.
`deploy/configs/{client}.json` holds project ID, region, OAuth credentials, KMS key name, app URL.
These files are gitignored — store securely in a password manager or encrypted vault.
Deployment scripts: `setup-new-client.sh`, `deploy.sh`, `deploy-all.sh`.

---

## 11. Environment Variables

Set via `firebase functions:config:set`:

| Key | Description |
|---|---|
| `google.client_id` | Google OAuth Client ID |
| `google.client_secret` | Google OAuth Client Secret |
| `kms.key_name` | Full KMS key resource name |
| `app.url` | Public app URL (e.g. `https://project.web.app`) |

Also required in process.env (set via Functions configuration):
- `OAUTH_REDIRECT_URI` — Google OAuth callback URI
- `OAUTH_SUCCESS_REDIRECT` — Post-OAuth redirect URL
- `ASANA_REDIRECT_URI` — Asana OAuth callback URI

All other credentials are managed through the Admin Panel.

---

## 12. Current State & What's Implemented

### Phase 1 (MVP)
- Google Drive transcript detection + deduplication
- AI task extraction (Anthropic Claude, with OpenAI fallback)
- Google Tasks creation
- Email notification via Gmail API (organizer's account)
- Proposal review page (email link token flow + direct auth flow)
- Per-user settings (isActive, autoApprove, proposalExpiryHours)
- Proposal expiry + cleanup

### Phase 2
- Asana integration (OAuth, workspace/project selection, task creation)
- Slack integration (bot token, DM notifications, interactive buttons)
- Two-way sync engine (scheduled, conflict resolution, cross-platform sync)
- Tasks kanban board (`/tasks`) with drag-to-complete and sync status badges
- Proposal reassignment
- Per-user AI provider key management
- Role-based access (admin/user), first-user bootstrap
- KMS-encrypted secrets storage
- Slack interaction handler (approve/reject from Slack)

### Phase 3
- Full admin panel (credentials, user management, dashboard, meetings)
- Setup wizard for new deployments
- Activity logging
- AI token usage tracking + cost estimation
- `awaiting_configuration` status for missing AI config
- Rate limiting on admin endpoints
- Last-admin demotion guard
- Data export endpoint
- Multi-client deployment scripts
- Settings page integration availability warnings
- Dashboard awaiting-configuration banner
- Comprehensive test checklist (19 sections)

---

## 13. Known Limitations / Notes for Future Work

- `onTaskCreated` in `index.ts` is a stub from Phase 1 — has no active logic.
- Rate limiting is in-memory per Cloud Function instance, not globally accurate.
- AI cost estimates use Anthropic Sonnet pricing hardcoded; need update for other models.
- `driveWatcher` processes users sequentially in chunks of 5; large orgs may see delay.
- The `invites/{email}` collection is never cleaned up after acceptance.
- `asanaOAuthStates` collection (separate from `oauthStates`) doesn't have explicit cleanup.
- Gemini Notes format detection (`gemini_notes`) relies on file naming conventions.
- Per-user AI keys (`users/{uid}/apiKeys`) are stored plaintext — only rules-protected. Consider KMS encryption.

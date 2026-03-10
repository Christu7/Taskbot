# TaskBot Phase 3 — Production Readiness & Admin Panel

**Builds on:** MVP + Phase 2 (Asana, Slack, Kanban dashboard, two-way sync)
**Goal:** Take TaskBot from a dev environment to a production-ready tool that can be deployed per-client with an admin panel for configuration.
**Date:** March 9, 2026

---

## 1. What Phase 3 Adds

**Role System** — Admin and User roles. Admin controls system-wide configuration, manages users, and monitors activity. Users manage their own preferences and tasks.

**Admin Panel** — Full admin UI for managing credentials (AI provider, Slack, Asana), user management, org defaults, and a usage dashboard.

**Secrets in Firestore** — Move API keys and app credentials from environment variables into Firestore (encrypted), configurable from the admin UI. This lets each client's admin manage their own setup without CLI access.

**Multi-Project Deployment** — Infrastructure to deploy the same codebase to multiple Firebase projects (one per client). Config-driven, script-automated.

---

## 2. Architecture Changes

### 2.1 — Role Model

```
users/{uid}:
  ...existing fields...
  role: "admin" | "user"        // NEW — default: "user"
  promotedBy?: string           // UID of admin who promoted this user
  promotedAt?: Timestamp
```

Rules:
- The first user to sign up is automatically assigned role: "admin"
- Only admins can promote other users to admin or demote them back
- There must always be at least one admin (prevent last-admin demotion)

### 2.2 — Secrets Storage

Move from environment variables to Firestore:

```
config/secrets (admin-only read/write):
  ai:
    provider: "anthropic" | "openai" | "gemini"
    apiKey: string (encrypted)
  slack:
    botToken: string (encrypted)
    signingSecret: string (encrypted)
    clientId: string
    clientSecret: string (encrypted)
  asana:
    clientId: string
    clientSecret: string (encrypted)
```

```
config/orgDefaults (admin-write, all-users-read):
  taskDestination: string[]
  notifyVia: string[]
  proposalExpiryHours: number
  autoApproveDefault: boolean
```

Encryption approach: Use Google Cloud KMS (Key Management Service)
to encrypt/decrypt secrets. Cloud Functions have native access to
KMS. Secrets are stored encrypted in Firestore and decrypted at
runtime in Cloud Functions only — never sent to the frontend.

### 2.3 — Multi-Project Deployment

```
/deploy/
  ├── configs/
  │   ├── internal.json       // Your team's config
  │   ├── thg.json            // THG's config
  │   └── template.json       // Blank template for new clients
  ├── deploy.sh               // Main deployment script
  └── setup-new-client.sh     // Script to bootstrap a new client
```

Each config file contains:
```json
{
  "projectId": "taskbot-internal",
  "region": "us-central1",
  "oauthClientId": "...",
  "oauthClientSecret": "...",
  "firebaseHostingUrl": "https://taskbot-internal.web.app",
  "adminEmail": "christian@yourcompany.com"
}
```

Google OAuth credentials stay in environment variables (set during
deployment) because they're needed before any user can sign in
and configure the admin panel. Everything else moves to Firestore.

### 2.4 — Admin Panel Structure

```
/admin (new section in web app, visible only to role: "admin")
  ├── /admin/dashboard     — Usage stats, system health
  ├── /admin/users         — User list, roles, status
  ├── /admin/settings      — Org defaults, credentials
  └── /admin/meetings      — All processed meetings, status
```

---

## 3. Work Packages & Estimates

| # | Work Package | Estimate |
|---|---|---|
| **WP1** | Role system + Firestore rules | 0.5 week |
| **WP2** | Secrets management (KMS + Firestore) | 1 week |
| **WP3** | Admin panel — credentials & org settings | 1–1.5 weeks |
| **WP4** | Admin panel — user management | 0.5–1 week |
| **WP5** | Admin panel — usage dashboard & meetings | 1 week |
| **WP6** | Multi-project deployment tooling | 0.5–1 week |
| **WP7** | Production hardening & testing | 1–1.5 weeks |

**Total estimate: 5–7 weeks**

---

## 4. Claude Code Prompts

---

### Prompt 1 — Role System

```
Add an Admin / User role system to TaskBot.

1. Update the user model in /functions/src/models/:
   - Add to the User interface:
     * role: "admin" | "user" (default: "user")
     * promotedBy?: string (UID of admin who changed this user's role)
     * promotedAt?: Timestamp

2. Update the Auth trigger (functions.auth.user().onCreate):
   - When creating the user document, check if ANY other users exist
     in Firestore.
   - If this is the FIRST user ever: set role = "admin"
   - If other users exist: set role = "user"
   - Log: "First user {email} promoted to admin" or "New user {email}
     created with role: user"

3. Update Firestore security rules:
   - users/{uid}: readable by self, writable by self EXCEPT for the
     role field — role can only be written by an admin
   - config/secrets: readable and writable ONLY by users where
     role === "admin"
   - config/orgDefaults: readable by all authenticated users, writable
     only by admins
   - Add a helper function in rules: isAdmin() that reads the
     requesting user's document and checks role === "admin"

4. Create role middleware for Cloud Functions:
   - Create /functions/src/middleware/auth.ts (or update existing):
     * requireAuth(req) — existing, verifies Firebase token
     * requireAdmin(req) — verifies Firebase token AND checks
       role === "admin" in Firestore. Returns 403 if not admin.
   - Apply requireAdmin to all admin-only endpoints

5. Create admin API endpoints in /functions/src/functions/adminApi.ts:
   - GET /api/admin/users — list all users with their roles and status
     (requires admin)
   - PATCH /api/admin/users/{uid}/role — change a user's role
     Body: { role: "admin" | "user" }
     Validation: cannot demote the last admin (query for admin count)
     Sets promotedBy and promotedAt
     (requires admin)
   - PATCH /api/admin/users/{uid}/status — activate/deactivate a user
     Body: { isActive: boolean }
     (requires admin)
   - DELETE /api/admin/users/{uid} — remove a user entirely
     (requires admin, cannot delete self)

6. Update the web app navigation:
   - If the logged-in user has role === "admin", show an "Admin" link
     in the nav bar (after Dashboard | Tasks | Settings)
   - If role === "user", don't show it
   - Fetch the user's role on login and store it in the frontend state

7. Protect the frontend:
   - If a non-admin user navigates to /admin/*, redirect to /dashboard
   - The API endpoints are the real security boundary (Firestore rules
     + requireAdmin middleware), but the frontend should also hide
     admin UI to avoid confusion
```

**Checkpoint:** Sign in as the first user → verify role is "admin" in Firestore. Sign in as a second user → verify role is "user." Try to access /api/admin/users as the second user → should get 403.

---

### Prompt 2 — Secrets Management

```
Move API credentials from environment variables into Firestore,
encrypted with Google Cloud KMS.

This allows admins to configure credentials from the admin UI instead
of needing CLI access.

1. Set up KMS encryption:
   - Create /functions/src/services/secrets.ts
   - Use Google Cloud KMS (@google-cloud/kms package)
   - Create two functions:
     * encryptSecret(plaintext: string): Promise<string>
       - Uses KMS to encrypt, returns base64-encoded ciphertext
     * decryptSecret(ciphertext: string): Promise<string>
       - Uses KMS to decrypt, returns plaintext
   - The KMS key ring and key name should be configured via environment
     variable: KMS_KEY_NAME (this is the ONE thing that stays in env vars)
   - Document the KMS setup: what commands to run in Google Cloud Console
     to create the key ring and key

   IMPORTANT: Tell me the exact gcloud CLI commands to create the KMS
   key ring and crypto key for my Firebase project.

2. Create the config/secrets Firestore document structure:
   - Path: config/secrets
   - Fields (all encrypted):
     * ai.provider: string (not encrypted — just "anthropic" | "openai" | "gemini")
     * ai.apiKey: string (encrypted)
     * slack.botToken: string (encrypted)
     * slack.signingSecret: string (encrypted)
     * slack.clientId: string (not encrypted)
     * slack.clientSecret: string (encrypted)
     * asana.clientId: string (not encrypted)
     * asana.clientSecret: string (encrypted)
   - Add a field: configuredAt: Timestamp (set when admin saves)
   - Add a field: configuredBy: string (UID of admin who last saved)

3. Create a secrets service:
   - Function: getSecret(path: string): Promise<string>
     * Reads from Firestore config/secrets
     * Decrypts the value using KMS
     * Caches decrypted values in memory for the function's lifetime
       (Cloud Functions are short-lived, so this is safe and avoids
       repeated KMS calls)
   - Function: setSecret(path: string, value: string): Promise<void>
     * Encrypts the value using KMS
     * Writes to Firestore

4. Update ALL existing code that reads from environment variables to
   use the secrets service instead:
   - aiProvider.ts: reads ai.apiKey and ai.provider from secrets
   - slackAuth.ts / slackNotifier.ts: reads slack.* from secrets
   - asanaAuth.ts / asanaApi.ts: reads asana.* from secrets
   - Keep a fallback: if config/secrets doesn't exist in Firestore
     (fresh deployment), fall back to environment variables. This
     allows the system to boot for initial setup before the admin
     configures credentials via the UI.

5. Create admin API endpoints:
   - GET /api/admin/secrets — returns the config with secrets MASKED
     (show only last 4 characters of each key, e.g., "sk-ant-...7x4Q")
     (requires admin)
   - PUT /api/admin/secrets — saves new credentials
     Body: { ai: { provider, apiKey }, slack: { ... }, asana: { ... } }
     Only update fields that are provided (partial update)
     Encrypt each secret before storing
     (requires admin)
   - POST /api/admin/secrets/test — tests each credential:
     * AI: make a minimal API call (short prompt, max 10 tokens)
     * Slack: call auth.test to verify the bot token
     * Asana: call /users/me to verify the credentials
     Return: { ai: "ok" | "error: ...", slack: "ok" | "error: ...",
               asana: "ok" | "error: ..." }
     (requires admin)

6. Handle the chicken-and-egg problem:
   - Google OAuth client ID and secret MUST stay in environment
     variables because they're needed for the very first user to sign
     in (before any admin exists to configure the UI).
   - Add a note in the admin settings UI: "Google OAuth credentials
     are configured during deployment and cannot be changed from this
     panel."
```

**Checkpoint:** Deploy, sign in as admin. Go to admin settings, enter your AI API key, click Test → should return "ok." Remove the AI key from environment variables, redeploy functions. The extraction pipeline should still work by reading from Firestore.

---

### Prompt 3 — Admin Panel: Credentials & Org Settings

```
Build the admin panel UI — starting with the credentials and
organization settings pages.

1. Create /web/admin.html (or a new section within the existing SPA):

   Navigation within admin: Dashboard | Users | Settings | Meetings
   (Dashboard and Meetings will be built in later prompts — create
   placeholder pages for now)

2. Admin Settings page (/admin/settings):

   Section 1: AI Configuration
   - Provider: dropdown (Anthropic / OpenAI / Gemini)
   - API Key: password input (shows masked value from GET /api/admin/secrets)
   - "Test Connection" button → calls POST /api/admin/secrets/test
     Shows: ✓ Connected or ✗ Error: [message]
   - "Save" button

   Section 2: Slack Configuration
   - Bot Token: password input
   - Signing Secret: password input
   - Client ID: text input
   - Client Secret: password input
   - "Test Connection" button
   - "Save" button
   - Help text: link to /docs/SLACK_SETUP.md with setup instructions

   Section 3: Asana Configuration
   - Client ID: text input
   - Client Secret: password input
   - "Test Connection" button
   - "Save" button
   - Help text: link to Asana developer console

   Section 4: Google OAuth (read-only)
   - Show: "Configured during deployment"
   - Display the current client ID (masked) for reference
   - No edit capability

   Section 5: Organization Defaults
   - Default task destinations: checkboxes (Google Tasks, Asana)
   - Default notification channels: checkboxes (Email, Slack)
   - Default proposal expiry: dropdown (24h / 48h / 72h)
   - Default auto-approve: checkbox
   - "Save" button
   - Note: "These apply to users who haven't set their own preferences"

3. UX details:
   - Show a "last configured" timestamp and who configured it
   - After saving credentials, show a confirmation toast
   - If Test Connection fails, show the error message inline
   - Password fields: show a "reveal" toggle (eye icon)
   - When loading the page, fetch current config from
     GET /api/admin/secrets and GET /api/admin/org-defaults

4. Add API endpoint for org defaults:
   - GET /api/admin/org-defaults — returns current org defaults
     (requires admin)
   - PUT /api/admin/org-defaults — saves org defaults
     (requires admin)
   - These read/write to config/orgDefaults in Firestore

5. Style: match the existing app style (white cards, subtle shadows).
   Use a sidebar navigation for the admin section to distinguish it
   from the regular user UI.
```

**Checkpoint:** Navigate to /admin/settings. Enter credentials, save, test each connection. Change org defaults and verify they're applied to a new user who hasn't set preferences.

---

### Prompt 4 — Admin Panel: User Management

```
Build the user management page in the admin panel.

1. Create the Users page at /admin/users:

   Layout: a table/list of all users with columns:
   - Name (display name from Google)
   - Email
   - Role (Admin / User) — shown as a badge
   - Status (Active / Inactive) — green/grey badge
   - Connected accounts: icons for Google ✓, Asana ✓/✗, Slack ✓/✗
   - Tasks created (count of proposals with status "created")
   - Last active (most recent login or action timestamp)
   - Actions column

2. Actions per user:
   - Toggle Active/Inactive (switch)
   - Change Role: dropdown (Admin / User)
     * Show a confirmation dialog: "Promote [name] to admin?"
     * Cannot demote the last admin — show a warning
   - Remove User: red button with confirmation dialog
     * "Remove [name]? This will deactivate their account and
       remove their stored tokens. Their existing tasks will not
       be deleted."
     * Cannot remove yourself

3. Add a search/filter bar at the top:
   - Search by name or email
   - Filter by: role (all / admin / user), status (all / active / inactive)

4. Invite flow (optional but useful):
   - "Invite User" button at the top
   - Opens a modal: enter email address
   - Sends an email to that address with a link to sign in to TaskBot
   - Since we use Google SSO, the "invite" is really just a notification
     — the user signs in normally and their account is created
   - Store pending invites in Firestore: invites/{email} → { invitedBy,
     invitedAt, accepted: boolean }
   - When the auth trigger fires for a new user, check if their email
     has a pending invite and mark it as accepted

5. Bulk actions:
   - Select multiple users (checkboxes)
   - Bulk activate / deactivate

6. Update the API:
   - GET /api/admin/users already exists from Prompt 1
   - Add query params: ?search=, ?role=, ?status=
   - Add: GET /api/admin/users/stats — returns aggregate stats
     { total, active, admins, connectedAsana, connectedSlack }
   - Add: POST /api/admin/invite — sends invite email
     Body: { email: string }
```

**Checkpoint:** View the users list, promote a second user to admin, verify they can access admin pages. Deactivate a user, verify they're skipped by the Drive Watcher.

---

### Prompt 5 — Admin Panel: Dashboard & Meetings

```
Build the admin dashboard and meetings overview pages.

1. Admin Dashboard (/admin/dashboard):

   Top row — summary cards (4 cards in a row):
   - Total Users: [N] active / [M] total
   - Meetings Processed: [N] this week / [M] total
   - Tasks Created: [N] this week / [M] total
   - AI Usage: [N] API calls this week (estimated cost: $X)

   Middle section — recent activity feed:
   - Chronological list of the last 20 system events:
     * "Meeting 'Weekly Standup' processed — 5 tasks extracted"
     * "Maria approved 3 tasks from 'Sprint Planning'"
     * "New user Carlos joined"
     * "Sync engine detected 2 completed tasks in Asana"
   - Each entry has: timestamp, event type icon, description
   - Source this from a new Firestore collection: activityLog/{id}
     { type, message, userId?, meetingId?, timestamp }

   Bottom section — system health:
   - AI Provider: ✓ Connected (Anthropic) / ✗ Error
   - Slack: ✓ Connected / ✗ Not configured
   - Asana: ✓ Connected / ✗ Not configured
   - Sync Engine: last run [time], next run [time]
   - Drive Watcher: last run [time], next run [time]
   - Pull these from the existing health check endpoint

2. Meetings page (/admin/meetings):

   Table of all processed meetings:
   - Meeting title
   - Date
   - Detected by (user who triggered detection)
   - Attendees (count, expandable to see names)
   - Tasks extracted (count)
   - Status: pending / processing / proposed / completed / failed
   - Format: plain_transcript / gemini_notes

   Actions:
   - Click a meeting → expand to see all proposals across all users
     (admin can see everyone's tasks)
   - "Reprocess" button on failed meetings (re-triggers the pipeline)
   - Filter by: date range, status, attendee

3. Activity logging — add log entries throughout the existing codebase:
   - In processTranscript.ts: log when a meeting is processed
   - In taskCreator.ts: log when tasks are created
   - In notifyUsers.ts: log when notifications are sent
   - In syncEngine.ts: log sync results
   - In the auth trigger: log new user signups
   - Create a helper: logActivity(type, message, metadata?)
   - Keep only the last 1000 entries (delete oldest on insert,
     or use a TTL approach)

4. AI cost estimation:
   - Track token usage per AI call. Update the processedTranscripts
     document with:
     * tokensUsed: { input: number, output: number }
   - The dashboard calculates estimated cost based on provider rates:
     * Anthropic: $3/M input, $15/M output (Sonnet)
     * OpenAI: $5/M input, $15/M output (GPT-4o)
   - Show weekly and monthly running totals

5. API endpoints:
   - GET /api/admin/dashboard — returns all summary stats
   - GET /api/admin/activity — returns recent activity (paginated)
   - GET /api/admin/meetings — returns all meetings (paginated,
     filterable)
   - POST /api/admin/meetings/{meetingId}/reprocess — retriggers
     the pipeline for a failed meeting
   - All require admin role
```

**Checkpoint:** View the admin dashboard. Check that summary numbers are correct. Process a test meeting and verify the activity feed updates. View the meetings list and click through to see all proposals.

---

### Prompt 6 — Multi-Project Deployment

```
Create deployment tooling for deploying TaskBot to multiple Firebase
projects (one per client).

1. Create /deploy/configs/template.json:
   {
     "projectId": "",
     "region": "us-central1",
     "google": {
       "oauthClientId": "",
       "oauthClientSecret": ""
     },
     "kms": {
       "keyName": ""
     },
     "adminEmail": "",
     "appUrl": ""
   }

2. Create /deploy/configs/internal.json:
   - Pre-filled with your current Firebase project details
   - This becomes the reference config

3. Create /deploy/setup-new-client.sh:
   A script that bootstraps a new client. It should:
   - Accept a client name as argument: ./setup-new-client.sh thg
   - Copy template.json to configs/thg.json
   - Prompt for: Firebase project ID, region, admin email
   - Run these steps (with confirmation):
     * firebase use [projectId]
     * Enable required APIs (Firestore, Auth, Cloud Functions, KMS)
     * Create KMS key ring and crypto key
     * Set up Firestore indexes
     * Deploy security rules
     * Set environment variables (Google OAuth only)
     * Deploy Cloud Functions
     * Deploy hosting
   - Print a summary: "Client [name] deployed to [url]. First user
     to sign in at [admin email] will become admin."

4. Create /deploy/deploy.sh:
   A deployment script for updates:
   - Usage: ./deploy.sh [client-name] [--only functions|hosting|rules]
   - Reads config from /deploy/configs/[client-name].json
   - Sets the Firebase project
   - Sets environment variables from the config
   - Builds and deploys
   - Example: ./deploy.sh thg --only functions

5. Create /deploy/deploy-all.sh:
   - Loops through all configs in /deploy/configs/ (except template)
   - Deploys to each project sequentially
   - Usage: ./deploy-all.sh [--only functions]
   - Shows progress: "Deploying to internal (1/3)... ✓"
   - If one fails, continues to the next and reports errors at the end

6. Update README.md with:
   - How to set up a new client
   - How to deploy updates
   - How to roll back (firebase hosting:rollback, function versioning)
   - List of what's in env vars vs Firestore for each client

7. Add a .env.example file at the root listing every environment
   variable needed with descriptions and example values.

8. Create /deploy/configs/.gitignore:
   - Ignore all config files EXCEPT template.json
   - Client configs contain secrets and should NOT be in git
   - Add a note in README: "Client configs are gitignored. Store
     them securely (e.g., in a password manager or encrypted vault)."
```

**Checkpoint:** Run setup-new-client.sh for a test project. Deploy to it. Sign in as the first user → verify admin role. Configure credentials via admin panel. Run the full pipeline.

---

### Prompt 7 — Production Hardening

```
Final production hardening pass before team testing.

1. Security review:
   - Verify all admin API endpoints use requireAdmin middleware
   - Verify Firestore rules: config/secrets is admin-only
   - Verify no API endpoint returns decrypted secrets to the frontend
     (only masked values)
   - Verify the secrets cache in Cloud Functions memory is not leaked
     in error messages or logs
   - Review all console.log / logger calls to ensure no secrets are
     logged (search for "apiKey", "secret", "token" in log messages)
   - Verify CORS settings on all HTTP Cloud Functions (restrict to
     your hosting domain)

2. Error handling for missing configuration:
   - If an admin hasn't configured AI credentials yet:
     * Drive Watcher still runs (detects transcripts)
     * Processing pipeline skips extraction and sets status:
       "awaiting_configuration" with message: "AI provider not
       configured. Ask an admin to set up credentials in Settings."
     * Show this message in the dashboard for users
   - If Slack credentials aren't configured:
     * Users who select Slack notifications get a warning
     * Fall back to email silently
   - If Asana credentials aren't configured:
     * Asana option is greyed out in user settings
     * Show: "Asana not configured for this organization"

3. Rate limiting on admin endpoints:
   - Add basic rate limiting to the secrets endpoints
     (prevent brute-force attempts to read secrets)
   - 10 requests per minute per user on admin endpoints

4. Onboarding flow for new deployments:
   - When the first admin signs in and the system has no credentials
     configured yet, redirect to /admin/settings with a setup wizard:
     * Step 1: "Welcome to TaskBot. Let's configure your AI provider."
     * Step 2: "Connect your notification channels (optional)."
     * Step 3: "Set your organization defaults."
     * Step 4: "Invite your team."
   - After completing setup, show the regular admin dashboard
   - Track setup completion in Firestore: config/setup →
     { completed: boolean, completedAt, completedBy }

5. Backup and recovery:
   - Create a Cloud Function: POST /api/admin/export
     * Exports all Firestore data (users, config, meetings, proposals)
       as a JSON file — EXCLUDING encrypted secrets
     * Returns a download link
     * Useful for migrating between projects or disaster recovery
   - Add to admin dashboard: "Export Data" button

6. Update the test checklist (/docs/TEST_CHECKLIST.md) with Phase 3:
   - [ ] First user sign-up gets admin role
   - [ ] Second user gets user role
   - [ ] Non-admin cannot access /admin/* pages
   - [ ] Non-admin gets 403 on admin API endpoints
   - [ ] Admin can configure AI credentials via UI
   - [ ] AI test connection works
   - [ ] Admin can configure Slack credentials via UI
   - [ ] Admin can configure Asana credentials via UI
   - [ ] Org defaults are applied to users without personal prefs
   - [ ] Admin can view all users
   - [ ] Admin can promote/demote roles
   - [ ] Admin can activate/deactivate users
   - [ ] Cannot demote last admin
   - [ ] Activity feed shows recent events
   - [ ] Meeting list shows all processed meetings
   - [ ] Admin can reprocess a failed meeting
   - [ ] Setup wizard appears on fresh deployment
   - [ ] Data export works
   - [ ] Deploy to a second project works
   - [ ] Credentials are never logged or returned in plain text

7. Fix any issues found. List anything that needs my input.
```

**Final Checkpoint:** Deploy to a fresh Firebase project using the deployment script. Walk through the setup wizard as the first admin. Configure all credentials. Invite a second user. Process a test meeting end-to-end. Verify everything works from both admin and user perspectives.

---

## 5. Environment Variables — What Stays vs What Moves

**Stays in environment variables (set during deployment):**
```
GOOGLE_OAUTH_CLIENT_ID     — needed before any user signs in
GOOGLE_OAUTH_CLIENT_SECRET — needed before any user signs in
KMS_KEY_NAME               — needed to decrypt everything else
```

**Moves to Firestore (configured by admin in UI):**
```
AI provider + API key
Slack bot token, signing secret, client ID, client secret
Asana client ID, client secret
Org defaults (task destination, notification channel, etc.)
```

---

## 6. Setup Checklist for a New Client

1. Create a Firebase project in the Firebase console
2. Enable: Firestore, Authentication (Google), Cloud Functions, Hosting
3. Create Google OAuth credentials in Cloud Console
4. Create a KMS key ring and crypto key
5. Run: `./deploy/setup-new-client.sh [client-name]`
6. First user signs in → becomes admin → completes setup wizard
7. Admin configures AI, Slack, Asana credentials in the admin panel
8. Admin invites team members
9. Team members sign in, connect their accounts, set preferences
10. Done — meetings are automatically processed

---

## 7. Risks Specific to Phase 3

| Risk | Impact | Mitigation |
|---|---|---|
| KMS adds latency to every API call | Slower function execution | Cache decrypted secrets in memory for function lifetime |
| Admin misconfigures credentials | Pipeline stops working | Test Connection button validates before saving. Fallback to env vars. |
| First-user-is-admin race condition | Two people sign up simultaneously, both get admin | Use Firestore transaction to check user count atomically |
| Deployment script breaks for a client | One client is down | Each client is independent. Fix and redeploy to that client only. |
| Client configs with secrets in them | Security risk if leaked | Gitignored, stored outside repo. Document secure storage practices. |
